---
title: 深入 Kotlin 协程的协作式取消机制：从 CancellationException 传播到 NonCancellable 的安全退出全链路
slug: kotlin-coroutine-cooperative-cancellation
translationKey: kotlin-coroutine-cooperative-cancellation
excerpt: 深入剖析 Kotlin 协程的协作式取消模型，详解 CancellationException 的传播规则与 NonCancellable 的安全退出机制，并结合实际案例总结结构化并发下的最佳取消策略与常见踩坑点。
publishDate: '2026-07-01'
tags:
- Kotlin
- 协程
- CancellationException
- NonCancellable
- 结构化并发
seo:
  title: 深入 Kotlin 协程的协作式取消机制：从 CancellationException 传播到 NonCancellable 的安全退出全链路
  description: 从线上协程未正常取消的问题出发，深入讲解 Kotlin 协作式取消机制：CancellationException 的传播规则、NonCancellable 安全清理、结构化并发取消策略及常见踩坑点。
---

上周排查一个线上问题：用户退出页面后，网络请求的协程没有按预期取消，继续占着连接池资源。代码里明明调了 `job.cancel()`，日志却显示协程体还在跑。

这引出协程设计中一个容易被误解的特性：**取消是协作式的，不是抢占式的**。

## 协作式取消模型

线程可以暴力中断（`Thread.stop()` 早已被废弃），协程没有这个能力。协程的取消依赖一个前提：**被取消的代码主动检查自身状态并抛出异常**。

`job.cancel()` 做了两件事：将 Job 的状态置为取消中（Cancelling），然后向协程内部发送取消信号。这个信号本身不打断正在执行的代码——它只是设置了一个标志位。真正让协程停下来的，是挂起函数在恢复时检测到这个标志位后抛出的 `CancellationException`。

```kotlin
// job.cancel() 只是发信号，不打断 1-10 的打印
runBlocking {
    val job = launch {
        for (i in 1..10) {
            println("running: $i")
            Thread.sleep(100) // 没有挂起点，取消信号无法被响应
        }
    }
    delay(200)
    job.cancel()
    println("cancel called, but coroutine still running...")
}
```

这段代码中 `Thread.sleep` 不会响应取消，loop 会完整跑完。要让取消生效，需要引入挂起函数：

```kotlin
val job = launch {
    for (i in 1..10) {
        println("running: $i")
        delay(100) // delay 会检查取消状态并抛出 CancellationException
    }
}
```

`delay` 在恢复时会调用 `ensureActive()`，检测到取消后立即抛出 `CancellationException`。

## CancellationException 的特殊传播规则

`CancellationException` 继承自 `IllegalStateException`，但它在协程框架中被特殊对待：**不会传播给父协程，也不触发 `CoroutineExceptionHandler`**。

这个设计很合理——取消是协程生命周期中的正常行为，不是程序错误。被取消的子协程将异常"静默"地吞掉，只通知父协程调整自身状态。

举个例子：

```kotlin
runBlocking {
    val handler = CoroutineExceptionHandler { _, e ->
        println("caught: $e")  // 这行不会执行
    }
    val scope = CoroutineScope(handler)
    scope.launch {
        delay(100)
        throw CancellationException("manual cancel")
    }.join()
    println("continue normally") // 正常执行到这里
}
```

换成普通异常：

```kotlin
scope.launch {
    delay(100)
    throw RuntimeException("real error")
}.join()
// 触发 handler，且父协程被取消
```

实际项目中我踩过一个坑：在 `try-catch` 中捕获 `CancellationException` 后没有重新抛出，导致协程无法正常取消：

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } catch (e: CancellationException) {
        log("cancelled, but silently swallowed") // Bug：吃掉了异常！
    }
}
```

**正确做法：`catch` 后必须 `rethrow`，除非你明确知道自己在做什么。**

## 异常在协程树中的传播路径

一个 Job 被取消后，取消会向下传播到所有子协程。调用链如下：

1. `parentJob.cancel()` → 遍历子 Job 列表，递归调用 `childJob.cancel()`
2. 每个子 Job 收到取消信号后，在下一次挂起恢复时抛出 `CancellationException`
3. 子 Job 的 `CancellationException` **不会**反向传播给父 Job
4. 所有子 Job 完成后，父 Job 状态从 Cancelling 变为 Cancelled

这里第 3 步是关键——取消是单向的：父取消子，子不污染父。

如果取消过程中某个子协程抛出了非 `CancellationException` 的异常，情况就不同了——那个异常会正常向上传播，可能导致父协程收到意料之外的错误。这也解释了为什么在取消回调中要小心处理：

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        // 这里如果 throw 非 CancellationException，父协程会被污染
        throw RuntimeException("cleanup failed")
    }
}
```

## NonCancellable：安全退出的最后防线

取消发生后，`finally` 块中的资源清理代码仍然运行。但这里有一个限制：`finally` 中不能调用挂起函数——当前协程已经被取消了，任何挂起点都会立即抛出 `CancellationException`。

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        delay(100) // 立即抛出 CancellationException，清理逻辑中断
        releaseResource()
    }
}
```

`releaseResource()` 永远不会执行。这是资源泄漏的温床。

`NonCancellable` 解决了这个问题。它本质是一个特殊的 `Job` 实现，永远不响应取消信号。用 `withContext(NonCancellable)` 包裹的代码块可以安全调用任意挂起函数：

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        withContext(NonCancellable) {
            delay(100) // 不受取消影响，正常挂起
            releaseResource() // 安全执行
        }
    }
}
```

`withContext` 切换了当前协程的上下文，其中的 Job 不再是原始的被取消 Job，而是一个永远 active 的 Job。挂起函数检查的是当前上下文中的 Job 状态，所以不会触发取消。

## 结构化并发下的取消策略

协程的树状结构本身提供了天然的取消边界。一个 UI 组件启动的协程，在组件销毁时只需取消根 Job，所有子树自动清理。不需要手动维护协程列表。

在实际项目中，我更倾向于用 `coroutineScope` 或 `supervisorScope` 划分取消边界：

```kotlin
suspend fun loadPageData() = coroutineScope {
    val data = async { fetchData() }
    val config = async { fetchConfig() }
    // 任一子任务失败，其余自动取消
    Pair(data.await(), config.await())
}
```

如果需要子任务独立失败不影响其他，换成 `supervisorScope`：

```kotlin
suspend fun loadPageDataSafe() = supervisorScope {
    val data = async { fetchData() }
    val config = async { fetchConfig() }
    // data 失败不影响 config
    Pair(data.await(), config.await())
}
```

## 几个容易踩坑的点

**`isActive` 和 `ensureActive()` 的区别。** `isActive` 是只读检查，返回 false 后不抛异常，适合在循环条件中使用。`ensureActive()` 是主动检查，在非活跃状态下直接抛 `CancellationException`。不要用 `isActive` 做判断后手动 throw，直接用 `ensureActive()` 语义更清晰。

**`cancelAndJoin()` 不是银弹。** 它等价于 `cancel()` + `join()`，确保协程完全退出后才继续。但如果协程卡在不可取消的阻塞操作中（比如长时间 IO 调用、纯 CPU 计算），`cancelAndJoin()` 会一直等下去。必要时配合超时：

```kotlin
withTimeoutOrNull(3000) { job.cancelAndJoin() } ?: println("force giving up")
```

**资源清理不要放在 `invokeOnCompletion` 中做复杂操作。** 这个回调在工作线程执行，不适合调用挂起函数。清理逻辑应该放在协程体的 `finally` 块中，结合 `withContext(NonCancellable)` 处理挂起需求。

协作式取消的核心就一条：你的代码必须给协程检查取消状态的机会。挂起点是天然的检查点，纯 CPU 密集代码需要手动插入 `yield()` 或 `ensureActive()`。`NonCancellable` 是退出阶段的安全出口，但用它的前提是你清楚自己在绕过取消机制——不要在 `NonCancellable` 块里执行耗时不确定的操作，否则协程可能永远退不出。
