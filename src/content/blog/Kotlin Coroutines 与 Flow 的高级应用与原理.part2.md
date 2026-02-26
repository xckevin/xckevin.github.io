---
title: "Kotlin Coroutines 与 Flow 的高级应用与原理（2）：结构化并发：告别协程泄漏与混乱"
excerpt: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 2/5 篇：结构化并发：告别协程泄漏与混乱"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Kotlin
  - 协程
  - Flow
series:
  name: "Kotlin Coroutines 与 Flow 的高级应用与原理"
  part: 2
  total: 5
seo:
  title: "Kotlin Coroutines 与 Flow 的高级应用与原理（2）：结构化并发：告别协程泄漏与混乱"
  description: "「Kotlin Coroutines 与 Flow 的高级应用与原理」系列第 2/5 篇：结构化并发：告别协程泄漏与混乱"
---
# Kotlin Coroutines 与 Flow 的高级应用与原理（2）：结构化并发：告别协程泄漏与混乱

> 本文是「Kotlin Coroutines 与 Flow 的高级应用与原理」系列的第 2 篇，共 5 篇。在上一篇中，我们探讨了「引言：告别回调地狱，拥抱结构化并发」的相关内容。

## 二、结构化并发：告别协程泄漏与混乱

这是协程区别于其他并发模型（如裸线程、GlobalScope）的核心优势。

### 1. 核心理念

协程的生命周期应该与执行它的某个作用域（Scope）绑定。当作用域结束时，其内部启动的所有协程都应该被自动取消。这极大地简化了资源管理，避免了「协程泄漏」。

### 2. 核心概念

- **CoroutineScope：** 定义协程的作用域。每个作用域都有一个关联的 CoroutineContext，其中通常包含一个 Job
- **Job：** 代表一个可取消的工作单元，具有生命周期状态（Active、Completing、Completed、Cancelling、Cancelled）。Job 可以组织成父子层级结构

### 3. 结构化并发的关键原则

- **作用域约束：** 协程必须在某个 CoroutineScope 内启动（使用 `launch`、`async` 等构建器）
- **生命周期绑定：** 协程的生命周期受其所在 CoroutineScope 的 Job 控制。取消 Scope 的 Job 会**递归地取消**其所有子 Job（及其协程）
- **父子关系：**
  - **父等子：** 父 Job 只有在其所有子 Job 都完成后才能进入完成状态
  - **子败父崩（默认）：** 如果一个子协程（非 SupervisorJob 下的直接子级）因为未捕获的异常而失败，它会取消它的父 Job，进而导致父 Job 取消所有其他子 Job

### 4. 常用作用域与构建器

- **GlobalScope：** **谨慎使用！** 这是一个全局单例 Scope，生命周期与整个应用进程绑定。在 GlobalScope 中启动的协程很容易泄漏，因为它们不会随特定的 UI 组件或业务逻辑结束而自动取消。主要用于某些顶层后台常驻任务（且需要极其小心的手动管理）
- **runBlocking { ... }：** 启动一个协程并**阻塞当前线程**直到其内部所有任务完成。主要用于连接阻塞代码与挂起世界（如在 main 函数或测试代码中调用 `suspend` 函数）。**切勿在 Android 主线程或协程内部使用（除非明确知道后果）**
- **coroutineScope { ... }（suspend 函数）：** 创建一个**结构化的嵌套作用域**。它会继承外部作用域的上下文，但拥有自己的 Job。它会**挂起**调用者，直到其内部启动的所有子协程都完成。如果其内部任何一个子协程失败，coroutineScope 自身会失败并重新抛出异常，同时取消其他子协程。常用于将一项工作分解为多个并行子任务，并等待它们全部完成
- **supervisorScope { ... }（suspend 函数）：** 与 coroutineScope 类似，也创建嵌套作用域并等待子任务完成。**关键区别：** 它使用 SupervisorJob。其直接子协程的失败**不会**导致 supervisorScope 本身失败，也**不会**取消其他兄弟子协程。异常需要由子协程自己处理（或通过 CoroutineExceptionHandler）。常用于需要隔离子任务失败影响的场景（如一个 UI 界面上有多个独立加载数据的区域）

### 5. Android Jetpack Scopes

- **viewModelScope（ViewModel 扩展属性）：** 预置在 ViewModel 中的 Scope，生命周期与 ViewModel 绑定（ViewModel `onCleared()` 时自动取消）。内部使用 SupervisorJob + Dispatchers.Main.immediate。**是在 ViewModel 中启动协程处理业务逻辑和数据加载的首选方式**
- **lifecycleScope（LifecycleOwner 扩展属性）：** 预置在 Activity/Fragment 中的 Scope，生命周期与组件的 Lifecycle 绑定（Lifecycle DESTROYED 时自动取消）。内部也使用 SupervisorJob + Dispatchers.Main.immediate。提供了 `launchWhenCreated`、`launchWhenStarted`、`launchWhenResumed` 等方法，可以在特定生命周期状态下启动协程，并在状态退出时自动暂停或取消

### 6. Job() vs. SupervisorJob()

- **Job()：** 子任务失败会导致父任务和所有兄弟任务被取消（默认的失败传递）
- **SupervisorJob()：** 子任务失败不会影响父任务或兄弟任务，实现失败隔离。viewModelScope 和 lifecycleScope 默认使用它。直接创建 `CoroutineScope(SupervisorJob() + ...)` 可以自定义使用

（图示：结构化并发 —— Job 层级与取消）

```plain
+---------------------------------------------+
| CoroutineScope (Parent Job)                 |
|---------------------------------------------|
|    launch { // Child Job 1                 |
|      ...                                    |
|      launch { // Grandchild Job 1.1        | --------+
|        ...                                  |         | Cancellation
|      }                                      |         | propagates down
|    } // Child Job 1 completes when 1.1 done |         V
|                                             |
|    async { // Child Job 2 (using default Job) |
|      ...                                    |
|      if (error) throw Exception() --------->|--- X (Failure)
|      ...                                    |
|    } // Failure here cancels Parent & Child 1|
|                                             |
|    launch(SupervisorJob()) { // Child Job 3 |
|      launch { // Grandchild Job 3.1        |
|        if (error) throw Exception() ------->|--- X (Failure) - Only 3.1 fails, 3 survives
|      }                                      |
|    } // Child Job 3 unaffected by 3.1 failure|
+---------------------------------------------+
   |
   | Parent Job completes only when ALL (non-failing or supervised) children complete.
   | If Parent Job is cancelled, ALL children are cancelled.
```

---

---

> 下一篇我们将探讨「调度器（Dispatchers）：协程在何处运行」，敬请关注本系列。

**「Kotlin Coroutines 与 Flow 的高级应用与原理」系列目录**

1. 引言：告别回调地狱，拥抱结构化并发
2. **结构化并发：告别协程泄漏与混乱**（本文）
3. 调度器（Dispatchers）：协程在何处运行
4. StateFlow & SharedFlow：热流状态与事件总线
5. 取消机制：优雅地停止
