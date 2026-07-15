---
title: "Choosing an Android On-Device AI Runtime: LiteRT to ExecuTorch"
lang: en
translationKey: android-on-device-ai-inference-engine-selection
slug: android-on-device-ai-inference-engine-selection
excerpt: "A production-oriented comparison of LiteRT, MediaPipe, ExecuTorch, ONNX Runtime, and llama.cpp for Android inference."
publishDate: '2026-06-29'
tags:
- "Android"
- "On-device Inference"
- "LiteRT"
- "ExecuTorch"
seo:
  title: "Choosing an Android On-Device AI Runtime"
  description: "Compare LiteRT, MediaPipe, ExecuTorch, ONNX Runtime, and llama.cpp for Android inference."
  pageType: article
---

When doing end-side multi-modal model integration last month, the team froze on engine selection. Some people say that LiteRT is the most stable, some insist that ExecuTorch is the future, and some suggest simply running LLM on llama.cpp. Finally, we tested all five engines on the same device, and the conclusion was much more complicated than expected.

## Architectural genes of the five major engines

**LiteRT** (formerly TensorFlow Lite) is Google's longest-invested product in mobile reasoning. The core architecture is divided into three layers: Converter is responsible for model conversion and quantization, Runtime provides interpreter execution, and Delegate mechanism offloads calculations to hardware accelerators. Its delegate system covers GPU (OpenGL ES/OpenCL), NNAPI, XNNPACK and Hexagon DSP. The key design is **fallback** - when the operator is not supported by the hardware, it automatically falls back to the CPU without reporting an error.

**MediaPipe** Strictly speaking, it is not an inference engine, but a streaming multimedia processing framework. It organizes processing nodes based on a computational graph, each node can be a LiteRT reasoner or image preprocessing step. The advantage lies in the out-of-the-box task solutions (faces, gestures, postures), but the disadvantage is the high cost of customization - the complexity of building your own pipeline is not low.

**ExecuTorch** is a mobile inference solution launched by Meta in 2023 and is positioned as the outlet of the PyTorch ecosystem. The core idea is **ahead-of-time compilation**: operator selection and memory planning are completed in the export phase, and only minimal execution is performed during runtime. The advantage is that the binary size is controllable and the startup delay is low. The price is that the model must be exported through `torch.export` and the dynamic control flow support is limited.

The core value of **ONNX Runtime Mobile** is format neutrality - no matter what framework you use for training, you can export it to ONNX and run it. Operator coverage is the widest among the five engines, but mobile GPU acceleration is not as mature as LiteRT and mainly relies on XNNPACK and NNAPI.

**llama.cpp** is an LLM inference framework implemented in pure C/C++ and is community-driven. Does not rely on any framework API and loads quantitative models through GGUF format. The core advantage lies in CPU inference efficiency: handwritten SIMD instructions and memory layout optimization allow devices without GPUs to run 7B models. Android integration relies on JNI packaging and has no official AAR.

## Operator coverage: the prerequisite for the model to run

The first step in choosing an engine is not to run the test scores, but to confirm whether the model can run.

LiteRT’s operator coverageIt focuses on the basic operators of CNN and Transformer, and lags in supporting new attention variants (GQA, Flash Attention) that will be released after 2023. I have encountered a model that uses RMSNorm and directly reports that the operator cannot be found after conversion.

ExecuTorch has better coverage of PyTorch's native operators. The operator library is organized by modules and can be linked on demand. But this also means that you need to know exactly which operators are used by the model, and custom attention variants may require you to write the kernel registration yourself.

ONNX Runtime has the most complete set of operators, especially ONNX opset 18+. However, the ONNX conversion itself may introduce accuracy loss and requires additional verification.

The GGUF format of llama.cpp has the best support for mainstream architectures such as LLaMA, Mistral, and Qwen. Non-standard architectures need to write their own conversion scripts.

After going through many pitfalls, I came up with a practical principle: **Which framework should be used for training, and which framework’s inference engine should be used first**, which can reduce 80% of compatibility issues.

## Hardware acceleration: The real difference between GPU and NPU

There are three paths for hardware acceleration on Android: NNAPI (system-level API), GPU Delegate (engine self-implementation), and manufacturer NPU SDK (Qualcomm SNPE, MediaTek NeuroPilot).

NNAPI has the best compatibility, but the upper limit of performance is affected by the system version and manufacturer driver. According to actual measurements, the same model runs NNAPI on Android 14 and 12, and the latency difference is 30%.

LiteRT's GPU delegate is the most stable in adapting to Adreno and Mali and has been polished for many years. ExecuTorch's Vulkan backend iterates quickly, and the 2024 Q3 version is significantly improved, but there are occasional numerical errors on low-end Mali GPUs.

NPU is the key to inference acceleration of high-end devices, but the support of each engine is not mature. LiteRT indirectly supports Qualcomm QNN delegate, and ExecuTorch has Qualcomm's official delegate but it is still in beta. My suggestion: **NPU acceleration should be used as an optional optimization first, not as a hard dependency**.

## Performance benchmark: actual measurement on the same device

The following data was tested on a Snapdragon 8 Gen 3 device with models MobileNetV3-Small (Classification) and Gemma 2B (LLM).

| Engine | MobileNetV3 (CPU) | MobileNetV3 (GPU) | Gemma 2B (CPU) |
|------|-------------------|------------------|----------------|
| LiteRT | 4.2ms | 2.1ms | Not supported |
| ExecuTorch | 5.8ms | 3.4ms | 2.3s/token |
| ONNX Runtime | 4.5ms | 3.0ms | Not supported |
| MediaPipe | 4.3ms | 2.2ms | Not supported |
| llama.cpp | Not applicable | Not applicable | 1.8s/token |

On the small model classification task, LiteRT and MediaPipe have the lowest GPU latency, with a gap of milliseconds. Teams already in the TensorFlow ecosystem do not need to change.

In terms of LLM inference, llama.cpp is about 20% faster than ExecuTorch. The reason is that it has made targeted optimizations for Transformer decoding - the memory layout of KV cache and the SIMD implementation of attention. General engines will not do these.

There is another indicator that is often ignored in actual projects: **Model loading time**. ExecuTorch's AOT compilation makes loading almost zero delay, while LiteRT needs to initialize the delegate for the first time, which may take 200-500ms for large models. In scenarios where models are frequently switched, these 200ms are a real experience problem.

## Four-dimensional selection matrix

When selecting, judge directly against your own project:

**Google Ecosystem + Multimedia Pipeline** → MediaPipe. When the task happens to be an officially supported face, gesture, or posture, the integration cost is the lowest. The opposite is true for custom models, where pipeline configuration slows down iterations.

**PyTorch training + newer model architecture** → ExecuTorch. There is no conversion step for native export, but custom attention variants may require handwritten kernels.

**Cross-framework, cross-platform consistency** → ONNX Runtime. When you need to run Android, iOS and Web at the same time, ONNX is the most worry-free intermediate format. The price is that the mobile GPU acceleration is not as good as the native solution.

**LLM inference, pursuing ultimate CPU performance** → llama.cpp. CPU inference efficiency currently has no rival, but it needs to accept the uncertainty of community maintenance. The integration cost of the LLaMA architectural model is lower than any official solution.

**Mixed scenarios, flexible backend switching** → LiteRT. The delegate system is the most mature, and a model can be used in CPU/GPU/NNAPISeamless switching between them, suitable for applications that need to adapt to different hardware.

## My selection experience

In the end, I adopted a **dual engine strategy** in the project: LiteRT (mature and stable) for general visual tasks, and llama.cpp (optimal performance) for the LLM part. It takes about 15MB of additional binary size, but in exchange for optimal performance in each scenario.

If I could only choose one engine, I would choose ExecuTorch. It’s not that a single indicator is the best, but that the team iterates the fastest, and the trend of the PyTorch ecosystem is also the clearest. Its operator coverage and GPU stability will be significantly improved in 2024. At this rate, it should be able to cover 90% of mobile reasoning needs by the end of 2025.

There is no perfect engine, only an engine that suits the current scenario. **Model format, operator coverage, hardware acceleration, team familiarity**—these four dimensions can help you make 80% of the correct decisions, and the remaining 20% ​​depends on actual measurements.
