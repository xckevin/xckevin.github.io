---
title: "Android Rendering and the Graphics Stack: A Deep Dive"
lang: en
translationKey: android-rendering-graphics-stack
slug: android-rendering-graphics-stack
excerpt: "A full walkthrough of Android rendering, from View invalidation, Choreographer, and RenderThread to BufferQueue, SurfaceFlinger, jank diagnosis, and optimization."
publishDate: 2025-06-19
tags:
- "Android"
- "Rendering"
- "Graphics Stack"
- "Performance Optimization"
seo:
  title: "Android Rendering and Graphics Stack: View, HWUI, and SurfaceFlinger"
  description: "Trace Android rendering from View traversal and HWUI hardware acceleration to BufferQueue, SurfaceFlinger composition, jank analysis, and tuning."
  pageType: article
---
## Introduction: The foundation of a smooth experience

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

## 3. View tree traversal: the three movements of performTraversals()

`performTraversals()` is one of the most important and complex methods in ViewRootImpl. It drives one frame of rendering preparation for the whole View hierarchy in the order Measure -> Layout -> Draw. Each phase only runs when needed, such as when size changes or a View is marked dirty.

### 3.1 Measure

`performMeasure()` -> `View.measure()`

- **Goal:** determine how much space each View and ViewGroup needs, producing `mMeasuredWidth` and `mMeasuredHeight`.
- **Process:** this is a **top-down** recursive process. A parent ViewGroup uses its own size constraints and the child's LayoutParams to compute the MeasureSpec passed to each child. In `onMeasure()`, the child uses that MeasureSpec and its own content, such as text length or image size, to calculate its desired size, then stores the result with `setMeasuredDimension()`.
- **MeasureSpec:** a 32-bit integer. The upper 2 bits represent the mode, and the lower 30 bits represent the size.
  - **Mode:**
    - `MeasureSpec.EXACTLY`: the parent specifies an exact size, such as `match_parent` or a fixed dp value, and the child must use that size
    - `MeasureSpec.AT_MOST`: the parent specifies a maximum available size, such as `wrap_content` inside a bounded parent, and the child cannot exceed it. The child usually computes the actual required size from its content
    - `MeasureSpec.UNSPECIFIED`: the parent places no limit on the child's size, common in containers such as ScrollView, so the child can be as large as needed
  - Understanding how MeasureSpec is generated and propagated is essential for optimizing custom layouts.
- **Performance considerations:** measurement can involve multiple recursive passes, especially with `wrap_content` and complex dependencies, so it is a common performance bottleneck. Avoid expensive work in `onMeasure`; a single layout may be measured more than once.

### 3.2 Layout

`performLayout()` -> `View.layout()` and `ViewGroup.onLayout()`

- **Goal:** determine the final position of each View and ViewGroup inside its parent, producing `mLeft`, `mTop`, `mRight`, and `mBottom`. This phase runs after measurement completes.
- **Process:** this is also a **top-down** recursive process. In `onLayout()`, the parent ViewGroup uses its own size and all measured child sizes to call each child's `layout(l, t, r, b)` method and place it at the computed position. A child stores its own position in `layout()`, and may trigger its own `onLayout` if it is also a ViewGroup.
- **Performance considerations:** layout is usually faster than measurement, but still traverses recursively. It should only run when a View's size or position needs to change. Avoid complex computation in `onLayout`.

### 3.3 Draw

`performDraw()` -> `View.draw()` and `ViewGroup.dispatchDraw()`

- **Goal:** render the contents of the View hierarchy onto the target drawing surface, or Canvas. This phase runs after layout completes.
- **Process:**
  1. Draw the background (`drawBackground`)
  2. Save a Canvas layer if needed (`saveLayer`)
  3. Draw the View's own content (`onDraw`)
  4. Draw child Views (`dispatchDraw`). ViewGroup traverses its children and calls each child's `draw()` method. The drawing order is usually the XML declaration order, but it can be changed with `childDrawingOrder` or Z-axis translation (`translationZ`)
  5. Draw decorations, such as scrollbars and foreground content through `onDrawForeground`
  6. Restore the layer if one was saved
- **Canvas API:** provides drawing commands such as `drawRect`, `drawBitmap`, and `drawText`. In **software rendering**, these commands operate directly on a Bitmap on the CPU.
- **What changes with hardware acceleration:** when hardware acceleration is enabled, the Canvas implementation becomes DisplayListCanvas or a similar implementation. The core behavior of `draw()` is no longer direct pixel drawing. Instead, drawing commands are **recorded** into a DisplayList/RenderNode.

---

## 4. Hardware acceleration: unlocking the GPU

Hardware acceleration was introduced in Android 3.0 (API 11) and became enabled by default in Android 4.0 (API 14). It significantly improved Android rendering performance.

### 4.1 Core idea

Move most graphics drawing operations from the CPU to the GPU. GPUs are good at parallel graphics computation at large scale.

### 4.2 DisplayList / RenderNode

- **Mechanism:** during Draw, when hardware acceleration is enabled, Canvas drawing commands inside `View.draw()`, such as `drawRect` and `drawPath`, no longer write directly to the pixel buffer. Instead, they are recorded into the **RenderNode** associated with that View. In earlier Android versions, this was called a DisplayList. This recording step runs on the UI thread, but is relatively lightweight.
- **Content:** RenderNode captures the View's drawing content, transforms such as translation, rotation, and scale, alpha, clipping, and the sequence of drawing commands. It is a recipe for drawing operations, not the final pixels.
- **Updates:** when a View's content or properties change and `invalidate()` is called, only that View's RenderNode needs to be updated. The entire window does not need to be redrawn, which greatly improves efficiency.

### 4.3 RenderThread

- **Why it exists:** to avoid blocking the UI thread on GPU driver calls. GPU operations may be asynchronous, but driver calls can still synchronously wait. Android therefore introduced an independent **in-process** thread called RenderThread.
- **Responsibilities:**
  - Receive the latest RenderNode tree state synchronized from the UI thread
  - Convert the drawing commands recorded in RenderNode, an abstract and platform-independent representation, into low-level graphics API calls such as OpenGL ES or Vulkan
  - Submit those graphics commands to the GPU driver through the **HWUI** library
- **Decoupling:** RenderThread lets the UI thread continue responding to input and running other logic after it records drawing commands, while the actual GPU drawing work proceeds asynchronously on RenderThread, even though synchronization points still exist. This improves UI responsiveness.

### 4.4 HWUI library

- **Role:** HWUI is the abstraction layer between the Android framework and low-level graphics drivers such as OpenGL ES and Vulkan.
- **Functions:** manages GPU resources such as textures and buffers, handles shaders, converts RenderNode's abstract commands into concrete GPU instructions, and optimizes rendering state changes.

### 4.5 Synchronization and drawing flow with hardware acceleration

1. The UI thread completes Measure, Layout, and Draw, recording RenderNodes
2. At the end of `performTraversals`, ViewRootImpl requests synchronization through `syncAndDrawFrame`
3. The UI thread synchronizes the updated RenderNode tree to RenderThread. This is a key synchronization point and may wait for RenderThread to finish part of the previous frame's work
4. RenderThread receives the updated RenderNode tree
5. RenderThread traverses the RenderNode tree and uses HWUI to convert drawing commands into OpenGL/Vulkan instructions
6. RenderThread submits the instructions to the GPU driver
7. The GPU executes the instructions and renders the result into a graphic buffer

**Diagram: hardware-accelerated rendering flow**

```plain
+---------------------------------+     Sync Data     +---------------------------------+
|          UI Thread              |-----------------> |          RenderThread           |
|---------------------------------|                   |---------------------------------|
| 1. performTraversals()          |                   |                                 |
|    - performMeasure()           |                   |                                 |
|    - performLayout()            |                   |                                 |
|    - performDraw()              |                   |                                 |
|      (Record RenderNodes)       |                   | 4. Receive RenderNode Tree Update|
|                                 |                   |                                 |
| 2. syncAndDrawFrame() Request   |                   | 5. Traverse RenderNode Tree     |
|    (Waits for RenderThread ready)|                   |    via HWUI -> Generate GPU Cmds|
|                                 |                   |                                 |
| 3. Synchronize RenderNode Data  |                   | 6. Issue Commands to GPU Driver |
+---------------------------------+                   +-----------------+---------------+
                                                                          |
                                                                          | To GPU
                                                                          V
                                                                   +-----------+
                                                                   |    GPU    |
                                                                   +-----------+
                                                                          | Renders to
                                                                          V
                                                                  Graphic Buffer
```

---

## 5. From GPU to screen: buffers, composition, and SurfaceFlinger

After the GPU finishes rendering, the pixel data still has to pass through several steps before it appears on screen.

### 5.1 Graphic Buffer

The GPU writes its rendering result into a memory buffer. This memory is usually allocated and managed through the Gralloc HAL, or Graphics Allocator HAL, to ensure efficient memory access. In some cases it may live directly in GPU-accessible memory.

### 5.2 BufferQueue: the buffer pipeline

- **Mechanism:** BufferQueue is a synchronized queue used to pass graphic buffers between a graphics data producer and consumer. It usually contains multiple buffer slots, such as three slots for triple buffering.
- **Producer:** usually the app, represented by RenderThread/HWUI. It asks BufferQueue for an available buffer with `dequeueBuffer`, writes rendered content into it, and enqueues the filled buffer with `queueBuffer`.
- **Consumer:** usually **SurfaceFlinger**. It acquires filled buffers from BufferQueue with `acquireBuffer`, processes them through composition, and releases them back to the queue with `releaseBuffer` so the producer can reuse them.

### 5.3 Surface: the canvas proxy for an application window

When each application window is registered with WMS, WMS creates a SurfaceControl for it. That SurfaceControl contains a Surface object, which represents the producer side of BufferQueue. The Surface object is passed to the app process through Binder. The app, through RenderThread/HWUI, ultimately draws its rendering result into the buffers in the BufferQueue associated with that Surface.

### 5.4 SurfaceFlinger: the system-level graphics compositor

- **Role:** SurfaceFlinger is a system service running in a separate high-priority process named `surfaceflinger`. It is the final convergence point of the Android graphics stack.
- **Responsibilities:**
  - **Collect layers:** fetch the latest rendered graphic buffers, called layers, from all currently visible windows. Each window corresponds to a BufferQueue/Surface. System UI elements such as the status bar and navigation bar also have their own Surfaces.
  - **Composition:** compute how those layers combine into the final screen image. This includes position, Z order, alpha, rotation, clipping, and possible effects.
  - **Prefer hardware composition (HWC):** SurfaceFlinger first tries to use the **Hardware Composer (HWC) HAL**. HWC is an interface exposed by the display hardware driver that lets SurfaceFlinger tell the hardware to read multiple layer buffers directly and compose them without involving the GPU again. This is very efficient, especially for cases such as full-screen video playback.
  - **GPU composition fallback:** if layers are too complex, for example too many layers or unsupported transforms/effects, or if HWC does not support the case, SurfaceFlinger falls back to GPU composition through OpenGL ES. This increases GPU load.
  - **Submit to display:** submit the final composed frame buffer to the display hardware.
- **VSYNC synchronization:** SurfaceFlinger's composition work is also strictly driven by VSYNC. On each VSYNC cycle, it checks whether visible BufferQueues have new buffers ready, latches them with `latchBuffer`, composes, and submits.

### 5.5 Multi-buffering: double and triple buffering

- **Goal:** avoid stalls in the rendering pipeline by preventing the producer, the app, from waiting on the consumer, SurfaceFlinger, and vice versa.
- **Double buffering:** the app renders Buffer A and submits it to SurfaceFlinger. At the same time, the app starts rendering Buffer B. SurfaceFlinger composes and displays A. On the next frame, SurfaceFlinger composes and displays B while the app renders A. If either side finishes too quickly, it may need to wait for the other.
- **Triple buffering, which is more common:** the app renders A and submits it, renders B and submits it, then renders C. SurfaceFlinger composes A. On the next frame, SurfaceFlinger composes B, and the app can continue rendering A if A has been released by SurfaceFlinger. This provides more buffer space, reduces the chance of waiting, and improves throughput, at the cost of adding roughly one frame of latency.

**Diagram: BufferQueue and SurfaceFlinger composition flow**

```plain
+-------------------------------------+       +-------------------------------------+
|           App Process               |       |        SurfaceFlinger Process       |
|-------------------------------------|       |-------------------------------------|
|  RenderThread (Producer)            |       | SurfaceFlinger (Consumer)           |
|   1. dequeueBuffer() from BufferQueue|       |                                     |
|   2. Render frame into Buffer N     |       |                                     |
|   3. queueBuffer(N) to BufferQueue  | ----> |                                     |
|                                     |       |                                     |
|                                     |       | 4. on VSYNC:                        |
|           +-------------+           |       |    - latchBuffer(N) from BufferQueue|
|           | BufferQueue | <---------------- |    - Collect layers from all apps   |
|           | [B0][B1][B2]|           |       |                                     |
|           +-------------+           |       | 5. Composition:                     |
|               ^       |             |       |    - Try HWC HAL (Hardware)         |
|               |       | releaseBuffer |       |    - Fallback to GPU (OpenGL ES)  |
|               `---------------------`       |                                     |
|                                     |       | 6. Submit Frame Buffer to Display HAL|
+-------------------------------------+       +----------------------+--------------+
                                                                       |
                                                                       V
                                                             +-----------------+
                                                             | Display Panel   |
                                                             +-----------------+
```

---

## 6. Special View types: SurfaceView vs TextureView vs SurfaceControlViewHost

Standard Views draw onto the Activity window's Surface and participate in the unified View tree drawing flow. Some high-performance or specialized scenarios need a different mechanism.

### 6.1 SurfaceView

- **Mechanism:** SurfaceView creates an **independent window/Surface** in WMS. That Surface sits **below** its host Activity window. The View in the host window leaves a transparent hole so the independent Surface below can show through. The key point is that rendering into this independent Surface **does not pass through** the View tree's `draw()` flow. Instead, the developer controls it directly on a **separate thread**, usually a background thread, using OpenGL ES, Vulkan, `Canvas = Surface.lockCanvas()`, or content driven by frameworks such as MediaPlayer or Camera.
- **Advantages:**
  - **Highest performance:** rendering happens on an independent thread and completely bypasses the app UI thread bottleneck. Its independent Surface can be composed directly by SurfaceFlinger through HWC if the hardware supports it and there are no complex transforms, avoiding an extra GPU composition pass.
  - **Low latency:** content can reach SurfaceFlinger faster, making it suitable for video playback, camera preview, games, and other high-frame-rate, low-latency scenarios.
- **Disadvantages:**
  - **Hard View integration:** because it is effectively a separate window layer, it is difficult to translate, rotate, scale, fade, or animate like a normal View. SurfaceControl APIs can support some of this, but the work is more complex. Visually, it stays below the host View.
  - **Input event handling:** input event forwarding needs special handling.
  - **Animation synchronization:** synchronizing with animations in the View hierarchy can be difficult.

### 6.2 TextureView

- **Mechanism:** TextureView itself is a normal hardware-accelerated View. Internally it owns a SurfaceTexture. SurfaceTexture is a special OpenGL ES texture object that can receive image stream data from other threads, such as a video decoder thread or camera preview thread. When TextureView participates in the View tree's `draw()` flow, it draws the current SurfaceTexture content like a normal texture.
- **Advantages:**
  - **Behaves like a normal View:** it can move, rotate, scale, change alpha, and participate in View hierarchy animations. Integration and usage are simpler.
- **Disadvantages:**
  - **Performance cost:** compared with SurfaceView, it adds overhead. Content must first be uploaded into a GPU texture, then drawn as part of the View tree, and finally composed by SurfaceFlinger as part of the Activity's main window.
  - **Higher latency:** the data path is longer.
  - **Memory cost:** SurfaceTexture consumes GPU memory.
  - **Main-thread dependency:** while content can come from a background thread, TextureView's own drawing, which paints the texture, still happens through the UI/RenderThread pipeline and can be affected by main-thread jank.

### 6.3 SurfaceControlViewHost on Android R / API 30+

- **Mechanism:** this is a more modern option designed to combine SurfaceView-like performance with TextureView-like usability. It allows a SurfaceControl, a layer managed by SurfaceFlinger, to be embedded into a View hierarchy. The SurfaceControl can host content from another process, such as a video decoding service.
- **Advantages:** performance is close to SurfaceView because it is also an independent SurfaceFlinger layer, while it provides better View integration, can participate in some View animations and transforms, and supports cross-process Surface embedding.
- **Disadvantages:** the API is relatively new and more complex. SurfaceControl lifecycle management requires care.

### Choosing between them

- **Prioritize performance and low latency** for video, camera, or games: SurfaceView is usually the first choice, but you must accept its integration limits.
- **Need full View behavior** such as animation and transforms, and performance requirements are not extreme: TextureView is more convenient, but you must account for its overhead.
- **Need high-performance embedding, possibly cross-process:** consider SurfaceControlViewHost.

---

## 7. Performance diagnosis: catching rendering jank

Jank is the visible symptom of rendering performance problems. It means the app failed to finish rendering and submitting a frame on time, causing the image to pause or the animation to jump.

### 7.1 What jank really is

The app failed to prepare the next frame before the VSYNC signal arrived, so the previous frame stayed on screen for more than one VSYNC interval. For example, a frame that should have completed within 16 ms takes 20 ms, causing the previous image to remain for 33.3 ms.

### 7.2 Common causes

**UI thread overload:**

- **Slow Measure/Layout:** the View hierarchy is too complex or deeply nested; custom View `onMeasure`/`onLayout` is inefficient; `requestLayout` is triggered frequently
- **Slow Draw on CPU:** custom View `onDraw` is too complex, with too many drawing operations, object allocations, or expensive calculations; overdraw is severe
- **Other main-thread work:** file I/O, network requests, heavy computation, or complex business logic runs on the UI thread
- **GC pauses:** frequent garbage collection pauses the UI thread

**RenderThread overload:**

- **Too many or too complex drawing commands:** a very deep View hierarchy creates many RenderNodes; effects such as blur or shadows are complex; Path drawing or complex graphics rendering is expensive
- **Resource upload bottlenecks:** large texture or Bitmap uploads, or large vertex data uploads to the GPU
- **Shader compilation:** first use of a complex Shader can cause compilation jank

**GPU bottlenecks:**

- **Pixel fill-rate limit:** severe overdraw causes the same screen pixels to be drawn repeatedly
- **Insufficient GPU compute capacity:** the scene is too complex or Shader computation is too heavy

**CPU bottlenecks:**

- **CPU resource contention:** background threads or other system processes compete for CPU, preventing the UI thread or RenderThread from getting CPU time on schedule
- **CPU throttling:** device heat causes CPU frequency reduction

**Buffer swap latency:** system-level delays, such as SurfaceFlinger processing delay or BufferQueue issues.

### 7.3 Diagnostic tools

**Developer options -> Profile GPU Rendering:**

- Shows colored vertical bars on screen. Each bar represents one frame, and its height represents time spent.
- Different color segments represent different stages, such as Swap Buffers, Input Handling, Animation, Measure/Layout, Draw or Sync, Command Issue or Draw commands, Sync & Upload, and Misc.
- The green line represents the VSYNC interval, 16.6 ms. A bar higher than the green line indicates jank.
- **Advantage:** real-time and visual. It quickly identifies problematic frames and the rough bottleneck stage.
- **Limitation:** information is coarse and cannot point to specific code.

**Developer options -> Debug GPU Overdraw:**

- Uses colors to indicate how many times screen areas are drawn: blue for once, green for twice, light red for three times, and dark red for four times or more.
- **Goal:** minimize red areas and keep most areas blue or green.
- **Advantage:** visually locates overdraw-heavy areas.
- **Limitation:** only shows overdraw. It cannot explain jank caused by other reasons.

**Systrace / Perfetto through Android Studio Profiler or command-line tools:**

- **The ultimate tool:** records detailed system-level and app-level trace data.
- **Key signals:**
  - SurfaceFlinger track: inspect buffer latch time, composition cost (`performComposition`), and virtual display events
  - VSYNC-app and VSYNC-sf: inspect app and SurfaceFlinger VSYNC signals
  - App process -> UI Thread: inspect `Choreographer#doFrame` duration, including the detailed cost of `performTraversals` for Measure/Layout/Draw. Combine with CPU samples to identify expensive methods
  - App process -> RenderThread: inspect DrawFrame time and analyze GPU command preparation and submission cost
  - gfx or Graphics track: inspect BufferQueue state and buffer flow time
  - CPU Cores / Frequency / Scheduling: inspect CPU usage, contention, and throttling
  - Memory / GC Events: check whether GC activity coincides with jank
- **Analysis method:** find the frame corresponding to jank, usually an abnormally long `doFrame` or a long period where SurfaceFlinger receives no new buffer. Then inspect UI thread, RenderThread, CPU, memory, and related metrics in that window to identify the bottleneck.

---

## 8. Advanced optimization strategies

With an understanding of the rendering pipeline, you can apply deeper optimizations.

### 8.1 Aggressive layout optimization

- **Flatten the hierarchy:** prefer ConstraintLayout for complex layouts. Reduce nesting and use features such as Guideline, Barrier, Group, and Chain.
- **Reuse and lazy loading:** use `<merge>` and `<include>` to optimize layout reuse. Use ViewStub to lazy-load rarely used UI blocks.
- **Custom layout performance:** if you must implement a custom ViewGroup, understand MeasureSpec interactions deeply, avoid repeated measurement, and keep `onLayout` logic as simple as possible.

### 8.2 Efficient drawing

- **Reduce overdraw:** use transparent backgrounds such as `@android:color/transparent`, or remove unnecessary backgrounds with `android:background="@null"`. Use `canvas.clipRect()` to restrict drawing regions and avoid drawing areas that will be fully covered.
- **Optimize onDraw:**
  - **Avoid object allocation:** do not create Paint, Rect, Path, or similar objects in `onDraw`. Store them as fields or use a cache pool.
  - **Avoid expensive computation:** move complex calculations out of `onDraw`.
  - **Simplify drawing operations:** use simple commands such as `drawRect` instead of complex Paths when the visual result allows it. Cache complex drawing results into a Bitmap and redraw the Bitmap only when needed, while paying attention to memory.
- **RenderNode API on API 29+:** for complex custom drawing that needs very high performance, such as charts or animated backgrounds, you can operate RenderNode directly. This provides finer control over drawing and property animation, with lower overhead than the traditional `View.draw()` plus property animation combination, but it requires deeper graphics knowledge.

### 8.3 Async work and concurrency

- **Bitmap processing:** image loading, decoding, cropping, rounded corners, and similar work must run on background threads. Mature libraries such as Glide and Picasso are recommended.
- **Text precomputation:** complex text layout computation, such as StaticLayout, can be done ahead of time on a background thread.
- **Main-thread protection:** strictly avoid any expensive operation on the UI thread.

### 8.4 Resource and thread management

- **Background thread priority:** make sure background threads preparing UI-related data, such as data loading, are not set too low, but also avoid stealing CPU time from the UI thread or RenderThread.
- **Use hardware layers carefully** with `View.setLayerType(View.LAYER_TYPE_HARDWARE, null)`: a hardware layer draws a View into an offscreen buffer, or FBO, and then uses it as a texture in later drawing.
  - **Advantage:** if a View's content is complex but changes rarely, the layer can cache the drawing result and speed up later frames because only the texture needs to be drawn. It may also help with complex alpha animations or cases that require frequent pixel readback.
  - **Disadvantage:** creating and updating a hardware layer has fixed overhead, including extra GPU memory and drawing work. If the View content changes frequently, performance can get worse. It may also break rendering batching and increase overdraw. **Always validate with profiling. Do not overuse it.**

### 8.5 Use newer platform features

- **Compose:** Jetpack Compose has a rendering model different from the traditional View system, with its own layout and state management. Under the hood, it still renders through Android Canvas/RenderNode and HWUI, which uses Skia internally. It needs dedicated performance analysis and optimization techniques, such as understanding recomposition scope, using `derivedStateOf`, and optimizing Modifiers.
- **Track platform updates:** Android releases may introduce new rendering optimizations or APIs, such as rendering improvements in Android 12.

---

## 9. Conclusion: control the pixels, build smooth UI

Android rendering is a complex system spanning the app layer, framework layer, system services such as WMS and SurfaceFlinger, graphics libraries such as Skia and HWUI, hardware such as CPU, GPU, and Display Controller, and precise synchronization mechanisms such as Choreographer, VSYNC, and BufferQueue. From the call to `invalidate()` to the final pixel lighting up on screen, every step can become a performance bottleneck.

For Android developers, it is not enough to know how to build UI. You also need to see through the graphics stack, understand the principles and limits of hardware acceleration, know the essential differences between SurfaceView and TextureView, and use tools such as Systrace and Perfetto to locate rendering problems precisely. That depth is what lets you build extremely smooth, responsive user experiences and solve stubborn performance issues that basic debugging cannot explain.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [Android app startup metrics: cold start, first frame, TTID, and Perfetto analysis](/en/blog/android-startup-metrics/)
- [RecyclerView cache explained: four cache levels, reuse, and prefetch](/en/blog/android-recyclerview-four-level-cache/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/en/blog/android-bitmap-oom/)
<!-- /seo-internal-links -->
