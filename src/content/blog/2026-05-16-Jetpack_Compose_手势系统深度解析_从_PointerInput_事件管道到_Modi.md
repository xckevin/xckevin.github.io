---
slug: jetpack-compose-gestures
translationKey: jetpack-compose-gestures
title: Compose 手势：PointerInput、事件消费与嵌套滚动
excerpt: 从正确选择 Compose 手势 API 开始，厘清 PointerInput 事件消费和 nestedScroll 的边界，解决复杂交互冲突。
publishDate: '2026-05-16'
updatedDate: '2026-09-22'
tags:
- Jetpack Compose
- 手势处理
- 嵌套滚动
- PointerInput
seo:
  title: "Compose 手势：PointerInput、事件消费与嵌套滚动"
  description: "正确选择 Compose 手势 API，理解 PointerInput 事件消费，并用 nestedScroll 协调嵌套滚动。"
---

**先选 Compose 提供的最高层 API。** 能用 `clickable`、`scrollable`、`draggable` 或 `transformable` 就不要直接写 `pointerInput`。例如 `LazyColumn` 中的横向滑动条目，通常只需要条目处理横向拖拽、列表保留原生纵向滚动，而不是照搬 View 的拦截模型。

这里有一个关键边界：`PointerInputChange.consume()` 是“标记这一部分指针变化已经被处理”，并不是“让父节点收不到事件”。命中测试选中的同一条处理链仍会经过各个 pass，处理器可以观察消费状态。`nestedScroll` 则是另一套机制，负责在可滚动父子组件之间协商**滚动距离和 fling 速度**。

## 先判断该用哪一层

`Button`、`clickable` 自带语义、键盘/焦点支持和视觉反馈；自定义内容上的标准手势优先使用手势 Modifier；只有产品需要自定义事件序列时，才进入 `pointerInput` 与 `awaitPointerEventScope`。

一个 `pointerInput` 块里不能顺序放两个顶层检测器：检测器会挂起等待手势，后一个通常不可达。确实需要点击和拖拽时，链式添加两个独立的 `pointerInput`。

```kotlin
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

@Composable
fun SwipeActionRow() {
    var offsetPx by remember { mutableFloatStateOf(0f) }
    val maxOffsetPx = 192f

    Box(
        Modifier
            .fillMaxWidth()
            .height(64.dp)
            .offset { IntOffset(offsetPx.roundToInt(), 0) }
            .background(Color.LightGray)
            .pointerInput(Unit) {
                detectHorizontalDragGestures { change, dragAmount ->
                    // 已越过 touch slop，声明横向 delta 的归属。
                    change.consume()
                    offsetPx = (offsetPx + dragAmount).coerceIn(-maxOffsetPx, maxOffsetPx)
                }
            }
    )
}
```

该例现在会在 `-192px..192px` 范围内移动条目；产品应按操作按钮宽度和布局密度定义边界，而不是把 192 当成通用值。状态应由滑动条目自身持有，向外只提交最终动作，不要每一帧都修改整个页面的状态。

## Pointer pass 与消费到底做了什么

按下时 Compose 做命中测试，并在本次手势剩余期间保留这条命中链（hover 是例外）。事件依次经历 `Initial`、`Main`、`Final`：`Initial` 中父级先访问，`Main` 中子级先访问，`Final` 让祖先在子级处理后作出反应。

消费是协作信号。需要独占时，先检查别的处理器是否已消费；确认手势后再消费自己拥有的部分。抢先消费 Down 会破坏点击、长按、选择和无障碍协作。埋点一类旁观者可用 `awaitFirstDown(requireUnconsumed = false)` 观察已消费的 Down，但“看见”不等于“拥有”。

因此，不要把“父级在 Initial 处理纵向、子级在 Main 处理横向”当作通用嵌套滚动方案。它会绕开内建的 fling、overscroll、touch slop 和无障碍行为。仅当交互确实自定义时再这样做，并测试斜向拖拽、取消、鼠标、手写笔和多指。

## 嵌套滚动是 delta 协商

`LazyColumn`、`verticalScroll`、`scrollable`、`draggable` 会在适用时参与嵌套滚动。确有父子滚动策略（例如折叠标题栏）时，把 `NestedScrollConnection` 挂在父级，并且只返回父级实际消费的距离；不要为了阻止子级而凭空返回一个值。

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Offset

private object ObserveOnlyConnection : NestedScrollConnection {
    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset = Offset.Zero
}

@Composable
fun Feed(items: List<String>) {
    Column(Modifier.fillMaxSize().nestedScroll(ObserveOnlyConnection)) {
        LazyColumn { items(items, key = { it }) { SwipeActionRow() } }
    }
}
```

折叠标题栏应当夹住自己的 offset，在 `onPreScroll`/`onPostScroll` 中只返回夹住后真实占用的差值，并补齐对应 fling 回调。若列表纵向、条目横向，先依赖默认 slop 和消费行为；只在可复现的斜向拖拽缺陷上增加方向锁。

## 缩放旋转需要明确坐标规则

`detectTransformGestures` 给出 centroid、pan、zoom、rotation 的增量。缩放和旋转要围绕 centroid 应用，并限制 scale、translation 的范围。若“只允许双指缩放”是产品规则，不要假设回调具有稳定的指针数契约；改用 `awaitPointerEventScope` 检查活动触点。标准可变换表面优先用 `transformable`。

## 排查顺序

1. 用 `performTouchInput` 复现，覆盖斜向移动和取消。
2. 能替换成 `clickable`、`draggable`、`scrollable` 就替换。
3. 在异常处理器处检查消费状态，不要根据回调是否执行来猜测。
4. 只有两个滚动容器需分配 delta 或 fling 时才加 `nestedScroll`。

手势的高频状态该在哪一阶段读取，可参阅 [Compose 三阶段](/blog/jetpack-compose-phases-composition-layout-draw/)；信息流还应同时遵守 [LazyColumn 性能](/blog/jetpack-compose-lazycolumn-performance/) 的 item 身份与测量建议。更多入口见 [Jetpack Compose](/jetpack-compose/) 和 [Android 性能](/android-performance/)。

## 官方资料

- [Compose Pointer input](https://developer.android.com/develop/ui/compose/touch-input/pointer-input)
- [理解手势与事件消费](https://developer.android.com/develop/ui/compose/touch-input/pointer-input/understand-gestures)
- [Scroll modifiers](https://developer.android.com/develop/ui/compose/touch-input/scroll/scroll-modifiers)
