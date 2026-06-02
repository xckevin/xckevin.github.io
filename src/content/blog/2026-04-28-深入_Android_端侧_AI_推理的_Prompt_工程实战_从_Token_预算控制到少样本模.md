---
title: 深入 Android 端侧 AI 推理的 Prompt 工程实战
excerpt: 在 Android 端侧部署 LLM 时，通过 Token 预算管理、少样本模板压缩与动态预算切换，将首 Token 延迟从 8.7 秒优化至 2 秒内，兼顾摘要质量。
publishDate: '2026-04-28'
tags:
- Android
- Prompt工程
- 端侧AI
- 性能优化
- LLM推理
seo:
  title: 深入 Android 端侧 AI 推理的 Prompt 工程实战
  description: Android 端侧 LLM 推理中，Token 预算管理、少样本模板压缩和动态预算切换等 Prompt 工程优化策略，将首 Token 延迟从 8.7 秒降至 2 秒以内。
---

在做端侧文档摘要功能时，同一份 3000 字的合同文本，在云端 API 上 1.2 秒返回结果，迁移到 Android 端侧 MediaPipe LLM Inference 后，首 Token 延迟飙到了 8.7 秒。用户盯着空白屏幕的每一秒都在流失。

翻遍官方文档，性能优化建议无非是「换小模型」或「降低精度」。但业务方要求摘要质量不能下降——在这个硬约束下，优化空间就落到了 Prompt 本身。

## 端侧推理的两个硬约束

端侧 LLM 推理和云端有本质区别。首 Token 延迟（Time to First Token，TTFT）与 Prompt 长度线性相关。问题出在 Prefill 阶段：模型一次性处理全部输入 Token，计算出完整的 KV Cache 之后，才能生成第一个输出 Token。

以 Gemma 2B 在 Pixel 8 上的实测数据为例：

| Prompt Token | TTFT | 吞吐量 |
|:---:|:---:|:---:|
| 64 | 380 ms | 18.2 tok/s |
| 256 | 1200 ms | 16.8 tok/s |
| 1024 | 4200 ms | 14.3 tok/s |
| 2048 | 8900 ms | 11.1 tok/s |

2048 Token 对比 64 Token，TTFT 差了 23 倍。这还不是最要命的——端侧的可用上下文窗口本就紧张，Gemma 2B 在 MediaPipe 框架下实际可用约 4096 Token，输入和输出共享这份配额。

第二个约束是内存带宽。模型权重约 2-4 GB，Prefill 阶段产生的 KV Cache 随输入长度线性膨胀。踩过的坑是：用 4096 Token 的 Prompt 推理，KV Cache 能吃掉 200MB+，低端设备直接 OOM，连报错日志都来不及写。

## Token 预算的拆分策略

我把 Token 当作有限预算来管理：先定义各组件的 Token 上限，再在限额内设计内容。

```python
# Token 预算分配（以 512 Token 上限为例）
TOKEN_BUDGET = 512

BUDGET = {
    "system_prompt": 80,      # 角色 + 输出格式
    "few_shot": 180,          # 2-3 个精简样本
    "task_instruction": 40,   # 核心任务
    "input_content": 200,     # 用户输入
    "reserve": 12,            # 缓冲
}
```

这套体系的逻辑是倒逼 Prompt 变紧凑，而不是接受「质量换延迟」的妥协。

```python
# 冗长版 System Prompt（~80 Token）
"""你是一个专业的技术文档分析助手。
请仔细阅读用户提供的技术文档，提取其中的关键信息。
输出时请使用 JSON 格式，包含以下字段：
summary, keywords, difficulty_level。
请确保 JSON 格式正确且可解析。"""

# 精简约版（~35 Token）
"""提取技术文档关键信息。输出纯 JSON，格式如下：
{"summary":"...","keywords":[],"difficulty_level":"basic|intermediate|advanced"}
只输出 JSON，不要额外文字。"""
```

用格式约束替代行为描述。不要说「确保 JSON 格式正确」，直接给出 Schema；不要说「请仔细阅读」，用输出字段反推模型的注意力分配。精简后效果没有可感知的差别。

## 少样本模板的压缩

Few-shot 是端侧场景下 Token 消耗的大头。传统做法放 3-5 个完整「输入-输出」对，但在端侧预算下，每个样本的输入部分是冗余重灾区——大段原文塞进 Prompt 里，对模型理解帮助有限，对延迟的拖累却立竿见影。

我的做法是模板化压缩：把样本中的常量提取到 System Prompt，样本体内只保留变量。以文档摘要为例——

压缩前（>100 Token/样本）：

```
示例 1:
输入: {一篇 800 字的技术合同全文...}
输出: {"summary": "本合同约定了甲方与乙方的软件开发合作事项，
包括项目范围、交付时间、付款方式等核心条款...",
"keywords": ["软件开发", "合同", "付款"], "difficulty_level": "intermediate"}
```

压缩后（~30 Token/样本）：

```
示例 1:
输入: [合同文本]
输出: {"summary":"软件开发项目合同,涵盖范围/交付/付款条款",
"keywords":["合同","开发","付款"],"difficulty_level":"intermediate"}
```

三个手段叠加：

1. 输入占位：用 `[合同文本]` 替代真实输入，削减 90% Token
2. 输出精简：关键词优先、去谓词，摘要 50 字压到 20 字
3. 样本筛选：只保留表现最极端的 2 个样本（一正一反），砍掉中间样本

实测：3 样本从 320 Token 压缩到 95 Token，TTFT 从 2.1 秒降到 0.9 秒，ROUGE-L 评分仅下降 1.2%。这个损失业务方完全接受。

## 运行时动态预算

固定预算的问题是：简单输入和复杂输入用同一套 Prompt，简单场景的延迟空间白白浪费了。

我的方案是两级预算切换：

```python
def select_budget(input_len: int) -> dict:
    if input_len < 200:
        return {"few_shot": 60, "system": 40}
    elif input_len < 800:
        return {"few_shot": 120, "system": 60}
    else:
        return {"few_shot": 150, "system": 80}
```

实现很简单：构建 Prompt 前先对输入做 tokenize（复用 MediaPipe 的 `BertTokenizer`），根据 Token 数选预算档位。

另一个需要动态判断的是任务难度。「提取关键词」这类任务，去掉 Few-shot 直接用 Zero-shot + 格式约束，Token 从 180 降到 60，延迟减少 40% 且准确率无明显下降。但「合同条款合规性判断」这类推理型任务，砍掉样本会导致误判率明显上升。判断标准很简单：输出是否有明确的对错分界，而非开放性生成。

## 延迟与质量的工程权衡

把这些策略落成可操作的决策框架：

- **TTFT 红线**：首 Token 延迟超过 3 秒，优先砍 Few-shot 样本而非 System Prompt。后者承担了格式约束——砍掉后模型容易产出不可解析的 JSON，影响的不只是质量，是功能可用性
- **质量兜底**：Zero-shot 不达标时，先加 1 个最简样本（只保留输出结构和关键判断逻辑），再考虑加第二个。边际增益递减非常明显——第 3 个样本带来的提升往往不到第 1 个的十分之一
- **输出 Token 也要预算**：`max_output_tokens` 设 256 而非默认的 1024。端侧生成速度 10-15 tok/s，1024 Token 意味着 60 秒以上等待。设一个小而合理的上限，反而倒逼 Prompt 让模型用更密集的信息量输出

在 Gemma 2B + MediaPipe + Pixel 7 这套组合上积累的经验数字：Prompt 控制在 400 Token 以内，TTFT 稳定在 2 秒以内；500-800 Token 需加载动画兜底；超过 1000 Token 直接走云端 Fallback，不要在端侧硬撑。

这些数字会随硬件迭代变化，但预算优先的思路不会变：把每次 Prompt 设计当作资源分配问题，而非语言表达问题。端侧 AI 的竞争力不在模型能力，在约束条件下的工程取舍。精简 Prompt 省下的不只是 Token——是用户盯着空白屏幕的那几秒。
