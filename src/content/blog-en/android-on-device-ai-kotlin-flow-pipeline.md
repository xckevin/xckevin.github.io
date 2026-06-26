---
title: "A Practical Guide to On-Device AI Pipelines with Kotlin Flow"
lang: en
translationKey: android-on-device-ai-kotlin-flow-pipeline
slug: android-on-device-ai-kotlin-flow-pipeline
excerpt: "Model on-device inference as a declarative, composable pipeline of Preprocess, Inference, and Postprocess stages wired together with Kotlin Flow operators, backpressure, and layered tests."
publishDate: '2026-06-17'
tags:
- "Android"
- "Kotlin"
- "OnDeviceAI"
- "TFLite"
- "KotlinFlow"
seo:
  title: "A Practical Guide to On-Device AI Pipelines with Kotlin Flow"
  description: "Build a declarative on-device AI inference pipeline with Kotlin Flow — preprocess, infer, postprocess, backpressure, multi-model branching, and layered tests."
  pageType: article
---

Last year, while building an on-device OCR feature, I hit a familiar trap: preprocess, inference, and postprocess code was tangled together. Adding a new model meant copy-pasting hundreds of lines. Testing meant manually running the whole pipeline. Touch one preprocessing detail and everything downstream broke — debugging felt like peeling an onion.

The root cause is **the inference flow lacks a structural abstraction**. On-device AI inference is a data-transformation pipeline: raw input → preprocess → model inference → postprocess → business result. Kotlin Flow's operator composition is exactly suited to making that pipeline explicit and composable.

## Three-Stage Abstraction

On-device inference reduces to three core stages, each a pure functional transformation:

```
Input → [Preprocess] → Tensor → [Inference] → RawOutput → [Postprocess] → Result
```

The first stage is **preprocess**: convert business input (Bitmap, text, audio frames) into the Tensor format the model expects — resizing, normalization, channel rearrangement.

The second is **inference**: invoke a runtime such as TFLite, NNAPI, or MediaPipe, feed the Tensor, and obtain raw output.

The third is **postprocess**: map raw model output (probability distributions, bounding boxes, embedding vectors) into data structures the business layer can consume.

Each stage is an independent, testable pure function: takes input, returns output, holds no state, depends on no global context. Expressed with Kotlin's type system:

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

Three interfaces, each owning its own concern. The remaining task is to wire them into a complete, observable, cancellable pipeline — which is exactly what Flow is for.

## Wiring Stages with Flow Operators

Flow is a natural fit for orchestrating a data pipeline because each operator is a processing stage. Implement the three stages as Flow extension functions:

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

Using `transform` rather than `map` is deliberate: `transform` allows more control inside a single operator — async resource release, conditional emission — leaving room to extend later.

Assembled, it is a complete inference pipeline:

```kotlin
val pipeline: Flow<List<Detection>> = flowOf(bitmap)
    .preprocess(imagePreprocessor)
    .infer(tfliteEngine)
    .postprocess(detectionPostprocessor)
    .catch { e -> emit(emptyList()) }
    .flowOn(Dispatchers.Default)
```

The pipeline structure is self-documenting. Each stage can be swapped or tested independently. Adding a new preprocessing step means writing a new `Preprocessor` and slotting it in. In a real project this cut model-switching cost from hundreds of lines to a one-line constructor parameter.

## Async and Resource Management

On-device inference has a few traps that synchronous code cannot handle gracefully: model load latency, native resources that must be held during inference, and timely release on cancellation. Flow's context switching and cancellation handle all three.

Model loading belongs on the dispatcher specified by `flowOn`, off the main thread:

```kotlin
fun Flow<Bitmap>.loadedInfer(
    modelPath: String,
    context: Context
): Flow<FloatArray> = transform { bitmap ->
    val interpreter = Interpreter(File(modelPath)) // synchronous, on flowOn dispatcher
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

The `try-finally` guarantees the Interpreter is released after each inference. For a load-once, infer-many scenario, manage the Interpreter lifecycle with `callbackFlow`:

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

`callbackFlow`'s lifecycle: it stays active while the upstream Flow is being collected, and the `finally` block guarantees release on cancellation. In a live-camera inference scenario, leaving the screen auto-cancels inference without leaking native memory.

## Composable Pipelines: Multi-Model Chaining and Branching

A single-model pipeline is straightforward, but real needs are usually more complex: a classification model judges the scene first, then routes to different detection models.

For this scenario, Flow's `flatMapConcat` expresses conditional branching naturally:

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

The key trick: the outer `flatMapConcat` captures the original bitmap so the inner switch branch still has the raw frame to hand to the detector. If you flatMap directly on the classification result, the original bitmap is lost.

The `Pipeline` type alias bundles preprocess-infer-postprocess into a reusable unit:

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

A `Pipeline` bundles three stages into one complete inference-capability unit. Different pipelines compose like building blocks, and business code only cares whether input and output types match. The star-projection in `Preprocessor<*, *>` erases intermediate types in exchange for a clean API — a pragmatic trade.

## Backpressure for Real-Time Scenarios

A camera preview produces 30 frames per second, but inference may only handle 10. Without backpressure, frames pile up, memory overflows, and latency grows.

`conflate` and `sample` are the preferred operators here:

```kotlin
cameraFrames
    .sample(100) // take the latest frame every 100ms, drop the rest
    .run(ocrPipeline)
    .collect { text -> updateUI(text) }
```

`sample`'s semantics are "I only care about the latest" — it drops unprocessed frames within the sampling interval. For real-time detection this is clearer than `buffer` + `conflate`.

Another common need is **debouncing**: trigger inference only after the user stops moving the camera, saving compute:

```kotlin
cameraFrames
    .debounce(300) // fire only after 300ms with no new frame
    .run(heavyPipeline)
    .collect { result -> showResult(result) }
```

These Flow operators require no changes to the pipeline code itself — the pipeline defines "what to do," and the operators define "when to do it." The two concerns are orthogonal.

## Testing: Each Stage in Isolation

The biggest win of pipelining is **testability**. Each stage can be unit-tested with a mock — no device, no model file required.

```kotlin
class PreprocessTest {
    @Test
    fun `normalize 0-255 pixel to 0-1 float`() = runTest {
        val preprocessor = ImagePreprocessor(targetSize = 224)
        val input = Bitmap.createBitmap(224, 224, Bitmap.Config.ARGB_8888)
        input.eraseColor(Color.WHITE)

        val tensor = preprocessor.process(input)

        assertEquals(1.0f, tensor.getFloat(0), 0.01f)
    }
}
```

Postprocess tests are equally simple — construct a raw `FloatArray` as model output and verify the parsed result:

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

    assertEquals(1, detections.size) // second box below threshold
    assertEquals(0.9f, detections[0].score)
}
```

The whole pipeline can also be end-to-end tested by injecting a fake `InferenceEngine` returning canned results:

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

This layered test strategy — unit-test each stage, integration-test the pipeline — lifts debugging efficiency by an order of magnitude. You no longer need to run a full inference pass every time you tweak postprocess logic, and you never wait on model load.

## Practical Recommendations

**Interface design precedes implementation**. Define the input and output types of `Preprocessor`, `InferenceEngine`, and `Postprocessor` first. The type system will tell you whether the pipeline is wired correctly. Type mismatches surface at compile time, not as runtime crashes.

**Pipeline as configuration unit**. Encapsulate preprocess parameters (target size, normalization scheme), model path, and postprocess threshold inside the Pipeline implementation. Business code receives a `Pipeline<Bitmap, List<Detection>>` and does not need to know the internals.

**Use `flowOn` to isolate compute**. Inference is CPU-bound; route it to `Dispatchers.Default` and separate it from the UI collection side. If preprocessing is lightweight it can stay on the main thread — `flowOn` then scopes only the inference stage.

On framework choice: I currently lean toward TFLite with the NNAPI delegate for most scenarios — operator coverage on Qualcomm and MediaTek platforms is already mature. MediaPipe suits complex scenarios requiring multi-model orchestration, but its Task API is highly encapsulated, and a custom pipeline is more flexible when you need control.
