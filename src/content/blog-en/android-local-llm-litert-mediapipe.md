---
title: "Android Local LLM Inference: LiteRT, MediaPipe, Quantization, and Production Trade-offs"
lang: en
translationKey: android-local-llm-litert-mediapipe
slug: android-local-llm-litert-mediapipe
excerpt: "A practical guide to Android local LLM inference across LiteRT, ONNX Runtime Mobile, MediaPipe LLM Inference, INT4 quantization, GPU delegates, KV cache memory, and device fallback."
publishDate: '2026-04-17'
tags:
- "Android"
- "On-device Inference"
- "LLM"
- "Performance Optimization"
- "MediaPipe"
seo:
  title: "Android Local LLM Inference with LiteRT and MediaPipe"
  description: "Learn how to choose Android local LLM engines, use INT4 quantization, tune GPU delegates, manage KV cache memory, and design device fallback."
  pageType: article
---

Late last year, while building a local AI assistant, we hit a painful issue: the same Gemma 2B model had a 3.2-second first-token latency on a Pixel 8, but went straight into OOM on a mid-range Snapdragon 778G device. At the time, we had three options in front of us: LiteRT, formerly TFLite, ONNX Runtime Mobile, and the MediaPipe LLM Inference API. We eventually used different engines for different scenarios. This article is a structured review of that experience.

## The core tension in on-device inference

Running an LLM on a phone is essentially forcing PC-era algorithms through mobile-era hardware. A 7B-parameter model needs roughly 14 GB of memory at FP16 precision, far beyond the usable ceiling of Android devices. Even a small 1B-parameter model takes around 2 GB at FP16, which is almost impossible on a 4 GB RAM phone.

**The bottleneck is not raw compute. It is memory bandwidth and capacity.** Modern mobile SoCs have respectable NPU throughput, but LPDDR5 memory bandwidth is usually only around 50-80 GB/s. LLM inference is a classic memory-bound workload. A Transformer's KV cache grows linearly with sequence length. That is manageable on a PC, but on a phone it can decide whether the feature works at all.

There are only two practical ways out: **reduce model size** through quantization and **reduce memory movement** through scheduling and runtime optimization. Every engineering decision for an on-device LLM is a trade-off along those two axes.

## Engine landscape: LiteRT, ONNX Runtime, and MediaPipe

### LiteRT, formerly TFLite

In 2024, Google renamed TensorFlow Lite to LiteRT, or Lite Runtime, moved it out of the TensorFlow repository, and folded it into the `com.google.ai.edge` ecosystem. This was not just a branding change. Several things changed underneath: the Delegate mechanism was reworked, GPU Delegate and NNAPI Delegate fallback became more stable, INT4 quantization became officially supported, `LiteRT Model Maker` can now support PTQ, and the `LiteRtCompiledModel` API introduced offline compilation caching to reduce first-load compilation cost.

For scenarios that need fine-grained control over the inference flow or custom models, LiteRT is the most flexible choice. Its downside is that it was not originally designed around LLMs. Transformer dynamic shapes and KV cache management still require a lot of developer-owned engineering.

### ONNX Runtime Mobile

If the model comes from PyTorch, ONNX Runtime has a shorter conversion path, `torch.onnx.export` to ORT Mobile, and better cross-platform consistency. That advantage is real.

On Android, however, ONNX Runtime's GPU acceleration depends on OpenCL EP, or Execution Provider. On some devices, its stability and performance are not as good as LiteRT's GPU Delegate. In my tests, LiteRT GPU Delegate was usually 15-30% faster than ORT OpenCL EP on Snapdragon devices.

ONNX Runtime is a good fit when the same model must be reused across Android, iOS, and server environments, or when the team's tooling is strongly PyTorch-centric.

### MediaPipe LLM Inference API

This is Google's high-level API designed specifically for on-device LLM inference. Under the hood it uses `MediaPipe Tasks` plus `LiteRT`. Its goal is to turn LLM inference into a ready-to-use component so developers do not have to manage KV cache, sampling logic, or tokenization details.

```kotlin
// Initialize the LLM inference task
val options = LlmInference.LlmInferenceOptions.builder()
    .setModelPath("/data/local/tmp/gemma-2b-it-gpu-int4.bin")
    .setMaxTokens(1024)
    .setTopK(40)
    .setTemperature(0.8f)
    .setRandomSeed(42)
    .build()

val llmInference = LlmInference.createFromOptions(context, options)

// Streaming inference
llmInference.generateResponseAsync(prompt) { partialResult, done ->
    runOnUiThread { updateUI(partialResult) }
}
```

Integration cost is extremely low, but customization is close to zero. The sampling strategy is fixed to Top-K. It does not support Top-P or Beam Search, custom tokenizers, or system prompt injection for multi-turn chat as of the 2025 Q4 version. MediaPipe LLM Inference API is a good fit for quickly validating a product idea. More complex production scenarios usually need to return to LiteRT.

## Quantization strategy: INT8, INT4, and mixed quantization

Quantization is not optional. It is the prerequisite for making an on-device LLM run. The real question is which quantization strategy to use.

### INT8 PTQ

INT8 PTQ is the most mature option. The toolchain is complete, and the accuracy loss is acceptable for most tasks. For models below 1B parameters, INT8 PTQ is usually the safest choice: model size is cut in half, and CPU inference is typically 1.5-2x faster because SIMD instruction sets are optimized for INT8 arithmetic.

### INT4 and block-wise quantization

INT4 quantization has been the main battleground for on-device LLMs in 2024 and 2025. Gemma 2B INT4 is only about 1.3 GB, which leaves enough system headroom on 6 GB RAM devices.

Direct uniform INT4 quantization usually loses too much accuracy. In practice, the common approach is **block-wise quantization**, also called group quantization: split the weights into blocks, compute scale and zero point independently for each group, and usually group 32 or 128 elements at a time.

```python
# Use ai_edge_torch for INT4 block-wise quantization
import ai_edge_torch
from ai_edge_torch.quantize import QuantConfig, BlockwiseQuantizationConfig

quant_config = QuantConfig(
    weight_quant=BlockwiseQuantizationConfig(
        num_bits=4,
        block_size=32,  # One group per 32 elements
        symmetric=True
    )
)

edge_model = ai_edge_torch.convert(
    pytorch_model,
    sample_inputs,
    quant_config=quant_config
)
edge_model.export("gemma2b_int4.tflite")
```

One trap I hit: smaller `block_size` improves accuracy, but it also increases metadata overhead, so the model file can become larger instead. For 2B-scale models, `block_size=32` has been a good practical balance.

### Mixed quantization

Attention-layer weights are more sensitive to quantization, while FFN layers are relatively robust. Mixed quantization uses INT8 for Attention and INT4 for FFN to find a better trade-off between size and quality.

The official pre-quantized Gemma model from MediaPipe, `gemma-2b-it-gpu-int4.bin`, is effectively a mixed-quantization model. Not every layer is INT4. That is why its output quality is much better than a casually produced INT4 PTQ model. Do not underestimate that gap. Self-quantized models can degrade noticeably on some inference tasks.

## GPU Delegate scheduling and memory mapping

### GPU Delegate initialization cost

GPU Delegate is the most important LiteRT acceleration path on Android, but it has a common trap: **the first initialization triggers OpenCL or OpenGL shader compilation**, which can take 2-5 seconds on some devices.

The fix is Delegate serialization: cache the compiled GPU program to disk, then load it directly on the next initialization.

```kotlin
val gpuOptions = GpuDelegateFactory.Options().apply {
    setSerializationParams(
        context.cacheDir.absolutePath,  // Cache directory
        "gemma2b_gpu_cache"             // Cache key
    )
    inferencePreference = GpuDelegateFactory.Options.INFERENCE_PREFERENCE_SUSTAINED_SPEED
}

val delegate = GpuDelegateFactory().create(gpuOptions)
val interpreterOptions = Interpreter.Options().addDelegate(delegate)
```

The first run is still slow, but later startup can drop from around 3 seconds to under 200 ms. In production, this optimization is almost mandatory.

### Memory-mapped loading

Map the model file directly into the process address space with `mmap` instead of copying the whole model into the heap. LiteRT supports this by default:

```kotlin
// Use MappedByteBuffer instead of reading the file directly
val modelBuffer: MappedByteBuffer = FileInputStream(modelFile).channel
    .map(FileChannel.MapMode.READ_ONLY, 0, modelFile.length())

val interpreter = Interpreter(modelBuffer, options)
```

`mmap` lets the OS page model data in on demand instead of occupying all physical memory up front. For a 1.3 GB INT4 model, RSS, or Resident Set Size, is usually 20-40% lower than direct loading. On memory-constrained devices, that can significantly reduce the chance of being killed by LMK, the Low Memory Killer.

### KV cache memory budget

KV cache size is determined by `maximum sequence length x layers x heads x dimension x 2 x bytes per precision unit`. For Gemma 2B, the KV cache is about 50 MB at 128 tokens and about 200 MB at 512 tokens.

The MediaPipe LLM Inference API's `setMaxTokens` parameter preallocates the KV cache during initialization. The advantage is that it avoids memory allocation jitter during inference. The downside is that even a one-sentence inference uses the full memory budget implied by `setMaxTokens`.

In a real project, I set `setMaxTokens` to 512 instead of the documentation's recommended 1024. A 512-token context window is usually enough for chat scenarios, cuts memory use in half, and noticeably reduces the OOM rate.

## Device adaptation and fallback strategy

The hardest engineering challenge in on-device AI is not making high-end phones work. It is making mid-range and low-end devices degrade gracefully.

We implemented a three-tier strategy:

**High-end devices, Snapdragon 8 Gen 2+ with 8 GB+ RAM**: GPU Delegate + INT4, full feature set, streaming output.

**Mid-range devices, Snapdragon 778G with 6 GB RAM**: GPU Delegate + INT4, but with a shorter KV cache and some capabilities disabled.

**Low-end devices or unsupported capability**: fall back directly to a cloud API and do not run the model locally.

```kotlin
fun selectInferenceStrategy(context: Context): InferenceStrategy {
    val memInfo = ActivityManager.MemoryInfo()
    (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
        .getMemoryInfo(memInfo)
    
    val availableRam = memInfo.totalMem / (1024 * 1024) // MB
    val hasGpuDelegate = checkGpuDelegateSupport(context)
    
    return when {
        availableRam >= 7000 && hasGpuDelegate -> InferenceStrategy.LOCAL_GPU_INT4
        availableRam >= 5000 && hasGpuDelegate -> InferenceStrategy.LOCAL_GPU_INT4_LIMITED
        else -> InferenceStrategy.REMOTE_API
    }
}
```

To determine whether GPU Delegate is actually usable, instead of merely checking whether the API exists, you need to run a small probe model. That cold-start cost can be paid in the background after first install, then cached in SharedPreferences.

## Practical recommendations

After going through this path, I ended up with a few rules of thumb.

**Engine choice**: use MediaPipe LLM Inference API for rapid product validation. Return to LiteRT manual management when you need customization. Consider ONNX Runtime mainly for cross-platform model reuse. Do not choose a complex path just because it looks technically advanced.

**Quantization strategy**: do not start by quantizing everything yourself. Prefer official or community-validated quantized models. Gemma and Phi-3 Mini both have official INT4 versions. Custom quantization needs evaluation sets and a lot of experiments, and the payoff is often poor.

**Memory management**: `mmap` loading, a realistic `maxTokens` budget, and device-tier fallback are the three most effective levers. Once those are in place, the OOM rate usually drops to an acceptable level. Controlling KV cache length is often easier and more effective than optimizing the model itself.

On-device LLMs are still evolving quickly. Today's best option may be outdated in six months. Keeping up with Google AI Edge and MediaPipe updates is usually more valuable than over-optimizing one low-level detail.
