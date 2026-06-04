---
title: "Android Rendering and the Graphics Stack (1): Building the Foundation for Smooth UI"
lang: en
translationKey: android-rendering-graphics-stack-part1
slug: android-rendering-graphics-stack-part1
excerpt: "Part 1 of the Android Rendering and Graphics Stack series: how ViewRootImpl, Choreographer, and VSYNC turn UI updates into scheduled frame work."
publishDate: 2025-06-19
displayInBlog: false
tags:
- "Android"
- "Rendering"
- "Graphics Stack"
- "Performance Optimization"
series:
  name: "Android Rendering and the Graphics Stack"
  part: 1
  total: 4
seo:
  title: "Android Rendering and Graphics Stack Part 1: ViewRootImpl, Choreographer, and VSYNC"
  description: "Start the Android rendering pipeline with View invalidation, ViewRootImpl traversal scheduling, Choreographer frame callbacks, and VSYNC timing."
  pageType: article
---
> This is part 1 of the Android Rendering and Graphics Stack series, a four-part series.

## Introduction: Building the foundation for smooth UI

In mobile apps, perceived smoothness is central to user experience, and it depends heavily on UI rendering performance. Smooth list scrolling, fluid transition animations, and immediate touch feedback all rely on Android's complex and carefully synchronized rendering system. Modern apps aim to reach and sustain 60 fps, 90 fps, or even 120 fps.

For Android developers, knowing how to build UI with XML layouts or Compose is only the baseline. To diagnose difficult UI jank, push performance further, or make sound decisions about custom Views and UI architecture, you need to **understand the full rendering pipeline and graphics stack: from a View tree drawing request, through hardware acceleration, to final composition by SurfaceFlinger and display on screen**.

This article explores that pipeline in depth, with a focus on:

- **Starting point and bridge:** how UI update requests are triggered and what ViewRootImpl does
- **Frame pulse:** how Choreographer and VSYNC synchronize rendering
- **View tree traversal:** the core logic of Measure, Layout, and Draw
- **Hardware acceleration:** how DisplayList/RenderNode, RenderThread, and HWUI use the GPU
- **From GPU to screen:** BufferQueue, SurfaceFlinger composition, and multi-buffering
- **Special View types:** SurfaceView, TextureView, and SurfaceControlViewHost tradeoffs
- **Performance diagnosis:** common causes of jank and key tools such as Profile GPU Rendering and Systrace/Perfetto
- **Advanced optimization:** tactics for each stage of the rendering pipeline

---

## 1. Starting point: UI update requests and ViewRootImpl as the bridge

When the UI needs to change, such as after a data update, user interaction, or animation tick, the rendering flow is triggered.

### 1.1 Triggering rendering

- **invalidate():** requests a redraw of the View and its child Views. It marks the View as dirty, but drawing does not happen immediately. The work waits until the next rendering opportunity. It does not trigger measurement or layout.
- **requestLayout():** indicates that a View's size or bounds may have changed, so measurement and layout must run again. A redraw usually follows. This is a heavier operation.

### 1.2 ViewRootImpl: the bridge between the app and the system window

- **Core role:** every application window, whether it is an Activity, Dialog, or another window added through `WindowManager.addView`, has a corresponding ViewRootImpl instance. It is the key bridge between the View hierarchy managed by app code and the system window manager, WindowManagerService (WMS).
- **Main responsibilities:**
  - **Traversal scheduling:** receives `invalidate()` or `requestLayout()` requests and schedules View tree measurement, layout, and drawing at the right time, usually on the next VSYNC.
  - **Input event dispatch:** receives input events from WMS, such as touch and key events, and dispatches them down the View hierarchy to the target View.
  - **Communication with WMS:** interacts with WMS on behalf of the window, for example to request window size or position changes through `relayoutWindow`, report that drawing is complete, and handle Surface creation and destruction.
- **scheduleTraversals():** when `invalidate()` or `requestLayout()` is called, it eventually triggers `scheduleTraversals()` in ViewRootImpl. This method **does not** run traversal immediately. Instead, it registers work with Choreographer and asks it to run a full traversal (`performTraversals()`) on the next frame.

---

## 2. Frame pulse: Choreographer and VSYNC synchronization

To avoid tearing and produce smooth animation, Android rendering must stay aligned with the display refresh cadence.

### 2.1 VSYNC signal

- VSYNC is emitted by the display hardware, or Display Controller, when the display has finished refreshing one frame and is ready to receive the next one.
- A typical refresh rate is 60 Hz, which means a VSYNC signal arrives roughly every 16.67 ms. High-refresh-rate screens such as 90 Hz and 120 Hz have shorter intervals, about 11.1 ms and 8.3 ms.
- VSYNC is the core timing reference for the entire rendering pipeline.

### 2.2 Choreographer

- **Role:** Choreographer is the unified scheduler for rendering, animation, and input handling inside an Android app. It runs on the UI thread and listens for low-level VSYNC signals through DisplayEventReceiver.
- **doFrame(long frameTimeNanos):** when Choreographer receives a VSYNC signal, it runs `doFrame` on the UI thread. This method processes callbacks registered for the current frame in order:
  1. **Input handling (CALLBACK_INPUT):** handles pending input events
  2. **Animation update (CALLBACK_ANIMATION):** runs animation update logic, such as ValueAnimator, and computes the animation state for the current frame
  3. **Layout and draw traversal (CALLBACK_TRAVERSAL):** if a ViewRootImpl requested traversal through `scheduleTraversals()`, runs `performTraversals()` for Measure, Layout, and Draw
  4. **Commit (CALLBACK_COMMIT):** runs cleanup or confirmation work after drawing finishes
- **Synchronization mechanism:** ViewRootImpl registers a `CALLBACK_TRAVERSAL` callback with Choreographer through `scheduleTraversals()`. Choreographer aligns that callback, namely `performTraversals()`, with VSYNC so the app's UI updates can match the display refresh rate.

**Diagram: VSYNC and Choreographer scheduling**

```plain
Hardware         VSYNC Signal (e.g., every 16.6ms)
   |                 |                 |
   |                 |                 |
   V                 V                 V
+------------------------------------------------+  Kernel/HAL
|             DisplayEventReceiver               |
+------------------+-----------------------------+
                   | receives VSYNC notification
                   | posts to UI Thread Looper
                   V
+------------------------------------------------+  App UI Thread
|                  Choreographer                 |
|                     .doFrame()                 |
|                       |                        |
|                       +--> Process Input       | (CALLBACK_INPUT)
|                       |                        |
|                       +--> Update Animation    | (CALLBACK_ANIMATION)
|                       |                        |
|                       +--> Perform Traversals  | (CALLBACK_TRAVERSAL, if scheduled by ViewRootImpl)
|                       |      (Measure/Layout/Draw)
|                       |                        |
|                       +--> Commit              | (CALLBACK_COMMIT)
+------------------------------------------------+
```

---

---

> The next article explores "View tree traversal: the three movements of performTraversals()."

**Android Rendering and the Graphics Stack series**

1. **Building the Foundation for Smooth UI** (this article)
2. View tree traversal: the three movements of performTraversals()
3. From GPU to screen: buffers, composition, and SurfaceFlinger
4. Special View types: SurfaceView vs TextureView vs SurfaceControlViewHost
