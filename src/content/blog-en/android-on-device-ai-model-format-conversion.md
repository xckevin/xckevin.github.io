---
title: "From PyTorch to TFLite on Android: A Practical Model Format Conversion Guide"
lang: en
translationKey: android-on-device-ai-model-format-conversion
slug: android-on-device-ai-model-format-conversion
excerpt: "A hands-on guide to converting PyTorch models through ONNX into TFLite and MediaPipe for on-device Android deployment, covering dynamic shapes, operator compatibility, and INT8 quantization."
publishDate: '2026-06-22'
tags:
- "Android"
- "PyTorch"
- "TFLite"
- "ONNX"
- "On-Device AI"
seo:
  title: "PyTorch to TFLite on Android: Model Conversion Walkthrough"
  description: "Convert PyTorch models to ONNX, TFLite, and MediaPipe for Android: dynamic shapes, operator compat, INT8 quant, and pitfalls."
  pageType: article
---

Last year I shipped an on-device image segmentation model built on MobileNetV3. Accuracy in PyTorch was great, but getting it onto Android was a chain of surprises: PyTorch Mobile ballooned the APK, TFLite's operator coverage had gaps, and MediaPipe's graph expected specific input formats. After several painful weeks I settled on a **PyTorch → ONNX → TFLite → MediaPipe** pipeline that closed the loop from training to deployment.

ONNX as an intermediate representation decouples the training framework from the inference engine. Format conversion stops being a black box and becomes a controllable, debuggable engineering workflow.

## PyTorch to ONNX: Three Hidden Traps

`torch.onnx.export()` looks straightforward. In practice it is full of pitfalls, and the root cause is the mismatch between PyTorch's dynamic graphs and ONNX's static graph model.

**Trap 1: Dynamic shapes break the trace**

The default `torch.onnx.export` runs `torch.jit.trace`, which feeds a real input through the model and records the executed path. If your model contains a branch like `if x.shape[0] > 1`, trace only records one branch — the other is silently dropped from the exported graph.

```python
# Wrong: trace mode freezes conditional branches
torch.onnx.export(model, dummy_input, "model.onnx")

# Right: use scripting or dynamo for dynamic logic
torch.onnx.export(
    model, dummy_input, "model.onnx",
    dynamo=True,  # recommended for PyTorch 2.0+
    input_names=["input"],
    dynamic_axes={"input": {0: "batch_size"}}
)
```

`dynamo=True` routes through the FX Graph, which handles control flow more completely than trace. The `dynamic_axes` declaration is mandatory — otherwise ONNX bakes the batch dimension in as a constant.

**Trap 2: Custom operators explode on export**

If you use operators like `torch.nn.functional.grid_sample`, ONNX export throws `RuntimeError` immediately. The ONNX operator set (opset) is a finite collection, and not every PyTorch operator has a corresponding implementation.

`torch.argmax`, which I used in the segmentation model, is unsupported below opset 11. The fix is to bump the opset version or replace the operator with an equivalent:

```python
# argmax requires opset 13+
torch.onnx.export(model, dummy_input, "model.onnx",
    opset_version=13,
    dynamo=True)
```

For operators that genuinely cannot be mapped, you need to register a custom implementation via `torch.onnx.symbolic` at the ONNX layer, or split the model into an exportable part plus post-processing, implementing the non-standard operator in native code on-device.

**Trap 3: Silent accuracy drift**

Export succeeds without error, but inference results diverge by 3-5%. This is the most insidious trap. The root cause is usually tiny numerical differences between ONNX operator implementations and PyTorch — for example, `BatchNorm` epsilon defaults that differ, or `Upsample` coordinate alignment that does not match.

My habit is to validate accuracy immediately after export, comparing PyTorch and ONNX Runtime outputs on the same input:

```python
import onnxruntime as ort
import numpy as np

# Validate right after export
session = ort.InferenceSession("model.onnx")
onnx_out = session.run(None, {"input": dummy_input.numpy()})
torch_out = model(dummy_input).detach().numpy()
diff = np.max(np.abs(onnx_out[0] - torch_out))
assert diff < 1e-5, f"Accuracy diff too large: {diff}"  # FP32 usually < 1e-5
```

For FP32 models the diff is typically on the order of 1e-6. Anything above 1e-4 means you need to investigate the specific operator.

## ONNX to TFLite: Operator Compatibility Is the Bottleneck

ONNX is a general-purpose intermediate format; TFLite is mobile-specialized. The conversion toolchain between them is thin. I tried two routes:

| Approach | Best for | Operator coverage |
|----------|----------|-------------------|
| `onnx-tf` → TFLite Converter | Simple CNNs | Moderate |
| `onnx2tf` | Mid-complexity models | Better |

`onnx2tf` is maintained by PINTO and covers more ONNX operators than the official `onnx-tf`, with INT8 quantization support. Install and basic usage:

```bash
pip install onnx2tf
onnx2tf -i model.onnx -o tflite_model
```

Two error categories dominate the conversion:

**Unsupported operator**: `onnx2tf` reports `ERROR: The OP is not yet implemented`. Common gaps include `Resize` (specific modes), `ScatterND`, and `NonMaxSuppression`. Fix: replace the operator on the PyTorch side with an equivalent, or simplify the graph with `onnx-simplifier` at the ONNX layer.

**Shape inference failure**: TFLite is a static graph and needs every tensor shape resolved at conversion time. If the ONNX model carries a `-1` dynamic dimension, you must pin it explicitly:

```bash
onnx2tf -i model.onnx -o tflite_model \
  -prf replace_1x1_with_conv \
  -kat input_1 1,3,256,256  # force input shape
```

The `-kat` flag overrides dynamic dimensions directly, which is less work than reshaping at the ONNX layer.

## Quantization: Trading Accuracy for Speed

FP32 models run slowly on mobile. Quantization is mandatory. `onnx2tf` supports INT8 quantization but needs a calibration dataset:

```bash
onnx2tf -i model.onnx -o tflite_model_quant \
  -oiqt \  # INT8 quantization
  -cind "input_1" /path/to/calib/images  # calibration data path
```

A trap I hit: a calibration set of only 20 images caused accuracy to crater after quantization. Use at least 200-500 representative samples that cover the input distributions your model will see in production.

Post-quantization accuracy validation matters more than for FP32:

```python
import tensorflow as tf

interpreter = tf.lite.Interpreter("tflite_model_quant")
interpreter.allocate_tensors()
input_details = interpreter.get_input_details()
output_details = interpreter.get_output_details()

# Run the validation set and compare against the float model
interpreter.set_tensor(input_details[0]['index'], test_input)
interpreter.invoke()
quant_output = interpreter.get_tensor(output_details[0]['index'])
```

Accuracy loss within 1% after INT8 quantization is reasonable. Above that, your calibration data is not representative enough, or the model contains quantization-sensitive operators (for example, `Softmax` tends to break at low precision).

## Wiring Into MediaPipe: Graphs and Data Flow

A TFLite model can run on Android directly through the TFLite Interpreter. But if you need a more complex pipeline — preprocessing plus inference plus post-processing plus rendering — MediaPipe's graph abstraction is a better fit.

MediaPipe's Calculator mechanism lets you embed TFLite inference as one node in a processing pipeline. The key configuration:

```protobuf
# mediapipe/graphs/segmentation/segmentation_gpu.pbtxt
node {
  calculator: "TfLiteInferenceCalculator"
  input_stream: "IMAGE:input_image"
  output_stream: "SEGMENTATION:segmentation_mask"
  options: {
    [mediapipe.TfLiteInferenceCalculatorOptions.ext] {
      model_path: "segmentation_model.tflite"
      delegate { gpu {} }
    }
  }
}
```

A few things that trip people up:

**Input format alignment**: MediaPipe's ImageFrame is RGB. Your training data might be BGR or YUV. Add an `ImageTransformationCalculator` for format conversion before inference, rather than hardcoding preprocessing inside the model.

**Delegate selection**: GPU Delegate delivers 3-5x speedup on most mid-to-high-end devices, but compatibility lags behind XNNPACK. In production I recommend a fallback strategy — prefer GPU, drop to XNNPACK when the device does not support it.

**Output post-processing**: Segmentation models typically output logits or probability maps. Run a follow-up Calculator for argmax or thresholding. Implementing this in MediaPipe's C++ Calculator layer is far more efficient than juggling `ByteBuffer` in Java or Kotlin.

## Lessons Learned

After walking the full pipeline, a few points are worth recording.

Run `onnx.checker.check_model()` for structural validation immediately after export, then use ONNX Runtime for an accuracy comparison. These two steps catch 80% of downstream issues. ONNX is a mandatory waystation, not the destination — many engineers rush to convert past ONNX and skip validation, then struggle to locate problems later.

Verify operator compatibility during the selection phase, not after training finishes. Before training, run `onnx2tf` with `--check_onnx_tf_outputs_elementwise_close` against a dummy model to confirm critical operators convert. I have lived through the experience of training for two weeks only to discover `grid_sample` would not convert.

Calibration dataset construction is worth the investment. Pull real data from production, cover edge cases — this beats subsetting the training set. I once lost 3% accuracy calibrating with 200 random images; switching to 500 scene-stratified images cut the loss to 0.5%. On a device, that gap is the difference between usable and unusable.

MediaPipe has a steep learning curve, but its Calculator abstraction unifies preprocessing, inference, post-processing, and rendering into one pipeline, which is valuable for managing complex on-device AI scenarios. That said, do not adopt it for its own sake — if the requirement is running a single classification model, the TFLite Interpreter is enough. Adding MediaPipe only adds complexity.
