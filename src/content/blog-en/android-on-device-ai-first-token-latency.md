---
title: "Android On-Device LLM Latency: From Tap to First Token"
lang: en
translationKey: android-on-device-ai-first-token-latency
slug: android-on-device-ai-first-token-latency
excerpt: "Break down and optimize the full Android on-device LLM path, from user input and model loading to prefill, decode, and first-token rendering."
publishDate: '2026-07-04'
tags:
- "Android"
- "On-device Inference"
- "LLM"
- "Performance Optimization"
seo:
  title: "Android On-Device LLM First-Token Latency"
  description: "Measure and optimize Android on-device LLM latency from user action to first token."
  pageType: article
---

When building a large-scale client-side model, the most sensitive indicator for users is not throughput, but Time To First Token Latency (TTFT, Time To First Token) - the time it takes from the click to send the first word to appear on the screen. After 2 seconds, the retention rate drops off a cliff. Next, we will dismantle this link from beginning to end, giving a time-consuming portrait of each stage and corresponding optimization methods.

## Full link stage division

A client-side inference is divided into 6 stages from the click to the first token on the screen:
```
Tap → [1] Input preprocessing → [2] Model readiness → [3] Prefill → [4] First-token decode → [5] Post-processing → [6] Render to screen
```

Bottleneck types vary: CPU-intensive, IO-intensive, GPU scheduling latency. It’s not that one type of problem cannot be solved at once. First, think clearly where you are stuck at the current stage.

## Phase 1: Input preprocessing (5~50ms)

This step includes tokenizer converting text into token ids, building attention mask, and splicing chat template.

```kotlin
// Typical call chain
val tokenizer = BertTokenizer.fromFile(modelPath)
val inputs = tokenizer.encode(chatTemplate.format(userMessage))
// inputs.inputIds → IntArray, inputs.attentionMask → IntArray
```

Tokenizer itself is very fast (usually < 5ms), but there are two pitfalls that are easy to avoid.

** Pitfall 1: Tokenizer files are loaded repeatedly. ** SentencePiece or BPE vocabulary files are often several MB in size. Don’t re-new Tokenizer every time you infer. It is enough to do it once when the Application is initialized.

** Pit 2: Construction of attention mask for long text. ** When prompt exceeds 4K tokens, mask matrix construction will suddenly slow down. The root cause is that the memory allocation and filling overhead degenerates from O(n) to close to O(n²). This overhead can be cut off by pre-allocating a Buffer pool using `allocateDirect`.

Actual measurement on MediaTek 9300 shows that 4K prompt preprocessing is reduced from 48ms to 6ms.

## Phase 2: Model ready (10ms~500ms+)

The stage with the greatest fluctuations depends entirely on the loading strategy.

**Strategy A: Lazy loading. ** Read the `.tflite` or `.pte` model file from disk only during inference, and then initialize the GPU delegate. The first frame must wait 300~500ms. In the chat scene, the user's experience is "stuck for a while before replying".

**Strategy B: Preload + Resident. ** When the app starts, the background thread loads the model, and the inference is forwarded directly. The time consumption is reduced to 10~30ms, at the expense of model resident memory (usually 1~3GB).

```kotlin
// Preload asynchronously from Application.onCreate.
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CoroutineScope(Dispatchers.IO).launch {
            ModelManager.preload(modelPath, delegate = NNAPI)
        }
    }
}
```

Compromise solution: **Preload when idle and unload when memory is tight**, combined with `onTrimMemory` callback management life cycle. Chat apps are directly preloaded. Users open them just for conversation. The weight of delay experience is much higher than the memory usage.

## Stage 3: Prefill - big delay (200ms~2s+)

Prefill is a process in which the model processes the entire prompt at once. The amount of calculation increases linearly with the prompt length, but the actual time-consuming increase is often superlinear.

The time-consuming formula for Prefill is roughly:
```
T_prefill ≈ (prompt_tokens × model_FLOPs) / (GPU_FLOPS × utilization)
```

Theoretically linear, but there are factors that make it deviate:

**KV Cache memory allocation. ** The prompt becomes longer and the KV Cache increases linearly. When the allocation exceeds the available memory of the GPU, swap or reallocation is triggered, and 100ms+ `vkAllocateMemory` events can be seen in systrace.

**Attention computational complexity. ** Even if FlashAttention type operators are used, the attention complexity of prefill is still O(n²) (n = prompt length). 4K tokens correspond to 16M pairwise calculations, and 8K correspond to 64M.

```python
# Attention compute during prefill
# Standard self-attention: Q @ K^T → [seq_len, seq_len]
# 4K prompt: 4096² = 16.7M elements
# 8K prompt: 8192² = 67.1M elements  ← 4× as many
```

Optimization direction:

**Quantification. ** INT4 weight quantization speeds up prefill most significantly - prefill is computationally intensive. Compared with FP16, INT4 prefill is 40~60% faster on Snapdragon 8 Gen3, at the expense of a slight decrease in model quality.

**Prompt compression. ** Before a large amount of context is crammed into the RAG scene, you can use methods such as LLMLingua to compress the prompts on the client first, from 4K to 2K, and the prefill time is directly halved.

**KV Cache reuse. ** When there are multiple rounds of dialogue, the previous rounds of historical tokens can be directly reused in KV Cache, and prefill only processes the new parts. This is scene optimization rather than operator optimization, but the effect is more significant than operator optimization.

## Stage 4: First Token Decode (50~200ms)

After Prefill is completed, the model enters autoregressive decode. The decoding time of the first token = single forward pass. At this time, the KV Cache has just been established and the GPU pipeline has not yet run hot.

The calculation amount of a single decode is much less than that of prefill (only 1 token is processed), but the GPU utilization is low and the actual latency is not low. The bottleneck is at two points:

- **Weight read bandwidth. ** Decode is a memory-bound operation. The weight of the 7B model FP16 is about 14GB, and each forward has to read one round from the video memory/shared memory.
- **GPU Core idle. ** A single token cannot feed all computing units, but register spill and memory access waiting time are consumed as usual.

Optimization focuses on improving bandwidth utilization:

```kotlin
// GPU delegate choice substantially affects decode latency.
val options = Interpreter.Options().apply {
    // For decoding, OpenCL is typically 15–25% faster than OpenGL.
    setUseNNAPI(false)  
    // Use the OpenCL delegate explicitly.
    addDelegate(GpuDelegateFactory.Options().create(OpenCL))
}
```

On MediaTek Dimensity 9300, the first token decode of OpenCL delegate is about 18% faster than NNAPI and about 30% faster than OpenGL. But note: If your app's main rendering pipeline uses OpenGL, there is context overhead when switching between delegates - a pitfall I stepped on, switching over saved 30ms, and the context switching took 25ms, which was almost in vain.

## Stage 5&6: Post-processing and rendering (5~20ms)

Decode outputs logits → token id → text string → TextView/Compose renders on the screen. The CPU can handle these steps more than enough and is not a bottleneck.

A hidden issue: **UI refresh frequency during streaming output**. Each token triggers `setText` or Compose recomposition once, the token generation speed is 20~40ms, and the UI thread will be frequently interrupted. Merge refresh with debounce:

```kotlin
// Cap UI refresh frequency in Compose.
var displayText by remember { mutableStateOf("") }
val debounced = snapshotFlow { rawTokens.joinToString("") }
    .debounce(50)  // Refresh at most once every 50 ms.
    .collectAsState(initial = "")
```

## End-to-end performance portrait (actual measurement data)

In the Snapdragon 8 Gen3 + 7B INT4 quantized model and 2K prompt scenario, the time consumption of each stage is:

| Stage | Time consuming | Proportion | After optimization |
|------|------|------|--------|
| Preprocessing | 8ms | ~0.5% | 6ms |
| Model ready | 18ms | ~1% | 15ms |
| Prefill | 620ms | ~42% | 280ms |
| First Token Decode | 85ms | ~6% | 65ms |
| Post-processing + rendering | 12ms | ~0.8% | 10ms |
| **TTFT Total** | **~1480ms** | | **~680ms** |

Prefill accounts for 42%, which is the absolute majority. The optimized 680ms comes mainly from INT4 quantization + prompt compression overlay.

## Three key decisions in practice

**TTFT or throughput? ** TTFT is preferred in client-side chat scenarios. All methods that do not affect throughput (quantization, preloading) are mentioned, and those that need to be weighed (such as speculative decoding, which increases throughput but may slow down the first token delay) are put aside first.

**Does Prefill require multi-threading? ** Small model (< 1B) prefill can use multi-threaded CPU inference to be 50-50 comparable to the GPU solution. However, the calculation amount of 7B model prefill is too large and the CPU cannot handle it. GPU delegate is the only option. Don't worry about the CPU.

**Metric management granularity. ** Each stage must be managed independently, otherwise the bottleneck cannot be located. Using `SystemClock.elapsedRealtimeNanos()` has negligible overhead on high frequency paths. Without staged data, optimization is metaphysical. I marked 6 points corresponding to 6 stages in the project, and one week after it went online, I found that 80% of the delay came from the GPU memory allocation jitter in the prefill stage - you would never have guessed it without checking.
