---
title: 端侧大模型推理调度层设计：优先级队列与背压控制实战
excerpt: 本文介绍如何在端侧推理引擎之上构建调度中间层，通过优先级队列、抢占机制和背压控制，解决多请求并发导致的内存溢出、延迟不可控和结果乱序问题。
publishDate: '2026-05-07'
tags:
- Android
- 端侧推理
- 并发调度
- 性能优化
- TFLite
seo:
  title: 端侧大模型推理调度层设计：优先级队列与背压控制实战
  description: 端侧大模型推理如何避免 OOM？本文详解 InferenceScheduler 的优先级队列、抢占打断、背压拒绝和去重合并设计，200 行核心代码实现稳定调度。
---

同系列还有： [博客自动发布工作流文章](https://xckevin.github.io/blog/2026/05/30/auto-blog-pipeline)

---

做端侧大模型推理时踩过一个坑：用户快速切换相册滤镜，连续触发 5 次风格迁移，App 直接 OOM 崩了。当时的代码很简单——每次请求直接调 `interpreter.run()`，没有任何并发控制。

端侧推理引擎通常是单例，资源极其有限。一个请求占着推理线程不放，后面的请求要么排队堵死，要么并发执行撑爆内存。这篇聊一下怎么在推理引擎之上构建一个**调度中间层**，让多请求有序执行、按优先级响应、不把设备搞崩。

## 问题的本质：三种并发失控

端侧推理的并发瓶颈不在锁竞争，也不在传统的线程安全——而在于三类资源争抢，每一类都直指移动端的物理限制。

**内存峰值失控。** 一次模型推理可能占用 200-500MB，三个并发就是 1.5GB。中低端机直接触发 OOM Killer，用户看到的不是慢，是闪退。

**推理延迟不可控。** 用户点了"翻译"按钮，但后台正在跑一个低优先级的预缓存推理，干等 3 秒没反应——体验上这就是卡死。用户不关心后台在算什么，只关心自己的操作有没有即时响应。

**结果乱序返回。** 请求 A 先发起，请求 B 后发起但推理更快完成，上层拿到 B 的结果覆盖了 A，UI 上出现"闪回"。这在图片处理场景里特别明显——连续切滤镜时画面来回跳。

解法思路很直：**把推理请求抽象为任务，用一个线程安全的优先级队列管理，每次只执行一个，执行完再取下一个。**

## 请求调度器的核心设计

调度器不关心模型结构和推理细节，只做三件事：接收请求、排队、按序执行。

```kotlin
class InferenceScheduler(
    private val maxConcurrent: Int = 1,  // 端侧通常为 1
    private val capacity: Int = 10       // 队列上限，触发背压
) {
    // 优先级队列：倒序排列，数字大优先
    private val taskQueue = PriorityBlockingQueue<Task>(
        11, compareByDescending { it.priority }
    )

    private val worker = Executors.newSingleThreadExecutor()

    data class Task(
        val id: String,
        val priority: Int,      // 0-10，10 最高
        val input: Any,
        val callback: (Result) -> Unit
    )

    fun submit(task: Task): Boolean {
        if (taskQueue.size >= capacity) {
            return false  // 背压拒绝
        }
        taskQueue.put(task)
        worker.submit { drainQueue() }
        return true
    }

    private fun drainQueue() {
        val task = taskQueue.take()
        val result = runInference(task.input)
        task.callback(result)
    }
}
```

核心决策：**用单线程执行器 + 优先级阻塞队列。** 不引入复杂的并发原语，线程模型简单可控。任务通过 `callback` 把结果抛回调用方线程（调用方自己负责切线程）。

`maxConcurrent = 1` 是端侧的合理默认值。GPU/NPU 驱动层通常不支持多个模型实例并发加载，强行设为 2 反而会因为驱动锁等待拉高延迟。我试过在骁龙 8 Gen 2 上开两个并发推理线程，实测总吞吐反而下降了约 15%。

## 优先级策略：别让用户等低优任务

优先级不是拍脑袋定的，实际落地时我拆了三层：

```kotlin
enum class Priority(val level: Int) {
    USER_INTERACTIVE(10),   // 用户直接操作触发
    USER_PERCEPTIBLE(5),    // 用户可感知但非即时
    BACKGROUND(0)           // 预加载、缓存预热
}
```

**USER_INTERACTIVE（10 级）**：用户点了"翻译"按钮、划到新滤镜。这类请求超过 500ms 不响应，用户就会觉得慢。调度器取队头任务时自动选优先级最高的，所以即使用户交互请求是最后入队的，也能插到队头。

有个细节得处理：Worker 正在执行一个低优任务时，新的高优任务来了怎么办？

```kotlin
fun submit(task: Task): Boolean {
    if (currentTask?.priority ?: Int.MAX_VALUE < task.priority) {
        // 打断当前低优推理，保存中间状态
        cancelCurrent()
    }
    taskQueue.put(task)
    // ...
}
```

打断不是无代价的——推理引擎的 `cancel()` 不一定即时生效，取决于底层 ML 框架对中断的支持。MediaPipe 支持 task 级别的 cancellation，TFLite 的 `Interpreter` 需要手动标记退出。实践下来我的做法是：**仅在优先级差距 ≥ 5 时才打断**，避免频繁中断引入不必要的开销。

## 背压控制：拒绝而不是崩溃

移动端的内存不像服务端可以弹性扩容，队列无限制增长等于慢性自杀。

**核心原则：当队列满了，宁可拒绝请求，也不挤占推理内存。**

```kotlin
fun submit(task: Task): InferenceResult {
    if (taskQueue.remainingCapacity() == 0) {
        // 策略 1：如果新请求优先级高于队列最低优先级，替换
        val minTask = taskQueue.minByOrNull { it.priority }
        if (minTask != null && task.priority > minTask.priority) {
            taskQueue.remove(minTask)
            minTask.callback(Result.Failure(BackpressureException()))
            taskQueue.put(task)
            return InferenceResult.Accepted
        }
        // 策略 2：直接拒绝
        return InferenceResult.Rejected(cause = BackpressureException())
    }
    taskQueue.put(task)
    return InferenceResult.Accepted
}
```

背压逻辑分两路走：

**同优先级置换。** 队列已满且新请求优先级更高时，踢掉队里优先级最低的那个，腾出位置。被踢掉的请求通过 callback 通知失败，上层做降级处理——比如用缓存结果，或者提示用户稍后重试。

**直接拒绝。** 新请求优先级不够高，返回 `Rejected` 让调用方自己兜底。实际项目中，UI 层接到 `Rejected` 后显示一个 loading 状态，等队列有空位了再重试。至少不会把 App 搞崩。

## 请求生命周期与状态追踪

并发调度不能只有"排队"和"执行"两种状态。落地需要更细粒度的追踪：

```kotlin
sealed class TaskState {
    object Queued : TaskState()
    data class Running(val startMs: Long) : TaskState()
    data class Completed(val elapsedMs: Long) : TaskState()
    data class Failed(val error: Throwable) : TaskState()
    object Cancelled : TaskState()
}
```

状态主要服务于两个场景：**监控诊断**和**去重合并**。

去重是一个容易忽略的问题：用户快速点击同一滤镜按钮 3 次，排队 3 个完全相同的推理请求，实际只需要执行最后一次。

```kotlin
fun submit(task: Task): Boolean {
    // 合并同类请求：移除队列中同 id 的旧请求
    taskQueue.removeIf { it.id == task.id && it.state is TaskState.Queued }
    taskQueue.put(task)
    return true
}
```

`id` 由业务层定义，比如 `"style_transfer:filter_vintage:img_123"`。同一张图同一个滤镜，重复入队时直接覆盖之前的排队请求，避免浪费推理资源。

## 踩坑记录：两个意外翻车点

**坑一：callback 里做了重操作。** 推理结果 decode 出 Bitmap 如果在 callback 里做，Worker 线程被阻塞，后续请求全部排队等待。正确做法是 callback 只做轻量通知——把结果塞进 LiveData 或 StateFlow——解码异步丢到另一个线程池。

**坑二：模型加载和推理用了同一个锁。** 调度器在推理过程中收到模型切换请求（比如用户换了一个滤镜风格），`loadModel()` 和 `runInference()` 竞争同一把锁，直接导致 ANR。解法是把模型加载独立于调度器，切换模型时先暂停队列消费，加载完成后再恢复。

```kotlin
fun switchModel(newModel: Model) {
    worker.submit {
        pauseQueue = true
        drainCurrentTask()  // 等当前任务执行完
        loadModel(newModel) // 加载新模型，期间队列暂停
        pauseQueue = false
        drainQueue()        // 恢复消费
    }
}
```

## 分层架构总览

最终落地的分层结构：

```
┌─────────────────────────┐
│    业务方（UI / Service）   │  调用 submit()，处理 callback
├─────────────────────────┤
│   InferenceScheduler    │  优先级队列 + 单线程消费
│   - 去重合并             │
│   - 背压拒绝             │
│   - 状态追踪             │
├─────────────────────────┤
│   ModelManager          │  模型加载、预热、缓存、切换
├─────────────────────────┤
│   ML Engine             │  TFLite / MediaPipe / NNAPI
└─────────────────────────┘
```

调度器和模型管理分离是关键——前者管"什么时候算"，后者管"用什么算"。分层后测试时可以单独 mock 推理耗时，不用真跑模型。

这套架构在项目里跑了半年，日均推理量 5000 次左右的设备上没有出过 OOM 崩溃。核心实现 200 行出头，关键不是代码量，而是把"排队、抢占、拒绝"这三种行为想清楚了再写。端侧推理的瓶颈永远在资源上，调度层的设计原则就一条：**宁可让请求失败，也别让系统崩溃。**
