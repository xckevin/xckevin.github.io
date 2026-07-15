---
title: 深入 Android 端侧 AI 推理的 Token 化与解码策略：从 BPE 分词原理到 Top-P/Top-K 采样的生成质量调控
slug: android-on-device-ai-tokenization-decoding
translationKey: android-on-device-ai-tokenization-decoding
excerpt: 深入分析端侧AI推理中解码策略对生成质量的影响，涵盖BPE分词原理、Top-K/Top-P采样机制及端侧小模型的参数调优实践。
publishDate: '2026-06-28'
tags:
- Android
- 端侧AI
- BPE
- 解码策略
- Tokenization
seo:
  title: 深入 Android 端侧 AI 推理的 Token 化与解码策略：从 BPE 分词原理到 Top-P/Top-K 采样的生成质量调控
  description: 深入剖析Android端侧AI推理的Token化与解码策略：从BPE分词原理到Top-P/Top-K采样，提供端侧小模型（Gemma 2B、Phi-2）的实战调参配置与选型建议。
---

## 一个端侧推理的质量问题

在 MediaPipe LLM Inference 上跑 Gemma 2B 模型时，遇到一个问题：同样的 prompt，服务端返回的文本流畅自然，端侧却频繁出现重复短语和逻辑断裂。排查后发现，问题不在模型权重，而在解码策略的默认配置——服务端用了 Top-P + Top-K 联合采样，端侧 SDK 默认走的是贪婪搜索（Greedy Search）。

这个差异在端侧推理中会被放大。服务端算力充足，即使采样策略不理想，大模型也能靠参数量兜底；端侧模型参数量通常在 1-3B，解码策略的优劣直接决定生成质量的下限。

## BPE 分词：模型怎么"看"文本

LLM 的输入不是原始字符串，而是一个整数序列，每个整数对应词表中的一个 Token。BPE（Byte Pair Encoding）是 SentencePiece 分词器的核心算法，也是 Gemma、Llama 等模型的标准选择。

BPE 的训练过程很直接：从字符级别开始，统计相邻 token 对的出现频率，把高频对合并成一个新 token，反复迭代直到词表达到预设大小。

```
初始词表：'l', 'o', 'w', 'e', 'r'（单个字符）
第1轮：统计最高频 pair → 'l'+'o'='lo'，合并
第2轮：最高频 pair → 'lo'+'w'='low'，合并
第3轮：最高频 pair → 'e'+'r'='er'，合并
...迭代至词表达到目标大小（如 32K）
```

BPE 的优势在于子词（subword）粒度：字符级分词会让序列过长，拖慢推理；词级分词遇到未登录词就束手无策。子词取了两者之长——"unbelievable" 被切分成 `un` + `believe` + `able`，模型能复用已知词根的理解。

在 Android 端侧，SentencePiece 模型以 `.model` 文件随 APK 打包，加载很简单：

```kotlin
val processor = SentencePieceProcessor(
    context.assets.openFd("tokenizer.model")
)
val tokens = processor.encode("Hello, how are you?")
// tokens: [2, 1234, 567, 890, 123, 45]
```

编码后的 token 序列送入模型推理，得到每个位置在词表上的概率分布。解码策略要解决的核心问题是：从这些概率分布中如何选出最合适的 token 序列。

## 贪婪搜索与 Beam Search：端侧的两难

贪婪搜索每步都选概率最高的 token，不回溯。延迟最低，但有一个明显缺陷：一旦某步选错，后面全错。更常见的是陷入重复循环——模型在某一步选了高频但无意义的 token，后续概率分布又把它推回同一个选择。

实测 Gemma 2B 用贪婪搜索生成中文，超过 30% 的输出包含至少一次连续重复短语（3 token 以上）。这是端侧小模型的通病，不是 bug。

Beam Search 维护 k 个候选序列，每步扩展所有候选，保留概率乘积最高的 k 个。理论上比贪婪搜索好，但端侧落地有两个问题：beam width=4 时推理计算量是贪婪搜索的 4 倍；beam 之间容易趋同，生成文本四平八稳，缺乏多样性。在 Pixel 8 上实测，beam width=3 时首 token 延迟从 200ms 飙升到 600ms。端侧做 Beam Search，性价比不高。

## Top-K 与 Top-P：端侧采样的最优解

Top-K 和 Top-P 都基于随机采样，但控制随机性的方式不同。

Top-K 采样：每步只从概率最高的 K 个 token 中采样，用固定数量截断长尾分布。K 越小，输出越保守确定。

Top-P（Nucleus Sampling）：从概率最高的 token 开始累加，当累积概率达到 P 时停止，只用这个动态集合采样。分布尖锐时（模型很确定下一个 token），候选池自动缩小；分布平坦时，给更多选择空间。

业界通常将两者联合使用：先 Top-K 过滤，再 Top-P 过滤，最后从剩余集合中采样。

```kotlin
fun sampleToken(logits: FloatArray, topK: Int, topP: Float, temp: Float): Int {
    // 温度缩放
    val scaled = logits.map { it / temp }
    val probs = softmax(scaled)
    
    // Top-K 过滤
    val sortedIndices = probs.indices.sortedByDescending { probs[it] }.take(topK)
    
    // Top-P 过滤
    var cumProb = 0f
    val nucleus = mutableListOf<Int>()
    for (idx in sortedIndices) {
        nucleus.add(idx)
        cumProb += probs[idx]
        if (cumProb >= topP) break
    }
    
    // 重新归一化并采样
    val filteredProbs = nucleus.map { probs[it] }
    val sum = filteredProbs.sum()
    var rand = Random.nextFloat() * sum
    for ((i, p) in filteredProbs.withIndex()) {
        rand -= p
        if (rand <= 0) return nucleus[i]
    }
    return nucleus.last()
}
```

两者的核心区别：K 是固定窗口，P 是动态阈值。概率分布高度集中时，Top-P 的候选池可能只有 2-3 个 token，而 Top-K 仍然给 40 个，多出来的都是噪声。

## 端侧调参实践

在 Gemma 2B 和 Phi-2 上反复调测后，我整理了一组参考配置：

| 场景 | Top-K | Top-P | Temperature | 说明 |
|------|-------|-------|-------------|------|
| 翻译/摘要 | 20-30 | 0.85 | 0.7 | 偏确定性，减少幻觉 |
| 对话/问答 | 40-50 | 0.9 | 0.8 | 平衡流畅度与多样性 |
| 创意写作 | 60-80 | 0.95 | 1.0 | 高多样性，允许跳跃 |

几点经验：

Temperature 和 Top-P 不要同时调大。Temp=1.2 且 Top-P=0.95 时，模型输出会变得语无伦次。先固定 Top-P，单独调 Temperature，找到可接受范围后再微调 Top-P。

端侧对话场景推荐 Top-K=40, Top-P=0.9, Temp=0.8。这是我在不同模型上反复验证后最稳定的起点配置，都能产出可读的中文文本。如果仍有重复，优先降 Temperature 而非调小 Top-K。

重复惩罚（Repetition Penalty）是端侧必选项。端侧小模型更容易陷入 token 重复，设一个 1.1-1.2 的惩罚因子，对已出现的 token 做概率衰减：

```kotlin
for (tokenId in generatedTokens) {
    probs[tokenId] /= penalty
}
```

## 选型决策

端侧解码策略的选型，本质上是延迟、质量、多样性的三角权衡。

如果产品对延迟极度敏感（如输入法补全），用贪婪搜索，但在业务层加重复检测逻辑做兜底。对话类应用默认用 Top-K + Top-P 联合采样，这是端侧性价比最高的方案。Beam Search 在端侧不是好选择，除非你跑的是 0.5B 以下的超小模型。

解码策略不是设完就忘的参数。同一个模型，中英文的最优 Top-P 值都可能不同——中文 token 粒度更粗、分布更集中，Top-P 可以设低 0.05-0.1。花一个下午调参，回报远超一周的 prompt engineering。
