---
title: "Android Rendering and the Graphics Stack (3): From GPU to Screen"
lang: en
translationKey: android-rendering-graphics-stack-part3
slug: android-rendering-graphics-stack-part3
excerpt: "Part 3 of the Android Rendering and Graphics Stack series: Graphic Buffer, BufferQueue, Surface, SurfaceFlinger, HWC, and multi-buffering."
publishDate: 2025-06-19
displayInBlog: false
tags:
- "Android"
- "Rendering"
- "Graphics Stack"
- "Performance Optimization"
series:
  name: "Android Rendering and the Graphics Stack"
  part: 3
  total: 4
seo:
  title: "Android Rendering Part 3: BufferQueue, SurfaceFlinger, HWC, and Multi-Buffering"
  description: "Follow Android rendering after GPU rasterization through Graphic Buffer, BufferQueue, Surface, SurfaceFlinger composition, HWC, and buffering."
  pageType: article
---
> This is part 3 of the Android Rendering and Graphics Stack series, a four-part series. The previous article covered "View tree traversal: the three movements of performTraversals()."

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

---

> The next article explores "Special View types: SurfaceView vs TextureView vs SurfaceControlViewHost."

**Android Rendering and the Graphics Stack series**

1. Building the Foundation for Smooth UI
2. View tree traversal: the three movements of performTraversals()
3. **From GPU to screen: buffers, composition, and SurfaceFlinger** (this article)
4. Special View types: SurfaceView vs TextureView vs SurfaceControlViewHost
