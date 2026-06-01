---
title: Kotlin Flow 工程化全景：冷热流模型、Channel 本质与 Android 架构层选型
excerpt: 深入剖析 Kotlin Flow 的冷热流模型与 Channel 底层原语，结合 SharedFlow、StateFlow 的选型陷阱，梳理 MVVM 各架构层的 Flow 使用规范与最佳实践。
publishDate: '2026-04-23'
tags:
- Kotlin
- Android
- 协程
- 架构设计
- 性能优化
seo:
  title: "Kotlin Flow 原理与工程实践：冷流、StateFlow、SharedFlow 对比"
  description: "系统讲解 Kotlin Flow 的冷流模型、背压、异常处理、StateFlow、SharedFlow 与 Android 工程化使用策略。"
---

在一次线上 bug 排查中，我发现某个页面的 UI 状态在配置变更后会短暂闪烁——原因是 `SharedFlow` 的 `replay = 0` 导致新订阅者错过了最后一次状态更新。这个问题让我重新审视了 Flow 的冷热模型，以及三种热流在架构层的选型逻辑。

## 冷流的本质：惰性求值与订阅隔离

冷流（Cold Flow）的核心特征是：**每次收集都触发一次独立的执行**。Flow 本身只是一个描述「如何生产数据」的挂起函数块，没有订阅者就不执行。

```kotlin
val coldFlow = flow {
    println("开始生产")
    emit(1)
    emit(2)
}

// 两次独立收集，各自触发一次"开始生产"
coldFlow.collect { println(it) }
coldFlow.collect { println(it) }
```

这和 RxJava 的 `Observable.create()` 行为一致。但 Flow 的实现更轻量——它不是类层级继承，而是基于挂起函数的 lambda 封装，背压（Backpressure）由协程的挂起机制天然处理，不需要 `Flowable` 和 `Observable` 的类型区分。

背压策略隐藏在 `emit` 的挂起行为里：当下游处理速度慢于上游生产速度时，`emit` 会挂起等待，既不会 OOM，也不需要声明 `BackpressureStrategy`。这是 Flow 相比 RxJava 切实的工程优势。

## Channel 是热流的底层原语

理解热流之前，需要先搞清楚「通道（Channel）」。Channel 是协程间通信的并发原语，本质是一个带容量的挂起队列。

```kotlin
val channel = Channel<Int>(capacity = Channel.BUFFERED)

// 生产者协程
launch { channel.send(1) }

// 消费者协程（只有一个消费者能收到）
launch { println(channel.receive()) }
```

Channel 的关键特性：**发送和接收是一对一的**，一条消息只能被一个消费者消费。`SharedFlow` 和 `StateFlow` 在内部基于 Channel 实现了广播语义——多个订阅者可以同时收到同一条数据。

一个常见的认知误区是把 Channel 和 Flow 当作竞争关系。两者的用途边界其实很清晰：**Channel 适合协程间的点对点事件传递，Flow 适合面向观察者的数据流**。在 ViewModel 里你几乎不会直接把 Channel 暴露给 UI 层，但 `channelFlow` 构建器允许在 Flow 内部借用 Channel 的并发能力：

```kotlin
val concurrentFlow = channelFlow {
    launch { send(fetchFromNetwork()) }  // 并发生产
    launch { send(fetchFromCache()) }
}
```

`channelFlow` 解决了普通 `flow { }` 只能在单协程内顺序 `emit` 的限制。

## SharedFlow：广播语义与粘性事件陷阱

`SharedFlow` 是真正的热流——即使没有订阅者，数据也可以被发射并缓存。

```kotlin
val sharedFlow = MutableSharedFlow<Int>(
    replay = 1,         // 新订阅者能收到最近 1 条历史数据
    extraBufferCapacity = 64,  // 额外缓冲区，防止背压阻塞
    onBufferOverflow = BufferOverflow.DROP_OLDEST
)
```

`replay` 参数是最容易踩坑的地方。`replay = 0` 时，新订阅者收不到任何历史数据；`replay > 0` 则会产生「粘性事件（Sticky Event）」——在 UI 导航事件场景下这是个陷阱。

**一次性事件（如 Toast、导航跳转）不应该使用带 replay 的 SharedFlow**，否则页面重建后会重新触发导航。正确做法是 `replay = 0`，在 ViewModel 里用 `emit` 发送：

```kotlin
// ViewModel
private val _navigationEvent = MutableSharedFlow<Screen>(replay = 0)
val navigationEvent = _navigationEvent.asSharedFlow()

fun navigateTo(screen: Screen) {
    viewModelScope.launch {
        _navigationEvent.emit(screen)
    }
}
```

背压策略的选择取决于场景。UI 事件丢弃最新通常比阻塞协程更安全，`DROP_LATEST` 是大多数 UI 事件场景的合理默认值。

## StateFlow：状态持有与 LiveData 的本质差异

`StateFlow` 是 `SharedFlow` 的特化版本：**强制 replay = 1，要求初始值，对重复值做去重**。它的行为接近 LiveData，但有几个关键差异值得展开说。

```kotlin
val stateFlow = MutableStateFlow(UiState.Loading)

// 相同值不会触发下游
stateFlow.value = UiState.Loading   // 不会 emit
stateFlow.value = UiState.Success(data)  // 会 emit
```

去重依赖 `equals()` 判断。状态是数据类时没问题；但如果状态包含 `List` 等引用类型且你期望每次都触发，就要留意——两个内容相同的列表 `equals` 返回 true，下游不会收到通知。

相比 LiveData，`StateFlow` 不依赖 Android 生命周期框架，可以在纯 Kotlin 模块使用；支持完整的 Flow 操作符链，`map`、`filter`、`combine` 可以直接作用在状态流上；`value` 的读写线程安全，不需要额外同步。在实际项目里，多个数据源的状态需要合并成一个 UI 状态时，`combine` 处理起来非常直接：

```kotlin
val uiState = combine(
    userRepository.userFlow,
    settingsRepository.settingsFlow
) { user, settings ->
    UiState(user = user, darkMode = settings.darkMode)
}.stateIn(
    scope = viewModelScope,
    started = SharingStarted.WhileSubscribed(5000),
    initialValue = UiState.Loading
)
```

`stateIn` 把冷流转成热流，`SharingStarted.WhileSubscribed(5000)` 表示最后一个订阅者离开后 5 秒才停止上游收集。这个 5000ms 窗口正好覆盖了 Activity 配置变更的重建时间，避免了不必要的数据重新拉取。

## MVVM 架构层的选型逻辑

三种流在 MVVM 各层有清晰的对应关系。

**Repository 层**暴露冷流。数据库查询、网络请求都是天然的冷流场景，每次订阅触发独立请求，背压由协程挂起处理。Room 的 `Flow<T>` 返回值就是这个模式。

**ViewModel 层**做冷转热。通过 `stateIn` 或 `shareIn` 将 Repository 的冷流转为热流，维持 UI 状态的持续可用性。原则是：**UI 状态用 StateFlow，一次性事件用 `SharedFlow(replay=0)`**。

```kotlin
class FeedViewModel(repo: FeedRepository) : ViewModel() {

    // UI 状态：StateFlow，有初始值，支持配置变更恢复
    val feedState = repo.feedFlow()
        .map { FeedUiState(items = it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), FeedUiState.Loading)

    // 一次性事件：SharedFlow，replay=0 避免重复触发
    private val _errorEvent = MutableSharedFlow<String>(replay = 0)
    val errorEvent = _errorEvent.asSharedFlow()
}
```

**UI 层（Fragment/Compose）**只负责收集，不做业务逻辑。用 `repeatOnLifecycle(Lifecycle.State.STARTED)` 绑定生命周期：

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.feedState.collect { state ->
            updateUi(state)
        }
    }
}
```

`repeatOnLifecycle` 比 `launchWhenStarted` 更安全——后者在 STOPPED 时仅挂起协程，上游仍在运行；前者会真正取消，并在重新进入前台时重启收集。处理位置更新、传感器等持续数据源时，这个差异影响明显。

## 几个实践判断

**关于 Channel vs SharedFlow**：在 ViewModel 里统一用 `SharedFlow(replay=0)` 替代 `Channel` 暴露事件更合适，Flow 的操作符生态更丰富，`SharedFlow` 对多订阅者的支持语义也更明确。`Channel` 留在协程内部通信场景——比如 `channelFlow` 内部的并发任务协调。

**关于 `replay` 的默认值**：把它当成需要主动设置的参数，而不是随手填 1。每次设置前问自己：新订阅者是否需要历史数据？错过最近一条会有什么后果？

**关于 Repository 层的边界**：不要在 Repository 层用 `MutableStateFlow` 作为数据源。数据库和网络请求的生命周期由 ViewModel 的 `viewModelScope` 管理，Repository 只负责提供数据描述，不持有状态。这个边界一旦模糊，状态管理就会变成一团乱麻——这是我在多个项目里反复看到的问题。

冷热流的本质差异、Channel 的点对点语义、`replay` 的粘性语义——把这三个概念理解清楚，大多数 Flow 相关的工程决策都会自然收敛到合理的答案。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Kotlin 与协程](/kotlin-coroutines/)
- [Kotlin suspend 原理：CPS 变换、Continuation 与状态机字节码](/blog/2026-04-23-Kotlin_suspend_%E7%9A%84%E7%BC%96%E8%AF%91%E5%99%A8%E9%BB%91%E7%9B%92_%E4%BB%8E_CPS_%E5%8F%98%E6%8D%A2%E5%88%B0%E7%8A%B6%E6%80%81%E6%9C%BA%E5%AD%97%E8%8A%82%E7%A0%81%E7%9A%84%E5%AE%8C%E6%95%B4%E6%8E%A8%E6%BC%94/)
- [Kotlin Coroutines 与 Flow：协程调度、结构化并发和响应式数据流](/blog/Kotlin%20Coroutines%20%E4%B8%8E%20Flow%20%E7%9A%84%E9%AB%98%E7%BA%A7%E5%BA%94%E7%94%A8%E4%B8%8E%E5%8E%9F%E7%90%86/)
- [Kotlin K2 编译器解析：统一前端、类型推断与 Android 构建影响](/blog/2026-04-23-Kotlin_K2_%E7%BC%96%E8%AF%91%E5%99%A8%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E%E7%BB%9F%E4%B8%80%E5%89%8D%E7%AB%AF%E6%9E%B6%E6%9E%84%E5%88%B0%E6%99%BA%E8%83%BD%E7%B1%BB%E5%9E%8B%E6%8E%A8%E6%96%AD%E9%87%8D%E5%86%99%E7%9A%84%E7%BC%96%E8%AF%91%E9%9D%A9%E6%96%B0%E4%B8%8E_Android_%E5%B7%A5/)
<!-- /seo-internal-links -->
