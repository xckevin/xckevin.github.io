---
title: 深入 Android View 拖放系统全链路：从 DragShadowBuilder 渲染到跨窗口 ClipData 传输
slug: android-view-drag-drop-system
translationKey: android-view-drag-drop-system
excerpt: 深入分析 Android 拖放系统底层实现，从 startDragAndDrop 启动链路、DragEvent 分发路径、DragShadow 独立渲染层，到跨窗口 ClipData 的 Binder 传输机制，以及与 RecyclerView、Compose 的衔接实践。
publishDate: '2026-06-11'
tags:
- Android
- 拖放系统
- DragShadowBuilder
- ClipData
- WindowManager
seo:
  title: 深入 Android View 拖放系统全链路：从 DragShadowBuilder 渲染到跨窗口 ClipData 传输
  description: 深入分析 Android 拖放系统底层实现，涵盖 DragShadowBuilder 独立渲染层、DragEvent 分发路径、跨窗口 ClipData 传输机制，以及与 RecyclerView 和 Compose 的衔接实践。
---

在做跨窗口拖放图片时，遇到了一个诡异现象：同 Activity 内拖放一切正常，手指拖到另一个窗口上方后 DragShadow 直接消失，ClipData 也拿不到了。查了半天发现是目标窗口的 WindowManager flags 没设对。顺着这个问题翻了一遍源码，把拖放系统的全链路摸清楚了。

## `startDragAndDrop` 的启动链路

`View.startDragAndDrop()` 的内部调用链比表面看起来长不少。

```java
public final boolean startDragAndDrop(ClipData data, DragShadowBuilder shadowBuilder,
        Object myLocalState, int flags) {
    View.DragShadowBuilder shadow = new View.DragShadowBuilder(this);
    try {
        return sCascadedDragDrop
                ? startDrag(this, shadowBuilder, data, flags)
                : false;
    } catch (Exception e) {
        Log.e(TAG, "Failed to start drag", e);
        return false;
    }
}
```

三个参数各自控制了一条路径：

- **DragShadowBuilder**：定义拖拽时跟随手指的视觉反馈，渲染在一个独立 Surface 上
- **ClipData**：实现 Parcelable 的跨进程数据载体，决定目标窗口能拿到什么
- **myLocalState**：同进程内的局部状态引用，跨窗口拖放时目标端拿不到这个字段

`startDrag` 内部创建 `ACTION_DRAG_STARTED` 事件，通过 `ViewRootImpl` 上报到 WindowManagerService。WMS 收到后进入一个全局拖放状态机——同一时间只允许一个拖放操作。如果在拖放过程中再调用 `startDragAndDrop`，第二次调用直接返回 false。

## DragEvent 的分发路径

DragEvent 的分发不经过 Activity 的 View 树层级。WMS 通过独立的 InputChannel 直接注入到对应窗口的 `ViewRootImpl`，然后走 `ViewGroup.dispatchDragEvent()` 向下分发。

这和普通触摸事件有本质区别——拖放事件和 `ACTION_DOWN/UP` 不在同一个 input channel 里。各阶段的生命周期：

- `ACTION_DRAG_STARTED`：拖放开始，所有可见窗口都会收到，系统借此"询问"哪个窗口愿意接收
- `ACTION_DRAG_ENTERED`：手指进入某个窗口的边界，跨窗口时坐标由 WMS 做全局映射
- `ACTION_DRAG_LOCATION`：拖拽过程中的位置更新，采样来源和普通 `ACTION_MOVE` 不是同一套
- `ACTION_DROP`：松手时发送给当前手指所在窗口
- `ACTION_DRAG_ENDED`：整个拖放结束，无论是否成功都会发出，源窗口在此清理临时状态

实际开发中容易忽略的是：`ACTION_DRAG_STARTED` 返回 true 才表示愿意接收拖放，后续才会收到 `ENTERED`、`LOCATION` 和 `DROP`。返回 false 的窗口会被完全排除在拖放目标之外。

## DragShadow 的独立渲染层

DragShadowBuilder 最常用的回调是 `onProvideShadowMetrics` 和 `onDrawShadow`。一个常见的直觉是 Shadow 画在源窗口上做 overlay，实际上不是。

WMS 在 Display 最顶层创建了一个临时 Surface，z-order 高于所有应用窗口。DragShadow 直接画在这个 Surface 上，跟随手指坐标移动。

```kotlin
class ScaledDragShadow(view: View, private val scale: Float = 1.2f) : View.DragShadowBuilder(view) {
    override fun onProvideShadowMetrics(outSize: Point, outTouchPoint: Point) {
        super.onProvideShadowMetrics(outSize, outTouchPoint)
        outTouchPoint.set(outSize.x / 2, outSize.y / 2)
    }

    override fun onDrawShadow(canvas: Canvas) {
        canvas.scale(scale, scale)
        super.onDrawShadow(canvas)
    }
}
```

这就是跨窗口时 Shadow 依然可见的原因——它根本不在源窗口的 drawing surface 上。但 WMS 是根据 Input 事件的采样频率来刷新这个 Surface 的，不走 Choreographer 的 VSYNC 同步。低端设备上如果 `onDrawShadow` 做了 clipPath 加 shadow layer 这类复杂绘制，拖放会有明显掉帧。

我踩过的一个坑：自定义 Shadow 时在 `onDrawShadow` 里用了 `canvas.concat(matrix)` 做旋转，结果在部分机型上 Shadow 会抖动。排查后发现 WMS 对 Shadow Surface 的合成时机在不同 GPU 上表现不一致，旋转矩阵和手指坐标的同步有微小偏差。

## 跨窗口的 ClipData 传输

跨窗口拖放的核心在于 ClipData 的序列化。`ClipData` 实现了 Parcelable，通过 Binder 在进程间传递。完整流程：

1. 源窗口调用 `startDragAndDrop` → WMS 记录全局拖放状态，持有 ClipData 引用
2. 手指移动到目标窗口上方 → WMS 计算坐标偏移量，向目标窗口的 `ViewRootImpl` 注入 `ACTION_DRAG_ENTERED`
3. 目标窗口通过 `event.getClipData()` 获取数据——`ENTERED` 和 `LOCATION` 里拿到的 ClipData 是同一个反序列化实例，不会每次重新传输
4. 松手时 WMS 发送 `ACTION_DROP`，目标消费数据后 WMS 向源窗口发 `ACTION_DRAG_ENDED`

跨窗口场景下 `myLocalState` 不可用。实践中如果需要在拖放过程中传递不经过序列化的中间状态，我的做法是用进程内单例 Map，key 用 ClipDescription 的 label：

```kotlin
object DragStateCache {
    private val cache = ConcurrentHashMap<String, Any>()

    fun put(label: String, state: Any) = cache.put(label, state)
    fun get(label: String): Any? = cache[label]
    fun remove(label: String) = cache.remove(label)
}
```

想让一个窗口接收外部拖放，`DecorView` 必须通过 WMS 的策略检查。一个常见坑：`FLAG_NOT_TOUCHABLE` 或 `FLAG_NOT_FOCUSABLE` 会让 WMS 拦截拖放事件，即使写了 `OnDragListener` 也收不到。

## 与 RecyclerView、Compose 的衔接

`ItemTouchHelper` 的拖拽排序和系统拖放完全是两套机制。`ItemTouchHelper` 走的是 `onTouchEvent` + Canvas 位移，根本没有碰 DragEvent。它的拖拽行为被锁死在 RecyclerView 内部。

要做跨控件拖放，必须在长按回调里手动桥接：

```kotlin
view.setOnLongClickListener {
    val clip = ClipData.newPlainText("id", item.id)
    val shadow = View.DragShadowBuilder(view)
    view.startDragAndDrop(clip, shadow, item, 0)
    true
}
```

Drop 端的接收逻辑：

```kotlin
targetView.setOnDragListener { _, event ->
    if (event.action == DragEvent.ACTION_DROP) {
        val id = event.clipData.getItemAt(0).text.toString()
        handleDrop(id)
    }
    true // 必须在 DRAG_STARTED 时返回 true
}
```

Compose 这边的 API 封装了底层调用，逻辑层更干净。`Modifier.dragAndDropSource` 和 `Modifier.dragAndDropTarget` 提供了声明式接口：

```kotlin
Modifier.dragAndDropSource {
    detectTapGestures(
        onLongPress = {
            startTransfer(DragAndDropTransferData(
                clipData = ClipData.newPlainText("key", value)
            ))
        }
    )
}

Modifier.dragAndDropTarget {
    shouldStartDragAndDrop { it.clipData.description.label == "key" }
    target {
        val event = awaitDragAndDropEvent()
        if (event is DragAndDropEvent.Drop) {
            val text = event.clipData.getItemAt(0).text
            // 处理 drop
        }
    }
}
```

`awaitDragAndDropEvent` 是 suspend 函数，在 PointerInput 协程里分发。如果在回调里做了耗时操作会阻塞手势，需要把业务逻辑 launch 到独立协程。Android 12+ 上 `DRAG_FLAG_GLOBAL` 可以跨 Activity 拖放，但跨应用仍然受限于目标窗口是否声明了匹配的 `MIME_TYPE`。

拖放系统的底层实现不复杂——核心是一个全局状态机、一个独立的输入通道、一块临时 Surface。真正花时间的，是搞清楚 WMS 里那些 flag 和 policy 的交互规则。把这些基础件理清楚后，所有业务需求都是这几个原语的组合。
