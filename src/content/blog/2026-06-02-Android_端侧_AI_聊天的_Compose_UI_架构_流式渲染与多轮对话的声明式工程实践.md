---
title: Android 端侧 AI 聊天的 Compose UI 架构：流式渲染与多轮对话的声明式工程实践
excerpt: 本文分享端侧 LLM 聊天应用中 Compose UI 的流式渲染实践，通过 Token 缓冲、状态隔离和统一数据源等策略，在高频流式输出下保持流畅体验。
publishDate: '2026-06-02'
tags:
- Android
- Jetpack Compose
- 端侧AI
- 性能优化
- 架构设计
seo:
  title: Android 端侧 AI 聊天的 Compose UI 架构：流式渲染与多轮对话的声明式工程实践
  description: 深入探讨端侧 LLM 聊天应用的 Compose 声明式 UI 架构，包括 Token 缓冲策略、流式状态管理、多轮对话一致性及推理状态建模，解决高频流式输出下的渲染性能瓶颈。
---

在做端侧 LLM 聊天应用时，我撞上一个看似简单的问题：模型每吐出一个 token，UI 就得刷一次。如果每个 token 到达都触发一次 `recomposition`，200 个 token 的回复会在 2 秒内拉满 200 次重组，界面直接卡死。

本文梳理我把端侧推理的流式输出接入 Compose 声明式 UI 的过程——怎么在实时性和渲染性能之间找平衡点，以及多轮对话上下文如何做到状态不出乱子。

## 端侧推理的流式特性

端侧 LLM 推理和云端 API 有个本质区别：延迟分布完全不同。云端调用瓶颈在网络，端侧则是模型推理本身吃 GPU/NPU。以 MediaPipe LLM Inference 为例，骁龙 8 Gen 3 上跑 Gemma 2B，首 token 延迟约 400-800ms，后续 token 间隔在 30-80ms 之间抖动。

这意味着流式输出的节奏不稳定——有时连续几个 token 在 20ms 内到达，有时单个 token 要等 100ms。直接把每个 token 推到 UI 线程渲染，等于在 30ms 窗口里连续触发多次重组，Compose 的重组调度根本跟不上。

解法是在中间加一层缓冲。

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
                || buffer.length >= 20 // 兜底，防止 token 间隔过长
        if (shouldFlush) {
            lastFlushTime = now
            return buffer.toString().also { buffer.clear() }
        }
        return null
    }
}
```

策略很简单：累积至少 3 个 token 且距离上次刷新超过 50ms 才推一次更新，同时设一个 20 字符的硬上限兜底。这样把最高 200 次重组压到 30-40 次左右，渲染压力降了一个数量级。

## Compose 的流式状态管理

缓冲层就绪后，下一步是把流式文本高效反映到 UI 上。直觉方案是用 `mutableStateOf` 存一个字符串，缓冲区每次有输出就更新它。但这意味着每次更新都重建整个 `Text` 组件，聊天界面上历史消息越多，重组越重。

我采用的方案是把正在流式输出的那条消息从常规消息列表中拆出来，单独管理。

```kotlin
@Stable
class ChatScreenState {
    // 已完成的消息列表——只在流式结束后才更新
    var completedMessages = mutableStateListOf<ChatMessage>()

    // 正在流式输出的消息——单独管理，隔离重组范围
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

对应的 Compose 布局：

```kotlin
@Composable
fun ChatScreen(state: ChatScreenState) {
    LazyColumn {
        // 已完成消息：只在列表变化时重组
        items(state.completedMessages, key = { it.id }) { message ->
            MessageBubble(message)
        }
        // 流式消息：文字变化时只有这个 item 重组
        state.streamingMessage?.let { streaming ->
            item(key = "streaming") {
                StreamingMessageBubble(streaming.content)
            }
        }
    }
}
```

`key = "streaming"` 让 Compose 把这个 item 识别为固定节点。文字内容变化时只重组这一个 `StreamingMessageBubble`，其余历史消息完全不动。实测 50 轮对话、每轮 200+ 字的长上下文场景，流式输出时主线程帧率稳定在 55fps 以上。

## 多轮对话的状态一致性

流式渲染搞定了，多轮对话的状态管理又是另一个坑。

端侧推理场景中，历史消息不只是 UI 展示数据，还是下一轮推理的输入上下文。UI 层的消息列表和推理层的对话历史必须严格同步——如果用户在 UI 上编辑或删了某条消息，推理层的上下文也必须跟着变，否则模型会在错位的上下文中生成回复。

我引入一个统一的 `ConversationState` 作为唯一数据源。

```kotlin
class ConversationState {
    private val _messages = mutableStateListOf<ChatMessage>()
    val messages: List<ChatMessage> get() = _messages

    // 推理引擎需要的上下文格式，从 messages 实时派生
    fun toInferenceContext(): List<Pair<String, String>> {
        return _messages.map { it.role to it.content }
    }

    fun appendUserMessage(text: String) {
        _messages.add(ChatMessage(role = "user", content = text))
    }

    fun appendAssistantStreaming(text: String) {
        // 流式更新时，直接操作列表最后一个元素
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

设计上有几个点：

**不区分 UI 消息和推理消息。**见过一些方案维护两套列表——一套给 UI，一套给推理引擎。同步两次，迟早出问题。一套列表、按需派生上下文格式，维护成本低得多。

**流式更新用 `copy` 重新创建对象。**Compose 的 State 更新依赖对象引用变化，直接改 `content` 字段不会触发重组。`data class` 的 `copy` 正好解决——新对象新引用，触发重组，同时保持不可变性。

**Token 裁剪尽早做。**端侧模型上下文窗口通常不大，2B 模型常见的窗口是 4K-8K tokens。超出窗口直接截断大概率会丢掉 system prompt。`trimToTokenLimit` 从最新消息往回数，保留窗口内的最近对话，确保最新上下文不丢。

## 加载状态与错误处理的 UI 反馈

端侧推理的加载和错误状态比云端 API 复杂得多。模型首次加载 5-10 秒，内存不足时直接加载失败，推理中设备过热降频也可能导致输出中断。

我把推理状态建模为 sealed class：

```kotlin
sealed class InferenceState {
    data object Idle : InferenceState()
    data object LoadingModel : InferenceState()
    data class Thinking(val partialText: String) : InferenceState()
    data class Error(val message: String, val retryable: Boolean) : InferenceState()
}
```

在 Compose 中消费时，`when` 分支确保每种状态都有对应的 UI 反馈：

```kotlin
@Composable
fun InferenceIndicator(state: InferenceState, onRetry: () -> Unit) {
    when (state) {
        InferenceState.Idle -> { /* 不渲染 */ }
        InferenceState.LoadingModel -> {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            Text("正在加载模型...", style = MaterialTheme.typography.bodySmall)
        }
        is InferenceState.Thinking -> {
            // 轻量指示器 + 展示当前已生成的部分文字
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(state.partialText.takeLast(20), style = MaterialTheme.typography.bodySmall)
            }
        }
        is InferenceState.Error -> {
            if (state.retryable) {
                TextButton(onClick = onRetry) {
                    Text("重试 - ${state.message}")
                }
            } else {
                Text("模型不可用：${state.message}", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
```

一个容易踩坑的地方：`Thinking` 状态的 `partialText` 更新和流式消息更新是两个不同的 State 对象。如果让它们同时频繁更新，会产生双重重组。我用 `derivedStateOf` 把 `partialText` 的计算延后到组合阶段，避免额外触发重组：

```kotlin
val displayText by remember {
    derivedStateOf {
        state.partialText.takeLast(20)
    }
}
```

## 实践中的取舍

这套方案在三个项目（个人助理、代码助手、文档问答）上跑了半年，有几点判断值得记下来。

**50ms 的缓冲间隔是经验值，不是绝对值。**我的测试数据来自骁龙 8 Gen 3，换到天玑 9300 或更低端芯片，token 生成速度差异很明显。这个值应该做成可配置的，和设备的实际推理速度挂钩。

**`mutableStateListOf` 在长列表场景有性能天花板。**超过 500 条消息后，`mutableStateListOf` 的 diff 计算开始成为瓶颈。正经的做法是用 Room 做分页存储，LazyColumn 的 `items` 只加载可见区域的消息。不过我目前的场景通常不超过 100 条消息，暂时没走到这一步。

**别在 Compose 层做 token 级别的精细化控制。**最初我确实试过让每个 token 以打字机效果出现——用 `AnimatedContent` 做逐字动画。结果 30ms 的 token 间隔下，动画反而比直接显示更卡。声明式 UI 的优势在于描述"应该是什么样"，逐帧控制不是它擅长的领域。

如果让我重新选技术栈，我还是会选 Compose。ChatGPT 的 iOS 客户端用 UIKit，Claude 的 Android 客户端用原生 View 系统，它们处理流式输出的方式本质上是 View 层做增量更新——逻辑散落在 Adapter、ViewHolder 和 DiffUtil 各处。Compose 的声明式模型把状态定义和 UI 描述解耦了，流式更新的核心代码不到 100 行，读起来清晰很多。

端侧 AI 的 UI 层没那么神秘。核心就三件事：控制刷新频率、隔离重组范围、保证状态一致性。剩下的都是工程细节。
