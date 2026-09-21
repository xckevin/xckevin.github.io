---
title: "Integrating On-Device AI Inference into Compose: State Machines, Lifecycle Isolation, and Streaming Rendering"
lang: en
translationKey: android-on-device-ai-compose-integration
slug: android-on-device-ai-compose-integration
excerpt: "A practical pattern for wiring on-device AI inference into Jetpack Compose: sealed-class state machines, lifecycle-safe coroutines, and frame-aligned streaming."
publishDate: '2026-08-09'
tags:
- "Android"
- "Jetpack Compose"
- "On-device AI"
seo:
  title: "On-Device AI Inference in Compose"
  description: "Model inference lifecycle with sealed classes, produceState side-effect isolation, and buffer-based streaming in Jetpack Compose."
  pageType: article
---

Last year, while our team was building a local image-processing app, we used MediaPipe for portrait segmentation. The inference itself was working quickly; what actually stalled us for two days was connecting the inference engine's output—especially streaming inference results—to the Compose UI smoothly. We hit all of it: state thrash, lifecycle leaks, and recomposition storms.

This article organizes our solution into a general pattern: from modeling the inference state machine, to managing Compose side effects, to integration patterns for streaming rendering. It does not cover model training; it focuses only on how to integrate inference capability into a declarative UI in an engineering-friendly way.

## The inference state machine: modeling the full lifecycle with a sealed class

On-device inference is fundamentally an asynchronous operation, but unlike a typical network request, it has more state dimensions. A bare `StateFlow<Bitmap?>` simply cannot express it clearly.

A single inference request goes through **six observable states**:

```kotlin
sealed interface InferenceState<out T> {
    data object Idle : InferenceState<Nothing>
    data object Preparing : InferenceState<Nothing>    // 加载模型、预热
    data object Running : InferenceState<Nothing>      // 推理中
    data class Streaming<T>(val partialResult: T) : InferenceState<T>  // 流式输出片段
    data class Success<T>(val result: T) : InferenceState<T>
    data class Error(val throwable: Throwable, val recoverable: Boolean = true) : InferenceState<Nothing>
}
```

**Why Preparing and Running are separated.** In practice, these two phases have very different durations: loading a 4MB TFLite model can take 200–500ms, while the inference itself may take only 20ms. The UI layer needs to give different feedback for each phase—show a progress indicator during Preparing, and use a skeleton screen or keep the previous frame during Running—so the user perceives lower latency.

**The value of the Streaming state.** Many on-device models—especially LLMs and diffusion models—produce output token by token or step by step. If the UI waits until the entire inference finishes before rendering, users stare at a blank screen. Streaming lets the UI receive intermediate results and render incrementally while inference is still in progress.

State transition logic lives in the ViewModel, and an `update` function performs atomic state transitions:

```kotlin
class InferenceViewModel : ViewModel() {
    private val _state = MutableStateFlow<InferenceState<SegmentationResult>>(InferenceState.Idle)
    val state: StateFlow<InferenceState<SegmentationResult>> = _state.asStateFlow()

    private fun transition(state: InferenceState<SegmentationResult>) {
        _state.update { state }
    }
}
```

`MutableStateFlow.update` is atomic and avoids race conditions when multiple writes to state happen concurrently—a critical property when inference is triggered repeatedly in quick succession.

## Side-effect isolation: binding inference to the lifecycle

The easiest mistake to make when running inference in Compose is to launch a coroutine inside `LaunchedEffect` and forget to cancel it. I have stepped on this trap: the user navigates away quickly, inference keeps running in the background, GPU resources stay occupied, and the state is already inconsistent when they come back.

The correct approach is to wrap inference in a component that knows exactly which coroutine context it is running in:

```kotlin
class TFLiteInferenceEngine(private val modelPath: String) {
    
    suspend fun run(
        input: Bitmap,
        onStreaming: (SegmentationResult) -> Unit
    ): SegmentationResult = withContext(Dispatchers.Default) {
        // 推理核心逻辑，onStreaming 用于流式回调
        val interpreter = Interpreter(File(modelPath))
        // ... 输入预处理、推理
        return@withContext finalResult
    }
    
    suspend fun prepare(): Unit = withContext(Dispatchers.Default) {
        // 模型加载，内存预热
    }
}
```

`withContext(Dispatchers.Default)` moves inference to a background thread pool so the main thread is not blocked. The functions are `suspend` functions, so cancellation propagates automatically when the coroutine is canceled, avoiding resource leaks. The `onStreaming` callback runs on the main thread—because `withContext` switches back when it resumes—so UI updates are safe.

On the Compose side, use `produceState` or `LaunchedEffect` to bind to the lifecycle:

```kotlin
@Composable
fun rememberInferenceState(
    engine: TFLiteInferenceEngine,
    input: Bitmap?
): State<InferenceState<SegmentationResult>> {
    return produceState<InferenceState<SegmentationResult>>(InferenceState.Idle, input) {
        if (input == null) return@produceState
        
        value = InferenceState.Preparing
        engine.prepare()
        
        value = InferenceState.Running
        try {
            val result = engine.run(input) { partial ->
                value = InferenceState.Streaming(partial)
            }
            value = InferenceState.Success(result)
        } catch (e: CancellationException) {
            value = InferenceState.Idle  // 正常取消，不算错误
        } catch (e: Exception) {
            value = InferenceState.Error(e)
        }
    }
}
```

`produceState` automatically cancels its internal coroutine when the composable leaves composition. Passing `input` as a key re-runs inference automatically when the input changes—the "input-driven inference" logic is fully contained in one function.

## Streaming rendering: what to do when inference competes with the UI for frames

Streaming inference has an implicit tension: inference output frequency can be much higher than the screen refresh rate. Token-level LLM output, for example, can reach 30–50 tokens per second, but Compose can consume state only once per frame.

Calling `setState` for every token directly would cause a recomposition storm. Our solution is **buffer + snapshot debouncing**:

```kotlin
class StreamingBuffer<T>(private val capacity: Int = 3) {
    private var buffer = mutableListOf<T>()
    private var pendingSnapshot: T? = null
    
    fun add(item: T) {
        buffer.add(item)
        pendingSnapshot = item
    }
    
    fun takeSnapshot(): List<T>? {
        if (buffer.isEmpty()) return null
        val snapshot = buffer.toList()
        buffer.clear()
        return snapshot
    }
}
```

Use it in the inference callback:

```kotlin
val buffer = StreamingBuffer<String>(capacity = 5)

engine.run(input) { token ->
    buffer.add(token)
}

// 在 Compose 帧回调中消费
LaunchedEffect(Unit) {
    withFrameMillis { 
        val snapshot = buffer.takeSnapshot()
        if (snapshot != null) {
            // 一次性把积攒的 token 消费掉
            _state.update { InferenceState.Streaming(accumulatedResult + snapshot) }
        }
    }
}
```

`withFrameMillis` ensures only one recomposition is triggered per frame. Tokens accumulated in the buffer are combined in batches, keeping the frame rate stable at 60fps while data is not lost.

For lighter scenarios, you can use `snapshotFlow` directly for throttling:

```kotlin
snapshotFlow { rawTokenStream.value }
    .debounce(16)  // 约一帧的时间
    .collect { token -> /* UI 更新 */ }
```

However, `snapshotFlow` introduces an extra recomposition dependency in Compose, so in high-frequency scenarios its performance is not as good as the buffer approach above.

## Consuming state in the UI: complete coverage with a `when`

Once the state machine is in place, UI consumption becomes clear—use a `when` expression to cover all six branches completely, and the compiler will help you catch missing branches:

```kotlin
@Composable
fun InferenceResultView(state: InferenceState<SegmentationResult>) {
    when (state) {
        InferenceState.Idle -> EmptyPrompt()
        InferenceState.Preparing -> LoadingIndicator(message = "加载模型中...")
        InferenceState.Running -> ProcessingPlaceholder()
        is InferenceState.Streaming -> StreamingOverlay(state.partialResult)
        is InferenceState.Success -> ResultCanvas(state.result)
        is InferenceState.Error -> {
            if (state.recoverable) {
                RetryDialog(onRetry = { /* 重新推理 */ })
            } else {
                ErrorFallback(message = "模型加载失败，请检查存储权限")
            }
        }
    }
}
```

Rendering the Streaming state has its own trick. Taking portrait segmentation as an example, during the Streaming phase you get an incomplete mask. When compositing it semi-transparently, blend it with the previous frame's result using alpha to avoid flicker:

```kotlin
@Composable
fun StreamingOverlay(current: SegmentationResult) {
    var lastResult by remember { mutableStateOf<SegmentationResult?>(null) }
    val displayResult = lastResult?.let { blend(it, current, alpha = 0.7f) } ?: current
    
    DisposableEffect(current) {
        lastResult = current
        onDispose { }
    }
    
    Canvas(modifier = Modifier.fillMaxSize()) {
        drawBitmap(displayResult.mask, blendMode = BlendMode.Screen)
    }
}
```

The core idea is to use `remember` for inter-frame smoothing in the Streaming state, reducing visible jumps.

## Practices for production

**Do not run inference on `Dispatchers.Main`.** Even a lightweight model will compete with Compose's rendering pipeline if it runs on the main thread. Our rule of thumb is: any inference longer than 5ms should be moved to `Dispatchers.Default`.

**Manage model lifecycle with a singleton.** Model loading is a one-time cost; do not reload the model for every inference. Use an `object` or a dependency injection container to hold the Interpreter instance:

```kotlin
object ModelRegistry {
    private val cache = LruCache<String, Interpreter>(maxSize = 3)
    
    fun get(path: String): Interpreter {
        return cache.get(path) ?: synchronized(this) {
            cache.get(path) ?: Interpreter(File(path)).also { cache.put(path, it) }
        }
    }
}
```

`LruCache` limits the number of models, preventing multiple models from residing in memory at the same time and causing OOM.

**Error states should give the user a way out.** The `recoverable` flag is key—a missing model file is unrecoverable and requires guiding the user to act; a single inference timeout is usually recoverable and can be handled with a retry button. Distinguishing these two kinds of errors significantly reduces user frustration.

When integrating on-device AI inference into Compose, the core challenge has never been the algorithm—it is engineering: how to organize an asynchronous, streaming, side-effectful inference process into declarative, readable, maintainable, leak-free code. A sealed class state machine + `produceState` lifecycle binding + buffer-based streaming throttling is the combination that feels most balanced to me right now.
