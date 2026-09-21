---
slug: android-on-device-ai-first-token-latency
translationKey: android-on-device-ai-first-token-latency
title: 深入 Android 端侧 AI 推理的延迟拆解与优化：从用户点击到首 Token 上屏
excerpt: 本文系统拆解了 Android 端侧大模型推理从用户点击到首 Token 上屏的完整链路，涵盖预处理、模型加载、Prefill、Decode 等六个阶段，并提供实测优化方案与性能数据。
publishDate: '2026-07-04'
tags:
- Android
- 端侧AI
- 性能优化
- 大模型推理
- TTFT
seo:
  title: 深入 Android 端侧 AI 推理的延迟拆解与优化：从用户点击到首 Token 上屏
  description: 深入拆解 Android 端侧大模型推理延迟，覆盖预处理到渲染六个阶段，结合骁龙 8 Gen3 实测数据，提供 Prefill 优化、量化、KV Cache 复用等实战方案。
---

做端侧大模型，用户最敏感的指标不是吞吐量，是**首 Token 延迟（TTFT, Time To First Token）**——从点击发送到屏幕上出现第一个字的耗时。超过 2 秒，留存率断崖式下跌。下面把这条链路从头拆到尾，给出每阶段的耗时画像和对应优化手段。

## 全链路阶段划分

一次端侧推理从点击到首 Token 上屏，拆成 6 个阶段：

```
点击 → [1]输入预处理 → [2]模型就绪 → [3]Prefill → [4]首 Token Decode → [5]后处理 → [6]渲染上屏
```

瓶颈类型各不相同：CPU 密集、IO 密集、GPU 调度延迟。不是一类问题不能一把梭，先想清楚当前阶段卡在哪。

## 阶段 1：输入预处理（5~50ms）

这一步包括 tokenizer 将文本转成 token ids、构建 attention mask、拼接 chat template。

```kotlin
// 典型调用链（具体 API 随框架而异，如 HuggingFace Tokenizers 的 Android 绑定、MediaPipe Tasks 的 BertPreprocessor，或 llama.cpp/MLC 等推理框架自带的 tokenizer）
val tokenizer = TokenizerFactory.loadFromAssets(modelPath) // 仅为示意接口，非固定 API
val inputs = tokenizer.encode(chatTemplate.format(userMessage))
// inputs.inputIds → IntArray, inputs.attentionMask → IntArray
```

Tokenizer 本身很快（通常 < 5ms），但有两个坑容易踩。

**坑一：Tokenizer 文件反复加载。** SentencePiece 或 BPE 词表文件动辄几 MB，别每次推理都重新 new Tokenizer。Application 初始化时做一次就够了。

**坑二：长文本的 attention mask 构建。** attention mask 本身的构建是 O(n) 的内存写入，不是 O(n²)。真正拖慢的是多次重分配导致的内存拷贝：prompt 达到某个长度后，若没有预先分配足龟的 Buffer，会触发数组扩容——旧数据拷贝到新内存区域，多次扩容叠加就会交易拖慢。而真正的 O(n²) 复杂度属于后面 attention 计算本身，跟 mask 构建无关。用 `allocateDirect` 预分配 Buffer 池可以绝大部分消除这部分拷贝开销。

MediaTek 9300 上实测，4K prompt 的预处理从 48ms 压到 6ms。

## 阶段 2：模型就绪（10ms~500ms+）

波动最大的阶段，完全取决于加载策略。

**策略 A：懒加载。** 推理时才从磁盘读 `.tflite` 或 `.pte` 模型文件，然后初始化 GPU delegate。首帧必然等 300~500ms。聊天场景里用户体感就是"卡了一下才回复"。

**策略 B：预加载 + 常驻。** App 启动时后台线程把模型加载好，推理直接 forward。耗时压到 10~30ms，代价是模型常驻内存（通常 1~3GB）。

```kotlin
// 预加载策略：Application.onCreate 中异步加载
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CoroutineScope(Dispatchers.IO).launch {
            ModelManager.preload(modelPath, delegate = NNAPI)
        }
    }
}
```

折中方案：**空闲时预加载、内存紧张时卸载**，结合 `onTrimMemory` 回调管理生命周期。聊天类 App 直接走预加载，用户打开就是为了对话，延迟体验权重远高于内存占用。

## 阶段 3：Prefill——延迟大头（200ms~2s+）

Prefill 是模型一次性处理整个 prompt 的过程。计算量随 prompt 长度线性增长，但**实际耗时增长经常超线性**。

Prefill 的耗时公式大致是：

```
T_prefill ≈ (prompt_tokens × model_FLOPs) / (GPU_FLOPS × 利用率)
```

理论上线性，但有因素让它跑偏：

**KV Cache 内存分配。** prompt 变长，KV Cache 线性增大。分配量超过 GPU 可用内存时触发 swap 或重分配，systrace 里能看到 100ms+ 的 `vkAllocateMemory` 事件。

**Attention 计算复杂度。** 标准 self-attention 的计算量随序列长度呈 O(n²) 增长（n = prompt 长度），这是对未优化实现而言的。FlashAttention 类算子主要优化的是**内存访问模式**（避免物理存储 n×n 的完整 attention 矩阵，降低显存占用和 IO），但**计算量本质仍是 O(n²)**，并未改变计算复杂度量级。4K tokens 对应 16M 次 pairwise 计算，8K 对应 64M。

```python
# Prefill 的 attention 计算量
# 标准 self-attention: Q @ K^T → [seq_len, seq_len]
# 4K prompt: 4096² = 16.7M 个元素
# 8K prompt: 8192² = 67.1M 个元素  ← 4 倍
```

优化方向：

**量化。** INT4 权重量化对 prefill 加速最明显——prefill 是计算密集型。和 FP16 比，INT4 prefill 在骁龙 8 Gen3 上实测快 40~60%，代价是模型质量轻微下降。

**Prompt 压缩。** RAG 场景大量上下文塞进去之前，可以用 LLMLingua 等方法在客户端先压缩 prompt，4K 压到 2K，prefill 耗时直接减半。

**KV Cache 复用。** 多轮对话时，前几轮历史 tokens 可以直接复用 KV Cache，prefill 只处理新增部分。这是场景优化不是算子优化，但效果比算子优化更显著。

## 阶段 4：首 Token Decode（50~200ms）

Prefill 完成后模型进入自回归 decode。第一个 token 的 decode 耗时 = 单次 forward pass。此时 KV Cache 刚建立，GPU 管线也还没跑热。

单次 decode 的计算量远小于 prefill（只处理 1 个 token），但 GPU 利用率低，实际延迟并不低。瓶颈在两点：

- **权重读取带宽。** Decode 是 memory-bound 操作。7B 模型 FP16 权重约 14GB，每次 forward 得从显存/共享内存中读完一轮。
- **GPU Core 闲置。** 单 token 喂不饱所有计算单元，但寄存器 spill 和内存访问等待时间照常消耗。

优化集中在提升带宽利用率：

```kotlin
// GPU delegate 选择对 decode 延迟影响大
val options = Interpreter.Options().apply {
    // OpenCL 在 decode 场景下通常比 OpenGL 快 15~25%
    setUseNNAPI(false)  
    // 指定使用 OpenCL delegate
    addDelegate(GpuDelegateFactory.Options().create(OpenCL))
}
```

联发科天玑 9300 上，OpenCL delegate 的首 token decode 比 NNAPI 快约 18%，比 OpenGL 快约 30%。但注意：如果你的 App 主渲染管线用 OpenGL，delegate 之间切换有上下文开销——我踩过的坑，切过去省了 30ms，上下文切换花了 25ms，几乎白干。

## 阶段 5&6：后处理与渲染（5~20ms）

Decode 产出 logits → token id → 文本字符串 → TextView/Compose 渲染上屏。CPU 处理这几步绰绰有余，不是瓶颈。

一个隐蔽问题：**流式输出时的 UI 刷新频率**。每个 token 都触发一次 `setText` 或 Compose recomposition，token 生成速度 20~40ms 一个，UI 线程会被频繁打断。用 debounce 合并刷新：

```kotlin
// Compose 中限制刷新频率
var displayText by remember { mutableStateOf("") }
val debounced = snapshotFlow { rawTokens.joinToString("") }
    .debounce(50)  // 每 50ms 最多刷新一次
    .collectAsState(initial = "")
```

## 端到端性能画像（实测数据）

骁龙 8 Gen3 + 7B INT4 量化模型、2K prompt 场景下，各阶段耗时：

| 阶段 | 耗时 | 占比 | 优化后 |
|------|------|------|--------|
| 预处理 | 8ms | ~1.1% | 6ms |
| 模型就绪 | 18ms | ~2.4% | 15ms |
| Prefill | 620ms | ~83.4% | 280ms |
| 首 Token Decode | 85ms | ~11.4% | 65ms |
| 后处理+渲染 | 12ms | ~1.6% | 10ms |
| **TTFT 合计** | **~743ms** | | **~376ms** |

Prefill 占 83%左右，是绝对大头。优化后的 376ms 主要来自 INT4 量化 + prompt 压缩叠加。

## 实践中的三个关键决策

**TTFT 还是吞吐量？** 端侧聊天场景优先 TTFT。不影响吞吐的手段都上（量化、预加载），需要权衡的（比如 speculative decoding，增加吞吐但可能拖慢首 token 延迟）先放一放。

**Prefill 要不要多线程？** 小模型（< 1B）prefill 用多线程 CPU 推理可以和 GPU 方案五五开。但 7B 模型 prefill 计算量太大，CPU 扛不住，GPU delegate 是唯一选择。别无脑上 CPU。

**Metric 打点粒度。** 每个阶段独立打点，否则定位不了瓶颈。用 `SystemClock.elapsedRealtimeNanos()` 在高频路径上开销可忽略。没有分阶段数据，优化就是玄学。我在项目里打了 6 个点对应 6 个阶段，上线一周定位出 80% 的延迟来自 prefill 阶段的 GPU 内存分配抖动——不打点根本猜不到。
