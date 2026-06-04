---
title: "Android RenderThread and HWUI: From DisplayList Recording to GPU Rasterization"
lang: en
translationKey: android-renderthread-hwui
slug: android-renderthread-hwui
excerpt: "A deep dive into Android HWUI rendering, main-thread and RenderThread responsibilities, DisplayList recording, RenderNode synchronization, Skia/Vulkan rasterization, and Compose rendering."
publishDate: '2026-04-20'
tags:
- "Android"
- "Performance Optimization"
- "HWUI"
- "Compose"
- "Vulkan"
seo:
  title: "Android RenderThread and HWUI: Rendering Pipeline, DisplayList, and Jank Analysis"
  description: "Understand Android HWUI, RenderThread, DisplayList recording, RenderNode sync, GPU rasterization, Compose layers, Vulkan, and frame drops."
  pageType: article
---

During performance work, I often see a confusing trace pattern: `RenderThread` takes far longer than the main thread's `draw`, but the app code does not seem to do complex drawing. After digging into HWUI internals, the reason becomes clear. The main thread is only the director; the actual rendering work runs quietly on a separate pipeline.

This article walks through the full path from `View.invalidate` to pixels reaching the framebuffer. The focus is RenderThread's scheduling model, the DisplayList lifecycle, and how Compose reuses the same underlying rendering system.

## Two-thread split: main thread records, RenderThread replays

After Android 4.0 introduced hardware acceleration, rendering moved from a single-threaded model to a two-stage pipeline:

- **Main thread**: runs `View.draw()`. It does not call OpenGL or Vulkan directly; it records drawing commands into a `DisplayList`.
- **RenderThread**: reads the DisplayList, drives the GPU rasterization work, and lets `SurfaceFlinger` compose the result to the screen.

The main value of this design is not "parallelism." The two threads still have strict synchronization barriers. The value is **moving GPU driver calls off the main thread**, so unpredictable driver latency does not block UI response.

The synchronization point is `syncFrameState`: the main thread synchronizes Java object state into native RenderNodes, then releases. RenderThread continues alone and submits GPU commands.

## How DisplayList recording works

Each View owns a `RenderNode`, and each `RenderNode` holds a `DisplayList` recorded by `RecordingCanvas`. Recording enters through `View.updateDisplayListIfDirty()`:

```java
// View.java (simplified)
RenderNode renderNode = mRenderNode;
if (!renderNode.hasDisplayList()) {
    // Create a recording canvas.
    RecordingCanvas canvas = renderNode.beginRecording(width, height);
    try {
        draw(canvas); // Triggers onDraw; all drawing commands go into the DisplayList.
    } finally {
        renderNode.endRecording(); // Wraps the DisplayList and marks it valid.
    }
}
```

At the native layer, `RecordingCanvas` maps to `SkiaRecordingCanvas`. It inherits from `SkCanvas`, but it does not actually draw. Each `drawRect`, `drawBitmap`, and similar call is serialized into a `DisplayListOp` and appended to the list.

This mechanism has an important property: **a child View's DisplayList is embedded in the parent by reference, not expanded as a copy**. When the parent records, it inserts a `DrawRenderNode` operation for the child. The child's DisplayList remains independent. If a child is invalidated, only that child's DisplayList needs to be rerecorded; the parent tree structure does not need to be rebuilt.

## RenderNode tree synchronization and CanvasContext

At the start of each frame, `ThreadedRenderer` calls `syncAndDrawFrame`, entering the synchronization phase between the main thread and RenderThread:

```cpp
// CanvasContext.cpp (Android 13 source, simplified)
void CanvasContext::prepareTree(TreeInfo& info) {
    mRootRenderNode->prepareTree(info);  // Recursively synchronize the RenderNode tree.
    // At this point, the main thread is blocked by syncFrameState until this completes.
}
```

`prepareTree` recursively traverses the RenderNode tree and performs two kinds of work:

1. **Property synchronization**: copies Java-side properties such as `translationX`, `alpha`, and `clipBounds` into native fields
2. **DisplayList dirty propagation**: after a node's DisplayList is rerecorded, dirty flags propagate upward

After synchronization finishes, the main thread unlocks. RenderThread then owns the tree exclusively and begins the real drawing stage.

## Skia backend and Vulkan rasterization

After RenderThread gets the RenderNode tree, it passes it to `SkiaPipeline`, which uses Skia for rasterization. Before Android 9, the default backend was OpenGL. Since Android 12, many devices use the Vulkan backend.

Both backends are transparent to the upper HWUI layer. `SkiaPipeline` only cares about `SkSurface` and `SkCanvas`; it does not care whether the lower layer is GL or Vulkan:

```cpp
// SkiaPipeline.cpp (simplified)
void SkiaPipeline::renderFrame(SkCanvas* canvas) {
    // Replay the DisplayList and convert it to Skia drawing calls.
    RenderNodeDrawable root(mRootNode, canvas);
    canvas->drawDrawable(&root);
    // Skia generates GL draw calls or Vulkan command buffers internally.
}
```

The Vulkan backend's advantage is that **command buffers can be recorded concurrently across threads**. OpenGL's state-machine model is global and mostly serial. Vulkan command buffers are naturally isolated, so HWUI can distribute rendering commands for different layers across multiple threads, then submit them to the same queue. That is one reason complex UIs often have more stable frame times on Vulkan.

One issue I hit after upgrading to targetSdk 33: some older devices forced Vulkan, and a custom `View` used `Canvas.drawPicture`. That API had backend path differences in Skia Vulkan, triggering extra CPU-side readback and increasing frame time. The fix was to draw directly or record into a `RenderNode` instead of using `drawPicture`.

## Compose's RenderNode mapping

On Android, Compose fully reuses HWUI's RenderNode system. It does not have a separate rendering engine.

After layout, each `@Composable` maps to an `OwnedLayer`, which internally owns a `RenderNodeLayer`. `RenderNodeLayer` wraps a native `RenderNode`. Compose invalidation rerecords that RenderNode and follows the same `updateDisplayListIfDirty` -> `syncAndDrawFrame` path as regular Views.

```kotlin
// AndroidComposeView.kt (Compose internals, simplified)
override fun dispatchDraw(canvas: Canvas) {
    // The root RenderNode represents the whole Compose tree.
    composeOwner.draw(canvas)
}
```

The difference is at the recording layer. A View's `onDraw` works directly with `Canvas`. Compose abstracts drawing through `DrawScope`. On Android, the underlying `Canvas` implementation is `SkiaCanvas`, and the recorded output still goes into HWUI's `RecordingCanvas`.

This shared foundation leads to an important conclusion: **if a Compose animation only changes RenderNode properties such as translation, scale, alpha, or clipping, it can bypass main-thread recomposition entirely**. RenderThread's animation system can drive those property changes directly. `Modifier.graphicsLayer` maps directly to this mechanism: it creates an independent RenderNode, and animation values write into that node's transform properties without triggering Compose recomposition.

```kotlin
// This animation can run on RenderThread without triggering recomposition.
Box(
    modifier = Modifier.graphicsLayer {
        translationX = animatedOffset.value  // Directly maps to RenderNode.translationX.
        alpha = animatedAlpha.value
    }
)
```

## End-to-end frame production

Putting the stages together, one frame is produced like this:

```text
Main thread:
  Choreographer vsync callback
    -> View.invalidate propagation
    -> updateDisplayListIfDirty (record DisplayList)
    -> syncFrameState (blocked while waiting for RenderThread sync)
    -> unlock and continue processing next-frame input

RenderThread:
  prepareTree (synchronize RenderNode properties)
    -> SkiaPipeline.renderFrame (replay DisplayList -> Skia calls)
    -> Skia generates GL draw calls / Vulkan command buffers
    -> eglSwapBuffers / vkQueueSubmit
    -> SurfaceFlinger composes to screen
```

`syncFrameState` is the critical bottleneck in this pipeline. The main thread's blocked duration depends on how long the previous frame's `prepareTree` took. If RenderThread has not finished the previous `prepareTree`, the main thread must wait. In Systrace, a large main-thread `syncFrameState` wait usually means RenderThread backlog. Investigate GPU time or overly complex DisplayLists, such as many `saveLayer` calls or large-area blur.

## Practical guidance

**Reduce unnecessary rerecording**: keep `invalidate` ranges precise and avoid full redraws from parent containers. In Compose, push mutable state down toward leaf nodes and use `remember` to isolate recomposition scope.

**Use `graphicsLayer` to isolate animations**: run translation, scale, and alpha animations through `graphicsLayer` so RenderThread can handle them independently. Once animation logic mixes with business state and triggers recomposition, this isolation is lost.

**Use `saveLayer` sparingly**: every `saveLayer` creates an offscreen framebuffer. Large stacked `saveLayer` operations are a common cause of RenderThread time spikes. In some Compose cases, `CompositingStrategy.ModulateAlpha` can avoid the default `Offscreen` cost.

**Test Vulkan compatibility early**: if custom drawing uses `Canvas.drawPicture`, `PorterDuff` blend modes, or complex `BitmapShader` paths, test on Vulkan-backend devices. Behavior can differ slightly from the GL backend.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [Android app startup metrics: cold start, first frame, TTID, and Perfetto analysis](/en/blog/android-startup-metrics/)
- [Why Bitmap causes OOM on Android: image memory model explained](/en/blog/android-bitmap-oom/)
- [Jetpack Compose recomposition performance: stability and derivedStateOf](/en/blog/jetpack-compose-recomposition-performance/)
<!-- /seo-internal-links -->
