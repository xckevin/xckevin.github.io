---
title: "Kotlin Coroutines 与 Flow 的高级应用与原理（3）：调度器（Dispatchers）：协程在何处运行"
excerpt: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 3/5 篇：调度器（Dispatchers）：协程在何处运行"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Kotlin
  - 协程
  - Flow
series:
  name: "Kotlin Coroutines 与 Flow 的高级应用与原理"
  part: 3
  total: 5
seo:
  title: "Kotlin Coroutines 与 Flow 的高级应用与原理（3）：调度器（Dispatchers）：协程在何处运行"
  description: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 3/5 篇：调度器（Dispatchers）：协程在何处运行"
---
# Kotlin Coroutines 与 Flow 的高级应用与原理（3）：调度器（Dispatchers）：协程在何处运行

> 本文是「Kotlin Coroutines 与 Flow 的高级应用与原理」系列的第 3 篇，共 5 篇。在上一篇中，我们探讨了「结构化并发：告别协程泄漏与混乱」的相关内容。

## 三、调度器（Dispatchers）：协程在何处运行

CoroutineDispatcher 决定了协程代码实际在哪个线程或线程池上执行。它是 CoroutineContext 的一部分。

### 1. 标准调度器

- **Dispatchers.Default：**
  - **线程池：** 由 JVM 共享的后台线程池，大小通常等于 CPU 核心数（至少为 2）
  - **适用：** CPU 密集型计算（排序、解析复杂数据、图像处理等不涉及阻塞 IO 的操作）。不应在此执行阻塞 IO
- **Dispatchers.IO：**
  - **线程池：** 由 JVM 共享的、可按需创建更多线程的后台线程池（上限较高，如 64 个或更多）
  - **适用：** 阻塞式 IO 操作（网络请求、文件读写、数据库访问等）。因为 IO 操作大部分时间线程处于阻塞等待状态，需要更多线程来提高并发吞吐量
- **Dispatchers.Main：**
  - **线程：** Android 应用的主线程（UI 线程）
  - **适用：** 任何需要与 UI 交互的操作（更新 View、显示 Toast）、调用需要主线程执行的 Android API
  - **.immediate：** Dispatchers.Main.immediate 是一个优化。如果当前已经在主线程，它会尝试立即执行协程代码，而不是先 post 到事件队列再执行，可能减少一点延迟。但在复杂情况下行为需注意
- **Dispatchers.Unconfined：**
  - **行为：** 协程启动时在**当前调用者线程**执行，但在第一个挂起点**恢复**时，会由**恢复该协程的线程**（即执行 `continuation.resumeWith` 的线程）继续执行。执行线程可能在挂起/恢复之间发生变化
  - **适用：** **非常有限**。通常不需要在普通应用代码中使用。可能用于某些需要极低延迟且不关心执行线程的场景，或某些框架/库的内部实现。**容易导致线程混乱，不推荐常规使用**

### 2. 切换调度器 —— withContext(Dispatcher) { ... }

- **作用：** 在协程内部临时切换到指定的 Dispatcher 执行代码块，执行完毕后自动切回原来的 Dispatcher。这是一个 `suspend` 函数
- **核心用途：** **将在特定线程上执行的任务（如 IO 操作、CPU 计算）封装起来，同时保持调用者代码的简洁性。** 例如，在 viewModelScope（主线程）启动的协程中，使用 `withContext(Dispatchers.IO)` 来执行网络或数据库操作
- **返回值：** withContext 会返回其代码块的执行结果

```kotlin
viewModelScope.launch { // Starts on Dispatchers.Main.immediate
    val userData = fetchUserData() // Calls suspend function below
    updateUi(userData) // Back on Main thread automatically
}

suspend fun fetchUserData(): UserData {
    // Switch to IO dispatcher for network call
    return withContext(Dispatchers.IO) {
        // This block runs on an IO thread
        val response = RetrofitClient.api.getUser()
        processResponse(response) // Still on IO thread
    } // Switches back to the original caller's dispatcher (Main) after block completes
}
```

---

## 四、Flow 深入：协程时代的响应式流

Flow 是 Kotlin 协程生态中处理异步数据流的核心工具。

### 1. 冷流（Cold Stream）特性

- Flow 默认是**冷**的。意味着只有当存在**终端操作符（Terminal Operator）**（如 `collect`）订阅它时，Flow 构建器（`flow { ... }`）内部的代码才会开始执行
- **每个终端操作符都会触发一次独立的 Flow 执行。** 如果有多个 `collect` 调用，`flow { ... }` 内的代码会被执行多次

### 2. 核心组成

- **Builders：** 创建 Flow 实例（`flow { emit(T) }`、`flowOf(T...)`、`List<T>.asFlow()`、`channelFlow`、`callbackFlow`）
- **Intermediate Operators（中间操作符）：** 对 Flow 进行转换、过滤、组合，返回一个新的 Flow，本身不触发执行（`map`、`filter`、`transform`、`zip`、`combine`、`flatMapConcat`、`flatMapMerge`、`flatMapLatest`、`flowOn`、`buffer`、`conflate`、`catch`、`onCompletion` 等）。这些操作符通常是 `suspend` 函数或内联函数
- **Terminal Operators（终端操作符）：** 消费 Flow，触发其执行，通常是 `suspend` 函数（`collect`、`first`、`single`、`toList`、`toSet`、`count`、`reduce`、`fold`、`launchIn(scope)`）

### 3. flowOn(Dispatcher) —— 指定上游运行线程

- **关键作用：** 改变执行 flow 构建器以及**它之前**所有中间操作符的 CoroutineContext（特别是 Dispatcher）
- **用法：** `myRepository.getData().map { ... }.flowOn(Dispatchers.IO).collect { ... }`。这里，`getData()`（假设是 `flow { ... }`）和 `map` 操作会在 Dispatchers.IO 上执行，而 `collect` 会在调用者的上下文中执行（例如主线程）
- **对比 withContext：** withContext 用于改变一小段代码块的上下文；flowOn 影响整个上游 Flow 的执行上下文

### 4. 背压处理（Backpressure）：生产者快于消费者怎么办？

- **默认行为：** 挂起。当 `collect` 处理不过来时，上游的 `emit` 调用会被挂起，等待 `collect` 处理完当前元素
- **缓冲（buffer(capacity)）：**
  - 在生产者和消费者之间引入一个缓冲区（内部使用 Channel）。生产者可以向缓冲区快速 emit（直到缓冲区满），消费者则从缓冲区取出数据处理
  - 允许生产者和消费者并发执行，提高吞吐量
  - capacity：缓冲区大小。Channel.BUFFERED（默认 64）、Channel.CONFLATED（只保留最新）、Channel.RENDEZVOUS（容量 0，类似无缓冲）
  - 需要注意缓冲区可能消耗额外内存
- **合并（conflate()）：**
  - 当生产者发出新值时，如果消费者还在处理旧值，则**丢弃**缓冲区中所有未处理的值，只保留**最新**的值给消费者
  - 适用于只需要关心最新状态的场景（如 UI 更新）
- **处理最新（collectLatest { action }）：**
  - 终端操作符。当 Flow 发出一个新值时，如果**之前**的值对应的 action 挂起函数仍在执行，则**取消**之前的 action，并为新值启动一个新的 action
  - 适用于只需要响应最新事件的场景（例如，用户快速输入触发搜索，只需要处理最后一次输入的搜索请求）

（图示：Flow 背压策略）

```plain
Producer:  --E1---E2---E3---E4---E5--> emit()

Collector:  | Process(E1) | Process(E2) | Process(E3) | ... -> collect() (Slow)

Default (Suspend):
Producer:  --E1(sus)E2(sus)E3(sus)E4---> emit() waits for collector

buffer(1): (Producer runs ahead slightly)
Buffer:    [E2] [E3]
Producer:  --E1---E2---E3---E4-------> emit() fills buffer then suspends
Collector:  | Process(E1) | Process(E2) | Process(E3) | ... -> collect() takes from buffer

conflate(): (Only latest matters)
Producer:  --E1---E2---E3---E4---E5--> emit() continuously
Collector:  | Process(E1) | Process(E3) | Process(E5) | ... -> collect() gets latest when ready

collectLatest(): (Cancel previous processing)
Producer:  --E1---E2---E3---E4---E5--> emit()
Collector Action: | Prc(E1) | Prc(E2) | Prc(E3)-cancel| Prc(E4)-cancel| Process(E5) | ...
```

---

---

> 下一篇我们将探讨「StateFlow & SharedFlow：热流状态与事件总线」，敬请关注本系列。

**「Kotlin Coroutines 与 Flow 的高级应用与原理」系列目录**

1. 引言：告别回调地狱，拥抱结构化并发
2. 结构化并发：告别协程泄漏与混乱
3. **调度器（Dispatchers）：协程在何处运行**（本文）
4. StateFlow & SharedFlow：热流状态与事件总线
5. 取消机制：优雅地停止
