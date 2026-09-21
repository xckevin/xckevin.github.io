---
title: 深入 Android 端侧 AI 推理的 Compose 声明式集成全链路：从推理状态建模到 UI 响应式渲染的工程化实践
excerpt: 介绍一套将端侧 AI 推理工程化接入 Jetpack Compose 的通用范式，涵盖推理状态机建模、协程生命周期绑定与流式渲染限流方案。
publishDate: '2026-08-09'
tags:
- Android
- Jetpack Compose
- 端侧AI推理
- 状态管理
- 工程化
seo:
  title: Android 端侧 AI 的 Compose 集成：推理状态建模与响应式渲染
  description: 从推理状态机建模到 Compose UI 响应式渲染，详解端侧 AI 推理在声明式 UI 中的工程化集成方案，包括生命周期管理、流式渲染优化与错误处理策略。
  pageType: article
slug: android-on-device-ai-compose-integration
translationKey: android-on-device-ai-compose-integration
---

去年我们团队在做一个本地图像处理 App 时，用 MediaPipe 跑人像分割，推理部分很快就调通了。真正卡了我们两天的，是把推理引擎的输出——尤其是流式推理结果——丝滑地接到 Compose UI 上。状态乱跳、生命周期泄露、重组风暴，全碰了一遍。

这篇文章把我们的解决方案整理成一套通用范式：从推理状态机的建模，到 Compose 副作用管理，再到流式渲染的集成模式。不涉及具体模型训练，只讲推理能力如何工程化地接入声明式 UI。

## 推理状态机：用 sealed class 建模全生命周期

端侧推理本质是一个异步操作，但和普通网络请求不同，它的状态维度更多。直接用一个 `StateFlow<Bitmap?>` 根本表达不清楚。

一次推理请求会经历 **6 种可观测状态**：

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

**Preparing 和 Running 为什么要分开。** 工程上这两个阶段的耗时差异很大：加载一个 4MB 的 TFLite 模型可能需要 200-500ms，推理本身可能只要 20ms。UI 层需要根据不同阶段给出不同反馈——Preparing 阶段放一个进度指示器，Running 阶段用骨架屏或者保持上一帧结果，用户感知的延迟更短。

**Streaming 状态的价值。** 很多端侧模型（尤其是 LLM 和扩散模型）是逐 token 或逐步输出的。如果等全部推理完再一次性渲染，用户会盯着空白屏幕。Streaming 让 UI 在推理进行中就能拿到中间结果做增量渲染。

状态切换逻辑放在 ViewModel 中，用 `update` 函数做原子性状态转移：

```kotlin
class InferenceViewModel : ViewModel() {
    private val _state = MutableStateFlow<InferenceState<SegmentationResult>>(InferenceState.Idle)
    val state: StateFlow<InferenceState<SegmentationResult>> = _state.asStateFlow()

    private fun transition(state: InferenceState<SegmentationResult>) {
        _state.update { state }
    }
}
```

`MutableStateFlow.update` 是原子操作，能避免状态并发写入的竞态问题——连续多次触发推理时这一点很关键。

## 副作用隔离：推理的生命周期绑定

Compose 中跑推理最容易犯的错误是直接在 `LaunchedEffect` 里起一个协程然后忘记取消。我踩过的坑：用户快速切走页面，后台推理还在跑，GPU 资源被占用，切回来时状态已经错乱了。

正确的做法是把推理封装成一个清醒知道自己在什么协程上下文中运行的组件：

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

`withContext(Dispatchers.Default)` 把推理切到后台线程池，不阻塞主线程。函数是 `suspend` 的，协程取消时会自动传播，避免泄露资源。`onStreaming` 回调在主线程上调用（因为 `withContext` 恢复时会切回来），所以 UI 更新是安全的。

在 Compose 一侧，用 `produceState` 或 `LaunchedEffect` 绑定生命周期：

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

`produceState` 会在 Composable 离开组合时自动取消内部协程。`input` 作为 key 传入，当输入变化时自动重新执行推理——「输入驱动推理」的逻辑完整收敛在一个函数里。

## 流式渲染：当推理跟 UI 抢帧时怎么办

流式推理有一个隐含的矛盾：推理输出频率可能远高于屏幕刷新率。比如 token 级别的 LLM 输出可以达到每秒 30-50 个 token，但 Compose 每帧只能消费一次状态。

直接每个 token `setState` 会导致重组风暴。我们的方案是用 **buffer + snapshot 去抖**：

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

在推理回调中使用：

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

`withFrameMillis` 确保每帧只触发一次重组。buffer 中积攒的 token 批量合并，帧率稳定在 60fps，同时不会丢数据。

更轻量的场景可以直接用 `snapshotFlow` 做限流：

```kotlin
snapshotFlow { rawTokenStream.value }
    .debounce(16)  // 约一帧的时间
    .collect { token -> /* UI 更新 */ }
```

但 `snapshotFlow` 在 Compose 中引入了额外的重组依赖，高频场景下性能不如上面的 buffer 方案。

## UI 层消费：when 分支的完整覆盖

状态机建立之后，UI 层的消费就很清晰了——用 `when` 完整覆盖 6 个分支，编译器会帮你检查遗漏：

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

Streaming 状态的 UI 渲染有技巧。拿人像分割举例，Streaming 阶段拿到的是一个不完整的 mask，做半透明叠加时可以和上一帧结果做 alpha 混合，避免闪烁：

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

核心思路是利用 `remember` 在 Streaming 状态下做帧间平滑，减少视觉跳变。

## 生产环境的实践

**推理不要用 `Dispatchers.Main`。** 即使是轻量模型，主线程推理也会抢 Compose 的渲染管线。我们的经验值是：推理耗时 > 5ms 一律切到 `Dispatchers.Default`。

**模型生命周期用单例管理。** 模型加载是一次性开销，不要每次推理都重新加载。用 `object` 或依赖注入容器持有 Interpreter 实例：

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

LruCache 限制数量，防止多个模型同时驻留导致 OOM。

**错误状态要给用户退路。** `recoverable` 标记是关键——模型文件缺失是不可恢复的，需要引导用户操作；单次推理超时通常是可恢复的，直接给重试按钮。区分这两类错误能显著降低用户的挫败感。

端侧 AI 推理集成到 Compose，核心挑战从来不是算法，而是工程化——怎么把异步、流式、有副作用的推理过程，用声明式的方式组织成可读、可维护、不泄漏的代码。sealed class 状态机 + produceState 生命周期绑定 + buffer 流式限流，这套组合是我目前觉得最平衡的做法。
