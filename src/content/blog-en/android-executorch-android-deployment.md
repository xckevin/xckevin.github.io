---
title: "Deploying ExecuTorch Models on Android"
lang: en
translationKey: android-executorch-android-deployment
slug: android-executorch-android-deployment
excerpt: "A practical ExecuTorch path from native PyTorch export to `.pte` deployment on Android, including AOT delegates and runtime trade-offs."
publishDate: '2026-07-05'
tags:
- "Android"
- "On-device Inference"
- "ExecuTorch"
- "PyTorch"
seo:
  title: "ExecuTorch Android Deployment Guide"
  description: "Deploy PyTorch models with ExecuTorch on Android and understand delegates, performance, and common pitfalls."
  pageType: article
---

When doing end-side image segmentation last year, I converted a trained PyTorch MobileNetV3 model into TFLite and spent two days - the operators were incompatible, the dynamic shape was lost, and the quantization accuracy decreased. The thought at the time was: **Why does the PyTorch model have to go through the TFLite bridge? **

The answer given by ExecuTorch is: no bridge.

## The unavoidable pain of format conversion

The PyTorch model is implemented on the Android side. The traditional path is roughly:
```
PyTorch → ONNX → TFLite / TensorFlow Lite
```

Each transformation step may introduce new problems. When exported by ONNX, `torch.onnx.export` has limited support for dynamic control flow, `if` branches and `for` loops are often expanded into static graphs, and the model volume is expanded. When it comes to TFLite, operator coverage is the main bottleneck - the new `torch.nn.functional.scaled_dot_product_attention` in the PyTorch ecosystem has no corresponding implementation in TFLite.

Debugging is even more of a headache. The error message during the conversion process is usually "a certain operator is not supported". You can only fall back to the PyTorch side, rewrite the model with a more conservative operator, and go through the conversion process again. This cycle lasts half a day.

## ExecuTorch solution ideas

ExecuTorch is the client-side inference engine officially launched by PyTorch. The core idea is: **PyTorch models are directly exported and run directly on the client side without format conversion**.

Its workflow has only two steps:

```bash
# 1. Export: PyTorch model → .pte file
python -m torchchat.export --model mobile_llama --output model.pte

# 2. Deploy: add the .pte file directly to the Android project
```

`.pte` (Program Torch Export) is the serialization format of ExecuTorch. It is essentially the calculation graph exported by `torch.export` and is the product of AOT (Ahead-of-Time) compilation and optimization. Unlike ONNX, it does not require an intermediate presentation layer, and the exported product is a graph that can be directly executed by ExecuTorch Runtime.

### What to do when exporting

The core difference between `torch.export` and traditional `torch.jit.trace` is that the former is a complete graph capture and will track the inside of the Python control flow, while the latter only records a forward propagation operator sequence.

This means that the graph exported by `torch.export` retains the possibility of dynamic branching - although the terminal side is still a static graph when executed, the export side does not need to change the model structure for adaptation.

There is another key role in the export pipeline: **Delegate**. When exporting, you can mark certain subgraphs in the graph as being delegated to specific backends for execution, such as NPU, GPU, Hexagon DSP. The marked subgraphs will be distinguished by the `backend_id` field in `.pte`, and the corresponding Delegate will take over at runtime.

## Android-side integration: lighter than expected

The integration of ExecuTorch on Android does not rely on the Python runtime, is implemented in pure C++, and is exposed to the Java/Kotlin layer through JNI.

Gradle dependency configuration:

```kotlin
dependencies {
    implementation("org.pytorch:executorch:0.3.0")
    implementation("org.pytorch:executorch_android:0.3.0")
}
```

Load the model and perform inference:
```kotlin
val module = Module.load("/data/local/tmp/model.pte")
val inputs = arrayOf(Tensor.fromBlob(floatArray, longArrayOf(1, 3, 224, 224)))
val outputs = module.forward(inputs)
val result = outputs[0].toTensor().dataAsFloatArray
```

The amount of code is about 1/3 less than TFLite's implementation of the same function, mainly because template codes such as `resizeInput` / `allocateTensors` of `Interpreter` are omitted. Runtime automatically completes memory allocation and operator scheduling when `forward()` is called.

### Threading model

ExecuTorch's Runtime defaults to single-threaded synchronous execution, but reserves a `Method` level parallel interface:

```cpp
// C++ layer: create multiple Method instances for parallel inference.
auto method1 = module->getMethod("forward");
auto method2 = module->getMethod("forward");
// Shard the input and run each shard independently.
```

In actual projects, I prefer to use coroutines to manage parallelism in the Kotlin layer instead of using thread pools in the C++ layer - Android's thread scheduling is more friendly to Java threads and can reuse existing coroutine infrastructure.

## Delegation mechanism: the key to performance

ExecuTorch’s delegate mechanism is where it sets apart from LiteRT. LiteRT's delegates (such as GPU Delegate) dynamically select the backend at runtime, while ExecuTorch's delegates are determined at AOT compile time.

### Two delegation methods

**Partitioner delegate**: During the export phase, use the `to_backend` API to compile a specific subgraph into the target backend code:

```python
from executorch.exir.backend.test_backend import TestBackend

exported_program = torch.export.export(model, example_inputs)
delegated = exported_program.to_backend(TestBackend())
```

**Composite delegation**: Fuse multiple operators into a composite operator and hand it over to the backend for one-time execution. This is more suitable for GPU scenarios and can reduce the number of data transfers between CPU and GPU.

### Why AOT delegation is better

Runtime delegation (LiteRT's method) requires graph matching in the `model.load()` stage - scanning the entire calculation graph, finding operators supported by the GPU, and inserting data transfer nodes. This process takes between 50-200ms, and scenarios that are sensitive to cold start (such as camera real-time inference) are additional overhead.

The AOT commission does all this work when exporting. The `.pte` file already has a "partitioned image", which can be loaded and used. For the same MobileNetV3 model, the model loading time of ExecuTorch is about 40% faster than that of LiteRT + GPU Delegate.

The trade-off is that the `.pte` file loses backend independence - a `.pte` exported for Qualcomm HTP will not run on a Mali GPU. But this is not a problem in the mobile scenario, where you have to distribute different ABIs per device.

## Performance comparison with LiteRT

I compared this on Pixel 7 (Tensor G2) using the same ResNet-50 model (PyTorch export vs TFLite conversion):

| Metrics | ExecuTorch (CPU) | LiteRT (CPU) | LiteRT (GPU) |
|------|-----------------|--------------|--------------|
| Model loading | 32ms | 85ms | 178ms |
| Single-shot inference | 18.7ms | 18.2ms | 9.3ms |
| Memory usage | 48MB | 52MB | 62MB |

There is not much difference in CPU inference performance, with LiteRT slightly better by 2-3%, mainly due to years of optimization of XNNPACK. Model loading with ExecuTorch is significantly faster for the reason mentioned earlier - there is no runtime graph matching overhead.

In terms of GPU reasoning, ExecuTorch currently supports Vulkan Delegate, but it is not as mature as LiteRT’s GPU Delegate. GPU inference latency on Pixel 7 is about 12ms, which is 30% slower than the LiteRT GPU. This is related to the operator coverage and tuning level implemented by Vulkan. The ExecuTorch team is working on this, but at this stage ifGPU inference is a necessity, and LiteRT is still a more stable choice.

## Several pitfalls in practice

**The first pitfall: limited dynamic shape support**. `torch.export` requires the shape to be fixed when exporting, and dynamic batch needs to be manually declared with the `dynamic_shapes` parameter. However, the end-side ExecuTorch Runtime currently does not have complete support for dynamic shapes. It is recommended to fix all dimensions when exporting.

**The second pitfall: operator coverage**. ExecuTorch's operator library (`kernels/portable`) covers most commonly used operators, but advanced operators such as `torch.fft` and `torch.linalg` have not yet been ported. If it encounters an unsupported operator, it will crash directly and will not be downgraded to CPU implementation. It is recommended to use `executorch.exir.verification` to perform operator verification during the export phase.

**The third pitfall: multi-model management**. Currently, `Module` instances of ExecuTorch do not share Runtime with each other, and each model independently loads its own operator registry. Running 3 models is the memory overhead of 3 operator registries. For multi-model scenarios on the client side, it is recommended to use the `Program` API to package multiple models into a `.pte` file and share a runtime.

## Selection judgment

If your scenario is "PyTorch training, client-side deployment, and fast model iteration", the format conversion time saved by ExecuTorch is worth the price. Especially when there are custom operators or dynamic structures in the model, the TFLite conversion link often requires handwriting custom op or even changing the model, while ExecuTorch can directly export it and run it.

If your scenario is "GPU inference performance is given priority and the model structure is stable", LiteRT's GPU Delegate is currently leading in terms of maturity and performance. When ExecuTorch's Vulkan and Qualcomm HTP delegation matures, the gap will close - but that's half a year away.

Don't use ExecuTorch for the sake of using ExecuTorch. If the current TFLite conversion link runs smoothly and there are no operator compatibility issues, there is no need to migrate. The value of ExecuTorch is in eliminating the translation link itself, rather than replacing an already functioning link.
