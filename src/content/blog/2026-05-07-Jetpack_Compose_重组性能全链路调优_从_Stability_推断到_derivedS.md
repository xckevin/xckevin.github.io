---
title: Jetpack Compose 重组性能全链路调优：从 Stability 推断到 derivedStateOf 的工程化诊断与优化实践
excerpt: 系统梳理 Compose 重组性能的诊断与优化全流程，涵盖编译器 Stability 推断机制、Layout Inspector 量化定位、derivedStateOf 收窄重组范围及状态读取下沉等工程化实践，帮助开发者从「靠经验猜」转向「按数据改」。
publishDate: '2026-05-07'
tags:
- Jetpack Compose
- Android
- 性能优化
- Kotlin
- 架构设计
seo:
  title: "Jetpack Compose 重组性能优化：Stability、derivedStateOf 与跳过重组"
  description: "深入讲解 Compose 重组性能优化，覆盖 Stability 推断、编译器报告、derivedStateOf、状态读取下沉和性能验证闭环。"
---

做 Compose 性能排查时，我遇到过一类让人头疼的问题：明明没有任何"重量级"操作，列表滑动就是卡，Profiler 里重组次数蹭蹭往上涨，却一时找不到根因。翻遍文档后才意识到，问题不在某一个 Composable，而在于整个重组链路上存在多个隐性触发点——工具链用法不对，排查就只能靠猜。

这篇文章把我在实际项目中用到的诊断和优化方法系统整理一遍，主线是：**编译器 Stability 推断机制 → 工具量化定位 → derivedStateOf / 结构调整修复 → 验证**。

## Stability 推断：编译器的跳过条件

理解重组为什么被触发，要先搞清楚编译器如何决定"可以跳过"。

Compose 编译器在编译期对每个 Composable 的参数类型做稳定性推断（Stability Inference）。只有当一个 Composable 的**所有参数都是稳定类型**时，运行时才允许在参数未变的情况下跳过这次调用。推断结果不是运行时动态计算的，而是编译期写死进 `$changed` 位掩码里的。

编译器认定为**稳定（Stable）**的情况：

- 原始类型、String、函数类型（Lambda）
- 所有公共属性都是 `val` 且属性类型也稳定的 data class
- 显式标注了 `@Stable` 或 `@Immutable` 的类
- `MutableState<T>`（状态变化通过 Snapshot 通知，不依赖 equals 比较）

以下几种场景会直接让参数变成**不稳定（Unstable）**，导致对应 Composable 无法被跳过：

```kotlin
// ❌ 含 var 属性的普通 class，编译器标记为 Unstable
data class UserProfile(
    val name: String,
    var avatarUrl: String   // var 属性破坏稳定性
)

// ❌ 使用标准 List<T>，即使 T 是稳定的
@Composable
fun FeedList(items: List<FeedItem>) { /* ... */ }

// ❌ 来自外部模块（如 OkHttp）的类型，编译器无法推断
@Composable
fun NetworkStatus(response: Response) { /* ... */ }
```

`List<T>` 是最常见的坑。标准库的 `List` 接口在编译器眼里是不稳定的，因为它有可变实现，编译器无法保证其 `equals()` 行为的可靠性。用 `kotlinx.collections.immutable` 的 `ImmutableList<T>` 或者给参数加 `@Stable` 包装都能解决，我更倾向于前者，语义更清晰，意图也更明确。

## 用编译器报告找出所有不稳定类型

靠肉眼看代码找不稳定类型，项目大了完全不现实。Compose 编译器提供了 **Stability Report**，一行 Gradle 配置开启：

```kotlin
// app/build.gradle.kts
composeOptions {
    kotlinCompilerExtensionVersion = "..."
    freeCompilerArgs += listOf(
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:stabilityConfigurationPath=${projectDir}/compose_stability_config.conf",
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:reportsDestination=${buildDir}/compose_reports"
    )
}
```

执行 `./gradlew assembleDebug` 后，`build/compose_reports/` 目录下会生成 `*-composables.txt` 和 `*-classes.txt`。重点看 `*-composables.txt`：

```
restartable skippable scheme("[androidx.compose.ui.UiComposable]") fun FeedItem(
  stable modifier: Modifier? = @static Companion
  unstable item: FeedItem     // ← 这里标注了 unstable
  <runtime stability> = Unstable
)
```

`unstable` 标注意味着这个 Composable 永远无法被跳过。`*-classes.txt` 里会列出每个类的稳定性推断结果，方便批量排查。

我在实际项目中发现过两类"惊喜"：一是领域模型 data class 里混入了 `var` 属性，二是某个 ViewModel 返回的列表里包含了第三方对象——这些都会让调用链上所有 Composable 失去跳过能力。

## 量化诊断：Layout Inspector 和 Recomposition Counter

找到不稳定类型后，下一步是确认它们实际导致了多少次冗余重组。Android Studio Hedgehog 之后的 Layout Inspector 支持 **Recomposition Count** 实时显示，是目前最直观的工具。

连接真机或模拟器，打开 Layout Inspector，在 "Live Updates" 模式下执行触发场景（比如滑动列表、点击按钮）。每个 Composable 节点右侧会显示两个数字：`recompose count / skip count`。

几个关键观察维度：

- **高 recompose count + 低 skip count**：典型的不稳定参数导致无法跳过
- **父节点 recompose count 远高于子节点**：父组件的状态读取范围太宽，可以下沉
- **某个叶子节点 recompose count 异常高**：可能读取了高频变化的状态（如动画进度、滚动偏移量）

排查阶段还可以用 `SideEffect` 做重组计数，当作 CI 回归校验的临时探针：

```kotlin
@Composable
fun ExpensiveItem(item: FeedItem) {
    // 每次重组都会执行，可以接入监控上报
    SideEffect {
        RecompositionTracker.increment("ExpensiveItem")
    }
    // ... 实际内容
}
```

这不适合留在生产代码里，只是排查阶段的探针，用完删掉。

## 根因修复：三种主要手段

诊断清楚之后，修复通常围绕三个方向展开。

### 修复类型稳定性

对自己控制的类，优先让它满足不可变契约：

```kotlin
// 方案 1：确保所有属性都是 val + 稳定类型
data class FeedItem(
    val id: Long,
    val title: String,
    val imageUrl: String
)

// 方案 2：外部模块类型用 @Stable 包装
@Stable
class StableResponse(val raw: Response) {
    val isSuccessful get() = raw.isSuccessful
    val body get() = raw.body
}

// 方案 3：标准 List 换成 ImmutableList
@Composable
fun FeedList(items: ImmutableList<FeedItem>) { /* ... */ }
```

对于来自外部 SDK 的类——本身不可变，但编译器无法感知——可以在 `compose_stability_config.conf` 里手动声明：

```
// compose_stability_config.conf
com.example.sdk.ImmutableModel  // 告知编译器该类是稳定的
```

这个配置文件在 Compose 编译器插件 1.5.5+ 支持，优先级高于自动推断。

### 用 derivedStateOf 收窄重组范围

`derivedStateOf` 解决的问题是：**上游状态高频变化，但下游 Composable 真正关心的派生值变化并不频繁**。在这种情况下，应该避免让下游随上游一起高频重组。

典型场景是列表滚动时的"显示/隐藏 FAB"逻辑：

```kotlin
// ❌ 每次滚动偏移量变化都触发重组
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    val showFab = listState.firstVisibleItemIndex > 0  // 高频读取
    Box {
        LazyColumn(state = listState) { /* ... */ }
        if (showFab) FloatingActionButton(onClick = {}) { /* ... */ }
    }
}

// ✅ 用 derivedStateOf 做一次 Boolean 缓存
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    // 只有从 false→true 或 true→false 时，订阅 showFab 的 Composable 才重组
    val showFab by remember(listState) {
        derivedStateOf { listState.firstVisibleItemIndex > 0 }
    }
    Box {
        LazyColumn(state = listState) { /* ... */ }
        if (showFab) FloatingActionButton(onClick = {}) { /* ... */ }
    }
}
```

`derivedStateOf` 的本质是在 Snapshot 系统里建立一个中间 State 节点。它内部维护缓存值，只有计算结果通过 `equals()` 比较后确认发生变化，才会标记订阅者为 dirty。滚动偏移量每帧都变，但 `firstVisibleItemIndex > 0` 这个布尔值绝大多数时候稳定不变，FAB 就不会重组。

踩过的坑是：把 `derivedStateOf` 用在没有 State 读取的普通计算上，或者内部读取的 State 变化频率和派生结果变化频率完全一致——这两种情况什么优化效果都没有，还多了一层开销。

### 状态读取下沉（State Hoisting Down）

另一类重组问题和稳定性无关，而是**读取状态的代码位置太靠近组件树的根**，导致大范围重组。

```kotlin
// ❌ 在父组件读取动画值，导致整个父组件重组
@Composable
fun ArticleCard(article: Article) {
    val alpha by animateFloatAsState(targetValue = if (article.isRead) 0.5f else 1.0f)
    Column(modifier = Modifier.alpha(alpha)) {  // alpha 每帧变化
        ArticleTitle(title = article.title)      // 跟着父组件重组
        ArticleSummary(summary = article.summary)
        ArticleMetadata(meta = article.meta)
    }
}

// ✅ 把状态读取下沉到真正需要它的地方
@Composable
fun ArticleCard(article: Article) {
    Column {
        ArticleTitle(title = article.title)
        ArticleSummary(summary = article.summary)
        ArticleMetadata(meta = article.meta)
        AlphaOverlay(isRead = article.isRead)  // 只有这里承担重组
    }
}

@Composable
private fun AlphaOverlay(isRead: Boolean) {
    val alpha by animateFloatAsState(targetValue = if (isRead) 0.5f else 1.0f)
    Box(modifier = Modifier.fillMaxSize().alpha(alpha))
}
```

原则很简单：**谁消费，谁读取**，不要让上层组件替下层读状态然后传递结果。

更激进的做法是用 `Modifier.graphicsLayer { }` 替代 `Modifier.alpha()`——`graphicsLayer` 的 lambda 在绘制阶段执行，完全绕开 Recomposition，直接走 RenderThread 的属性动画通道：

```kotlin
// graphicsLayer lambda 在 draw 阶段执行，完全绕开 Recomposition
Box(modifier = Modifier.graphicsLayer { this.alpha = animAlpha })
```

## 建立验证闭环

优化之后必须量化验证，否则改了一处，另一处又冒出来，来回拉锯。

**1. 编译期 Stability 守门**：在 CI 里解析 `compose_reports` 目录，如果新增了 `<runtime stability> = Unstable` 的 Composable，构建报警。这条规则能把稳定性回归挡在合并之前。

**2. 基准测试（Macrobenchmark）量化帧时间**：对核心场景录制基准，把 P95 帧时间纳入性能指标看板：

```kotlin
@Test
fun feedScrollBenchmark() = benchmarkRule.measureRepeated(
    packageName = "com.example.app",
    metrics = listOf(FrameTimingMetric()),
    iterations = 5,
    setupBlock = { startActivityAndWait() }
) {
    device.findObject(By.res("feed_list"))
          .setGestureMargin(device.displayWidth / 5)
    device.findObject(By.res("feed_list")).fling(Direction.DOWN)
}
```

**3. 局部回归用 Recomposition Highlighter**：在 debug build 里打开 `ComposeUiFlags.isDebugInspectorInfoEnabled`，配合 Layout Inspector 的 Recomposition Count，在重要页面改动后人工比对前后数字，能快速感知是否引入回归。

---

实践下来，Compose 重组性能问题 80% 集中在三个地方：不稳定的 List 参数、状态读取位置太靠上、高频状态没有用 `derivedStateOf` 隔离。Stability Report 把第一类问题完全透明化了，剩下两类靠 Layout Inspector 的 Recomposition Count 基本能定位。

工具链到位之后，优化这件事就从"靠经验猜"变成了"按数据改"，节省的时间远超配置成本。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Jetpack Compose](/jetpack-compose/)
- [Jetpack Compose 原理与高级应用：状态、布局、重组与性能实践](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose Modifier 原理：链式节点、布局绘制与事件处理](/blog/2026-05-15-jetpack_compose_modifier_链式机制深度解析_从_modifier_node_/)
- [Jetpack Compose 手势系统：PointerInput 事件管道与嵌套滚动](/blog/2026-05-16-jetpack_compose_手势系统深度解析_从_pointerinput_事件管道到_modi/)
- [Jetpack Compose 动画系统：AnimationSpec、弹簧模型与 Transition](/blog/2026-05-09-jetpack_compose_动画系统深度解析_从_animationspec_物理弹簧模型到_t/)
<!-- /seo-internal-links -->
