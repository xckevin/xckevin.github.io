---
title: "Android Rendering and the Graphics Stack (2): View Traversal and Hardware Acceleration"
lang: en
translationKey: android-rendering-graphics-stack-part2
slug: android-rendering-graphics-stack-part2
excerpt: "Part 2 of the Android Rendering and Graphics Stack series: Measure, Layout, Draw, RenderNode recording, RenderThread, and HWUI."
publishDate: 2025-06-19
displayInBlog: false
tags:
- "Android"
- "Rendering"
- "Graphics Stack"
- "Performance Optimization"
series:
  name: "Android Rendering and the Graphics Stack"
  part: 2
  total: 4
seo:
  title: "Android Rendering Part 2: View Traversal, RenderNode, RenderThread, and HWUI"
  description: "Understand Android View traversal through Measure, Layout, and Draw, then follow hardware acceleration through RenderNode, RenderThread, and HWUI."
  pageType: article
---
> This is part 2 of the Android Rendering and Graphics Stack series, a four-part series. The previous article covered "Building the Foundation for Smooth UI."

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

---

> The next article explores "From GPU to screen: buffers, composition, and SurfaceFlinger."

**Android Rendering and the Graphics Stack series**

1. Building the Foundation for Smooth UI
2. **View tree traversal: the three movements of performTraversals()** (this article)
3. From GPU to screen: buffers, composition, and SurfaceFlinger
4. Special View types: SurfaceView vs TextureView vs SurfaceControlViewHost
