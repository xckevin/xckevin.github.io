---
title: 深入 Android 线程池与并发编程全链路：从 ThreadPoolExecutor 调参到协程调度器底层映射的工程实践
excerpt: 本文系统梳理了 Android 并发编程体系中线程池的核心参数调优、队列选型与拒绝策略，深入剖析了 Kotlin 协程调度器与底层线程池的映射关系，并给出了线程池监控、生命周期管理等工程实践方案。
publishDate: '2026-06-18'
tags:
- Android
- 线程池
- 并发编程
- Kotlin协程
- 性能优化
seo:
  title: 深入 Android 线程池与并发编程全链路：从 ThreadPoolExecutor 调参到协程调度器底层映射的工程实践
  description: 从 ThreadPoolExecutor 参数调优、队列选型、拒绝策略，到 Kotlin 协程调度器底层线程池映射，系统讲解 Android 并发编程的工程落地与线程治理实践。
---

去年接手一个即时通讯模块的优化，线上 ANR 率 2.3%。Trace 打开，全场共用一个无界线程池处理消息收发，高峰期线程数干到 200+。**Android 面试里人人能背四种线程池，但工程落地时，大多数人停在 Handler 和协程之间，对中间地带一知半解。**

## 线程池在 Android 并发体系中的位置

Android 并发编程有三个核心工具：

- **Handler/Looper**：单线程串行，适合 UI 操作和简单异步
- **ThreadPoolExecutor**：多线程并行，适合计算密集和批量 I/O
- **Kotlin 协程**：结构化并发，适合复杂异步流程编排

很多项目的问题是：Handler 不够用就直接上协程，跳过了线程池这个合理的中间层。协程的调度器底层依然依赖线程池，不理解这个映射关系，协程用起来就是在「凭感觉调参」。

## 核心参数：不是背公式，是理解行为

```kotlin
ThreadPoolExecutor(
    corePoolSize = 4,           // 核心线程数
    maximumPoolSize = 8,        // 最大线程数
    keepAliveTime = 30, TimeUnit.SECONDS,
    workQueue = LinkedBlockingQueue(128),
    threadFactory = NamedThreadFactory("msg"),
    rejectedExecutionHandler = CallerRunsPolicy()
)
```

线程池处理任务时依次判断三个条件：

1. 当前线程数 < corePoolSize → **直接创建新线程**，不管有没有空闲线程
2. 当前线程数 ≥ corePoolSize 且队列未满 → 入队等待
3. 队列满了且线程数 < maximumPoolSize → 创建非核心线程执行

这个逻辑有个反直觉的地方：**corePoolSize 设得太大，队列几乎不走任务**，因为优先创建线程而不是入队。我见过一个项目 corePoolSize 设了 32，队列指标永远是 0，线程数一直维持在 32，完全失去了线程池「复用」的本意。

### 队列选型：不是越大越好

```kotlin
// 有界队列——推荐的工程选择
LinkedBlockingQueue(128)

// 同步队列——要求线程数即时匹配
SynchronousQueue()

// 优先级队列——按任务优先级排序
PriorityBlockingQueue(64)
```

有界队列是工程上的安全选择。不指定容量的无界队列，一旦任务提交速度持续大于处理速度，队列无限堆积，最终 OOM。SynchronousQueue 适合 burst 场景，但在 Android 端容易触发 RejectedExecutionException，需要配合合理的拒绝策略。

## 拒绝策略：CallerRunsPolicy 是 Android 端的解药

四种拒绝策略中，Android 场景下我对 **CallerRunsPolicy** 有明确偏好：

```kotlin
// 在被拒绝时，由调用线程直接执行任务
val executor = ThreadPoolExecutor(
    corePoolSize = 4, maximumPoolSize = 8,
    keepAliveTime = 30, TimeUnit.SECONDS,
    workQueue = LinkedBlockingQueue(64),
    rejectedExecutionHandler = ThreadPoolExecutor.CallerRunsPolicy()
)
```

选它的理由很实际：**CallerRunsPolicy 天然提供背压机制**。线程池满负荷时，提交任务的线程（通常是主线程或生产者线程）自己执行任务，自然减缓新任务的提交速度。其他三种策略——AbortPolicy 抛异常、DiscardPolicy 静默丢弃、DiscardOldestPolicy 丢弃队首任务——都不适合需要保证任务不丢失的 Android 业务场景。

踩过的坑：CallerRunsPolicy 在主线程提交任务时，可能让主线程执行耗时操作导致 ANR。解法是确保提交到线程池的任务不会从主线程发起，或者在提交侧做超时控制。

## 线程工厂：给线程起个好名字

```kotlin
class NamedThreadFactory(private val name: String) : ThreadFactory {
    private val group = Thread.currentThread().threadGroup
    private val threadNumber = AtomicInteger(1)

    override fun newThread(r: Runnable): Thread {
        val t = Thread(group, r, "$name-${threadNumber.getAndIncrement()}", 0)
        t.isDaemon = false          // Android 线程池应使用非守护线程
        t.priority = Thread.NORM_PRIORITY
        t.uncaughtExceptionHandler = CrashHandler()
        return t
    }
}
```

命名线程不是锦上添花。线上排查时，`pool-1-thread-3` 和 `msg-dispatch-3` 的区别是：后者能让你直接在 Trace 中定位到业务模块。`uncaughtExceptionHandler` 同样关键——线程池线程的异常不会自动传递到主线程，不设 handler，任务静默失败，你连日志都看不到。

## 协程调度器的线程池映射

Kotlin 协程的调度器最终都落在 Java 线程池上，理解这个映射关系能避免很多坑：

```kotlin
// Dispatchers.Main —— Android 主线程 Looper
// 底层：HandlerDispatcher，不是线程池

// Dispatchers.IO —— 弹性线程池
// 默认最大 64 线程，按需创建，空闲 60s 回收
// 等价于：newCachedThreadPool 但有上限

// Dispatchers.Default —— CPU 密集型线程池
// 线程数 = CPU 核心数，最少 2 个
// 等价于：固定大小线程池 + 全局工作队列
```

**Dispatchers.IO 和 Default 共享同一个线程池**，这是个容易被忽略的细节。IO 调度器线程空闲时，会被 Default 调度器复用。如果你在 IO 协程里执行大量 CPU 计算，会挤占 Default 调度器的线程资源。

实际用法：IO 协程里只做 I/O 操作，计算任务用 `withContext(Dispatchers.Default)` 切换。

### 自定义调度器：用线程池作为协程载体

```kotlin
// 为特定业务创建独立线程池，避免全局调度器竞争
val businessExecutor = ThreadPoolExecutor(
    2, 4, 60, TimeUnit.SECONDS,
    LinkedBlockingQueue(32),
    NamedThreadFactory("business")
)
val businessDispatcher = businessExecutor.asCoroutineDispatcher()

// 使用
viewModelScope.launch(businessDispatcher) {
    // 在独立线程池中执行，不受 IO/Default 调度器影响
}
```

这个模式适用推送消息处理、日志写入、数据库批量操作等需要隔离的高频任务。用 `asCoroutineDispatcher()` 转换后，协程的结构化并发优势（取消传播、异常处理）全部保留，线程池资源完全隔离。

## 线程治理的工程实践

### 监控先行

线程池不出问题时像不存在，一出问题就是灾难。上线前必须接入监控：

```kotlin
class MonitorableExecutor(
    corePoolSize: Int, maxPoolSize: Int,
    keepAliveTime: Long, unit: TimeUnit,
    workQueue: BlockingQueue<Runnable>,
    factory: ThreadFactory
) : ThreadPoolExecutor(corePoolSize, maxPoolSize, keepAliveTime, unit, workQueue, factory) {

    override fun beforeExecute(t: Thread?, r: Runnable?) {
        super.beforeExecute(t, r)
        // 记录：活跃线程数 / 队列大小 / 任务开始时间
        val metrics = Metrics(
            activeCount = activeCount,
            queueSize = queue.size,
            poolSize = poolSize
        )
        reporter.report(metrics)
    }

    override fun afterExecute(r: Runnable?, t: Throwable?) {
        super.afterExecute(r, t)
        // 记录任务耗时，t 不为 null 表示异常
        if (t != null) reporter.reportError(t)
    }
}
```

监控盯三个维度：activeCount 持续接近 maximumPoolSize 说明需要扩容，queue.size 持续增长说明处理速度跟不上，任务耗时 P99 超过 500ms 需要排查。

### 线程池的生命周期

```kotlin
// 正确的关闭姿势
executor.shutdown()           // 不再接受新任务，等待已提交任务完成
if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
    executor.shutdownNow()    // 超时强制中断
}
```

`shutdown()` 后线程池状态变为 SHUTDOWN，不再接受新任务但继续执行队列中的任务。`shutdownNow()` 返回未执行的任务列表，方便做补偿处理。在 Activity/Fragment 的 onDestroy 或 Application 的 onTerminate 中忘记关闭线程池，会导致内存泄漏——线程池的线程持有对 ThreadGroup 的引用，间接持有 Context。

---

线程池调参的核心不是背参数，而是理解**线程创建、队列堆积、任务拒绝**三条路径的触发条件。在实际项目中，我的习惯是：

- 每个业务模块独立线程池，避免互相影响
- 有界队列 + CallerRunsPolicy 作为标配
- 线程池监控作为上线 checklist 的必选项
- 协程场景下，对高频任务用 `asCoroutineDispatcher()` 隔离

并发问题排查的本质是：**先看线程数，再看队列，最后看任务耗时**。这个顺序能解决 80% 的线程池疑难杂症。
