---
title: "Android On-device LLM Streaming Output: From Tokens to Compose UI"
lang: en
translationKey: android-on-device-llm-streaming-output
slug: android-on-device-llm-streaming-output
excerpt: "A full-stack architecture for Android on-device LLM streaming output, covering KV Cache memory pressure, Kotlin Flow backpressure, and incremental Compose rendering."
publishDate: '2025-12-16'
tags:
- "Android"
- "LLM"
- "Kotlin"
- "Jetpack Compose"
- "Performance Optimization"
seo:
  title: "Android On-device LLM Streaming Output from Tokens to Compose UI"
  description: "Build stable Android on-device LLM streaming with KV Cache optimization, Flow backpressure, and Compose incremental rendering."
  pageType: article
---

Last year, while building an on-device assistant, I hit a trap: model inference was much faster than UI consumption. The result was UI jank and runaway memory growth. My first instinct was to add a buffer, but that made things worse. The real problem was not buffer size. It was the lack of a unified backpressure mechanism across the whole pipeline. This article covers the issues I hit and the architecture that finally worked.

## Pipeline overview: three gates from token generation to screen

On-device LLM streaming output has three stages:

- **Inference layer**: the LLM engine, such as MediaPipe LLM Inference or llama.cpp, generates tokens one by one and emits them through callbacks or Flow
- **Transport layer**: the token stream moves from native code to Kotlin, involving thread switching and buffering strategy
- **Rendering layer**: Compose UI receives token increments and performs incremental recomposition instead of full refresh

Each stage operates on a different timescale. The inference layer may generate a token every 10-50ms. The rendering layer has a 16ms frame budget on the main thread. Without coordination, you either drop frames or hit OOM.

## The KV Cache memory problem

The biggest memory consumer in on-device LLM inference is **KV Cache, or Key-Value Cache**. For each generated token, the approximate increment is `2 x number of layers x KV dimension x bytes per element`.

The exact number varies widely by model architecture. For two 2B-parameter models, Multi-Query Attention with one KV head and Grouped-Query Attention with eight KV heads can differ by 8x in KV Cache size. Take Gemma 2B INT4 as an example: 18 layers, 2048 hidden dimension, and MQA architecture. A 512-token response consumes roughly 10MB of KV Cache, which is still acceptable. But for a GQA model like Llama 8B, the same 512 tokens can go straight to 70MB. In multi-turn conversations with a 4096-token context, even INT4 KV Cache can exceed 140MB. Add model weights on top, and a 6GB RAM device starts to struggle.

```kotlin
// Estimate KV Cache size
fun estimateKVCache(
    numLayers: Int, hiddenDim: Int, kvHeads: Int, 
    seqLen: Int, bytesPerElem: Int = 2 // FP16
): Long {
    val perToken = 2L * numLayers * hiddenDim * kvHeads * bytesPerElem
    return perToken * seqLen
}
// Gemma 2B: 2 * 18 * 2048 * 8 * 2 * 512 ~= 576MB (including K + V)
// Around 144MB after INT4 quantization, still too large to ignore
```

In practice, we used three optimization ideas:

1. **Sliding window**: keep only the most recent N tokens of KV Cache and discard older cache entries. In conversation scenarios, users rarely care about context from 2,000 tokens ago.
2. **Quantized KV Cache**: store KV Cache in INT8 or even INT4. The quality loss is usually acceptable.
3. **Active release**: release native memory immediately after inference ends. Do not wait for GC.

## Flow backpressure: from "it runs" to "it does not crash"

The inference engine callback runs on a native thread. If it calls directly into Kotlin with `Channel.UNLIMITED` or with no backpressure strategy, the producer keeps emitting tokens while the consumer falls behind, and memory keeps growing.

My first implementation used `MutableSharedFlow`, and it failed quickly. Flow has no backpressure by default, so the producer does not suspend.

The final version used `callbackFlow` with `Channel.RENDEZVOUS`, a zero-buffer channel. When the consumer is not ready, the inference thread automatically blocks:

```kotlin
fun streamTokens(modelPath: String, prompt: String): Flow<String> = callbackFlow {
    val inference = MediaPipeLlmInference.create(modelPath)
    
    inference.setTokenCallback(object : TokenCallback {
        override fun onToken(token: String) {
            // trySendBlocking blocks the native thread until the consumer receives
            // This creates natural backpressure: inference speed = UI consumption speed
            trySendBlocking(token)
        }
        
        override fun onComplete() {
            close()
        }
    })
    
    inference.generate(prompt)
    
    awaitClose { inference.close() }
}
```

`trySendBlocking` is the key. When the channel is full, it blocks the calling thread, which pauses the native inference thread. The inference engine waits for the callback to return before generating the next token, so the whole pipeline runs at the speed of its slowest stage.

With this approach, memory peak in 200+ token long replies dropped from 380MB to 120MB, and OOM disappeared.

## Compose incremental recomposition: refresh only what changed

After receiving the token stream, the most direct approach is to concatenate tokens into one full text string and refresh it. But with 512 tokens, every new token triggers full text layout again, which can freeze the main thread.

A better approach is **incremental recomposition**. Compose's `Snapshot` system supports this naturally. The core idea is to manage a token list with `mutableStateListOf` instead of repeatedly concatenating strings:

```kotlin
@Composable
fun StreamingChatBubble(tokens: SnapshotStateList<String>) {
    Column {
        // Confirmed tokens: no longer recomposed
        Text(
            text = buildAnnotatedString {
                tokens.dropLast(1).forEach { append(it) }
            }
        )
        // Latest token: typewriter effect, recomposed independently
        if (tokens.isNotEmpty()) {
            Text(
                text = tokens.last(),
                modifier = Modifier.alpha(1f) 
                // Only this Text participates in recomposition
            )
        }
    }
}
```

Add `derivedStateOf` to avoid unnecessary recomposition propagation:

```kotlin
val displayText by remember {
    derivedStateOf {
        tokens.joinToString("")
    }
}
// displayText is recomputed only when the token list structure changes
// Mutating an element inside the list does not trigger recomposition
```

In measurement, during 500-token streaming output, main-thread frame time dropped from 80ms to under 4ms, and frame rate stayed around 58-60fps. The core reason is that **only the Composable for the latest token is recomposed**. Compose can intelligently skip the earlier static text.

## Full timing across the three layers

Putting the pieces together:

```
[Inference thread] Generate token -> trySendBlocking -> Channel.RENDEZVOUS
    | (Backpressure: inference thread pauses until...)
[Consumer coroutine] Receive token -> append to mutableStateListOf
    | (Snapshot notification)
[Main thread] Compose recomposition -> refresh only the last Text node
    | (Complete within 16ms)
[Consumer coroutine] Next trySendBlocking unblocks -> inference continues
```

In this design, inference speed is determined by UI rendering speed, not the other way around. KV Cache release is synchronized with inference completion, so no dangling native memory remains.

## Measurements and tuning advice

On Pixel 6 with 8GB RAM, running Gemma 2B INT4 across 200 conversations, with an average of 300 tokens per turn:

| Metric | Before | After |
|---|---|---|
| Memory peak | 380MB | 120MB |
| Main-thread frame time P99 | 82ms | 5ms |
| End-to-end latency, first token | 1.2s | 0.9s |
| OOM rate | 12% | 0% |

A few lessons from tuning:

1. **Buffering is not a cure**: `Channel.BUFFERED` has a default capacity of 64. If the UI is consistently slower than inference, it still stalls after 64 tokens. `RENDEZVOUS` is the right answer.
2. **A KV Cache window of 1024 is enough**: for mobile conversation use cases, a 1024-token context covers more than 95% of interactions. Larger windows mostly waste memory.
3. **Quantization before pruning**: INT4 quantization causes less quality loss than aggressive pruning. For on-device deployment, prefer quantization first.
4. **Use `derivedStateOf` for debouncing**: when token generation is very fast, under 5ms, batch tokens accumulated within 50ms and commit them to state together to reduce recomposition count. Balance this against perceived interactivity; users can feel stalls above 100ms.

This architecture has already shipped in three on-device AI features: smart replies, document summaries, and code completion. If you are building something similar, starting with backpressure gives the best return for the engineering effort.
