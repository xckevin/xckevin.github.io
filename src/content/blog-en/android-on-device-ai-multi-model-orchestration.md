---
title: "Multi-Model Orchestration for Android On-Device AI"
lang: en
translationKey: android-on-device-ai-multi-model-orchestration
slug: android-on-device-ai-multi-model-orchestration
excerpt: "Design Pipe-style workflows for multiple Android models, with routing, fallback, model management, and coroutine scheduling."
publishDate: '2026-07-02'
tags:
- "Android"
- "On-device Inference"
- "AI Architecture"
- "Kotlin Coroutines"
seo:
  title: "Multi-Model Orchestration for Android AI"
  description: "Build reliable multi-model on-device AI workflows with routing, fallbacks, and coroutine scheduling."
  pageType: article
---

When I was working on a photo album organizing function last year, the requirements didn't sound complicated: identify objects in photos, classify them by species if they were pets, and extract text summaries if they were documents. Just looking at each subtask and running a model is enough. But after being put together, problems with state management, model switching, and error recovery all emerged.

Single model inference is the comfort zone, and composite AI tasks are the real battlefield of engineering.

## Comfort zone of single model inference

To run a TFLite or MediaPipe model on Android, the code usually looks like this:

```kotlin
val interpreter = Interpreter(modelBuffer)
val output = Array(1) { FloatArray(NUM_CLASSES) }
interpreter.run(inputBuffer, output)
```

A dozen lines of code, one model, one input, and one output. But in the actual product, what the user wants is not "This picture has an 87% probability of being a cat", but "Help me pick out the cat photos and organize them by species." What you need is no longer a single inference, but a multi-model collaborative workflow.

The problem lies in the connection: the output of the previous model is the input of the latter model, and you need to take care of the intermediate format conversion, exception handling, and resource scheduling yourself. Each model may come from different frameworks (TFLite, ONNX, NNAPI), and have different memory footprints and loading times.

## Pipe: the basic paradigm of serial orchestration

The most straightforward solution is to string the models together like a pipeline - the output of the previous one is piped to the input of the next one. This is the core of the Pipe pattern (Pipeline Pattern).

```kotlin
class ImageAnalysisPipeline(
    private val detector: ObjectDetector,   // Object detection
    private val classifier: BreedClassifier, // Breed classification
    private val ocr: TextRecognizer         // Text recognition
) {
    suspend fun process(image: Bitmap): AnalysisResult {
        val objects = detector.detect(image)

        return objects.map { obj ->
            when (obj.category) {
                "pet" -> {
                    val breed = classifier.classify(obj.cropFrom(image))
                    PetResult(breed, obj.boundingBox)
                }
                "document" -> {
                    val text = ocr.recognize(obj.cropFrom(image))
                    DocumentResult(text, obj.boundingBox)
                }
                else -> GenericResult(obj.category, obj.boundingBox)
            }
        }
    }
}
```

The core value of this Pipeline is not "series", but the adaptation layer of input and output. Each model has different requirements for input size, format, and normalization method. You need to perform cropping, scaling, and color space conversion at the transfer point. Encapsulate this layer of logic into Pipe so that it won’t be scattered everywhere when new models are added later.

## Conditional branch: upgrade if-else to routing table

The `when` branch above has hard-coded routing logic. It is okay to have few models. Once there are more than 5 downstream models, the code becomes a mess.

A more engineering approach is to use a declarative routing table - which separates "which model to use under what conditions" from the code logic:

```kotlin
data class RouteRule(
    val condition: (DetectionResult) -> Boolean,
    val handler: suspend (DetectionResult) -> AnalysisResult
)

class RoutedPipeline(private val rules: List<RouteRule>) {
    suspend fun route(result: DetectionResult): AnalysisResult {
        val matched = rules.firstOrNull { it.condition(result) }
            ?: return FallbackResult(result)
        return matched.handler(result)
    }
}

// Configure the routing table.
val pipeline = RoutedPipeline(listOf(
    RouteRule({ it.confidence > 0.8f && it.category == "pet" }) { obj ->
        PetResult(classifier.classify(obj.crop), obj.bbox)
    },
    RouteRule({ it.category == "text_block" }) { obj ->
        DocumentResult(ocr.recognize(obj.crop), obj.bbox)
    }
))
```

The routing table allows each rule to be independently tested, and routing rules can be dynamically distributed without publishing. The most important thing is to have a clear path to the bottom - fallback when you miss, and you won't lose data silently.

I once stepped on a pitfall: after the label list returned by the classification model was updated online, the hard-coded `when` branch missed a new category, causing that part of the picture to skip classification directly. After changing to the routing table and adding a buffer, the new category can at least get `GenericResult`, and the user side will not have the situation of "there is a result but can't see it".

## Dynamic routing: let the workflow learn to detour

Pipes and simple branches can only take fixed paths. What should I do if document recognition fails? Fallback and try again with CPU model? Or use server-side OCR? This brings us to dynamic routing.

```kotlin
class AdaptiveRouter(
    private val primary: ModelNode,
    private val fallback: ModelNode,
    private val maxRetries: Int = 1
) {
    suspend fun execute(input: ModelInput): ModelOutput {
        for (attempt in 0..maxRetries) {
            try {
                return primary.run(input)
            } catch (e: ModelException) {
                if (attempt == maxRetries) break
                // Fallback strategy: switch models or reduce precision.
                primary.adjustPreference(Preference.LOW_LATENCY)
            }
        }
        return fallback.run(input) // Final fallback
    }
}
```

The essence of dynamic routing is to move the decision-making logic from compile time to run time. You need to maintain the health status of each node - whether the loading is successful, whether the inference time exceeds the threshold, whether the memory pressure is too high - and then select the path based on the real-time status.

My practice is to abstract an `ExecutionGraph`. Each node has two edges: `onSuccess` and `onFailure`. The entire workflow is a directed graph rather than a line. This not only enables downgrading, but also allows for parallel branching: for example, after recognizing a pet, running breed classification and emotion detection at the same time, and finally merging the results, saving serial waiting time.

## Three trade-offs in engineering practice

In terms of model management, my habit is lazy loading plus LRU elimination. Most models do not require permanent memory, use soft references or directly unload, and only load before inference. Loading a 50M model from disk to GPU takes about 200-300ms, which is an acceptable overhead.

It is enough to use coroutines for the threading model. Each model inference is placed on `Dispatchers.Default`, and the pipeline itself is `Flow` - with native support for backpressure and cancellation. NNAPI's delegate already has a thread pool inside, so there is no need to worry about it.

As for the bottom-line strategy, I tend to rather give rough results than leave blanks. For example, when pet breed classification fails, at least tell the user "this is a pet" instead of returning nothing. The bottom line of user experience is that information is not lost - if you miss one dimension, users will not notice it, but if you miss the entire result, users will feel that the function is broken.

## From Pipe to workflow engine

Looking back, from the initial serial pipeline to routing tables and then to dynamic graph execution, we are essentially solving the same problem: how to let multiple independent models collaborate to complete a composite task without exploding the engineering complexity.

When actually selecting a model, base it on the scenario: a simple series connection of two or three models, Pipe mode is enough, don’t over-design. Fixed multi-branch scenarios, added routing tables with cover-up strategies, and extracted conditions from the code. Dynamic decision-making links for downgrading and parallel branches are required before adding runtime routing to `ExecutionGraph`.

Use `Node` instead of `Model` in naming, because a node can be an RPC call to the server, or it can be pure rule logic and does not need to be bound to a local model. This level of abstraction will make subsequent expansion much smoother - when adding new capabilities, you only need to implement a `Node` interface instead of changing a bunch of `if (model is TFLiteModel)` judgments.
