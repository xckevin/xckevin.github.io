---
title: "Android NNAPI End to End: From HAL Abstraction to Qualcomm and MTK NPUs"
lang: en
translationKey: android-nnapi-hal-npu
slug: android-nnapi-hal-npu
excerpt: "A practical deep dive into Android NNAPI, covering the HAL layer, vendor drivers, graph partitioning, operator fallback, and on-device AI inference tuning."
publishDate: '2025-08-07'
tags:
- "Android"
- "NNAPI"
- "On-Device AI Inference"
- "Performance Optimization"
- "Hardware Acceleration"
seo:
  title: "Android NNAPI End to End: HAL, Vendor Drivers, and NPU Acceleration"
  description: "A practical guide to Android NNAPI, from HAL abstraction and QNN or Neuron drivers to graph partitioning, operator fallback, and inference tuning."
  pageType: article
---

## A 10x performance gap

Last year, while working on an on-device OCR project, I hit a painful issue: the same MobileNetV3 model ran in 8 ms on a Pixel 6, but took 85 ms on a mid-range MediaTek device. After digging in, I found that the Pixel path used NNAPI with GPU acceleration. The MTK device had an APU, but NNAPI did not match the right driver, so every operator fell back to the CPU.

Android device fragmentation is especially visible in NNAPI. The API surface is the same, but the execution path can be completely different across SoCs. If you do not understand the full chain, performance tuning for on-device inference is mostly guesswork.

## Where NNAPI fits in the Android AI stack

NNAPI is not an inference framework. It is a **hardware acceleration abstraction layer**. In the Android AI stack, it sits here:

```text
LiteRT / MediaPipe / AICore     <- upper-level inference frameworks
        |
        v
  NNAPI Runtime (libneuralnetworks.so)  <- system-level runtime
        |
        v
  NNAPI HAL (AIDL / HIDL)       <- hardware abstraction layer
        |
        v
  Vendor drivers (.so)          <- QNN / Neuron / ENN
        |
        v
  DSP / NPU / GPU / CPU         <- physical hardware
```

Upper-level frameworks do not need to know whether the underlying accelerator is a Hexagon DSP or an MTK APU. They hand the model to the NNAPI Runtime, and the runtime matches it to available acceleration devices. This architecture was introduced in Android 8.1 and has evolved through seven major Android releases up to Android 15. The HAL interface is now stable.

## The three core HAL interfaces

NNAPI HAL defines the interfaces a driver must implement. They map to the model lifecycle:

```cpp
// AIDL definition (Android 11+)
interface IDevice {
    // 1. Capability query: return supported operators and performance levels
    Capabilities getCapabilities();

    // 2. Model compilation: convert the graph into a device-executable format
    IPreparedModel prepareModel(in Model model, ...);

    // 3. Create an execution context and bind inputs and outputs
    IExecution createExecution(in IPreparedModel preparedModel, ...);
}
```

The operator support table returned by `getCapabilities()` is the first gate in the whole chain. The runtime uses it for **graph partitioning**: splitting a model into subgraphs and assigning each subgraph to a device.

The part that is easy to overlook is the **memory path**. NNAPI can use `AHardwareBuffer` to share tensors across devices, avoiding copies between CPU, GPU, and NPU. But this only works if the driver implements `BURST` mode and the `MemoryDomain` extension. Many early drivers only implemented a simple `mmap` path, so zero-copy optimization never actually took effect.

## Graph partitioning and operator fallback

Android officially defines more than 100 standard operators, and each device supports only a subset. The runtime flow is:

1. Walk through every operator in the model.
2. Query which devices support each operator.
3. Partition the graph with a strategy that minimizes cross-device transfers.
4. Put operators with no accelerator support into a CPU fallback subgraph.

The default partitioning strategy is greedy: it gives consecutive supported operators to the first device that can run them. The result can alternate between GPU subgraphs, NPU subgraphs, and CPU subgraphs. Each switch triggers an explicit memory copy:

```text
// Typical partitioning log
Subgraph 0: [Conv2D, ReLU, MaxPool] -> QTI NPU
Subgraph 1: [Reshape] -> CPU        <- one operator causes a device switch
Subgraph 2: [Conv2D, Softmax] -> QTI NPU
```

This kind of "single-operator fallback" is a performance killer. A better approach is to control partitioning during model conversion with a **delegate allowlist**:

```kotlin
val options = Interpreter.Options().apply {
    useNNAPI = true
    // Reject the model instead of allowing CPU fallback
    setNnapiAllowFp16PrecisionForFp32(true)
}
```

`allowFp16PrecisionForFp32` is only a precision option. To fully disable CPU fallback, you need to set `ExecutionPreference::FAST_SINGLE_ANSWER` and verify that every operator has accelerator support. If that is not possible, the model is not a good fit for a pure NNAPI path.

## Vendor drivers: QNN and Neuron

### Qualcomm QNN, formerly SNPE

Qualcomm's AI engine stack evolved from SNPE to QNN. Its core advantage is **offline compilation**:

```bash
# QNN offline compilation
qnn-onnx-converter -i model.onnx -o model.cpp
qnn-model-lib-generator -c model.cpp \
  -b qnn_model.bin -t aarch64-android
```

The compiled `.bin` runs directly on the Hexagon DSP and skips runtime online compilation. The Snapdragon 8 Gen 2 Hexagon supports INT4 precision and **micro-tile inferencing**, which is especially useful for Transformer-style models.

QNN version management is a common trap. Each SoC platform is tied to a specific SDK version, so cross-platform deployment usually means maintaining multiple compiled artifacts.

### MTK Neuron Delegate

MediaTek takes the TFLite Delegate route and does not rely on the NNAPI HAL:

```kotlin
val delegate = NeuronDelegate.create(
    NeuronDelegate.Options().apply {
        setPlatform(NeuronDelegate.Platform.MT6983)  // Dimensity 9000
        setOptimization(NeuronDelegate.Optimization.PREFER_FP16)
    }
)
val interpreter = Interpreter(model, options.addDelegate(delegate))
```

Neuron bypasses the NNAPI Runtime partitioning logic and takes over whole-graph inference directly. The benefit is that it avoids cross-device switching overhead. The cost is that you lose the compatibility guarantees around operator support: if the APU does not support an operator, the model can crash outright.

In real projects, I usually prefer Neuron over generic NNAPI on MTK platforms. MTK's NNAPI HAL implementation often lags behind Neuron SDK feature updates, and new APU capabilities may require a system OTA before they become accessible through NNAPI.

## Three real pitfalls

**Pitfall 1: inconsistent dynamic shape support**

NNAPI 1.3 introduced dynamic shapes, but vendor implementations vary. The same model containing `tf.while_loop` worked on a Samsung device and hung on an OPPO device. The final fix was to freeze every dimension during model export and give up dynamic batch sizes.

**Pitfall 2: INT8 quantization precision does not line up**

Qualcomm uses symmetric quantization, while MTK uses asymmetric quantization. When the conversion pipeline did not align the quantization scheme, output drift exceeded 5%. My fix was to add a precision validation step in CI that compares FP32 and INT8 outputs with cosine similarity.

**Pitfall 3: driver version mismatches silently downgrade execution**

On Android 14, AIDL HAL had reached V4, but some vendors were still on V2. After detecting a version mismatch, the runtime **silently fell back to CPU**. Logcat only showed a tiny `W/NativeAllocationRegistry` warning, which is easy to miss unless you capture logs intentionally.

## A decision framework

For on-device inference, I make technology choices in this order:

1. **Is the model's operator set covered by the target NPU?** Validate with `getSupportedOperationsForDevices()` before running the model.
2. **Can the model use offline compilation?** QNN and Neuron offline paths are usually 3 to 5 times faster than online compilation, so I prioritize them.
3. **Is CPU fallback acceptable?** If not, disable fallback and ensure full operator support. If yes, include fallback latency in the performance budget.

NNAPI is essentially a unified entry point into vendor drivers. The real acceleration result depends on driver quality. Understanding the whole chain is not about trusting the default behavior. It is about knowing where to look when the default behavior breaks.
