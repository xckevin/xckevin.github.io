---
slug: jetpack-compose-phases-composition-layout-draw
translationKey: jetpack-compose-phases-composition-layout-draw
title: Compose 三阶段：Composition、Layout、Drawing 与状态读取
excerpt: 理解 Compose 的组合、布局、绘制三阶段，并将状态读取放到能使无效工作最少的位置。
publishDate: '2026-01-15'
updatedDate: '2026-09-22'
tags:
- Android
- Jetpack Compose
- 性能优化
- 状态管理
seo:
  title: "Compose 三阶段：Composition、Layout、Drawing 与状态读取"
  description: "理解 Compose 状态读取如何影响重组、布局与绘制，并掌握正确的 lambda Modifier 写法。"
  pageType: article
---

**状态在哪个阶段被读取，决定 Compose 最早必须从哪里重新执行。** 文本和结构在 Composition 读取；位置在 Layout 读取；只影响像素的值在 Drawing 读取。这是测量后可用的优化工具，不是把所有状态都塞进绘制 lambda 的理由。

一帧通常沿单向流动：

```text
Composition（显示什么）-> Layout（尺寸与位置）-> Drawing（像素）
```

Compose 会按这些 restart scope 追踪状态读取，并在输入未变时复用工作。这是局部优化，不是魔法：`LazyColumn`、`LazyRow`、`BoxWithConstraints` 的子项组合依赖父级布局约束，是明显例外。Layout 还分 measurement 和 placement restart scope；placement 的状态读取可以只重启 placement，并不必然重新测量该节点。

## 让状态匹配它实际影响的阶段

下面的完整示例把三个独立值放到消费它们的阶段。一次点击会改动三者；分析性能时应分别观察它们。

```kotlin
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

@Composable
fun PhaseAwareBadge() {
    var label by remember { mutableStateOf("Ready") }
    var offsetPx by remember { mutableIntStateOf(0) }
    var color by remember { mutableStateOf(Color.Magenta) }

    Column(Modifier.padding(16.dp)) {
        Button(onClick = {
            label = "Updated"       // Text 在 Composition 中读取
            offsetPx += 12           // offset lambda 在 placement 中读取
            color = Color.Cyan       // drawBehind 在 Drawing 中读取
        }) { Text("Update") }

        Text(
            text = label,
            modifier = Modifier
                .offset { IntOffset(offsetPx, 0) }
                .drawBehind { drawCircle(color = color, radius = 8.dp.toPx()) }
                .background(Color.White)
        )
    }
}
```

直接写 `Modifier.offset(x = someDp, y = 0.dp)` 会在 Composition 读取 `someDp`；上例的 lambda 重载把读取延迟到 Layout placement。同理，`Modifier.graphicsLayer { alpha = alphaState }`、`drawBehind`、`Canvas` 在 Drawing 读取状态，只有像素变化时可以跳过之前两阶段。前提是这份状态没有在同一受影响路径更早被读取。

## 不要制造跨阶段反馈环

常见错误是：在 `onSizeChanged` 或 `onGloballyPositioned` 观察子项尺寸，写进 state，再把该 state 作为父级 `padding`/`height` 的输入。一次布局写状态，请求新的组合和布局；第一帧可能错位，变化持续时可能反复循环。

应使用 `Column`、`Row`、`Box`、parent-data Modifier 或自定义 `Layout`，让最近的共同父级从同一来源测量、放置关联子项。也不要在一次 Composition 中写回已读取的状态（backwards write）；Compose 可能不断重组，直到触发限制。

## 跳过：有用、受版本影响，但不是目标

符合条件的可重启 composable 在输入比较未变化时可以跳过。普通模式下，稳定输入按 `equals` 比较，不稳定输入可能让函数失去跳过资格。Kotlin 2.0.20 起 Strong Skipping 默认开启：带不稳定输入的可重启 composable 也可成为 skippable，不稳定输入按实例相等比较；编译器还会记忆化捕获 lambda。

Strong Skipping 不保证一定跳过。不可重启/不可跳过函数、新建的不稳定对象实例、该作用域读取状态的变化，或必要的布局/绘制更新，都仍可能执行工作。不要为了追报告而滥加 `@Stable`/`@Immutable`：它们承诺“可观察变化一定通知”的契约。尤其在 Kotlin 2.0.20 之前，应检查被分析模块的 compiler 配置和 report。

## 有纪律的优化路径

1. 在 release 模式记录真实交互，确认成本在组合、测量/放置、绘制、图片解码还是数据计算。
2. 先保持状态归属正确、代码可读。
3. 高频值只移动内容时，用 lambda Layout Modifier；只改变像素时，再考虑 draw lambda 或 `graphicsLayer`。
4. 用相同路径重新测量；只有降低实际瓶颈才算优化成功。

[LazyColumn 性能](/blog/jetpack-compose-lazycolumn-performance/) 把这套原则落实到列表状态、key 和测量；指针驱动的值可继续看 [Compose 手势](/blog/jetpack-compose-gestures/)。更多入口见 [Jetpack Compose](/jetpack-compose/) 与 [Android 性能](/android-performance/)。

## 官方资料

- [Jetpack Compose phases](https://developer.android.com/develop/ui/compose/phases)
- [Modifier breakdown by phase](https://developer.android.com/develop/ui/compose/performance/modifier-phases)
- [Strong skipping mode](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
- [Compose performance best practices](https://developer.android.com/develop/ui/compose/performance/bestpractices)
