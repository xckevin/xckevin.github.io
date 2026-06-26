---
title: 深入 Android 端侧 AI 推理的声明式管道：用 Kotlin Flow 构建可组合的推理工作流
excerpt: 本文介绍如何用 Kotlin Flow 将端侧 AI 推理抽象为可组合的声明式管道，通过 Preprocess/Inference/Postprocess 三层架构实现预处理、推理、后处理的解耦，并结合背压控制与分层测试策略构建健壮的推理工作流。
publishDate: '2026-06-17'
tags:
- Android
- Kotlin
- 端侧AI推理
- TFLite
- Kotlin Flow
seo:
  title: 深入 Android 端侧 AI 推理的声明式管道：用 Kotlin Flow 构建可组合的推理工作流
  description: 用 Kotlin Flow 构建端侧 AI 推理的声明式管道，实现预处理、推理、后处理的解耦与可组合，结合背压控制与分层测试策略，构建健壮的端侧推理工作流。
---

去年在做一个端侧 OCR 功能时，我遇到了一个很典型的困局：预处理、推理、后处理三段代码纠缠在一起，每加一个新模型就要复制粘贴几百行，测试只能靠手动跑一遍完整流程。改一处预处理逻辑，下游全部崩掉，排查起来像剥洋葱。

这个问题的根因是**推理流程缺乏结构化抽象**。端侧 AI 推理就是一个数据变换管道：原始输入 → 预处理 → 模型推理 → 后处理 → 业务结果。Kotlin Flow 的操作符组合能力正好能把这个管道显式化、可组合化。

## 推理管道的三层抽象

端侧推理可以抽象为三个核心阶段，每个阶段都是一个纯函数式的数据变换：

```
Input → [Preprocess] → Tensor → [Inference] → RawOutput → [Postprocess] → Result
```

第一阶段是**预处理（Preprocess）**：将业务输入（Bitmap、文本、音频帧）转换为模型需要的 Tensor 格式，包括尺寸缩放、归一化、通道调整等。

第二阶段是**推理（Inference）**：调用 TFLite、NNAPI 或 MediaPipe 等运行时，输入 Tensor 得到原始输出。

第三阶段是**后处理（Postprocess）**：将模型原始输出（概率分布、坐标框、嵌入向量）映射为业务层可用的数据结构。

每个阶段都是一个独立的、可测试的纯函数，接收输入、返回输出，不持有状态，不依赖全局上下文。用 Kotlin 的类型系统来表达：

```kotlin
interface Preprocessor<in TInput, out TOutput> {
    suspend fun process(input: TInput): TOutput
}

interface InferenceEngine<in TInput, out TOutput> {
    suspend fun infer(input: TInput): TOutput
}

interface Postprocessor<in TInput, out TOutput> {
    suspend fun process(input: TInput): TOutput
}
```

三个接口独立定义，各自关注自己的职责。剩下的事就是把它们串联成一个完整的、可观测的、可取消的管道——这就是 Flow 的用武之地。

## 用 Flow 操作符串联阶段

Flow 天然适合做数据管道的编排，因为它的每个操作符就是一个 processing stage。把三个阶段分别实现为 Flow 的扩展函数：

```kotlin
fun <TInput, TOutput> Flow<TInput>.preprocess(
    preprocessor: Preprocessor<TInput, TOutput>
): Flow<TOutput> = transform { input ->
    emit(preprocessor.process(input))
}

fun <TInput, TOutput> Flow<TInput>.infer(
    engine: InferenceEngine<TInput, TOutput>
): Flow<TOutput> = transform { input ->
    emit(engine.infer(input))
}

fun <TInput, TOutput> Flow<TInput>.postprocess(
    postprocessor: Postprocessor<TInput, TOutput>
): Flow<TOutput> = transform { input ->
    emit(postprocessor.process(input))
}
```

使用 `transform` 而非 `map` 是有意为之：`transform` 允许在单个操作符内做更多控制，比如异步释放资源、条件发射等，为后续扩展保留空间。

组装起来就是一条完整的推理管道：

```kotlin
val pipeline: Flow<List<Detection>> = flowOf(bitmap)
    .preprocess(imagePreprocessor)
    .infer(tfliteEngine)
    .postprocess(detectionPostprocessor)
    .catch { e -> emit(emptyList()) }
    .flowOn(Dispatchers.Default)
```

管道结构一目了然，每个阶段可以单独替换、单独测试，新增一个预处理逻辑只需写一个新的 Preprocessor 实现然后插进去。我在实际项目中用这种方式把模型切换的成本从几百行代码降到了改一行构造函数参数。

## 处理推理中的异步与资源管理

端侧推理有几个坑是同步代码很难优雅处理的：模型加载耗时、推理过程中需要持有 Native 资源、取消推理时需要及时释放。Flow 的上下文切换和取消机制可以解决这些。

模型加载应当放在 `flowOn` 指定的调度器上，避免阻塞主线程：

```kotlin
fun Flow<Bitmap>.loadedInfer(
    modelPath: String,
    context: Context
): Flow<FloatArray> = transform { bitmap ->
    val interpreter = Interpreter(File(modelPath)) // 同步加载，在 flowOn 调度器上执行
    try {
        val tensor = preprocessBitmap(bitmap)
        val output = FloatArray(outputSize)
        interpreter.run(tensor, output)
        emit(output)
    } finally {
        interpreter.close()
    }
}.flowOn(Dispatchers.Default)
```

`try-finally` 确保 Interpreter 在每次推理后释放。如果是一次加载多次推理的场景，可以用 `callbackFlow` 管理 Interpreter 生命周期：

```kotlin
fun Flow<ByteBuffer>.inferWithPool(
    modelPath: String
): Flow<FloatArray> = callbackFlow {
    val interpreter = Interpreter(File(modelPath))
    try {
        collect { tensor ->
            val output = FloatArray(outputSize)
            interpreter.run(tensor, output)
            send(output)
        }
    } finally {
        interpreter.close()
    }
    awaitClose()
}
```

`callbackFlow` 的生命周期：它在上游 Flow 收集期间保持活跃，取消时 `finally` 块保证释放。在相机实时推理场景中，退出页面时自动取消推理，不会泄漏 Native 内存。

## 可组合的管道：多模型串联与条件分支

单个模型的管道相对简单，但实际需求往往更复杂：先用分类模型判断场景，再路由到不同的检测模型。

这种场景下，Flow 的 `flatMapConcat` 可以自然地表达条件分支：

```kotlin
fun Flow<Bitmap>.classifyThenDetect(
    classifier: Pipeline<Bitmap, Classification>,
    personDetector: Pipeline<Bitmap, List<Detection>>,
    vehicleDetector: Pipeline<Bitmap, List<Detection>>
): Flow<List<Detection>> = flatMapConcat { bitmap ->
    flowOf(bitmap)
        .run(classifier)
        .flatMapConcat { classification ->
            when (classification.category) {
                "person" -> flowOf(bitmap).run(personDetector)
                "vehicle" -> flowOf(bitmap).run(vehicleDetector)
                else -> flowOf(emptyList())
            }
        }
}
```

这里的关键技巧是外层 `flatMapConcat` 捕获了原始 bitmap，使得内层 switch 分支仍然能拿到原始帧传给检测器。如果直接在分类结果上 flatMap，原始 bitmap 就丢失了。

`Pipeline` 类型别名把预处理-推理-后处理三件套打包成一个可复用的单元：

```kotlin
data class Pipeline<in TInput, out TOutput>(
    val preprocessor: Preprocessor<TInput, *>,
    val engine: InferenceEngine<*, *>,
    val postprocessor: Postprocessor<*, TOutput>
)

@Suppress("UNCHECKED_CAST")
fun <TInput, TOutput> Flow<TInput>.run(
    pipeline: Pipeline<TInput, TOutput>
): Flow<TOutput> = transform { input ->
    val intermediate = pipeline.preprocessor.process(input)
    val raw = (pipeline.engine as InferenceEngine<Any?, Any?>).infer(intermediate)
    emit(pipeline.postprocessor.process(raw))
}
```

`Pipeline` 封装了三个阶段的组合，一个 `Pipeline` 就是一个完整的模型推理能力单元。不同的 Pipeline 可以像搭积木一样组合，业务代码里只需要关心输入输出类型是否匹配。`Preprocessor<*, *>` 中的星投影会擦除中间类型，换来的是简洁的 API——这是一种务实的取舍。

## 为实时场景加入背压控制

相机预览每秒产生 30 帧，但推理可能只能处理 10 帧。如果不做背压控制，帧会堆积导致内存溢出和延迟越来越大。

`conflate` 和 `sample` 是处理这个问题的首选操作符：

```kotlin
cameraFrames
    .sample(100) // 每 100ms 取最新一帧，丢弃中间帧
    .run(ocrPipeline)
    .collect { text -> updateUI(text) }
```

`sample` 的语义是"我只关心最新的"，它会丢弃采样间隔内未处理的帧。对于实时检测场景，这比 `buffer` + `conflate` 更语义明确。

另一个常见需求是**防抖**：用户停止操作（如停止移动相机）后再触发推理，节省算力：

```kotlin
cameraFrames
    .debounce(300) // 300ms 内无新帧才触发
    .run(heavyPipeline)
    .collect { result -> showResult(result) }
```

这些 Flow 操作符不需要改动管道本身的任何代码——管道定义的是"做什么"，操作符定义的是"什么时候做"，两者正交。

## 测试：每个阶段独立可测

管道化最大的好处是**可测试性**。每个阶段可以独立注入 mock 进行单元测试，不需要真机、不需要模型文件。

```kotlin
class PreprocessTest {
    @Test
    fun `normalize 0-255 pixel to 0-1 float`() = runTest {
        val preprocessor = ImagePreprocessor(targetSize = 224)
        val input = Bitmap.createBitmap(224, 224, Bitmap.Config.ARGB_8888)
        // 填充白色像素
        input.eraseColor(Color.WHITE)

        val tensor = preprocessor.process(input)

        // 白色像素归一化后应为 1.0
        assertEquals(1.0f, tensor.getFloat(0), 0.01f)
    }
}
```

后处理阶段的测试同样简单——直接构造模型输出的 FloatArray，验证解析结果是否正确：

```kotlin
@Test
fun `parse detection boxes from raw output`() = runTest {
    val postprocessor = DetectionPostprocessor(threshold = 0.5f)
    val rawOutput = floatArrayOf(
        // [class_id, score, x1, y1, x2, y2]
        0f, 0.9f, 0.1f, 0.2f, 0.5f, 0.6f,
        0f, 0.3f, 0.7f, 0.8f, 0.9f, 0.95f
    )

    val detections = postprocessor.process(rawOutput)

    assertEquals(1, detections.size) // 第二框低于阈值
    assertEquals(0.9f, detections[0].score)
}
```

整条管道也可以端到端测试，注入一个 fake 的 InferenceEngine 返回预定义结果：

```kotlin
@Test
fun `end to end pipeline with fake engine`() = runTest {
    val fakeEngine = object : InferenceEngine<ByteBuffer, FloatArray> {
        override suspend fun infer(input: ByteBuffer) = floatArrayOf(0f, 0.95f, 0f, 0f, 1f, 1f)
    }
    val pipeline = Pipeline(
        ImagePreprocessor(224),
        fakeEngine,
        DetectionPostprocessor(0.5f)
    )

    val results = flowOf(testBitmap).run(pipeline).first()

    assertEquals(1, results.size)
}
```

这种分层测试策略——单元测阶段、集成测管道——让调试效率提升了一个量级。不用每次改后处理逻辑都跑一遍完整推理，不用等模型加载。

## 几点实践建议

**接口设计优先于实现**。先定义好 Preprocessor / InferenceEngine / Postprocessor 的输入输出类型，类型系统会帮你检查管道是否拼装正确。类型不匹配在编译期就暴露，而不是运行时崩溃。

**Pipeline 作为配置单元**。把预处理参数（目标尺寸、归一化方式）、模型路径、后处理阈值都封装在 Pipeline 的实现里，上层业务代码只拿到一个 `Pipeline<Bitmap, List<Detection>>`，不需要关心内部细节。

**善用 `flowOn` 隔离计算**。推理是 CPU 密集型操作，用 `flowOn(Dispatchers.Default)` 把它和 UI 收集端分离。预处理如果是轻量操作可以留在主线程，`flowOn` 只作用在推理阶段即可。

关于端侧推理框架的选择，我目前倾向于 TFLite 的 NNAPI delegate 用于大多数场景——它在高通和联发科平台上的算子覆盖已经很成熟。MediaPipe 适合需要多模型编排的复杂场景，但它的 Task API 封装程度较高，自定义管道反而更灵活。
