---
title: "ONNX Runtime on Android: Export, Quantize, and Run Models"
lang: en
translationKey: android-onnx-runtime-android-inference
slug: android-onnx-runtime-android-inference
excerpt: "An end-to-end guide to ONNX Runtime for Android, from export and integration through INT8 acceleration and operator compatibility."
publishDate: '2026-07-07'
tags:
- "Android"
- "On-device Inference"
- "ONNX Runtime"
- "Model Optimization"
seo:
  title: "ONNX Runtime Android Inference Guide"
  description: "Export, quantize, and deploy ONNX models with ONNX Runtime on Android."
  pageType: article
---

Half a year ago, I was doing end-side image classification. The model team gave me a `.pt` file exported by PyTorch. Can the Android version be run directly? cannot. The plan at that time was to use PyTorch Mobile, but soon the detection model for another scene was replaced by TensorFlow training.

Two engines, two sets of APIs, two sets of optimization strategies - maintenance costs directly double.

ONNX (Open Neural Network Exchange) solves this problem: it is a set of model intermediate representation specifications that allow the models of PyTorch, TensorFlow, and Keras frameworks to be uniformly exported to `.onnx` format, and the mobile terminal can use ONNX Runtime to execute a set of inference engines.

In the Android end-side inference engine matrix, NCNN, MNN, and TFLite each have their own advantages, but the unique value of ONNX Runtime lies in cross-framework compatibility—you can know exactly what framework the model team uses for training.

## Model export

Code for PyTorch to import ONNX:

```python
import torch

model = torch.load("model.pt", map_location="cpu")
model.eval()

dummy_input = torch.randn(1, 3, 224, 224)

torch.onnx.export(
    model,
    dummy_input,
    "model.onnx",
    input_names=["input"],
    output_names=["output"],
    dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
    opset_version=13
)
```

`dynamic_axes` makes batch dimensions variable. Mobile-side inference usually has batch=1, but during the debugging phase, verification may be run in batches, and the addition of dynamic axes can avoid the trouble of re-exporting.

`opset_version` determines the operator set version. The higher the version, the newer operators are supported, but the ONNX Runtime mobile version may not be fully compatible. In actual testing, 13 has the best balance of coverage and compatibility, and I have always settled on this version.

Convert TensorFlow to ONNX using `tf2onnx`:

```bash
python -m tf2onnx.convert \
  --saved-model ./tf_model \
  --output model.onnx \
  --opset 13
```

After exporting, be sure to open the `.onnx` file with Netron to check the calculation graph. Occasionally you can see redundant Cast or Transpose nodes automatically inserted by the framework - use the `onnxsim` tool to streamline them, and these invalid overheads will be reduced during inference.

## Android side integration

### Dependency configuration

AAR is imported directly, no need to bother with NDK compilation:

```groovy
dependencies {
    implementation 'com.microsoft.onnxruntime:onnxruntime-android:1.17.1'
}
```

Projects that are sensitive to package size can switch to `onnxruntime-mobile`, which removes training-related operators and is 40% smaller in size. It is completely sufficient for pure inference scenarios.

### Model loading and inference

```kotlin
import ai.onnxruntime.*

class OnnxRunner(context: Context) {
    private val env = OrtEnvironment.getEnvironment()
    private var session: OrtSession? = null

    fun loadModel(modelPath: String) {
        session = env.createSession(modelPath)
    }

    fun run(floatInput: FloatArray): FloatArray {
        val session = session ?: throw IllegalStateException("model not loaded")
        val tensor = OnnxTensor.createTensor(env, floatInput, longArrayOf(1, 3, 224, 224))
        val outputs = session.run(mapOf("input" to tensor))
        val result = outputs.get("output").get().value as Array<FloatArray>
        return result[0]
    }
}
```

When loading a model from assets, you cannot directly pass the path. You need to copy it to internal storage first:
```kotlin
fun copyFromAssets(ctx: Context, name: String): String {
    val file = File(ctx.filesDir, name)
    if (!file.exists()) {
        ctx.assets.open(name).use { input ->
            FileOutputStream(file).use { out -> input.copyTo(out) }
        }
    }
    return file.absolutePath
}
```

### Execution Provider

ONNX Runtime supports multiple computing backends. XNNPACK (CPU optimization library) and NNAPI (hardware acceleration channel) are mainly used on Android:

```kotlin
val options = OrtSession.SessionOptions().apply {
    addCPU(true) // Enable XNNPACK; float models are typically 2–3× faster.
    // addNnapi()  // Enable only after compatibility testing.
}
session = env.createSession(modelPath, options)
```

There is a pitfall in NNAPI: after it is enabled, the inference results of some devices are all zero, and if XNNPACK is turned off, it will be normal immediately. NNAPI’s operator coverage and device compatibility from various manufacturers are currently far from enough. Only XNNPACK is enabled by default online, and NNAPI is made optional for users to manually enable it, which is more pragmatic.

## Quantization and acceleration

### INT8 dynamic quantization

Floating-point models are large and slow to infer. ONNX Runtime has built-in quantification tools:

```bash
python -m onnxruntime.quantization.quantize_dynamic \
  --input model.onnx \
  --output model_int8.onnx \
  --weight_type QUInt8
```

Static quantization is better but requires a calibration data set; dynamic quantization does not require calibration and the accuracy loss is controlled within 1%. Actual measurement on Snapdragon 8 Gen1:

| Indicators | FP32 | INT8 |
|------|------|------|
| Size | 46.8 MB | 13.2 MB |
| Reasoning time | 18.7 ms | 8.3 ms |
| Top1 Accuracy | 69.8% | 69.2% |

The accuracy is reduced by 0.6 percentage points, in exchange for a 70% reduction in volume and twice the speed - worth it.

### Multi-thread parameter adjustment

ONNX Runtime is single-threaded by default. Proper configuration of the mobile terminal can squeeze out some more performance:

```kotlin
val options = OrtSession.SessionOptions().apply {
    val cores = Runtime.getRuntime().availableProcessors()
    setIntraOpNumThreads((cores - 1).coerceAtLeast(1))
    setInterOpNumThreads(1)
    addCPU(true)
}
```

`intra_op_num_threads` controls the degree of parallelism within a single operator, and `inter_op_num_threads` controls the degree of parallelism between operators. Most mobile computing graphs are serial chains. Set inter to 1 and intra to the number of cores minus one - leaving one core for the UI thread.

## Trampling on the pit record

The biggest headache for me when switching engines is not performance, but operator compatibility.

An image model uses the `GridSample` operator, and the exported ONNX directly reports `Unsupported Op` on the mobile terminal. ONNX Runtime mobile cuts out a large number of low-frequency operators, and if they are not supported, the model can only be rewritten with equivalent operations.

Another pitfall is the input format. PyTorch defaults to NCHW channel order, and the data from Android Bitmap is HWC or NHWC. The ONNX model will not be automatically transposed for you, and the preprocessing stage must be manually transposed. This problem took a long time to troubleshoot - the inference results were all messed up, but no errors were reported, and all the numbers looked "normal". This kind of silent mistake is the most terrible.

Another time, the quantized INT8 model crashed directly on some low-end and mid-range devices, and the log showed that `std::bad_alloc` was triggered. With the Quant Tool's default configuration, some nodes are allocating more memory than expected. The solution is to switch to per-channel quantization and sacrifice a little speed for stability.

## Practical suggestions

Export using opset 13. After exporting, use Netron to check the calculation graph to confirm that there are no redundant nodes inserted by the framework. If necessary, run `onnxsim` to simplify it. This habit can save you many inexplicable problems when reasoning.

XNNPACK is turned on by default, and NNAPI is turned on and off. The coverage of NNAPI is not stable enough, and it is easy to overturn on unpopular low-end machines if you open it directly online. The situation should improve once Google iterates several more versions of NNAPI adaptation.

Prioritize dynamic INT8 quantization. No calibration set is required, accuracy loss is controllable, and volume and speed gains are significant—this is the lowest-cost optimization path for most classification and detection scenarios.

Input preprocessing is placed outside the model. The logic of normalization and channel conversion is written in Kotlin. If there is a problem, you can see it at a glance without re-exporting the model. This applies to all end-side inference engines, not just ONNX Runtime.
