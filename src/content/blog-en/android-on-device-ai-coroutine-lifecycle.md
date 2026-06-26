---
title: "Managing On-Device AI Inference Lifecycles with Kotlin Coroutines"
lang: en
translationKey: android-on-device-ai-coroutine-lifecycle
slug: android-on-device-ai-coroutine-lifecycle
excerpt: "How to use structured concurrency to manage Android on-device AI inference: GPU resource release ordering, actor-style serialization, and cancellation propagation."
publishDate: '2026-06-11'
tags:
- "Android"
- "Kotlin"
- "On-Device AI"
- "Coroutines"
- "Memory Management"
seo:
  title: "On-Device AI Inference Lifecycle with Kotlin Coroutines"
  description: "Use structured concurrency to manage Android on-device AI inference: three-tier resource model, GPU release ordering, actor serialization, and cancellation."
  pageType: article
---

Last month I chased a production crash whose stack trace pointed at `AHardwareBuffer` native-layer release, triggered when a user rapidly switched pages. The code told the story: MediaPipe inference ran on a hand-rolled thread pool, and on page destruction we only called `future.cancel(true)` — GPU resources were never properly reclaimed.

On-device AI inference has a harder lifecycle than a network request. It involves GPU memory, NPU DMA buffers, and native allocations. A couple of `dispose()` calls in `onCleared()` won't cover it.

## The Three-Tier Resource Model

On-device inference resources aren't a flat block of memory. They stack in three tiers:

**Compute resource tier**: GPU memory or NPU-private memory. LiteRT allocates this via `AHardwareBuffer`, and its lifecycle is managed by the driver. Java-side GC has no visibility into when this memory is freed.

**Model instance tier**: the `Interpreter` or `InferenceSession` object. Expensive to create (loads the .tflite into VRAM), so it must be reused, not rebuilt per inference.

**Inference context tier**: the input/output tensors for a single `run()` call. ByteBuffer aliases point into native memory and may only be reclaimed after page-out.

Each tier has its own creation cost and release timing. Mix them into one `try-finally` block and something will eventually leak.

A typical anti-pattern:

```kotlin
class BadViewModel : ViewModel() {
    private val executor = Executors.newSingleThreadExecutor()
    private val interpreter = Interpreter(modelBuffer) // GPU delegate

    fun runInference(input: ByteBuffer) {
        executor.execute {
            val output = ByteBuffer.allocateDirect(1024)
            interpreter.run(input, output) // may run after ViewModel is cleared
        }
    }

    override fun onCleared() {
        executor.shutdownNow() // GPU resources won't be released — native leak
    }
}
```

The problem is clear: `ExecutorService` doesn't know about the ViewModel's lifecycle. `shutdownNow()` interrupts the thread, but the GPU compute stream is still running.

## Modeling the Lifecycle with Structured Concurrency

Kotlin's **structured concurrency** fits this scenario perfectly: when a parent coroutine is cancelled, all child coroutines are cancelled automatically, and the signal propagates down the scope. No orphaned tasks.

ViewModel provides `viewModelScope`, which is tied to `onCleared()`. But running inference directly inside it isn't enough — you need two layers of scope:

```kotlin
class InferenceViewModel : ViewModel() {
    // Layer 1: ViewModel lifecycle scope
    // Layer 2: inference session scope, controls model instance reuse
    private var sessionScope: CoroutineScope? = null

    fun loadModel(modelPath: String) {
        sessionScope?.cancel() // clean up the old model
        sessionScope = CoroutineScope(
            viewModelScope.coroutineContext + SupervisorJob() + Dispatchers.Default
        )
    }
}
```

`SupervisorJob()` means one child's failure doesn't affect its siblings, and parent cancellation propagates downward. A model session can serve multiple inference requests; one request failing shouldn't kill the whole session.

Compared to `Job()`, `SupervisorJob` is closer to "resource management" semantics than "transaction management" — inference tasks aren't atomic units, they're independent work items.

## Coroutine-Friendly Inference Wrapping

Wrapping `Interpreter.run()` as a suspend function hits a tricky problem: GPU delegate inference executes in the native layer, where `interrupt()` has no effect. After a coroutine is cancelled, the GPU compute kernel keeps running.

Layered cancellation is the workable approach:

```kotlin
suspend fun Interpreter.runSafely(input: ByteBuffer, output: ByteBuffer) {
    return suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation {
            // Step 1: mark cancelled; subsequent run() calls return immediately
            cancelled.set(true)
        }
        // Step 2: the inference itself is uninterruptible in native code
        run(input, output)
        if (cont.isActive) cont.resume(Unit)
    }
}
```

Here's the counterintuitive part: there's no direct causal link between `invokeOnCancellation` and `run()`. The real safety mechanism is **not submitting new tasks after cancellation**, not forcibly interrupting an in-flight inference.

For inference latency under 200ms, letting the current frame finish before releasing resources is reasonable. Force-killing the GPU context can leave driver-layer state inconsistent — the cure is worse than the disease.

**The right way to reuse resources** is the actor pattern for serialized access:

```kotlin
class InferenceActor(scope: CoroutineScope, private val interpreter: Interpreter) {
    private val channel = Channel<InferenceRequest>(Channel.RENDEZVOUS)

    init {
        scope.launch {
            for (req in channel) {
                interpreter.runSafely(req.input, req.output)
                req.deferred.complete(req.output)
            }
        }
    }

    suspend fun infer(input: ByteBuffer): ByteBuffer {
        val deferred = CompletableDeferred<ByteBuffer>()
        channel.send(InferenceRequest(input, deferred))
        return deferred.await()
    }
}
```

`Channel.RENDEZVOUS` guarantees only one task accesses the `Interpreter` at a time, with no extra locking. When the coroutine is cancelled, `channel.send()` throws `CancellationException`, which propagates up the call chain.

## Ordering GPU Resource Release

Resource release isn't just calling `close()`. There's a required ordering: the GPU delegate must be released after all inference tasks finish, and before `Interpreter` is closed.

```kotlin
class LifecycleAwareInference(
    private val scope: CoroutineScope
) {
    private var interpreter: Interpreter? = null
    private var gpuDelegate: GpuDelegate? = null
    private var actor: InferenceActor? = null

    suspend fun init(modelPath: String) {
        gpuDelegate = GpuDelegate()
        val options = Interpreter.Options().apply {
            addDelegate(gpuDelegate)
        }
        interpreter = Interpreter(loadModel(modelPath), options)
        actor = InferenceActor(scope, interpreter!!)
    }

    suspend fun release() {
        // Ordering matters
        actor = null              // 1. stop accepting new requests
        scope.coroutineContext[Job]?.children?.forEach { it.join() } // 2. wait for in-flight inference
        interpreter?.close()      // 3. release Interpreter (internally calls delegate.close)
        gpuDelegate?.close()      // 4. explicitly release the GPU delegate
        gpuDelegate = null
        interpreter = null
    }
}
```

Why the gap between `actor = null` and `join()`? The actor's channel may still hold queued tasks. Setting the reference to null only cuts the external handle; the consumer coroutine inside the channel is still running. `join()` waits for it to finish naturally — combined with the `invokeOnCancellation` flag, the consumer reads the cancelled state and exits on its own.

I learned this ordering the hard way. Initially I put `interpreter.close()` first, and the NPU driver threw `DEAD_OBJECT` — an in-flight inference was still referencing the `AHardwareBuffer`. Android's NNAPI driver is even more sensitive to release ordering than the GPU delegate.

## Three Decision Points in Practice

**Dispatcher choice**: use `Dispatchers.Default` for the entire inference pipeline, not `Dispatchers.IO`. The IO scheduler spins up many threads, while inference is compute-bound — thread-switching overhead exceeds wait overhead. On the same device with 4 concurrent inferences, Default outperformed IO by 18% in throughput.

**Model instance caching**: keep a single model instance resident; don't rebuild it per screen. For multi-model setups (e.g., a classifier and a detector), use `Map<String, LifecycleAwareInference>` and give each its own `sessionScope` so one model's release doesn't slow down another.

**`CancellationException` propagation**: never catch and swallow `CancellationException` inside inference code. Structured concurrency relies on this exception propagating upward to trigger cascading cancellation. If you must catch it (for cleanup), rethrow in `finally`:

```kotlin
try {
    interpreter.runSafely(input, output)
} catch (e: CancellationException) {
    // cleanup only, don't swallow
    throw e
}
```

Anywhere that swallows `CancellationException` breaks the cancellation chain of structured concurrency.

If you want to ship this in production, LiteRT's `GoogleAiEdgeSupport` library already ships `InferenceSession` with a suspend API that encapsulates this resource-management pattern. If you're on MediaPipe, its `llm.InferenceSession` provides a `generateResponse()` suspend function that runs inside ViewModel scope with lifecycle protection built in. For a custom solution, use the release-ordering template above as your starting point.
