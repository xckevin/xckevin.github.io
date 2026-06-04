---
title: "Android ML Kit in Practice: Vision Pipelines and CameraX Integration"
lang: en
translationKey: android-ml-kit-vision-camerax
slug: android-ml-kit-vision-camerax
excerpt: "A practical guide to ML Kit for on-device vision, covering detection pipelines, CameraX integration, multi-model orchestration, and inference optimization."
publishDate: '2025-08-01'
tags:
- "Android"
- "ML Kit"
- "CameraX"
- "On-device Inference"
- "Computer Vision"
seo:
  title: "Android ML Kit Vision Pipelines with CameraX Integration"
  description: "Learn how to build real-time on-device vision with ML Kit and CameraX, including backpressure, resolution choices, ImageProxy handling, and pipeline design."
  pageType: article
---

Last year I worked on an industrial inspection app. The requirement was to detect surface defects on parts in real time with a phone camera while the production line kept running. At the time, everyone on the team was talking about LLMs, but for this kind of pure vision task, an LLM was the wrong tool: latency was too high, the model was too large, and inference cost was impossible to justify. We eventually used **ML Kit** for on-device vision and paired it with CameraX to build a real-time analysis pipeline.

This article records the engineering choices and implementation details from that project.

## ML Kit's role: the Swiss army knife of on-device vision

ML Kit is essentially Google's unified API layer for mobile vision capabilities. Its main advantage is not "best possible accuracy." It is **ready-to-use APIs with no server dependency**.

It provides two broad categories of capabilities:

- **Base vision APIs**: face detection, text recognition (OCR), barcode scanning, image labeling, object detection, pose detection, and selfie segmentation. These models are built into Play Services and do not require separate downloads.
- **Custom model APIs**: integration with TensorFlow Lite models, useful for enterprise-specific scenarios such as our defect detection model.

One detail is easy to miss: ML Kit's Detection Pipeline does not process each frame as a completely independent image. Internally, it maintains cross-frame tracking state, which is critical for stability on continuous video streams.

## How the detection pipeline works

Using Object Detection as an example, ML Kit's processing chain has three steps:

```text
CameraX frame -> InputImage wrapper -> Detector inference -> Result callback
```

**InputImage** is the input format for the whole pipeline. It needs to be converted from CameraX's `ImageProxy`, and this is a common source of performance mistakes.

There are two ways to create an InputImage:

```kotlin
// Option 1: from ByteBuffer (recommended, zero copy)
val image = InputImage.fromByteBuffer(
    buffer,
    width, height, rotation,
    InputImage.IMAGE_FORMAT_YUV_420_888
)

// Option 2: from Bitmap (format conversion adds overhead)
val image = InputImage.fromBitmap(bitmap, rotation)
```

In a real project, **use option 1**. Pass CameraX's YUV output directly and avoid the RGB conversion cost, which can add 15-25 ms of latency. At high frame rates, that optimization can be the difference between two visible performance tiers.

Once you have an InputImage, detector execution is straightforward:

```kotlin
objectDetector.process(image)
    .addOnSuccessListener { results ->
        for (obj in results) {
            val box = obj.boundingBox
            val labels = obj.labels
            // Read the detection box and labels
        }
    }
    .addOnFailureListener { e -> /* Handle error */ }
```

The **DetectedObject** returned in the callback has four key fields: bounding box, labels, tracking ID, and corner points. The tracking ID is maintained automatically by ML Kit, so the same object keeps the same ID across consecutive frames. That saves you from implementing your own tracking layer.

## CameraX integration: balancing frame rate and detection cadence

CameraX's `ImageAnalysis` use case is the bridge between camera frames and ML Kit. The recommended approach is to register a callback with `setAnalyzer`:

```kotlin
val imageAnalysis = ImageAnalysis.Builder()
    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
    .setTargetResolution(Size(640, 480))
    .build()

imageAnalysis.setAnalyzer(executor) { imageProxy ->
    val mediaImage = imageProxy.image
    if (mediaImage != null) {
        val inputImage = InputImage.fromMediaImage(
            mediaImage, imageProxy.imageInfo.rotationDegrees
        )
        objectDetector.process(inputImage)
            .addOnCompleteListener {
                imageProxy.close() // Must be closed manually
            }
    }
}
```

Three decisions matter most.

**Use `STRATEGY_KEEP_ONLY_LATEST` for backpressure.** If detection takes longer than the frame interval, for example 150 ms per frame while the camera produces 30 fps, CameraX drops older frames and keeps only the newest one for the analyzer. This prevents frame backlog and memory growth. The trade-off is that some frames may be skipped, which is acceptable for real-time detection.

**Set the resolution to 640x480 (VGA).** We tested 1080p input. Accuracy improved by less than 2%, while inference latency jumped from 60 ms to 180 ms. For on-device models, input resolution is one of the highest-leverage tuning knobs.

**Always call `imageProxy.close()`.** If you miss this line, ImageProxy instances are not returned to the shared buffer pool, and CameraX stops emitting frames after roughly 30 frames. In logs this may appear as "ImageProxy is already closed" or buffer exhaustion, and it is miserable to debug.

## Building a complete pipeline: detection, classification, feedback

Industrial inspection needs more than detection. Multiple capabilities need to be chained together. For defect detection, our pipeline looked like this:

```text
CameraX frame -> Object detection (locate defect region) -> Image classification (defect type) -> Result aggregation -> UI feedback
```

The core code structure:

```kotlin
class InspectionPipeline(private val context: Context) {
    private val detector = ObjectDetection.getClient(...)
    private val classifier = ImageClassification.getClient(...)
    private var lastResults: InspectionResult? = null

    fun process(imageProxy: ImageProxy) {
        val inputImage = InputImage.fromMediaImage(
            imageProxy.image!!, imageProxy.imageInfo.rotationDegrees
        )

        detector.process(inputImage).addOnSuccessListener { detections ->
            if (detections.isEmpty()) {
                lastResults = InspectionResult.Normal
                imageProxy.close()
                return@addOnSuccessListener
            }

            // Classify each detected region
            val detection = detections.first()
            val cropImage = cropToDetectionBox(inputImage, detection.boundingBox)
            classifier.process(cropImage).addOnSuccessListener { labels ->
                lastResults = when (labels.firstOrNull()?.text) {
                    "scratch" -> InspectionResult.Scratch(detection.boundingBox)
                    "dent" -> InspectionResult.Dent(detection.boundingBox)
                    else -> InspectionResult.Unknown
                }
                imageProxy.close()
            }
        }
    }
}
```

I made two trade-offs in the pipeline design.

**Run classification only after detection finds a target**, instead of classifying every frame. This reduced classifier calls by about 70%. Most production-line frames were normal and did not need classification.

**Classify only the first detection result.** The requirement was to raise an alarm when any defect was found, not to classify every target. If your scenario requires multi-object analysis, this simplification does not apply.

## Engineering lessons for on-device inference

Three pitfalls stood out.

**Pitfall 1: model loading timing.** The detector and classifier together were about 15 MB. Loading them synchronously in `onCreate` pushed first-frame latency beyond 2 seconds. The right approach is asynchronous preloading:

```kotlin
// Complete this during Application or Splash startup
lifecycleScope.launch(Dispatchers.IO) {
    ObjectDetection.getClient(options) // Triggers download
}
```

ML Kit models are lazy-loaded and are truly initialized only on the first `process()` call. Calling `getClient()` early only creates the configuration object. **You need to run one empty warm-up inference to trigger model loading**. I used a 1x1 blank frame for this. It cost about 200 ms and removed waiting from later frames.

**Pitfall 2: threading model.** `setAnalyzer` runs on a CameraX internal thread. If you do synchronous slow work there, you block frame production. Using `addOnSuccessListener` avoids that issue because the callback is asynchronous, but if the pipeline logic is heavy, move result processing to a separate HandlerThread:

```kotlin
val analysisThread = HandlerThread("ml-inference").apply { start() }
val analysisHandler = Handler(analysisThread.looper)
```

In practice, I found that ML Kit already runs inference on its own internal thread pool, so adding another thread often did not help much. The more important part was controlling concurrent frames. Use `AtomicBoolean` as a single-frame guard:

```kotlin
private val isProcessing = AtomicBoolean(false)

setAnalyzer { imageProxy ->
    if (isProcessing.compareAndSet(false, true)) {
        pipeline.process(imageProxy) {
            isProcessing.set(false)
        }
    } else {
        imageProxy.close() // Skip this frame, but still close it
    }
}
```

**Pitfall 3: device compatibility.** ML Kit's base models depend on Google Play Services. Some devices, especially certain overseas variants, may ship with an old Play Services version that makes models unavailable. Use `GoogleApiAvailability` for runtime checks. The fallback is to guide users to update Play Services or switch to a custom TFLite model.

## Where on-device intelligence fits

After this project, I had a clearer view of what belongs on-device.

ML Kit is strong for well-defined vision tasks such as detection, classification, and OCR; latency-sensitive flows that need inference under 50 ms; and offline environments. It is not a good fit for semantic understanding tasks, which belong to LLMs; extremely high-accuracy requirements, where cloud models may be better; or scenarios where models change frequently.

During architecture review, the product manager wanted to use the GPT-4V API directly for defect analysis. I argued for the on-device approach for three simple reasons: factory networks were unreliable, latency had to stay under 200 ms, and data could not leave the facility. Those constraints ruled out the cloud path.

If your scenario has similar constraints, ML Kit plus CameraX deserves a place in your toolbox. It is not the flashiest option, but for real-time on-device vision analysis, its maturity is still hard to replace.
