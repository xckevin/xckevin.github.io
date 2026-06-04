---
title: "Android On-device LLM Context Window Engineering"
lang: en
translationKey: android-on-device-llm-context-window
slug: android-on-device-llm-context-window
excerpt: "A practical Android on-device LLM context management strategy covering layered prompt compression, summary caching, dialog state machines, and token budget allocation."
publishDate: '2025-12-17'
tags:
- "Android"
- "On-device Inference"
- "LLM"
- "Performance Optimization"
- "Context Management"
seo:
  title: "Android On-device LLM Context Window Engineering"
  description: "Manage long Android on-device LLM conversations with prompt compression, summary caches, dialog state machines, and token budgets."
  pageType: article
---

When doing on-device inference, the first problem that hurts is often not model accuracy. It is the context window. Server-side GPT-4-class models can already reach 128K tokens, but LiteRT and MediaPipe models running on phones are doing well if they support 4K tokens. After a user chats for a few rounds, historical messages fill the window, and the model starts forgetting the earliest instructions. Eventually, even the system prompt you gave it is gone.

Below are the problems I ran into while building long-conversation context management on Android, and the design that finally worked.

## The real constraints of on-device context windows

On-device LLM context windows are constrained by three things:

**Memory ceiling.** A flagship phone may have 4-6GB of available memory, but after system reservation and other app usage, the model usually gets no more than 2GB. KV Cache grows linearly with sequence length. A 7B model with a 4K context can easily spend more than 500MB on KV Cache alone. I have seen worse in real development: on low-end devices, the system triggered the OOM killer directly, leaving no crash log at all.

**A quadratic latency curve.** Transformer self-attention has O(n^2) complexity. When token count doubles, latency approaches 4x. On-device NPUs help somewhat, but MLIR compiler operator fusion becomes less effective on long sequences. Users may tolerate three seconds. At eight seconds, they force quit.

**Accumulated quantization error.** On-device models are usually int4 or int8 quantized. Quantization error is not obvious on short text, but as context grows, the error accumulates. In my tests, at 8K tokens, factual consistency of an int4 model was about 12% lower than fp16.

These constraints mean you cannot treat the device like a server and throw all conversation history into the prompt.

## Prompt compression: not just truncation

The first implementation was crude: when the window overflowed, remove the earliest conversation turns. User feedback was obvious. As the conversation continued, the model started "forgetting" things and lost the role definition in the system prompt.

### Layered compression strategy

I split context into three layers and handled each one differently:

```
+----------------------+
|  System Prompt       |  <- Always retained, never touched by compression
+----------------------+
|  Core Context        |  <- Key entities and constraints relevant to the current conversation
+----------------------+
|  Dialogue History    |  <- Compressible conversation turns
+----------------------+
```

**System Prompt is permanently resident.** This part is roughly 200-500 tokens and defines role, rules, and output format. No matter how the rest is compressed, this layer stays intact. Losing the role definition costs far more than losing a few old turns, because users immediately notice when the model falls out of character.

**Core Context is updated incrementally.** Extract key entities and constraints from the conversation, and maintain a dynamic context state object. If the user is discussing a travel plan, this stores destination, budget, and date range. It is updated after each turn, and old entities are evicted if they have not been mentioned for more than three turns. Keep it under 300 tokens.

**Dialogue History is compressed by turn.** This is where most compression happens. The idea is not truncation. It is to express older turns with fewer tokens:

```python
# Compression strategy sketch
def compress_turn(turn, model):
    """Compress one conversation turn into a summary."""
    if turn["importance"] == "high":  # Turn contains a key decision
        return turn["original"]       # Keep the original text
    elif turn["age"] > 5:             # Older than five turns
        summary = model.generate(
            f"Summarize the key information in this conversation in one sentence: {turn['original']}"
        )
        return f"[Summary] {summary}"
    else:
        return turn["original"]
```

Importance detection is the core of the compression strategy. How do you know which turn matters? I used two signals. A user message longer than 100 characters usually contains more information, so mark it as high. If the model response contains confirmation phrases such as "Sure, I will arrange that" or "Based on your requirements," it likely produced a decision, so mark that turn as high too. These rules are simple, but in practice they are accurate enough.

### When to trigger compression

Compression should not run before every inference, because that only adds latency. I maintain a token counter and trigger compression once the estimated token count reaches 80% of the window limit. A single compression pass takes about 200-400ms and happens roughly every 10-15 turns, so users do not notice it.

With this layered compression strategy, a 4K window went from about 8 useful conversation turns to 25-30, while the system prompt and key context stayed complete.

## Summary cache: optimizing compression further

Layered compression has a cost: each trigger may call the model several times to summarize older turns. That consumes compute. When users switch topics back and forth, some turns may be compressed repeatedly.

### Sliding window with summary anchors

I introduced a sliding-window mechanism:

```kotlin
class SummaryCache(private val maxCachedSummaries: Int = 3) {
    private val summaries = mutableListOf<SummaryAnchor>()

    data class SummaryAnchor(
        val startTurn: Int,
        val endTurn: Int,
        val text: String,
        val tokenCount: Int
    )

    fun add(turns: List<Turn>): String {
        // When over the limit, merge the two oldest summaries
        if (summaries.size >= maxCachedSummaries) {
            val merged = merge(summaries[0], summaries[1])
            summaries.removeAt(0)
            summaries[0] = merged
        }
        val anchor = SummaryAnchor(
            startTurn = turns.first().id,
            endTurn = turns.last().id,
            text = compactSummarize(turns),
            tokenCount = estimateTokens(turns)
        )
        summaries.add(anchor)
        return summaries.joinToString("\n") { it.text }
    }
}
```

Each summary anchor covers 5-10 conversation turns. When the number of cached anchors exceeds the limit, which I set to three, the two oldest anchors are merged into a coarser summary. This effectively builds a multilevel index over conversation history. The older the conversation is, the coarser its summary becomes. The result is similar to hierarchical caching strategies often used on servers, except the cached value here is semantically compressed text.

### Delayed write strategy

There is another optimization: do not generate a summary immediately after the user sends a message. Instead, schedule an asynchronous write with a 500ms coroutine delay. If the user sends follow-up messages within those 500ms, which is common, multiple turns can be merged and summarized together, reducing compression frequency.

```kotlin
private var summaryJob: Job? = null

fun scheduleSummary(turns: List<Turn>) {
    summaryJob?.cancel()
    summaryJob = scope.launch {
        delay(500) // Wait for possible consecutive input
        val merged = mergeRecentTurns(turns)
        cache.add(merged)
    }
}
```

Together, these two optimizations reduced summary-related inference overhead by about 40%.

## Dialog state machine: structuring long conversations

Compression solves the token budget problem, but it introduces another issue. After many rounds of compressed summaries, the model can lose track of the conversation stage. For example, the user is still in the information-gathering phase, but the model jumps to giving recommendations because the stage marker was compressed away.

### Finite state machine modeling

I modeled a typical conversation flow as a state machine:

```
[IDLE] -> [CLARIFYING] -> [ANALYZING] -> [RESPONDING] -> [CONFIRMING]
                                    ^                    |
                                    `--------------------'
```

Each state defines legal transitions and a corresponding system prompt patch. State classification is handled by lightweight logic. It does not need a full model pass; rules plus keyword matching are enough:

```kotlin
enum class DialogState {
    IDLE,        // Waiting for user input
    CLARIFYING,  // Asking follow-up questions
    ANALYZING,   // Analyzing the problem
    RESPONDING,  // Generating the response
    CONFIRMING   // Confirming user satisfaction

    fun transition(userInput: String, modelOutput: String): DialogState {
        return when (this) {
            IDLE -> if (userInput.isNotEmpty()) CLARIFYING else IDLE
            CLARIFYING -> if (isClarified(userInput)) ANALYZING else CLARIFYING
            ANALYZING -> RESPONDING
            RESPONDING -> if (needsConfirmation(modelOutput)) CONFIRMING else IDLE
            CONFIRMING -> if (isAcknowledged(userInput)) IDLE else RESPONDING
        }
    }
}
```

State information does not consume much of the token budget. Inject a 10-20 token state marker at the end of the system prompt:

```
[Current dialog state: ANALYZING - enough information has been collected, now analyzing]
```

This marker tells the model what it should be doing now. After many rounds of compression, that one line helps keep behavior consistent. In testing, adding the state machine reduced long-conversation drift from about 18% to under 5%.

### Token budget allocation for the context window

Putting the pieces together, one inference can allocate the token budget like this, using a 4096-token window as an example:

| Component | Tokens | Share |
|---------|---------|------|
| System Prompt, including state marker | 400 | 10% |
| Core Context, key entities | 250 | 6% |
| Latest three full conversation turns | 1200 | 30% |
| Summary cache, compressed old conversation | 600 | 15% |
| Current user input | 300 | 7% |
| Reserved output space | 1346 | 33% |

## Engineering details

**Compression quality depends on the prompt template.** I iterated over the summary prompt more than a dozen times and eventually converged on a concise version: "Summarize the key information and decisions in the following conversation in one sentence. Preserve names, numbers, and dates. Do not add explanations." A long compression prompt consumes token budget and is not worth it.

**Choosing the on-device model.** Compression and state classification do not require a large model. I used Gemma 2B specifically for compression and classification, while the main conversation ran on a 7B model. The 2B model had about 50ms inference latency and barely affected user experience. The pitfall I hit early was trying to make one 7B model handle everything. Compression latency exceeded 500ms, and users could clearly feel the stall.

**State restoration.** When the user switches away from the app and returns, the state machine must be restorable. I serialize `DialogState`, `CoreContext`, and `SummaryCache` into a Room database, then deserialize directly on cold start without rerunning compression.

## Tradeoffs

Several decisions are worth calling out.

Compared with maximizing compression ratio, I care more about preserving the full system prompt. If one or two old turns are lost, users may not notice. If the role definition is lost, model responses immediately feel wrong. In token budget allocation, the system prompt always has the highest priority.

Should the state machine use a dedicated classifier model? I tried it, but the improvement was limited. Drift dropped from 5% to 4%, while loading another model added overhead. Rules plus keywords are good enough on Android.

If I rebuilt this system, I would introduce quantitative token budget management earlier. Early tuning was mostly based on intuition. It became stable only after using a token counter to allocate budget precisely. On-device engineering is much more resource-conscious than server-side engineering. You cannot casually add Redis or switch to a machine with more GPU memory. Every MB of memory and every millisecond of latency has to be accounted for.
