---
title: "Kotlin Coroutines 与 Flow 的高级应用与原理（4）：StateFlow & SharedFlow：热流状态与事件总线"
excerpt: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 4/5 篇：StateFlow & SharedFlow：热流状态与事件总线"
publishDate: 2025-03-30
displayInBlog: false
tags:
  - Android
  - Kotlin
  - 协程
  - Flow
series:
  name: "Kotlin Coroutines 与 Flow 的高级应用与原理"
  part: 4
  total: 5
seo:
  title: "Kotlin Coroutines 与 Flow 的高级应用与原理（4）：StateFlow & SharedFlow：热流状态与事件总线"
  description: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 4/5 篇：StateFlow & SharedFlow：热流状态与事件总线"
---
> 本文是「Kotlin Coroutines 与 Flow 的高级应用与原理」系列的第 4 篇，共 5 篇。在上一篇中，我们探讨了「调度器（Dispatchers）：协程在何处运行」的相关内容。

## 五、StateFlow & SharedFlow：热流状态与事件总线

冷流在某些场景下不适用，例如需要多个订阅者接收相同的数据流（而不是重新执行），或者需要表示一个可观察的当前状态。

### 1. StateFlow\<T\> —— 状态表示的热流

**特性：**

- **热流（Hot）：** 存在时就有值，独立于是否有收集者
- **状态容器：** 持有单一的、最新的状态值
- **初始值：** 创建时必须提供一个初始值
- **立即获取：** 新的收集者会立即收到当前的最新状态值
- **值比较：** 只会发射与前一个值 `equals()` 结果为 false 的新值（去重）
- **合并（Conflation）：** 内部机制保证收集者只会收到最新的状态，中间过快产生的状态会被「合并」掉（类似于 `conflate()`）

**MutableStateFlow\<T\>：** 可变的 StateFlow，提供 `value` 属性进行读写，`update { ... }` 原子更新，`tryEmit()` 非挂起尝试发射。

**应用场景：** **ViewModel 中向 UI 层暴露状态的最佳实践之一。** UI 层通过 `stateIn(scope, SharingStarted.WhileSubscribed(5000), initialValue)` 将冷流转换为 StateFlow，或者直接使用 MutableStateFlow，然后 UI 层用 `collectAsStateWithLifecycle` 收集。

### 2. SharedFlow\<T\> —— 通用型热流/事件总线

**特性：**

- **热流（Hot）：** 独立于收集者存在
- **广播：** 可以将值广播给所有当前的收集者
- **高度可配置：** 通过构造函数参数控制其行为：
  - **replay：** (Int) 向**新加入**的收集者回放多少个最近发射过的值。0 表示不回放（新收集者只收到后续的新值）。1 以上用于缓存历史值
  - **extraBufferCapacity：** (Int) 在 replay 缓存之外，为活跃收集者提供的额外缓冲空间，用于应对背压。0 表示没有额外缓冲
  - **onBufferOverflow：** (BufferOverflow) 当缓冲区（replay + extraBufferCapacity）已满时，新的 emit 操作的行为：SUSPEND（挂起，默认）、DROP_OLDEST（丢弃最旧的值）、DROP_LATEST（丢弃最新的值）

**MutableSharedFlow\<T\>：** 可变的 SharedFlow，提供 `emit()`（挂起）和 `tryEmit()`（非挂起）方法发射值。`subscriptionCount: StateFlow<Int>` 可观察当前活跃收集者数量。

**应用场景：**

- **事件总线：** 需要将事件（如用户操作、后台通知）广播给多个监听者。需要特别注意「一次性事件」的处理（见下文）
- **需要回放历史数据的热流**
- 实现自定义 StateFlow 行为（通过特定配置）

**关键考量：**

- **参数选择：** replay、extraBufferCapacity、onBufferOverflow 的选择对 SharedFlow 的行为至关重要，必须根据具体需求仔细设定，否则可能导致事件丢失、内存泄漏（如果缓存过大）或死锁（如果 SUSPEND 策略下没有收集者消费）
- **一次性事件处理（Single-Shot Events）：** 如果使用 SharedFlow 传递需要**确保只被处理一次**的事件（如显示 Toast、导航），需要特别小心。因为配置更改等原因可能导致 UI 层重新订阅，如果 replay > 0，可能会收到并再次处理旧事件。常用解决方案包括：(1) 使用 Channel 替代；(2) 在下游使用某种机制标记事件已被消费；(3) 配合 Event 包装类

---

## 六、Channel：协程间的信使

Channel 是协程提供的另一种热流（或称为通信原语），类似于线程安全的阻塞队列（BlockingQueue），但使用 `suspend` 函数进行发送和接收。

### 1. 特性

- 热的，数据在发送者和接收者之间传递
- `send(element)`：挂起发送者直到元素被接收者 `receive()`（或放入缓冲区）
- `receive()`：挂起接收者直到 Channel 中有元素可供接收
- 支持不同容量和策略：RENDEZVOUS（0 容量，发送/接收必须配对）、BUFFERED（有限容量）、CONFLATED（只保留最新）、UNLIMITED（无限容量，小心内存）

### 2. 构建器

`Channel<E>(capacity)`、`produce<E>(context, capacity) { ... }`（返回 `ReceiveChannel<E>`）

### 3. callbackFlow\<T\> { ... } / channelFlow\<T\> { ... }

- **目的：** 将基于回调的 API 或需要主动推送数据的逻辑桥接为冷 Flow
- **机制：** 内部创建一个 Channel。提供一个 ProducerScope（继承自 CoroutineScope，并实现了 SendChannel），可以在其中安全地调用 `send()` 或 `trySend()` 来发射数据。必须调用 `awaitClose { cleanup_logic }`，它会在 Flow 被取消或关闭时执行，用于注销回调或清理资源，**防止泄漏**
- **区别：** channelFlow 是 callbackFlow 的更通用版本，callbackFlow 对回调 API 做了些优化（如保证 send 安全）

### 4. 应用场景

协程间的生产者-消费者模式、需要精确控制发送/接收同步的场景、桥接回调 API。

---

## 七、高级异常处理：优雅地应对失败

协程的结构化并发对异常处理有重要影响。

### 1. 基本 try-catch

在 `launch` 或 `async` 代码块内部使用 try-catch 可以捕获其内部代码（包括调用的 `suspend` 函数）抛出的异常。这是最直接的处理方式。

### 2. 结构化并发的传播

- **默认 Job：** 如果一个协程（非 SupervisorJob 的直接子级）发生未捕获异常，该异常会**向上**传播给父 Job，导致父 Job 和所有其他兄弟 Job 被取消。异常最终可能导致应用崩溃
- **async 的异常：** async 启动的协程如果发生异常，异常会被**持有**，直到调用 `await()` 时才会被抛出。如果不调用 `await()`，异常可能「丢失」（除非父作用域被取消）

### 3. CoroutineExceptionHandler —— 最后的防线

- **角色：** 作为一个 CoroutineContext 元素，用于处理**未被捕获**的异常（即没有被 try-catch 住，并且传播到了 Scope 的边界或 GlobalScope）
- **目的：** **记录日志、上报错误**。它**不能**阻止协程或其作用域的取消过程
- **安装位置：** 通常安装在**顶层作用域**（如 GlobalScope、viewModelScope、lifecycleScope）或顶层 `launch` 构建器中。安装在子协程或非 SupervisorJob 的中间作用域通常无效（因为异常会先取消父级）

### 4. supervisorScope 与异常隔离

在 `supervisorScope { ... }` 内部，其**直接子协程**的失败**不会**传播给 supervisorScope 本身或其他兄弟子协程。失败的子协程需要**自己**处理异常（通过 try-catch 或安装在其 `launch` 构建器中的 CoroutineExceptionHandler）。

### 5. Flow 的异常处理

- **下游 try-catch：** `collect` 调用者可以用 try-catch 捕获来自 collect 本身、上游所有操作符以及 flow 构建器内部抛出的异常
- **catch { e -> emit(...) } 操作符：**
  - **只捕获上游异常：** 仅捕获其**上游**（包括 builder 和之前的操作符）发生的异常
  - **提供恢复/转换：** 可以在 catch 块中 emit 一个备用值，或者记录日志，或者 throw 一个不同的异常
  - **不捕获下游异常：** catch 操作符**无法**捕获其下游（如 collect 内部）发生的异常
- **onCompletion { cause: Throwable? -> ... } 操作符：**
  - 无论 Flow 是正常完成还是因异常终止，onCompletion 块都会执行
  - cause 参数在异常终止时为非 null，否则为 null
  - **用途：** 执行清理逻辑（类似 finally），无论成功或失败

---

---

> 下一篇我们将探讨「取消机制：优雅地停止」，敬请关注本系列。

**「Kotlin Coroutines 与 Flow 的高级应用与原理」系列目录**

1. 引言：告别回调地狱，拥抱结构化并发
2. 结构化并发：告别协程泄漏与混乱
3. 调度器（Dispatchers）：协程在何处运行
4. **StateFlow & SharedFlow：热流状态与事件总线**（本文）
5. 取消机制：优雅地停止
