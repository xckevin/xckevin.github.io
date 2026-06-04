---
title: "Android On-device AI Chat Compose UI Architecture: Streaming Rendering and Multi-turn Conversation State"
lang: en
translationKey: android-on-device-ai-chat-compose-ui
slug: android-on-device-ai-chat-compose-ui
excerpt: "Compose UI patterns for on-device LLM chat apps, using token buffering, state isolation, and a single source of truth to keep streaming output smooth."
publishDate: '2026-02-10'
tags:
- "Android"
- "Jetpack Compose"
- "On-device AI"
- "Performance Optimization"
- "Architecture Design"
seo:
  title: "Android On-device AI Chat UI with Compose Streaming"
  description: "Design a Compose UI architecture for on-device LLM chat with token buffering, streaming state isolation, multi-turn consistency, and inference feedback."
  pageType: article
---

While building an on-device LLM chat app, I ran into a problem that looked simple: every time the model emits one token, the UI needs to update. If every token arrival triggers one `recomposition`, a 200-token response can produce 200 recompositions in two seconds. The interface locks up quickly.

This article walks through how I connected on-device inference streaming output to a Compose declarative UI: how to balance real-time feedback with rendering performance, and how to keep multi-turn conversation state from drifting out of sync.

## Streaming characteristics of on-device inference

On-device LLM inference differs fundamentally from cloud APIs: the latency distribution is completely different. Cloud calls are usually bottlenecked by the network. On-device inference spends its time on GPU or NPU execution. With MediaPipe LLM Inference, for example, running Gemma 2B on a Snapdragon 8 Gen 3 gives a first-token latency of roughly 400-800ms, while later tokens fluctuate between 30ms and 80ms.

That means the streaming cadence is unstable. Sometimes several tokens arrive within 20ms. Sometimes a single token takes 100ms. If every token is pushed directly to the UI thread for rendering, Compose may receive multiple recomposition requests inside a 30ms window. Its recomposition scheduler simply cannot keep up.

The fix is to add a buffer layer in the middle.

```kotlin
class TokenBuffer(
    private val flushIntervalMs: Long = 50L,
    private val minFlushSize: Int = 3
) {
    private val buffer = StringBuilder()
    private var lastFlushTime = 0L

    fun push(token: String): String? {
        buffer.append(token)
        val now = System.currentTimeMillis()
        val shouldFlush = (now - lastFlushTime >= flushIntervalMs && buffer.length >= minFlushSize)
                || buffer.length >= 20 // Fallback to prevent long token gaps
        if (shouldFlush) {
            lastFlushTime = now
            return buffer.toString().also { buffer.clear() }
        }
        return null
    }
}
```

The strategy is intentionally simple: accumulate at least three tokens and wait at least 50ms since the previous flush before sending an update. Also set a hard 20-character fallback. This reduces a worst-case 200 recompositions to roughly 30-40, cutting rendering pressure by an order of magnitude.

## Streaming state management in Compose

Once the buffer layer is ready, the next step is reflecting streaming text in the UI efficiently. The intuitive solution is to store a string in `mutableStateOf` and update it every time the buffer flushes. But that rebuilds the entire `Text` component on every update. As the chat history grows, recomposition becomes increasingly expensive.

My solution is to separate the currently streaming message from the normal message list and manage it independently.

```kotlin
@Stable
class ChatScreenState {
    // Completed messages are updated only after streaming ends.
    var completedMessages = mutableStateListOf<ChatMessage>()

    // The active streaming message is managed separately to isolate recomposition.
    var streamingMessage by mutableStateOf<StreamingMessage?>(null)

    fun onTokenBatch(text: String) {
        val current = streamingMessage
        if (current != null) {
            streamingMessage = current.copy(content = text)
        }
    }

    fun onStreamComplete() {
        streamingMessage?.let {
            completedMessages.add(it.toCompletedMessage())
            streamingMessage = null
        }
    }
}
```

The corresponding Compose layout:

```kotlin
@Composable
fun ChatScreen(state: ChatScreenState) {
    LazyColumn {
        // Completed messages recompose only when the list changes.
        items(state.completedMessages, key = { it.id }) { message ->
            MessageBubble(message)
        }
        // Streaming message: only this item recomposes when text changes.
        state.streamingMessage?.let { streaming ->
            item(key = "streaming") {
                StreamingMessageBubble(streaming.content)
            }
        }
    }
}
```

`key = "streaming"` lets Compose recognize this item as a stable node. When the text changes, only this one `StreamingMessageBubble` recomposes, while the historical messages remain untouched. In a real test with 50 conversation turns and 200+ characters per turn, the main-thread frame rate stayed above 55fps during streaming output.

## State consistency in multi-turn conversations

After streaming rendering is solved, multi-turn conversation state management becomes the next trap.

In on-device inference, historical messages are not just UI display data. They are also the input context for the next inference round. The UI message list and the inference-layer conversation history must stay strictly synchronized. If the user edits or deletes a message in the UI, the inference context must change with it. Otherwise, the model generates against a shifted context.

I introduced a unified `ConversationState` as the single source of truth.

```kotlin
class ConversationState {
    private val _messages = mutableStateListOf<ChatMessage>()
    val messages: List<ChatMessage> get() = _messages

    // The context format required by the inference engine is derived from messages.
    fun toInferenceContext(): List<Pair<String, String>> {
        return _messages.map { it.role to it.content }
    }

    fun appendUserMessage(text: String) {
        _messages.add(ChatMessage(role = "user", content = text))
    }

    fun appendAssistantStreaming(text: String) {
        // During streaming updates, replace the last list element directly.
        val last = _messages.lastOrNull() ?: return
        val index = _messages.lastIndex
        _messages[index] = last.copy(content = text)
    }

    fun trimToTokenLimit(maxTokens: Int, tokenizer: Tokenizer) {
        var count = 0
        val toKeep = _messages.reversed().takeWhile { msg ->
            count += tokenizer.count(msg.content)
            count < maxTokens
        }.reversed()
        _messages.clear()
        _messages.addAll(toKeep)
    }
}
```

There are a few important design points here.

**Do not separate UI messages from inference messages.** I have seen designs that maintain two lists: one for the UI and one for the inference engine. They need to be synchronized twice, and they eventually diverge. Keeping one list and deriving the inference context as needed is much cheaper to maintain.

**Use `copy` to recreate objects during streaming updates.** Compose state updates depend on object reference changes. Mutating a `content` field directly will not trigger recomposition. A `data class` `copy` solves this cleanly: it creates a new object reference, triggers recomposition, and preserves immutability.

**Trim tokens as early as possible.** On-device model context windows are usually small. A 2B model commonly has a 4K-8K token window. If you simply truncate after exceeding the window, you may drop the system prompt. `trimToTokenLimit` counts backward from the newest message, preserving the most recent conversation inside the window so the latest context is not lost.

## UI feedback for loading and errors

Loading and error states for on-device inference are more complex than they are for cloud APIs. The first model load can take 5-10 seconds. Insufficient memory may make loading fail immediately. Device overheating during inference can also interrupt output.

I model inference state as a sealed class:

```kotlin
sealed class InferenceState {
    data object Idle : InferenceState()
    data object LoadingModel : InferenceState()
    data class Thinking(val partialText: String) : InferenceState()
    data class Error(val message: String, val retryable: Boolean) : InferenceState()
}
```

When consuming it in Compose, a `when` branch ensures every state has matching UI feedback:

```kotlin
@Composable
fun InferenceIndicator(state: InferenceState, onRetry: () -> Unit) {
    when (state) {
        InferenceState.Idle -> { /* Render nothing */ }
        InferenceState.LoadingModel -> {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            Text("Loading model...", style = MaterialTheme.typography.bodySmall)
        }
        is InferenceState.Thinking -> {
            // Lightweight indicator plus the latest generated text fragment
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(state.partialText.takeLast(20), style = MaterialTheme.typography.bodySmall)
            }
        }
        is InferenceState.Error -> {
            if (state.retryable) {
                TextButton(onClick = onRetry) {
                    Text("Retry - ${state.message}")
                }
            } else {
                Text("Model unavailable: ${state.message}", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
```

One easy mistake: the `partialText` update in `Thinking` and the streaming message update are two different state objects. If both update frequently, you create double recomposition pressure. I use `derivedStateOf` to defer `partialText` calculation until composition and avoid extra recomposition triggers:

```kotlin
val displayText by remember {
    derivedStateOf {
        state.partialText.takeLast(20)
    }
}
```

## Practical trade-offs

This architecture has run for six months across three projects: a personal assistant, a coding assistant, and a document Q&A app. Several lessons are worth writing down.

**A 50ms buffer interval is an empirical value, not a law.** My test data came from Snapdragon 8 Gen 3. On Dimensity 9300 or lower-end chips, token generation speed differs significantly. This value should be configurable and tied to the device's actual inference speed.

**`mutableStateListOf` has a performance ceiling in long lists.** Once the list exceeds 500 messages, diffing overhead starts to become a bottleneck. The proper solution is paged storage with Room, letting `LazyColumn` load only visible messages. My current scenarios usually stay under 100 messages, so I have not needed that step yet.

**Do not do token-level fine control in Compose.** At first, I tried to make each token appear with a typewriter effect using `AnimatedContent` character-by-character animation. With 30ms token intervals, the animation was actually slower than direct display. Declarative UI is good at describing what the UI should be. Frame-by-frame control is not its strength.
