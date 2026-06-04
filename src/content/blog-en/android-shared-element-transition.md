---
title: "Android Shared Element Transitions: ActivityOptions to Compose SharedTransitionScope"
lang: en
translationKey: android-shared-element-transition
slug: android-shared-element-transition
excerpt: "A practical guide to Android shared element transitions, covering ActivityOptions, Snapshot and GhostView, Compose SharedTransitionScope, pitfalls, and migration."
publishDate: '2025-10-07'
tags:
- "Android"
- "Jetpack Compose"
- "Animation"
- "SharedTransitionScope"
- "Performance Optimization"
seo:
  title: "Android Shared Element Transitions: ActivityOptions and Compose"
  description: "Compare Android View shared element transitions with Compose SharedTransitionScope, including snapshots, GhostView, RenderNode animation, and migration."
  pageType: article
---

I once hit a strange bug while implementing a shared element transition. Passing an ImageView between two activities looked perfectly smooth on Pixel devices, but on one vendor's low-end phone it flashed to a white screen. The root cause was that the vendor ROM had changed the timing of Window animation frame submission. The transition started before the shared element snapshot had finished generating. To understand why that matters, we need to start from the internals of the View-system Transition API.

## View system: how ActivityOptions shared elements work

`ActivityOptions.makeSceneTransitionAnimation()` is the classic Android 5.0 API for passing shared elements between activities:

```kotlin
val options = ActivityOptions.makeSceneTransitionAnimation(
    this,
    Pair(imageView, "shared_image"),
    Pair(titleView, "shared_title")
).toBundle()
startActivity(intent, options)
```

Page B calls `Window.setSharedElementEnterTransition()` before `setContentView`. The system then performs three steps automatically: capture a screenshot of the shared element on page A, add it to the Window as an Overlay, animate its transform, and fade in the real View on page B. The flow looks simple, but the Framework does quite a bit. The core path has three phases.

**Snapshot phase**. The View on page A generates a Bitmap through `View.drawToBitmap()`. If the hierarchy contains a SurfaceView or TextureView, which is common in video playback, `drawToBitmap` can only capture a black image. Hardware-rendered content is not in the View Canvas drawing path, and there is no real workaround for that limitation.

**Ghost View phase**. The snapshot is wrapped as a **GhostView** and attached to the DecorView's ViewOverlay. GhostView does not participate in measure or layout. It only draws the Bitmap at a specified position during the draw phase. During the shared element animation, touch events are not delivered to GhostView because it is not part of the event-dispatch chain.

**Transition phase**. The Transition framework calculates matrix transforms between the start and end positions, usually scale plus translate, and drives property animations through `TransitionValues`. The actual animation runs on RenderThread. The main thread only submits Animator starting values and per-frame update callbacks.

The full call sequence looks like this:

```text
Activity A finish()  ->  Generate Snapshot  ->  Attach GhostView
    |
Activity B onCreate()  ->  setEnterTransition()
    |
Transition calculates matrix  ->  RenderThread runs animation  ->  Remove GhostView
```

## Snapshot timing and Window hierarchy

In practice, Snapshot timing is where most problems happen.

By default, Android triggers page A's `onPause()` immediately after `startActivity()`. But if page B uses `singleTop` and already exists in the stack, A's `onPause` may not be called immediately, so the Snapshot is delayed. The result is a half-second pause after tapping, followed by a direct jump with no animation.

`setExitSharedElementCallback` is another common source of mistakes. The callback can intercept Snapshot generation:

```kotlin
setExitSharedElementCallback(object : SharedElementCallback() {
    override fun onSharedElementEnd(
        names: List<String>,
        elements: List<View>,
        snapshots: List<View>
    ) {
        // Manually clean up resources here.
    }
})
```

When the shared element comes from a RecyclerView item, the View may already have been recycled by the time `onSharedElementStart` fires, and `isAttachedToWindow` may be `false`. In that state, `drawToBitmap` can return a transparent image. The fix is to call `View.setTransitionName(null)` in the Adapter's `onViewRecycled` method so the Transition framework knows to skip that View's snapshot.

## Compose: the declarative shift with SharedTransitionScope

The View-system shared element APIs are spread across Activity, Window, and Fragment layers. Lifecycle management depends on callbacks, and mistakes rarely produce compile-time warnings. Compose 1.7 introduced **SharedTransitionScope**, which redesigns this mechanism declaratively. It does not depend on Activity boundaries. Inside the Compose render tree, you mark nodes in the same or different Composition trees with the `sharedElement()` modifier, and the runtime calculates the transition automatically.

```kotlin
SharedTransitionScope {
    var showDetail by remember { mutableStateOf(false) }

    AnimatedContent(showDetail) { target ->
        when (target) {
            true -> DetailScreen(Modifier.sharedElement(
                state = rememberSharedContentState(key = "hero"),
                animatedVisibilityScope = this
            ))
            false -> ListScreen(Modifier.sharedElement(
                state = rememberSharedContentState(key = "hero"),
                animatedVisibilityScope = this
            ))
        }
    }
}
```

Unlike the View system, this does not pass a `transitionName` string. It uses a shared `SharedContentState` object. That State stores the source and target position, size, and alpha. When `AnimatedContent` triggers recomposition and switches state, the Compose rendering engine interpolates properties between the two Composition nodes.

## The SharedTransitionScope rendering pipeline

Compose shared element animation completely bypasses the View-system GhostView mechanism:

1. A Compose `LayoutNode` records the shared element's source position and size during measurement.
2. When the target `LayoutNode` appears, the `sharedElement()` modifier intercepts the measurement result and calculates the matrix transform.
3. The animation is applied directly at the Compose **RenderNode** layer, equivalent to RenderThread animation in the View system.

The key difference is that Compose does not need a Snapshot. Source and target pixel data are already in GPU caches, so the `drawToBitmap` step disappears. The SurfaceView black-image issue mentioned earlier is also avoided naturally if the shared element is an `Image` or content wrapped by a `Box`; the transition has effectively zero extra bitmap cost.

The real constraint is that **SharedTransitionScope only handles transitions inside Compose trees**. If page A is a View-system Activity and page B is Compose, there is currently no official cross-system shared element solution. My workaround is to manually capture a Bitmap on page A and simulate the transition with `graphicsLayer` at the Compose entry of page B. The result can get close to native behavior, but it adds maintenance cost.

## Choosing between the two systems

| Dimension | View system | Compose SharedTransitionScope |
|------|----------|------|
| Runtime scope | Between Activity/Fragment screens | Inside Compose trees or across Compositions |
| Mechanism | GhostView + Snapshot | RenderNode property interpolation |
| SurfaceView compatibility | Requires manual handling | Not involved because there is no Snapshot step |
| Lifecycle management | Callbacks plus manual cleanup | Managed automatically by Compose |
| Debugging difficulty | Hard to trace | Observable in Layout Inspector |

In pure Compose projects, SharedTransitionScope is the better option. In existing projects that mix View and Compose, `ActivityOptions` will remain the main cross-Activity tool for a while. A practical compromise is to use Compose plus `AnimatedContent` for in-page transitions on new screens, keep the View-system approach for cross-Activity shared elements, and migrate once Compose Navigation supports SharedTransitionScope transitions across destinations.

In real projects, I prefer `AnimatedContent` plus `sharedElement` over ViewPager plus Fragment transitions for Tab switching. Compose avoids the problem of synchronizing Fragment lifecycles. But for heavy View-based pages such as WebView or map SDK screens, do not force SharedTransitionScope onto them. Those Views are not rendered inside the Compose pipeline, so the transition will either drop frames or not run as expected.

## Practical toolbox

**Debugging shared element animation**. In the View system, enable "Show layout bounds" and set "Transition animation scale" to 10x in Developer Options. This makes the GhostView drawing area and animation duration visible. In Compose, use Layout Inspector to inspect property changes on nodes that carry the `sharedElement` modifier.

**Avoiding Snapshot failure**. In the View system, make sure the shared element View is still attached when `onSharedElementStart` fires. In list scenarios, clear `transitionName` in `onViewRecycled`.

**Gradual migration strategy**. In existing projects, start by trying SharedTransitionScope inside Compose subpages such as Dialogs, BottomSheets, or Tabs. After validating animation quality and performance, expand it into main flows. Avoid rewriting every Activity transition at once. Keeping a fallback path makes debugging much easier.
