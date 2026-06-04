---
title: "Android On-device AI Real-time Video: CameraX Frames, GPU Preprocessing, and LiteRT Inference"
lang: en
translationKey: android-on-device-ai-realtime-video
slug: android-on-device-ai-realtime-video
excerpt: "A practical end-to-end Android real-time video AI pipeline, covering CameraX head-of-line blocking, GPU YUV preprocessing, LiteRT inference jitter, async staging, and frame-expiration control."
publishDate: '2026-05-06'
tags:
- "Android"
- "On-device AI"
- "Performance Optimization"
- "CameraX"
- "LiteRT"
seo:
  title: "Android Real-time On-device AI Video with CameraX, GPU Preprocessing, and LiteRT"
  description: "Fix CameraX frame congestion, GPU preprocessing copies, and LiteRT inference jitter to build a 1080p 30fps Android on-device AI video pipeline."
  pageType: article
---

## The problem: a 30 fps camera, but the model only saw 8 frames

Last year, while building a real-time portrait segmentation feature, I hit a frustrating issue: CameraX was delivering frames steadily at 30 fps, but the model was only processing around 8 fps. The `analyze()` callback clearly fired for every frame in logcat. So where did the frames go?

After investigation, the issue came down to three bottlenecks:

1. **Frame congestion**: YUV-to-RGB conversion ran on the CPU, costing 4-6 ms per frame, and `ImageProxy` was not closed quickly enough, so the queue filled up
2. **Inference jitter**: model inference fluctuated heavily from 15 ms to 40 ms, and occasional timeout frames were dropped internally by CameraX
3. **Implicit copies**: GPU texture upload and OpenCL memory sharing for inference were not wired correctly, causing a GPU-to-CPU-to-GPU detour

These problems are coupled. If any one stage stalls, the whole pipeline slows down.

## Head-of-line blocking in CameraX callbacks

The default behavior of `ImageAnalysis.Analyzer` is serial processing. If the previous frame's `analyze()` has not returned, the next callback will not fire. If preprocessing and inference run synchronously inside the callback, frame rate is determined by the slowest frame.

```kotlin
// Dangerous pattern: synchronous inference on the callback thread
val analyzer = ImageAnalysis.Analyzer { imageProxy ->
    val result = runInference(imageProxy)  // Takes 15-40 ms
    imageProxy.close()
}
```

`setBackpressureStrategy(STRATEGY_KEEP_ONLY_LATEST)` only drops frames when the callback queue is full. It does not solve serial blocking itself. The fix is asynchronous decoupling: the callback only enqueues the frame and returns immediately.

```kotlin
val analyzer = ImageAnalysis.Analyzer { imageProxy ->
    if (!frameQueue.offer(imageProxy)) {
        imageProxy.close() // Queue full, drop frame
    }
}

// Consumer thread
while (isActive) {
    val frame = frameQueue.poll(50, TimeUnit.MILLISECONDS) ?: continue
    processFrame(frame)
}
```

The CameraX callback thread becomes almost zero-cost, and capture rate returns to the hardware level. Frame-dropping policy moves to the consumer side, where business logic decides which frames to discard instead of letting the system silently swallow them. Which frames are worth keeping becomes your decision.

## GPU preprocessing: keep pixels on the GPU

CameraX gives `ImageProxy` in `YUV_420_888` format by default, while the model needs RGB input. If you use CPU-side `YuvImage` or RenderScript conversion, one 1080p frame costs 4-8 ms. Add resize and normalize, and it easily exceeds 10 ms.

I used an OpenGL ES fragment shader path: YUV-to-RGB conversion, resizing, and normalization all happen in one pass.

```glsl
vec3 yuv2rgb(vec3 yuv) {
    yuv.r = 1.164 * (yuv.r - 0.0625);
    yuv.g = yuv.g - 0.5;
    yuv.b = yuv.b - 0.5;
    float r = yuv.r + 1.596 * yuv.b;
    float g = yuv.r - 0.392 * yuv.g - 0.813 * yuv.b;
    float b = yuv.r + 2.017 * yuv.g;
    return vec3(r, g, b) / 255.0;  // Normalize directly
}
```

Upload the Y plane as `GL_LUMINANCE` and the UV plane as `GL_LUMINANCE_ALPHA`, using separate textures. The shader reads them through samplers, avoiding CPU-side plane splitting and pixel stitching.

After rendering into an FBO-bound texture, the GPU texture handle can be fed directly to LiteRT's GPU Delegate. No CPU readback, no cross-process copy. In measurement, 1080p preprocessing dropped from 8 ms to 1.5 ms.

## Controlling LiteRT inference jitter

Once the model was running, the hardest part was latency jitter. The same segmentation model fluctuated between 15 ms and 40 ms per inference, nearly a 3x range. There were two reasons.

**Dynamic GPU frequency scaling.** When an Adreno GPU is idle, it downclocks. After an inference task is submitted, it may need 2-5 ms to climb back to a higher frequency. Warmup solves the first-frame problem:

```kotlin
interpreter.run(dummyInput, dummyOutput)  // Raise GPU frequency
// Wait 1-2 ms for frequency to stabilize before entering the real inference loop
```

But warmup only fixes first-frame jitter. Runtime load variation is harder: the system scheduler can hand CPU cores to other threads at any time, and when the inference thread is preempted, latency spikes.

One lesson from debugging: I first used synchronous `Interpreter.run()`, and when the inference thread was blocked, the whole pipeline stopped. Switching to `runAsync()` with a listener fixed that:

```kotlin
interpreter.runAsync(inputBuffer, outputBuffer)
    .addListener({ renderCallback(outputBuffer) }, gpuExecutor)
```

After inference submission, the thread is released immediately. The GPU notifies the listener when results are ready. P99 latency dropped from 42 ms to 28 ms, and frame-processing variation narrowed from +/-35% to +/-12%.

## Three-stage pipeline orchestration

When the three stages are connected, the core structure is a three-slot ring buffer with frame IDs:

```
[Capture thread] -> Slot 0 -> [GL thread] -> Slot 1 -> [Inference thread] -> Slot 2 -> [Render]
```

Each slot stores only a texture handle and frame ID, not pixel data. The key expiration check happens on the render side. If the inference result's frame ID is too far behind the current display frame ID, discard it; rendering it would make the image jump backward.

```kotlin
class FramePipeline(private val maxLag: Int = 2) {
    @Synchronized
    fun shouldRender(inferId: Long, displayId: Long): Boolean {
        return displayId - inferId <= maxLag
    }
}
```

`maxLag = 2` was an empirical value tuned on Snapdragon 8 Gen 2. If it is too large, the view feels delayed. If it is too small, frames are dropped too often.

With this design, a 1080p/30 fps portrait segmentation pipeline stayed under 35 ms end-to-end latency, with frame loss below 2%. The core idea is simple: split the serial path into a pipeline, let each stage run independently, and hand work off asynchronously. For real-time Android on-device AI, remember three rules: keep pixels on the GPU, make the CameraX callback enqueue only, and use async inference plus frame IDs for expiration checks instead of relying on timestamps alone.
