---
title: 深入 Android 端侧 LLM 的上下文窗口工程：从 Prompt 压缩到对话状态机的全链路实践
excerpt: 本文系统梳理了 Android 端侧大模型长对话上下文管理的完整方案，涵盖分层 Prompt 压缩、摘要缓存、对话状态机及 token 预算分配等工程实践，有效突破端侧 4K 窗口限制。
publishDate: '2026-06-01'
tags:
- Android
- 端侧推理
- LLM
- 性能优化
- 上下文管理
seo:
  title: 深入 Android 端侧 LLM 的上下文窗口工程：从 Prompt 压缩到对话状态机的全链路实践
  description: Android 端侧 LLM 长对话上下文管理全链路实践：分层 Prompt 压缩、摘要缓存与对话状态机，突破 4K token 窗口限制，实现 25-30 轮有效对话。
---

做端侧推理时，第一个让你头疼的问题往往不是模型精度，而是上下文窗口。服务端 GPT-4 已经开到 128K 了，但手机上跑的 LiteRT/MediaPipe 模型，4K token 就算不错了。用户多聊几轮，历史消息直接把窗口塞满，模型开始忘掉最早的指令——你给它的 system prompt 都没了。

下面是我在 Android 端做长对话上下文管理时踩过的坑和最终落地的方案。

## 端侧上下文窗口的现实约束

端侧 LLM 的上下文窗口受三重限制：

**显存天花板。** 一部旗舰机可用内存大约 4-6GB，但系统预留加上其他 App 占用后，留给模型的一般不超过 2GB。KV Cache 随序列长度线性增长，一个 7B 模型跑 4K context 时 KV Cache 轻松吃掉 500MB+。实际开发中我还遇到过更糟的情况——低端机上系统直接触发 OOM killer，连崩溃日志都拿不到。

**推理延迟的二次曲线。** Transformer 的自注意力计算复杂度是 O(n²)，token 数翻倍，延迟接近四倍增长。端侧 NPU 对此有一定缓解，但 MLIR 编译器的算子融合优化在长序列上效果递减。用户等 3 秒还能忍，等 8 秒就直接杀进程了。

**量化损失叠加。** 端侧模型基本都是 int4/int8 量化版本。量化误差在短文本上不明显，但上下文越长，误差累积越显著。实测 8K token 时 int4 模型的事实一致性比 fp16 低了约 12%。

这三座大山摆在那里，决定了你不能像服务端那样「把全部历史扔进去就完事了」。

## Prompt 压缩：不是简单的截断

最初的做法很粗暴——超出窗口就截掉最早的对话。用户反馈很明显：聊着聊着模型就「失忆」了，还丢失了 system prompt 里的角色设定。

### 分层压缩策略

我把上下文分成了三层，分别处理：

```
┌──────────────────────┐
│  System Prompt       │  ← 始终保留，压缩时不触碰
├──────────────────────┤
│  Core Context        │  ← 当前对话相关的关键实体、约束
├──────────────────────┤
│  Dialogue History    │  ← 可压缩的对话轮次
└──────────────────────┘
```

**System Prompt 永久驻留。** 这部分约 200-500 token，定义角色、规则、输出格式。无论后面怎么压，这一层不动。丢掉角色设定比丢掉几轮对话的代价大得多——前者用户立刻能感知到「出戏」。

**Core Context 增量更新。** 从对话中提取关键实体和约束条件，维护一个动态的「上下文状态对象」。比如用户在聊旅行计划，这里存目的地、预算、日期范围。每轮对话后增量更新，旧实体超过 3 轮未提及则淘汰。控制在 300 token 以内。

**Dialogue History 按轮次压缩。** 这是压缩的主战场。思路不是截断，而是把旧轮次用更少的 token 表达：

```python
# 压缩策略示意
def compress_turn(turn, model):
    """将一轮对话压缩为摘要"""
    if turn["importance"] == "high":  # 包含关键决策的轮次
        return turn["original"]       # 保留原文
    elif turn["age"] > 5:             # 超过5轮的旧对话
        summary = model.generate(
            f"用一句话总结以下对话的核心信息：{turn['original']}"
        )
        return f"[摘要] {summary}"
    else:
        return turn["original"]
```

importance 判定是整个压缩策略的核心。怎么知道哪轮对话重要？我用了两个信号：用户消息长度超过 100 字的轮次通常包含较多信息，标记为 high；模型回复中出现了确认性短语（「好的，我帮你安排」「根据你的需求」），说明这轮产生了决策，也标记为 high。这两个规则简单，但实际准确率够用了。

### 压缩触发时机

不是每次推理都做压缩——那样反而增加延迟。我维护一个 token 计数器，当预估 token 数达到窗口上限的 80% 时触发一次压缩。单次压缩耗时约 200-400ms，频率大约每 10-15 轮触发一次，用户体验无感。

这套分层压缩方案实测将 4K 窗口的有效对话轮次从约 8 轮提升到 25-30 轮，system prompt 和关键上下文始终保持完整。

## 摘要缓存：压缩的进一步优化

分层压缩有个问题：每次触发时需要对多个旧轮次调用模型做摘要，这本身消耗算力。用户来回切换话题时，一些轮次可能被反复压缩。

### 滑动窗口 + 摘要锚点

我引入了一个滑动窗口机制：

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
        // 超过上限时，合并最旧的两个摘要
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

每个摘要锚点覆盖 5-10 轮对话，当缓存锚点超过上限（我设为 3 个），就把最旧的两个锚点合并为一个更粗粒度的摘要。这相当于给对话历史建了一个多级索引——越远的对话，摘要粒度越粗。实际效果类似于服务端常用的分级缓存策略，只是这里的「缓存」存的是语义压缩后的文本。

### 延迟写入策略

还有一个优化点：不在用户发消息后立刻生成摘要，而是用协程延迟 500ms 异步写入。如果用户在这 500ms 内连发了消息（常见于追问场景），就可以把多轮合并后再做摘要，减少压缩次数。

```kotlin
private var summaryJob: Job? = null

fun scheduleSummary(turns: List<Turn>) {
    summaryJob?.cancel()
    summaryJob = scope.launch {
        delay(500) // 等待可能的连续输入
        val merged = mergeRecentTurns(turns)
        cache.add(merged)
    }
}
```

两项优化叠加后，摘要相关的额外推理开销降低了约 40%。

## 对话状态机：管理长对话的结构

压缩解决了 token 预算问题，但另一个问题随之出现：经过多轮压缩摘要后，模型有时会搞混对话所处的阶段。比如用户在「收集信息」阶段，模型却跳到了「给出建议」——因为摘要把阶段标记给压缩掉了。

### 有限状态机建模

我把典型对话流程抽象为一个状态机：

```
[IDLE] → [CLARIFYING] → [ANALYZING] → [RESPONDING] → [CONFIRMING]
                                    ↑                    │
                                    └────────────────────┘
```

每个状态定义了合法的转换路径和对应的 system prompt 补丁。状态判定由轻量级分类逻辑完成——不需要跑完整模型，基于规则加关键词匹配就够：

```kotlin
enum class DialogState {
    IDLE,        // 等待用户输入
    CLARIFYING,  // 追问澄清
    ANALYZING,   // 分析问题
    RESPONDING,  // 生成回复
    CONFIRMING   // 确认用户满意度

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

状态信息不作为 token 消耗大头——只注入一个 10-20 token 的状态标记到 system prompt 末尾：

```
[当前对话状态: ANALYZING - 已收集足够信息，正在分析]
```

这个标记告诉模型「你现在该干什么」。尤其经过多轮压缩后，这条信息帮助模型保持行为一致性。实测加了状态机后，模型在长对话中跑偏的概率从约 18% 降到 5% 以下。

### 上下文窗口的 token 预算分配

把以上方案串起来，一次推理的 token 预算分配如下（以 4096 token 窗口为例）：

| 组成部分 | Token 数 | 占比 |
|---------|---------|------|
| System Prompt（含状态标记） | 400 | 10% |
| Core Context（关键实体） | 250 | 6% |
| 最近 3 轮完整对话 | 1200 | 30% |
| 摘要缓存（压缩后的旧对话） | 600 | 15% |
| 用户当前输入 | 300 | 7% |
| 预留输出空间 | 1346 | 33% |

## 工程落地的几个细节

**压缩质量靠 Prompt 模板。** 摘要生成用的 prompt 我反复调了十几版，最终收敛到一个简洁版本：「用一句话概括以下对话的关键信息和决策，保留人名、数字、日期，不添加任何解释。」太长的压缩 prompt 反而侵占 token 预算，得不偿失。

**端侧模型的选择。** 压缩和状态判定的任务不需要大模型。我用 Gemma 2B 专门做压缩和分类，主对话跑 7B 模型。2B 模型推理延迟约 50ms，几乎不影响用户体验。踩过的坑是初期试图用一个 7B 模型包办所有事情，结果压缩延迟 500ms+，用户明显能感知到卡顿。

**状态恢复。** 用户切走 App 再回来，状态机要能恢复。我把 `DialogState`、`CoreContext`、`SummaryCache` 序列化到 Room 数据库，冷启动时直接反序列化，不需要重跑压缩。

## 选择取舍

做这套方案的过程中，有几个决策点值得一说。

比起追求极致的压缩比，我更看重 system prompt 的完整性。丢了一两轮旧对话，用户可能感知不到；但角色设定丢了，模型回复会立刻「出戏」。预算分配上 system prompt 始终是最高优先级。

状态机要不要引入一个专门的分类模型？我试过，效果提升有限——跑偏率从 5% 再降到 4%，但多了一个模型的加载开销，不划算。规则加关键词的方案在 Android 端够用了。

如果让我重做一次，我会更早引入 token 预算的量化管理。早期靠感觉调参，后来用 token 计数器精确分配才稳定下来。端侧工程对资源的斤斤计较，和服务端完全是两种思路——你没法随手加个 Redis 或者换个更大显存的机器，每一 MB 内存和每一毫秒延迟都得算清楚。
