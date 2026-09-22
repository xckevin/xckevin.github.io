---
slug: jetpack-compose-lazycolumn-performance
translationKey: android-compose-lazycolumn-scroll-performance
title: Compose LazyColumn 性能：key、contentType、稳定性与测量
excerpt: 用稳定 item 身份、内容类型、合理的状态边界和 release Macrobenchmark 定位并解决 LazyColumn 卡顿。
publishDate: '2026-02-26'
updatedDate: '2026-09-22'
tags:
- Android
- Jetpack Compose
- LazyColumn
- 性能优化
- 重组
seo:
  title: "LazyColumn 性能：key、contentType、稳定性与测量"
  description: "通过稳定 key、contentType、准确的稳定性判断和 release Macrobenchmark，定位并优化 LazyColumn 滑动。"
  pageType: article
---

**不要凭 debug 包的滑动手感调 LazyColumn。** 先在启用 R8 的 release 构建上复现代表性滚动路径，再根据 trace 修复实际工作。Lazy 布局会按需组合和布局可见 item，但它无法自动消除不稳定输入、昂贵 item 工作或错误的列表结构。

优先级最高的清单是：给会重排或保存状态的 item 稳定且唯一的 `key`；混合结构的列表提供 `contentType`；不要在 item lambda 中做全列表计算；测量后再报告结果。不存在通用的“恢复 60 fps”配方。

## 身份与复用解决的不是同一件事

`key` 让 item 在插入、删除、移动和状态恢复时保留逻辑身份，`remember` 的状态会跟随 item 而不是位置。item 内使用 `rememberSaveable` 时，key 应是 Bundle 支持的稳定类型，例如 ID、枚举或 `Parcelable`。

`contentType` 描述的是 item 的**布局种类**，让 Lazy 布局只在兼容结构之间复用组合。它适用于图文卡片、广告、分组标题混排，不是统一列表必填的装饰参数。

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

sealed interface FeedRow { val id: Long
    data class Article(override val id: Long, val title: String) : FeedRow
    data class Ad(override val id: Long, val label: String) : FeedRow
}

@Composable
fun FeedList(rows: List<FeedRow>) {
    LazyColumn {
        items(
            items = rows,
            key = { it.id },
            contentType = { row -> when (row) {
                is FeedRow.Article -> "article"
                is FeedRow.Ad -> "ad"
            } }
        ) { row ->
            when (row) {
                is FeedRow.Article -> ArticleRow(row)
                is FeedRow.Ad -> AdRow(row)
            }
        }
    }
}

@Composable private fun ArticleRow(row: FeedRow.Article) =
    Column(Modifier.fillMaxWidth()) { Text(row.title) }
@Composable private fun AdRow(row: FeedRow.Ad) =
    Column(Modifier.fillMaxWidth()) { Text(row.label) }
```

不要把整屏 item 都放进一个 `item { ... }`：任一部分可见时，这一组都会一起组合、测量，懒加载就失效了。分割线这类无法拆开的轻量装饰可以跟随所属行。

## 稳定性用于诊断，不是注解仪式

Compose 把标准 `List`、`Set`、`Map` 视为不稳定，因为无法证明其不可变性。`@Immutable`、`@Stable` 是契约：只有类型确实满足契约、且所有可观察变化都会通知 Compose 时才能标注。给可变数据乱加注解，可能造成 UI 不更新。

Kotlin 2.0.20 起 Compose 默认开启 Strong Skipping：带不稳定参数的可重启 composable 也可能跳过，不稳定参数按实例相等比较、稳定参数按 `equals` 比较，捕获 lambda 也会被编译器记忆化。这减少了常见的 lambda 分配问题，但不会让新建列表、变化的 item 模型、图片解码或昂贵计算变成零成本。较旧的编译器配置行为不同，应检查当前模块配置和 compiler report，而不是复制特定版本的 workaround。

trace 显示 item 反复组合时，先检查输入：行模型是否不可变、回调是否有合理作用域、父级是否每次都重建 backing list。排序、过滤、映射放到 ViewModel，或使用 key 正确的 `remember` 缓存；不要在一次组合中写回已经读取过的状态。

## 不要把高频状态读在整个列表主体

“回到顶部”只关心阈值是否越过，而不关心每一个像素偏移。`derivedStateOf` 只在推导值改变时通知读取方。

```kotlin
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

@Composable
fun FeedWithTopButton() {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val showTopButton by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = listState) { items(100, key = { it }) { Text("Row $it") } }
        if (showTopButton) Button(onClick = { scope.launch { listState.animateScrollToItem(0) } }) { Text("Top") }
    }
}
```

仅当推导值比源状态变化少时使用它。持续变化的视差、拖拽位置，应像 [Compose 三阶段](/blog/jetpack-compose-phases-composition-layout-draw/) 所述，延迟到 lambda Modifier 或绘制阶段读取。

## 测量必须对应一段可复现旅程

使用真实或具有代表性的设备、启用 R8 的 release/profileable 构建、固定数据集和一致的导航/图片缓存条件。官方 Macrobenchmark 可完成端到端滚动：为列表设置 `Modifier.testTag`，用 UI Automator 驱动，记录 `FrameTimingMetric`，检查 JSON 和 trace。前后必须是同一场景；报告设备、构建类型、迭代次数、数据/图片条件及 percentile 或 jank 指标。缺少这些，帧率数字只是轶事。

Baseline Profile 可以改善启动和关键路径，但应在修正 UI 工作之后，从真实旅程收集；不要手写 Compose 内部方法签名，也不要承诺固定毫秒收益。

条目含滑动操作时，继续阅读 [Compose 手势](/blog/jetpack-compose-gestures/)；状态读取位置则见 [Compose 三阶段](/blog/jetpack-compose-phases-composition-layout-draw/)。专题入口： [Jetpack Compose](/jetpack-compose/) 与 [Android 性能](/android-performance/)。

## 官方资料

- [Lazy lists and grids](https://developer.android.com/develop/ui/compose/lists)
- [Compose performance](https://developer.android.com/develop/ui/compose/performance)
- [Stability in Compose](https://developer.android.com/develop/ui/compose/performance/stability)
- [Strong skipping mode](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
- [Write a Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark)
