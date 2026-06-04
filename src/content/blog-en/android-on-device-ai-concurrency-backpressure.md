---
title: "Designing an On-Device LLM Inference Scheduler: Priority Queues and Backpressure in Practice"
lang: en
translationKey: android-on-device-ai-concurrency-backpressure
slug: android-on-device-ai-concurrency-backpressure
excerpt: "This article shows how to build a scheduling layer above an on-device inference engine, using priority queues, preemption, and backpressure to avoid OOMs, unpredictable latency, and out-of-order results."
publishDate: '2026-05-07'
tags:
- "Android"
- "On-Device Inference"
- "Concurrency Scheduling"
- "Performance Optimization"
- "TFLite"
seo:
  title: "On-Device LLM Scheduling: Priority Queues and Backpressure"
  description: "Learn how an InferenceScheduler uses priority queues, preemption, rejection, and deduplication to keep Android on-device AI inference stable."
  pageType: article
---

Also in this series: [blog auto-publishing workflow article](https://xckevin.github.io/blog/2026/05/30/auto-blog-pipeline)

---

I once hit a painful issue while building on-device LLM inference: the user quickly switched photo filters, triggered style transfer five times in a row, and the app crashed with an OOM. The code at the time was simple: every request called `interpreter.run()` directly, with no concurrency control.

On-device inference engines are usually singletons, and resources are extremely limited. If one request holds the inference thread, later requests either block forever in a queue or run concurrently and blow up memory. This article covers how to build a **scheduling middleware layer** above the inference engine so multiple requests execute in order, respond by priority, and do not take the device down.

## The core problem: three kinds of runaway concurrency

The concurrency bottleneck in on-device inference is not lock contention, nor traditional thread safety. It is contention across three resource types, each tied directly to physical mobile-device limits.

**Uncontrolled memory peaks.** One model inference may consume 200 to 500 MB. Three concurrent runs can mean 1.5 GB. On midrange or low-end devices, that directly triggers the OOM Killer. Users do not see a slow app; they see a crash.

**Unpredictable inference latency.** The user taps the "Translate" button, but a low-priority pre-cache inference is running in the background, so nothing happens for three seconds. From the user's perspective, that is a frozen app. Users do not care what background job is computing. They care whether their own action gets an immediate response.

**Out-of-order results.** Request A starts first, request B starts later but finishes faster, and the upper layer uses B's result to overwrite A. The UI appears to "flash back." This is especially obvious in image processing, where rapid filter switching makes the image jump between states.

The solution is straightforward: **abstract inference requests as tasks, manage them with a thread-safe priority queue, execute one at a time, then take the next task after the current one finishes.**

## Core scheduler design

The scheduler does not care about model structure or inference details. It does only three things: accepts requests, queues them, and executes them in order.

```kotlin
class InferenceScheduler(
    private val maxConcurrent: Int = 1,  // Usually 1 on-device
    private val capacity: Int = 10       // Queue limit that triggers backpressure
) {
    // Priority queue: descending order, larger numbers run first
    private val taskQueue = PriorityBlockingQueue<Task>(
        11, compareByDescending { it.priority }
    )

    private val worker = Executors.newSingleThreadExecutor()

    data class Task(
        val id: String,
        val priority: Int,      // 0-10, with 10 highest
        val input: Any,
        val callback: (Result) -> Unit
    )

    fun submit(task: Task): Boolean {
        if (taskQueue.size >= capacity) {
            return false  // Backpressure rejection
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

The key decision is **a single-thread executor plus a priority blocking queue**. There is no need for complex concurrency primitives. The threading model stays simple and controllable. Each task returns its result through `callback`; the caller is responsible for switching threads if needed.

`maxConcurrent = 1` is the right default on-device. GPU and NPU driver layers usually do not support loading multiple model instances concurrently. Forcing the value to 2 often increases latency because of driver-level lock waiting. I tried two concurrent inference threads on a Snapdragon 8 Gen 2 device, and measured total throughput dropped by about 15 percent.

## Priority strategy: do not make users wait for low-priority work

Priority should not be guessed casually. In practice, I split it into three layers:

```kotlin
enum class Priority(val level: Int) {
    USER_INTERACTIVE(10),   // Triggered directly by user action
    USER_PERCEPTIBLE(5),    // User-visible but not immediate
    BACKGROUND(0)           // Preloading and cache warmup
}
```

**USER_INTERACTIVE, level 10**: the user taps a "Translate" button or swipes to a new filter. If this kind of request takes more than 500 ms to respond, users perceive it as slow. When the scheduler takes the next task from the queue, it automatically chooses the highest-priority one, so an interactive request can move to the front even if it was enqueued last.

There is one detail to handle: what happens if the worker is already running a low-priority task when a new high-priority task arrives?

```kotlin
fun submit(task: Task): Boolean {
    if (currentTask?.priority ?: Int.MAX_VALUE < task.priority) {
        // Interrupt the current low-priority inference and save intermediate state
        cancelCurrent()
    }
    taskQueue.put(task)
    // ...
}
```

Interruption is not free. The inference engine's `cancel()` may not take effect immediately; it depends on the underlying ML framework's interrupt support. MediaPipe supports task-level cancellation. TFLite's `Interpreter` needs manual exit signaling. In practice, my rule is: **only preempt when the priority gap is at least 5**, avoiding unnecessary overhead from frequent interruption.

## Backpressure control: reject instead of crashing

Mobile memory cannot elastically scale the way server memory can. Letting a queue grow without limit is slow self-destruction.

**The core principle: when the queue is full, reject requests rather than consuming inference memory.**

```kotlin
fun submit(task: Task): InferenceResult {
    if (taskQueue.remainingCapacity() == 0) {
        // Strategy 1: if the new request has higher priority than the lowest-priority queued task, replace it
        val minTask = taskQueue.minByOrNull { it.priority }
        if (minTask != null && task.priority > minTask.priority) {
            taskQueue.remove(minTask)
            minTask.callback(Result.Failure(BackpressureException()))
            taskQueue.put(task)
            return InferenceResult.Accepted
        }
        // Strategy 2: reject directly
        return InferenceResult.Rejected(cause = BackpressureException())
    }
    taskQueue.put(task)
    return InferenceResult.Accepted
}
```

The backpressure logic has two paths:

**Priority replacement.** If the queue is full and the new request has higher priority, remove the lowest-priority task in the queue and make room. The removed request is notified through its callback and the upper layer handles degradation, such as using a cached result or asking the user to retry later.

**Direct rejection.** If the new request is not important enough, return `Rejected` and let the caller handle fallback. In real projects, the UI layer can show a loading state after receiving `Rejected` and retry when a queue slot becomes available. At least the app does not crash.

## Request lifecycle and state tracking

Concurrent scheduling needs more than two states, "queued" and "running." Production code needs finer-grained tracking:

```kotlin
sealed class TaskState {
    object Queued : TaskState()
    data class Running(val startMs: Long) : TaskState()
    data class Completed(val elapsedMs: Long) : TaskState()
    data class Failed(val error: Throwable) : TaskState()
    object Cancelled : TaskState()
}
```

State mainly supports two scenarios: **monitoring and diagnosis**, and **deduplication with merge behavior**.

Deduplication is easy to overlook. If the user taps the same filter button three times quickly, queuing three identical inference requests is wasteful. Only the latest one matters.

```kotlin
fun submit(task: Task): Boolean {
    // Merge similar requests: remove old queued requests with the same id
    taskQueue.removeIf { it.id == task.id && it.state is TaskState.Queued }
    taskQueue.put(task)
    return true
}
```

The business layer defines `id`, for example `"style_transfer:filter_vintage:img_123"`. If the same image and same filter are enqueued repeatedly, replace the earlier queued request directly and avoid wasting inference resources.

## Pitfall log: two unexpected failures

**Pitfall one: heavy work inside the callback.** If Bitmap decoding runs inside the inference callback, the worker thread is blocked and all later requests wait in the queue. The correct pattern is for the callback to do only lightweight notification, such as pushing the result into LiveData or StateFlow, then dispatch decoding asynchronously to another thread pool.

**Pitfall two: model loading and inference used the same lock.** The scheduler received a model-switch request during inference, for example when the user selected a different filter style. `loadModel()` and `runInference()` competed for the same lock and directly caused an ANR. The fix is to keep model loading independent from the scheduler. When switching models, pause queue consumption first, wait for the current task to finish, load the model, and then resume.

```kotlin
fun switchModel(newModel: Model) {
    worker.submit {
        pauseQueue = true
        drainCurrentTask()  // Wait for the current task to finish
        loadModel(newModel) // Load the new model while the queue is paused
        pauseQueue = false
        drainQueue()        // Resume consumption
    }
}
```

## Layered architecture overview

The final layered structure looks like this:

```text
┌─────────────────────────┐
│    Caller: UI / Service │  Calls submit() and handles callback
├─────────────────────────┤
│   InferenceScheduler    │  Priority queue + single-thread consumption
│   - Deduplication       │
│   - Backpressure reject │
│   - State tracking      │
├─────────────────────────┤
│   ModelManager          │  Model loading, warmup, caching, switching
├─────────────────────────┤
│   ML Engine             │  TFLite / MediaPipe / NNAPI
└─────────────────────────┘
```

Separating the scheduler from model management is critical. The scheduler controls "when to compute"; the model manager controls "what to compute with." After this separation, tests can mock inference duration independently without running a real model.

This architecture has run in production for half a year on devices averaging about 5,000 inferences per day, with no OOM crashes. The core implementation is just over 200 lines. The hard part is not the amount of code; it is thinking through the three behaviors of queueing, preemption, and rejection before writing it. The bottleneck in on-device inference is always resources, so the scheduler's design principle is simple: **let a request fail before letting the system crash.**
