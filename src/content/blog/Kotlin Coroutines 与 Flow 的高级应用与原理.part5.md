---
title: "Kotlin Coroutines 与 Flow 的高级应用与原理（5）：取消机制：优雅地停止"
excerpt: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 5/5 篇：取消机制：优雅地停止"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Kotlin
  - 协程
  - Flow
series:
  name: "Kotlin Coroutines 与 Flow 的高级应用与原理"
  part: 5
  total: 5
seo:
  title: "Kotlin Coroutines 与 Flow 的高级应用与原理（5）：取消机制：优雅地停止"
  description: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 5/5 篇：取消机制：优雅地停止"
---
# Kotlin Coroutines 与 Flow 的高级应用与原理（5）：取消机制：优雅地停止

> 本文是「Kotlin Coroutines 与 Flow 的高级应用与原理」系列的第 5 篇，共 5 篇。在上一篇中，我们探讨了「StateFlow & SharedFlow：热流状态与事件总线」的相关内容。

## 八、取消机制：优雅地停止

协程的取消也是基于结构化并发和协作机制。

### 1. 传播

取消请求会从父 Job 向下传播到所有子 Job。调用 `scope.cancel()` 或 `job.cancel()`。

### 2. 协作式（Cooperative）

协程代码需要**主动**检查取消状态并做出响应，才能被有效取消。

- **内置检查点：** 所有 kotlinx.coroutines 库中的**挂起函数**（如 `delay`、`yield`、`withContext`、`channel.receive`、Flow 操作符等）内部都会检查当前协程是否已被取消。如果已取消，它们会抛出 `CancellationException`
- **手动检查：** 对于长时间运行的、**不包含**挂起函数调用的 CPU 密集型计算循环，必须**手动**检查取消状态：
  - `if (!isActive) return` 或 `if (!isActive) throw CancellationException()`
  - `ensureActive()`：如果已取消则抛出 `CancellationException`
  - `yield()`：挂起当前协程并允许其他协程运行，同时也会检查取消状态
- **CancellationException：** 这是协程取消的标准信号，通常被认为是正常流程，默认的异常处理器（如 CoroutineExceptionHandler）通常会忽略它

### 3. NonCancellable Context

- **场景：** 在 finally 块或 onCompletion 中执行必须完成的清理操作（如释放文件句柄、关闭网络连接），即使协程已经被取消
- **用法：** `withContext(NonCancellable) { // cleanup code }`。在此代码块内，协程暂时不会响应取消请求。**谨慎使用，避免执行耗时操作**

:::danger
千万注意：

- **不要乱 catch：** 如果你在代码中 `catch (e: Exception)`，请务必将 `CancellationException` 重新抛出（`throw e`），否则协程会「假装没听见」取消信号，继续运行，导致资源浪费或内存泄漏
- **非 cancellable 的 suspend 函数：** 如果协程卡在一个不检查取消状态的 suspend 函数（如某些 IO 操作）上，它可能无法及时响应取消
:::

---

## 九、测试协程与 Flow

kotlinx-coroutines-test 库提供了强大的测试支持。

### 1. runTest { ... }

- **核心测试构建器：** 取代 runBlockingTest。提供一个 TestScope，运行在 TestDispatcher 上
- **虚拟时间：** 默认情况下，`delay` 等时间相关的挂起函数会立即完成（虚拟时间推进），使得测试无需实际等待
- **调度器控制：** 可以注入和控制 TestDispatcher（如 StandardTestDispatcher、UnconfinedTestDispatcher）来管理协程的执行顺序和时间

### 2. TestCoroutineScheduler

提供对虚拟时间的更精细控制（`advanceTimeBy`、`runCurrent`）。

### 3. 测试 Flow

- 在 runTest 中直接 collect Flow
- 使用第三方库 **Turbine**（app.cash.turbine:turbine）提供了更简洁、更强大的 Flow 测试 API，如 `flow.test { awaitItem(), expectNoEvents(), awaitComplete(), ... }`

### 4. 依赖注入

**最佳实践**是在 ViewModel、Repository 等类中注入 CoroutineDispatcher（而不是直接使用 Dispatchers.IO 等），这样在测试中可以方便地替换为 TestDispatcher。

---

## 十、Coroutines vs. RxJava vs. Threads

- **Coroutines vs. Threads：** 协程更轻量，易于管理，结构化并发避免泄漏，代码更简洁
- **Coroutines vs. RxJava：**
  - **相似性：** 都处理异步数据流
  - **差异性：**
    - **范式：** 协程基于挂起函数，代码更接近同步风格；RxJava 基于观察者模式和链式操作符
    - **简洁性：** 协程通常样板代码更少
    - **结构化并发：** 协程内置支持更好
    - **操作符：** RxJava 拥有极其丰富的操作符生态；Flow 的操作符也在不断完善
    - **学习曲线：** 协程通常被认为更容易上手
  - **互操作：** kotlinx-coroutines-rx3（或 rx2）库提供了在两者之间转换的方法（如 `Flow.asObservable()`、`Observable.asFlow()`）

对于新项目，尤其基于 Kotlin，协程 + Flow 通常是首选。对于已有大量 RxJava 代码的项目，可以逐步迁移或混合使用。

---

## 十一、常见陷阱与最佳实践

- **阻塞调度器：** 在 Dispatchers.Default 执行阻塞 IO，或在 Dispatchers.IO 执行 CPU 密集长计算
- **滥用 GlobalScope：** 导致潜在泄漏和测试困难。优先使用 viewModelScope、lifecycleScope 或自定义 Scope
- **忘记检查取消：** 在无挂起函数的长循环中不检查 `isActive`
- **异常处理不当：** 错误地认为 CoroutineExceptionHandler 能阻止取消；async 异常未被 await 捕获；supervisorScope 下的子协程异常未处理
- **SharedFlow 配置错误：** 对 replay/buffer/overflow 理解不清，导致事件丢失或行为不符预期，尤其对于「一次性事件」
- **callbackFlow/channelFlow 忘记 awaitClose：** 导致回调/监听器泄漏
- **过度使用 Dispatchers.Unconfined：** 导致线程行为难以预测
- **硬编码 Dispatcher：** 不利于测试。应通过 DI 注入 Dispatcher
- **UI 层收集 Flow 未使用 collectAsStateWithLifecycle：** 可能导致后台不必要的资源消耗
- **StateFlow 与 SharedFlow 选择不当：** 用 StateFlow 处理需要保证送达的事件流（可能丢失），或用 SharedFlow 处理只需最新值的状态（效率不高且可能收到旧值）

---

## 十二、结论：并发编程的现代利器

Kotlin Coroutines 与 Flow 为 Android 开发者提供了强大、现代且优雅的异步编程解决方案。它们通过轻量级的协程、革命性的结构化并发、灵活的调度器以及功能丰富的响应式流（Flow），极大地简化了并发代码的编写、管理和测试，有效解决了传统方式下的诸多痛点。

精通协程与 Flow 意味着不仅能熟练运用 API，更能深刻理解其**挂起与恢复的本质、状态机转换、结构化并发的生命周期与异常传播机制、不同调度器的适用场景与性能影响、Flow 冷热流模型与背压策略、StateFlow/SharedFlow 的精妙配置与应用场景，以及协程取消与异常处理的各种细节**。

掌握这些高级原理与实践，才能在面对日益复杂的业务逻辑和用户体验要求时，自信地构建出高性能、高并发、高稳定性的 Android 应用，将异步编程的复杂性化繁为简。这是现代 Android 高级工程师必备的核心技能。

---

**「Kotlin Coroutines 与 Flow 的高级应用与原理」系列目录**

1. 引言：告别回调地狱，拥抱结构化并发
2. 结构化并发：告别协程泄漏与混乱
3. 调度器（Dispatchers）：协程在何处运行
4. StateFlow & SharedFlow：热流状态与事件总线
5. **取消机制：优雅地停止**（本文）
