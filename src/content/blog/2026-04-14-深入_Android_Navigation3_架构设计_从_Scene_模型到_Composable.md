---
title: "深入 Android Navigation3 架构设计：回退栈回归开发者手中"
excerpt: "解析 Navigation3 的核心设计思路：将回退栈从 NavController 黑盒中解放出来，变为开发者可直接操作的 Compose 状态列表，并通过 Scene 策略链实现多窗格适配。"
publishDate: 2026-04-14
tags:
  - Android
  - Jetpack Compose
  - Navigation3
  - 架构设计
seo:
  title: "深入 Android Navigation3 架构设计：回退栈回归开发者手中"
  description: "详解 Navigation3 如何用 SnapshotStateList 替代 NavController 管理回退栈，实现类型安全路由与可插拔 Scene 策略，简化 Compose 导航与大屏适配。"
---

Navigation3 在 2026 年 4 月发布了 1.1.0 stable。这不是旧 Navigation 组件的迭代升级，而是 Google 为 Compose 从零设计的导航库。两者的核心差异一句话就能说清：**旧库替你管回退栈，Navigation3 让你自己管**。

迁移到 Navigation3 之后，我最直观的感受是导航逻辑终于可以像普通 Compose 状态一样调试了——回退栈就是一个 `List`，打个断点就能看清当前导航状态，不用再到 NavController 的内部状态里翻来翻去。

## 旧导航的根本问题

旧 Navigation 组件（`navigation-compose`）虽然提供了 Compose DSL，底层仍然依赖 Fragment 的生命周期模型。NavController 内部维护了一个 `NavBackStackEntry` 栈，状态保存、恢复、转场动画全都耦合在一起。

实际开发中的痛点很具体：

**NavController 是黑盒。** 回退栈的增删改查全靠 `navigate()`、`popBackStack()` 等命令式 API，你无法直接观察或操作栈的状态。想做"跳过中间页面直接回到首页"这种操作，得靠 `popUpTo` + `inclusive` 的参数组合，写起来很别扭，读起来更费劲。

**路由缺乏类型安全。** 路由本质是字符串拼接，`"detail/{id}"` 这种模式在编译期无法校验参数类型和数量。线上常见的崩溃之一就是路由参数解析失败——少传一个参数或者类型不对，编译器不会告诉你。

**多窗格适配困难。** 大屏设备上要做 List-Detail 双栏布局，旧库需要自己在外层套一层逻辑判断，导航库本身不理解"同时展示多个目的地"这件事。

Navigation3 的设计目标很明确：把回退栈交还给开发者，导航库只负责根据栈状态渲染 UI。

## BackStack 即 State

Navigation3 最核心的设计决策：**回退栈就是一个普通的 Compose 状态列表**。

```kotlin
// 定义类型安全的路由
@Serializable data object HomeRoute
@Serializable data class DetailRoute(val id: String)

@Composable
fun App() {
    // 回退栈 = 一个 mutableStateList，你完全拥有它
    val backStack = rememberMutableStateList<Any>(HomeRoute)

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryProvider = entryProvider { route ->
            when (route) {
                is HomeRoute -> NavEntry(route) {
                    HomeScreen(onItemClick = { id ->
                        backStack.add(DetailRoute(id)) // 导航 = 往列表里加一项
                    })
                }
                is DetailRoute -> NavEntry(route) {
                    DetailScreen(route.id)
                }
            }
        }
    )
}
```

这段代码就是 Navigation3 的完整导航设置，几个关键点值得展开。

路由是 Kotlin data class，用 `@Serializable` 标注，编译器直接校验参数类型。`DetailRoute(id = "123")` 代替了 `"detail/123"` 字符串拼接，类型安全在编译期就解决了。

`backStack` 是一个 `SnapshotStateList`。导航操作就是列表操作：`add()` 前进，`removeLast()` 后退，`clear()` 后再 `add()` 就是 reset。没有 `navigate()`、`popUpTo`、`launchSingleTop` 这些专用 API，因为根本不需要——列表操作已经覆盖了所有导航场景。

`NavDisplay` 做的事情很纯粹：观察 `backStack` 的变化，根据栈顶路由通过 `entryProvider` 拿到对应的 `NavEntry`，然后渲染。**它是一个无状态的渲染器**，所有导航状态都在你手上。

## NavEntry 与 Scene 策略

`NavEntry` 是 Navigation3 的基本渲染单元，把一个路由 key 和一个 Composable 内容绑定在一起。但 Navigation3 真正有意思的地方在于 **Scene 策略（SceneStrategy）**——它决定了多个 NavEntry 如何同时展示。

```kotlin
NavDisplay(
    backStack = backStack,
    onBack = { backStack.removeLastOrNull() },
    entryProvider = entryProvider { ... },
    // Scene 策略链：依次尝试匹配
    sceneStrategy = DialogSceneStrategy()
        then TwoPaneSceneStrategy(isDetailVisible = backStack.size > 1)
        then SinglePaneSceneStrategy() // 兜底
)
```

Scene 策略本质是一个责任链。NavDisplay 拿到当前回退栈后，依次询问每个策略"你能处理这组 entries 吗"。`DialogSceneStrategy` 识别标记为 dialog 的 entry，将其渲染为浮层；`TwoPaneSceneStrategy` 在大屏上把栈顶两项并排展示；`SinglePaneSceneStrategy` 作为兜底，只展示栈顶一项。

这比旧库的做法好不少。旧库处理大屏适配，基本靠外层手写条件判断或者嵌套 NavHost，逻辑散落各处。Navigation3 把"如何展示"抽象成可插拔的策略，应用层只需组合策略链，不用关心内部渲染细节。

我在项目里通常这样组织：手机上只挂 `SinglePaneSceneStrategy`，平板上加一个 `TwoPaneSceneStrategy`，折叠屏再根据铰链状态动态切换。策略的切换本身也是 Compose 状态驱动的，窗口尺寸变化时自动 recompose，不需要手动处理配置变更。

## 状态保存与生命周期

旧库的一个优势是 `SavedStateHandle` 集成得很深，NavBackStackEntry 自带 ViewModel 作用域。Navigation3 走了一条不同的路。

每个 `NavEntry` 可以声明自己需要的生命周期资源：

```kotlin
NavEntry(
    route = DetailRoute(id),
    featureMap = mapOf(
        SavedStateFeature to SavedStateSpec(),
        ViewModelStoreFeature to ViewModelStoreSpec()
    )
) {
    DetailScreen(route.id)
}
```

`featureMap` 是一个可扩展的能力声明机制。`SavedStateFeature` 让 entry 在进程重建后恢复状态，`ViewModelStoreFeature` 给 entry 分配独立的 ViewModelStore。这些能力是**按需声明**的——如果一个页面不需要 ViewModel，就不挂这个 feature，减少不必要的开销。

这里有一个容易踩的坑：如果忘了声明 `ViewModelStoreFeature`，在 entry 的 Composable 里调用 `viewModel()` 会拿到外层（通常是 Activity）的 ViewModel 作用域，而不是 entry 级别的。排查时很容易漏掉，因为不会崩溃，只是数据莫名其妙地在页面间串了。

## 迁移的务实建议

从旧 Navigation 迁移到 Navigation3，我的经验是别想一步到位，按模块逐步替换最稳妥。

**先迁移路由定义。** 把字符串路由改成 data class，这一步在旧库上也能做（Navigation 2.8+ 已经支持类型安全路由），迁移到 Navigation3 时路由层可以直接复用。

**导航逻辑收口到一个 StateHolder。** 不要在每个 Screen 里直接操作 `backStack`，通过一个集中的 NavigationStateHolder 暴露有语义的方法：

```kotlin
class AppNavigationState(private val backStack: SnapshotStateList<Any>) {
    fun goToDetail(id: String) = backStack.add(DetailRoute(id))
    fun goBack() = backStack.removeLastOrNull()
    fun resetToHome() {
        backStack.clear()
        backStack.add(HomeRoute)
    }
}
```

这样既保留了"回退栈即状态"的可观测性，又避免了导航逻辑散落在各个 Screen 中。

**暂时别依赖深层嵌套。** Navigation3 当前对嵌套 NavDisplay 的支持还比较基础，多层嵌套的状态保存可能有边界问题。如果原来用了嵌套 NavHost，建议先打平成单层 NavDisplay + Scene 策略的组合。

最后说一点个人判断：Navigation3 的 API 已经足够稳定，新项目直接上没问题。但旧项目如果导航逻辑本身不复杂，迁移的收益主要体现在类型安全和可调试性上。这两项改善确实明显，但够不够驱动一次大规模重构，取决于你的项目痛点是不是真的卡在导航层。别为了用新东西而迁移。
