---
title: "Android On-Device AI Inference Warmup: From Model Loading to First-Token Latency"
lang: en
translationKey: android-on-device-ai-inference-warmup
slug: android-on-device-ai-inference-warmup
excerpt: "A practical breakdown of on-device AI cold-start latency: model loading, GPU Delegate initialization, KV cache prefill, warmup inference, long-lived contexts, and memory tradeoffs."
publishDate: '2026-06-09'
tags:
- "Android"
- "On-Device AI"
- "Performance"
- "TFLite"
- "GPU Inference"
seo:
  title: "Android On-Device AI Inference Warmup and First-Token Latency"
  description: "Optimize on-device AI cold starts through model loading, GPU Delegate warmup, KV cache prefill, long-lived contexts, and memory tradeoffs."
  pageType: article
---

While building on-device large-model features, I ran into a frustrating pattern: the first inference after tapping the AI feature took 3.2 seconds, while the second request took only 400 ms. That eightfold gap forced me to break down the "cold start" of on-device inference.

The problem looks a lot like app startup. It is rarely one slow operation; it is a chain of synchronous costs: model loading, runtime initialization, GPU delegate setup, prompt prefill, and first decode.

## Latency Sources

Using MediaPipe LLM Inference with a Gemma 2B model on a Pixel-class device, a rough breakdown looks like this:

| Stage | Cost | Share |
|------|------|------|
| Model file loading with mmap | 180ms | 5.6% |
| TFLite runtime initialization | 120ms | 3.8% |
| Graph construction | 450ms | 14.1% |
| GPU Delegate initialization | 820ms | 25.6% |
| KV cache prefill | 1550ms | 48.4% |
| First decode | 80ms | 2.5% |
| **Total** | **3200ms** | 100% |

GPU Delegate initialization is often underestimated. Shader compilation, memory allocation, and operator selection are commonly lazy and happen on the first real inference.

KV cache prefill is even larger for long prompts. A 500-token system prompt requires full attention computation before the model can begin decoding.

## Model Loading: Decouple I/O and Parsing

Model file loading is not always the main bottleneck, but it can be improved.

### Use mmap and prefetching

Large model weights should be memory-mapped instead of fully copied into heap memory. When possible, use sequential prefetch hints:

```cpp
madvise(addr, file_size, MADV_SEQUENTIAL | MADV_WILLNEED);
```

This tells the kernel that the mapping will be read sequentially and soon. It can move disk I/O out of the critical path.

### Parallelize graph construction and loading

I/O and CPU parsing can often run in parallel:

```kotlin
val weightJob = CoroutineScope(Dispatchers.IO).async {
    loadModelWeights(modelPath)
}
val graphJob = CoroutineScope(Dispatchers.Default).async {
    buildInferenceGraph(config)
}

val weights = weightJob.await()
val graph = graphJob.await()
initializeEngine(weights, graph)
```

The gain is bounded by the slower branch, but it prevents unnecessary serialization.

## GPU Delegate Initialization: The Hidden Cost

The GPU Delegate usually performs operator matching, shader generation, shader compilation, and GPU buffer allocation. If this happens on the first user request, the user sees it as a long stall.

### Warmup inference

Run a minimal inference in the background to trigger delegate initialization:

```kotlin
lifecycleScope.launch(Dispatchers.Default) {
    interpreter.runWarmup()
}
```

The warmup must use the same delegate and interpreter instance. Warming up a throwaway interpreter does not help the real one.

### Reuse delegate instances

Creating a new interpreter for every request repeats expensive setup. Keep an engine instance alive where memory allows:

```kotlin
class InferenceEngineHolder {
    private var engine: LlmEngine? = null

    suspend fun getOrCreate(): LlmEngine {
        return engine ?: createEngine().also { engine = it }
    }
}
```

The tradeoff is memory pressure. A long-lived engine improves latency but occupies RAM and GPU buffers. Use lifecycle-aware release when the feature has been inactive for a while.

## KV Cache Prefill: Compute Earlier

For LLM-style inference, prefill is the largest cost when prompts are long. The system prompt, tool definitions, and conversation context all become tokens that must be processed before decoding starts.

### Option 1: Precompute after model loading

If the system prompt is stable, prefill it during warmup:

```kotlin
engine.prefill(systemPrompt)
```

Then user prompts only append the variable part. This turns repeated fixed context from per-request work into startup or idle-time work.

### Option 2: Long-lived context

Keep a conversation context alive across turns:

```kotlin
val session = engine.createSession()
session.prefill(systemPrompt)
session.generate(userMessage)
```

This avoids rebuilding the same KV cache repeatedly. It is especially useful for chat UIs where the model remains active during a session.

The memory cost is significant. KV cache grows with sequence length, number of layers, hidden dimension, and precision. You need eviction rules: release old sessions, cap context length, or summarize older turns.

## Results and Tradeoffs

A combined strategy usually works best:

- mmap model weights.
- parallelize I/O and CPU setup.
- initialize GPU Delegate during idle time.
- warm up the real interpreter.
- prefill stable prompts.
- reuse sessions while controlling memory.

The most important product decision is when to pay the cost. If the user explicitly opens an AI feature, some warmup before the first prompt is acceptable. If the feature is only occasionally used, aggressive startup warmup may waste battery and memory.

On-device AI performance work is therefore not just optimization. It is scheduling: move unavoidable cost away from the user's first meaningful interaction, while keeping memory and thermal behavior under control.
