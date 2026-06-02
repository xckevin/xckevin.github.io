---
title: 深入 Android Compose LazyColumn 滑动性能调优全链路
excerpt: 从 LazyColumn 重组模型与 RecyclerView 的差异出发，系统梳理状态上提、Lambda 引用不稳定、图片加载扩散等高频性能陷阱，并结合 Compose Compiler Metrics 诊断与 Baseline Profile 兜底，提供一套可落地的滑动性能优化方案。
publishDate: '2026-02-26'
tags:
- Android
- Jetpack Compose
- LazyColumn
- 性能优化
- 重组
seo:
  title: 深入 Android Compose LazyColumn 滑动性能调优全链路
  description: 系统解析 LazyColumn 重组扩散根因与诊断方法，涵盖稳定性标记、Lambda 稳定化、图片加载隔离及 Baseline Profile 等实战优化策略，助你将滑动帧率从 35fps 拉回 60fps。
---

做 Compose 迁移时，团队遇到过一个典型问题：图文混排卡片的信息流列表，滑动帧率从 60fps 跌到 35fps 上下。初步怀疑卡片太复杂，但 Layout Inspector 一看重组次数——大部分卡片数据没变，却被反复重组了。

## LazyColumn 的重组模型与 RecyclerView 的差异

RecyclerView 优化滑动靠的是 ViewHolder 复用加 DiffUtil 差分更新。滑出屏幕的 View 回收，滑入时重新绑定数据。这套方案很成熟，但代价是在 Adapter 里自己把控更新粒度，稍不留神就刷了整个列表。

Compose 走的是另一条路。LazyColumn 不复用 Composable 实例，用「位置-内容」映射加智能重组来替代。每个 item 被调用时，编译器生成的重组标记决定它是否跳过执行。说是声明式的进步没错，用不好比 RecyclerView 还卡。

触发机制的差异是根因：

- RecyclerView：数据变 → `notifyItemChanged()` → Adapter 更新对应 ViewHolder
- LazyColumn：数据变 → State 变化触发重组 → Compose Runtime 按作用域传播重组 → 波及其他无关 item

排查时"卡片数据没变却被重组"，问题就出在这里——重组在作用域树上扩散，而不是精准到单个 item。

## 追踪与诊断重组扩散

Compose 1.5+ 内置了 Compose Compiler Metrics，用来量化重组行为。`build.gradle` 中开启：

```kotlin
kotlinOptions {
    freeCompilerArgs += listOf(
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:reportsDestination=${buildDir}/compose_metrics"
    )
}
```

编译后输出三个文件，核心是 `<module>-composables.txt`。每个 Composable 函数后面标注：

- `restartable`：可被重组
- `skippable`：参数未变时可跳过
- `stable`：参数类型被推断为稳定

我踩过的坑是：自定义 data class 没加 `@Stable` 或 `@Immutable`，编译器把它判为不稳定类型。结果所有接收它的 Composable 变成 `restartable` 但**不是 `skippable`**——父级重组必然带它一起重组。

```kotlin
// 编译器认为不稳定 → 每次重组都执行
data class FeedItem(
    val title: String,
    val avatarUrl: String,
    val tags: List<String>  // List 默认不稳定
)

// 加上 @Immutable 后 → 可跳过重组
@Immutable
data class FeedItem(
    val title: String,
    val avatarUrl: String,
    val tags: ImmutableList<String>  // 用稳定集合替代
)
```

另一个顺手工具是 Android Studio 的 Layout Inspector，打开"Show Recomposition Counts"，滑动列表就能看到哪些 item 频繁重组。我的经验值：超过 3 次/秒就值得排查了。

## 几个高频场景与处理方式

### 列表状态上提引发全量重组

把 `LazyListState` 放在高层 Composable，加个"回到顶部"按钮：

```kotlin
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    val showFab by remember {
        derivedStateOf { listState.firstVisibleItemIndex > 3 }
    }
    
    Column {
        LazyColumn(state = listState) { /* items */ }
        if (showFab) FloatingActionButton(onClick = { /* 回到顶部 */ })
    }
}
```

`derivedStateOf` 是关键——只在计算结果变化时通知读取方。如果直接写成 `if (listState.firstVisibleItemIndex > 3)`，每次微小滚动偏移都会触发 FAB 的重组判断。FAB 本身不重绘，但调度开销积少成多。

### Lambda 引用不稳定

这个问题更隐蔽：

```kotlin
items(list, key = { it.id }) { item ->
    FeedCard(
        item = item,
        onClick = { viewModel.onItemClick(item.id) }  // ⚠️ 每次重组创建新的 lambda
    )
}
```

外层每次重组，`onClick` 都是全新对象。Compose 用 `equals` 判断参数是否变化，lambda 每次都是新实例，`FeedCard` 其他参数没变也会被重组。

修法：`remember` 稳定化 lambda，或把回调收进 State：

```kotlin
val onItemClick = remember { { id: String -> viewModel.onItemClick(id) } }
items(list, key = { it.id }) { item ->
    FeedCard(item = item, onClick = onItemClick)
}
```

### 图片加载触发不必要的重组

Coil 的 `AsyncImagePainter` 加载完成时的状态更新会传播到宿主 Composable：

```kotlin
@Composable
fun FeedCard(item: FeedItem) {
    Column {
        AsyncImage(model = item.avatarUrl, contentDescription = null,
            modifier = Modifier.size(48.dp, 48.dp))
        Text(item.title)
    }
}
```

处理方向是把图片加载隔离到独立作用域，重组不扩散：

```kotlin
@Composable
fun FeedCard(item: FeedItem) {
    Column {
        // 图片加载变化只影响这个 Box 内部
        Box(modifier = Modifier.size(48.dp, 48.dp)) {
            AsyncImage(model = item.avatarUrl, contentDescription = null)
        }
        Text(item.title)
    }
}
```

图片尺寸固定的情况下，配合 `graphicsLayer` 做离屏渲染，能进一步阻断加载对卡片布局阶段的影响。

## Baseline Profile：压最后的帧率抖动

运行时优化做到位了还有微抖动，可以上 Baseline Profile。它的原理是预编译关键热路径为 AOT 代码，减少运行时 JIT 的 CPU 开销——把编译成本从主线程挪到安装时的后台。

```kotlin
// baseline-prof.txt
HSPLandroidx/compose/foundation/lazy/LazyListState$scrollToItem$1;->invoke(Lkotlin/coroutines/Continuation;)Ljava/lang/Object;
HSPLandroidx/compose/foundation/lazy/layout/LazyLayoutPrefetchState;-><init>(Lkotlin/jvm/functions/Function1;)V
```

只收集滚动路径上必然执行的方法，不要全量覆盖。全量 profile 文件反而拖 AOT 编译，还多吃存储空间。

我们在 CI 中集成 Macrobenchmark 跑滚动帧率，自动收集并更新 baseline profile。三轮迭代下来，P99 滚动帧时间从 18ms 降到 11ms，肉眼可感知的卡顿基本消失。

## 实践排序

以下三条是我在实际项目里反复验证过的优先级，按投入产出比排：

1. **稳定性标记先搞定**：`@Immutable` / `@Stable` + 稳定集合类型。成本最低、收益最直接。用 Compose Compiler Metrics 验证每个 data class 是否 `stable`
2. **隔离副作用作用域**：图片加载、动画、异步状态更新都圈定重组边界，用 `Modifier` 或嵌套 Composable 堵住向上扩散
3. **Baseline Profile 是兜底**：前两步拉满了再上，收益递减。作为生产环境里挤最后 5-8ms 的手段，性价比刚好
