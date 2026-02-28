---
title: "Android 渲染机制与图形栈深入理解（2）：View 树遍历：performTraversals() 的三大乐章"
excerpt: "「Android 渲染机制与图形栈深入理解」系列第 2/4 篇：View 树遍历：performTraversals() 的三大乐章"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 渲染
  - 图形栈
  - 性能优化
series:
  name: "Android 渲染机制与图形栈深入理解"
  part: 2
  total: 4
seo:
  title: "Android 渲染机制与图形栈深入理解（2）：View 树遍历：performTraversals() 的三大乐章"
  description: "「Android 渲染机制与图形栈深入理解」系列第 2/4 篇：View 树遍历：performTraversals() 的三大乐章"
---
# Android 渲染机制与图形栈深入理解（2）：View 树遍历：performTraversals() 的三大乐章

> 本文是「Android 渲染机制与图形栈深入理解」系列的第 2 篇，共 4 篇。在上一篇中，我们探讨了「引言：打造流畅体验的基石」的相关内容。

## 三、View 树遍历：performTraversals() 的三大乐章

`performTraversals()` 是 ViewRootImpl 中一个极其核心且复杂的方法，它按照 Measure → Layout → Draw 的顺序，驱动整个 View 层级树完成一帧的渲染准备工作。只有在必要时（例如尺寸改变或被标记为 dirty），相应的阶段才会被执行。

### 1. Measure（测量阶段）

`performMeasure()` → `View.measure()`

- **目标：** 确定每个 View 和 ViewGroup 需要占据多大的空间（计算 `mMeasuredWidth` 和 `mMeasuredHeight`）。
- **过程：** 这是一个**自顶向下**的递归过程。父 ViewGroup 根据自身的尺寸约束和子 View 的 LayoutParams，计算出传递给子 View 的 MeasureSpec。子 View 在 `onMeasure()` 方法中，根据收到的 MeasureSpec 和自身的内容（文本长度、图片尺寸等），计算出自己期望的尺寸，并通过 `setMeasuredDimension()` 存储结果。
- **MeasureSpec：** 一个 32 位整数，高 2 位代表模式（Mode），低 30 位代表尺寸（Size）。
  - **Mode：**
    - `MeasureSpec.EXACTLY`：父 View 指定了精确尺寸（如 `match_parent` 或固定 dp 值），子 View 必须使用这个尺寸
    - `MeasureSpec.AT_MOST`：父 View 指定了一个最大可用尺寸（如 `wrap_content` 在有边界的父容器中），子 View 不能超过这个尺寸，通常会根据内容计算出实际需要的尺寸
    - `MeasureSpec.UNSPECIFIED`：父 View 对子 View 尺寸没有限制（常用于 ScrollView 等），子 View 可以根据需要任意大
  - 理解 MeasureSpec 的生成和传递是优化自定义布局的关键。
- **性能考量：** Measure 过程可能涉及多次递归遍历（尤其在 `wrap_content` 和复杂依赖关系下），是常见的性能瓶颈。避免在 `onMeasure` 中进行耗时操作，一个布局可能会触发多次测量。

### 2. Layout（布局阶段）

`performLayout()` → `View.layout()` & `ViewGroup.onLayout()`

- **目标：** 确定每个 View 和 ViewGroup 在其父容器中的最终位置（计算 `mLeft`、`mTop`、`mRight`、`mBottom`）。此阶段在 Measure 完成后进行。
- **过程：** 同样是**自顶向下**的递归过程。父 ViewGroup 在 `onLayout()` 方法中，根据自身的尺寸和所有子 View 测量好的尺寸，调用每个子 View 的 `layout(l, t, r, b)` 方法，将其放置在计算好的位置上。子 View 在 `layout()` 方法中保存自己的位置信息，并可能触发自身的 `onLayout`（如果它也是 ViewGroup）。
- **性能考量：** 通常比 Measure 快，但也涉及递归遍历。只有在 View 尺寸或位置需要改变时才执行，避免在 `onLayout` 中做复杂计算。

### 3. Draw（绘制阶段）

`performDraw()` → `View.draw()` & `ViewGroup.dispatchDraw()`

- **目标：** 将 View 层级树的内容实际渲染到目标绘图表面（Canvas）上。此阶段在 Layout 完成后进行。
- **过程：**
  1. 绘制背景（drawBackground）
  2. 如果需要，保存 Canvas 图层（saveLayer）
  3. 绘制 View 自身内容（onDraw）
  4. 绘制子 View（dispatchDraw）——ViewGroup 会遍历子 View 并调用其 `draw()` 方法。绘制顺序通常是 XML 中定义的顺序，但可以通过 `childDrawingOrder` 或 Z 轴平移（translationZ）改变
  5. 绘制装饰（如滚动条、前景 onDrawForeground）
  6. 如果之前保存了图层，则恢复图层
- **Canvas API：** 提供了各种绘图命令（`drawRect`、`drawBitmap`、`drawText` 等）。在**软件渲染**模式下，这些命令直接在 CPU 上操作 Bitmap。
- **硬件加速下的变化：** 当硬件加速启用时，Canvas 对象的实现会变为 DisplayListCanvas（或类似的名称），`draw()` 方法的核心逻辑不再是直接绘制像素，而是将绘图命令**记录**到 DisplayList/RenderNode 中。

---

## 四、硬件加速：释放 GPU 的力量

从 Android 3.0（API 11）开始引入，并在 Android 4.0（API 14）默认开启，硬件加速极大地提升了 Android 的渲染性能。

### 1. 核心思想

将大部分图形绘制操作从 CPU 转移到 GPU 执行，GPU 擅长并行处理大量的图形计算。

### 2. DisplayList / RenderNode

- **机制：** 在 Draw 阶段，当硬件加速开启时，`View.draw()` 方法中的 Canvas 绘图命令（如 `drawRect`、`drawPath`）不再直接作用于像素缓冲区，而是被记录到一个与该 View 关联的 **RenderNode**（早期版本称为 DisplayList）对象中。这个记录过程本身在 UI 线程上进行，但相对轻量。
- **内容：** RenderNode 捕获了 View 的绘制内容、变换（平移、旋转、缩放）、透明度、裁剪等属性和绘制命令序列。它是一个绘制操作的「配方」，而不是最终的像素结果。
- **更新：** 当 View 的内容或属性改变并调用 `invalidate()` 时，只需要更新该 View 对应的 RenderNode 即可，无需重新绘制整个窗口，大大提高了效率。

### 3. RenderThread（渲染线程）

- **引入：** 为了避免 UI 线程被 GPU 驱动调用阻塞（GPU 操作可能是异步的，但驱动调用可能同步等待），Android 引入了一个**进程内**的独立线程——RenderThread。
- **职责：**
  - 接收 UI 线程同步过来的 RenderNode 树的最新状态
  - 将 RenderNode 记录的绘制命令（这是一个抽象的、平台无关的表示）转换为底层的图形 API 调用（OpenGL ES 或 Vulkan）
  - 通过 **HWUI** 库将这些图形命令提交给 GPU 驱动执行
- **解耦：** RenderThread 的存在，使得 UI 线程可以在记录完绘制命令后继续响应用户输入和处理其他逻辑，而 GPU 的实际绘制工作则在 RenderThread 上异步进行（虽然也需要同步点），提高了 UI 的响应性。

### 4. HWUI（Hardware UI）库

- **角色：** 作为 Android 框架与底层图形驱动（OpenGL ES / Vulkan）之间的抽象层。
- **功能：** 管理 GPU 资源（纹理、缓冲区）、处理着色器（Shader）、将 RenderNode 的抽象命令转换为具体的 GPU 指令、优化渲染状态切换等。

### 5. 同步与绘制流程（硬件加速）

1. UI 线程完成 Measure、Layout、Draw（记录 RenderNode）
2. ViewRootImpl 在 `performTraversals` 结束时，会请求进行同步（`syncAndDrawFrame`）
3. UI 线程将更新后的 RenderNode 树信息同步给 RenderThread（这是一个关键的同步点，可能需要等待 RenderThread 完成上一帧的部分工作）
4. RenderThread 接收到更新后的 RenderNode 树
5. RenderThread 遍历 RenderNode 树，通过 HWUI 将绘制命令转换为 OpenGL/Vulkan 指令
6. RenderThread 将指令提交给 GPU 驱动
7. GPU 执行指令，将结果渲染到图形缓冲区（Graphic Buffer）

**（图示：硬件加速渲染流程）**

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

> 下一篇我们将探讨「从 GPU 到屏幕：缓冲区、合成与 SurfaceFlinger」，敬请关注本系列。

**「Android 渲染机制与图形栈深入理解」系列目录**

1. 引言：打造流畅体验的基石
2. **View 树遍历：performTraversals() 的三大乐章**（本文）
3. 从 GPU 到屏幕：缓冲区、合成与 SurfaceFlinger
4. 特殊视图辨析：SurfaceView vs TextureView vs SurfaceControlViewHost
