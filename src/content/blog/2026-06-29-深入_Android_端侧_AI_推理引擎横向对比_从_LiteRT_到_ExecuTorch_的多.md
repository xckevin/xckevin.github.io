---
slug: android-on-device-ai-inference-engine-selection
translationKey: android-on-device-ai-inference-engine-selection
title: 深入 Android 端侧 AI 推理引擎横向对比：从 LiteRT 到 ExecuTorch 的多引擎选型决策框架
excerpt: 横向对比 LiteRT、MediaPipe、ExecuTorch、ONNX Runtime 和 llama.cpp 五大端侧推理引擎，从算子覆盖、硬件加速、性能基准到选型矩阵，提供可落地的决策框架。
publishDate: '2026-06-29'
tags:
- Android
- 端侧AI
- 推理引擎
- 性能优化
- 模型部署
seo:
  title: Android 端侧推理引擎对比：LiteRT 与 ExecuTorch 选型
  description: 横向对比 Android 端侧五大 AI 推理引擎：LiteRT、MediaPipe、ExecuTorch、ONNX Runtime、llama.cpp，从算子覆盖、硬件加速到性能实测，提供四维选型决策框架。
  pageType: article
---

上个月在做端侧多模态模型集成时，团队在引擎选型上僵住了。有人说 LiteRT 最稳，有人坚持 ExecuTorch 是未来，还有人提议干脆上 llama.cpp 跑 LLM。最后我们在同一台设备上把五个引擎全测了一遍，结论比预期复杂得多。

## 五大引擎的架构基因

**LiteRT**（前身 TensorFlow Lite）是 Google 在移动端推理投入最久的产品。核心架构分三层：Converter 负责模型转换与量化，Runtime 提供解释器执行，Delegate 机制将计算卸载到硬件加速器。它的 delegate 体系覆盖了 GPU（OpenGL ES/OpenCL）、NNAPI、XNNPACK 和 Hexagon DSP，关键设计是 **fallback**——算子不被硬件支持时自动回退 CPU，不报错。

**MediaPipe** 严格来说不是与 LiteRT、ExecuTorch 同一层面的推理引擎，而是更高层的任务级处理框架——它基于计算图组织处理节点，底层的实际模型推理邀靠 LiteRT 完成，自己并不实现独立的推理后端。也就是说，MediaPipe 更像是“LiteRT + 预处理/后处理流水线”的封装层，而不是一个独立的引擎实体。它的优势在于开箱即用的任务方案（人脸、手势、姿态），劣势是定制化成本高——自己搭管道的复杂度不低。

**ExecuTorch** 是 Meta 2023 年推出的移动端推理方案，定位是 PyTorch 生态的出口。核心思路是 **ahead-of-time compilation**：导出阶段完成算子选择和内存规划，运行时只做最小化执行。好处是二进制体积可控、启动延迟低，代价是模型必须经过 `torch.export` 导出，动态控制流支持有限。

**ONNX Runtime Mobile** 的核心价值在于格式中立——不管你用什么框架训练，导出 ONNX 就能跑。算子覆盖在五个引擎中最广，但移动端 GPU 加速不如 LiteRT 成熟，主要依赖 XNNPACK 和 NNAPI。

**llama.cpp** 是纯 C/C++ 实现的 LLM 推理框架，社区驱动。不依赖任何框架 API，通过 GGUF 格式加载量化模型。核心优势在 CPU 推理效率：手写 SIMD 指令和内存布局优化，让无 GPU 设备也能跑 7B 模型。Android 集成依赖 JNI 封装，无官方 AAR。

## 算子覆盖：模型能跑起来的前提

选引擎的第一步不是跑分，是确认模型能不能跑。

LiteRT 的算子覆盖偏重 CNN 和 Transformer 基础算子，对 2023 年后新出的注意力变体（GQA、Flash Attention）支持滞后。我遇到过使用 RMSNorm 的模型转换后直接报找不到算子。

ExecuTorch 对 PyTorch 原生算子覆盖更好，算子库按模块组织、可按需链接。但这也意味着你需要明确知道模型用了哪些算子，自定义 attention 变体可能需要自己写 kernel 注册。

ONNX Runtime 的算子集最完整，尤其是 ONNX opset 18+。但 ONNX 转换本身可能引入精度损失，需要额外验证。

llama.cpp 的 GGUF 格式对 LLaMA、Mistral、Qwen 等主流架构支持最好，非标准架构需要自己写转换脚本。

踩过的坑多了，总结出一条实用原则：**用哪个框架训练，优先用哪个框架的推理引擎**，能减少 80% 的兼容性问题。

## 硬件加速：GPU 和 NPU 的真实差距

Android 端硬件加速三条路径：NNAPI（系统级 API）、GPU Delegate（引擎自实现）、厂商 NPU SDK（高通 SNPE、联发科 NeuroPilot）。

NNAPI 兼容性最好但性能上限受系统版本和厂商驱动影响。实测同一模型在 Android 14 和 12 上跑 NNAPI，延迟差 30%。

LiteRT 的 GPU delegate 对 Adreno 和 Mali 的适配最稳定，经过多年打磨。ExecuTorch 的 Vulkan 后端迭代很快，2024 年 Q3 版本改善明显，但低端 Mali GPU 上偶尔出现数值错误。

NPU 是高端设备推理加速的关键，但各引擎支持都不算成熟。LiteRT 通过 Qualcomm QNN delegate 间接支持，ExecuTorch 有高通官方 delegate 但还在 beta。我的建议：**NPU 加速先作为可选优化，不要作为硬性依赖**。

## 性能基准：同一设备上的实测

以下数据来自我在骁龙 8 Gen 3 单台设备上的一次性实测，测试条件（模型量化方式、线程数、系统负载）未做严格对照实验控制，仅供参考量级，不代表各引擎的官方基准，实际数值会因设备、系统版本、模型量化配置差异很大：

| 引擎 | MobileNetV3 (CPU) | MobileNetV3 (GPU) | Gemma 2B (CPU) |
|------|-------------------|-------------------|----------------|
| LiteRT | 约 4ms 量级 | 约 2ms 量级 | 不支持 |
| ExecuTorch | 略高于 LiteRT | 略高于 LiteRT | 秒级/token |
| ONNX Runtime | 与 LiteRT 接近 | 略高于 LiteRT | 不支持 |
| MediaPipe | 与 LiteRT 接近（底层即 LiteRT） | 与 LiteRT 接近 | 不支持 |
| llama.cpp | 不适用 | 不适用 | 秒级/token，略优于 ExecuTorch |

小模型分类任务上，LiteRT 的 GPU 延迟表现较好，MediaPipe 因底层复用 LiteRT，表现相近。已在 TensorFlow 生态的团队不需要换。

LLM 推理上，llama.cpp 在本次实测中略快于 ExecuTorch。可能的原因在于它对 Transformer 解码做了针对性优化——KV cache 的内存布局、attention 的 SIMD 实现，通用引擎不一定做这些优化，但具体差距需要在目标设备和模型量化配置下重新实测确认。

实际项目中还有一个常被忽略的指标：**模型加载时间**。ExecuTorch 的 AOT 编译让加载几乎零延迟，而 LiteRT 首次加载需初始化 delegate，大模型可能花费 200-500ms。频繁切换模型的场景下，这 200ms 是真实的体验问题。

## 四维选型矩阵

选型时直接对着自己的项目判断：

**Google 生态 + 多媒体管线** → MediaPipe。任务恰好是官方支持的人脸、手势、姿态时，集成成本最低。自定义模型则相反，管线配置反而拖慢迭代。

**PyTorch 训练 + 模型架构较新** → ExecuTorch。原生导出无转换环节，但自定义 attention 变体可能需要手写 kernel。

**跨框架、跨平台一致性** → ONNX Runtime。需要同时跑 Android、iOS 和 Web 时，ONNX 是最省心的中间格式。代价是移动端 GPU 加速不如原生方案。

**LLM 推理，追求极致 CPU 性能** → llama.cpp。CPU 推理效率目前没有对手，但需接受社区维护的不确定性。LLaMA 架构模型的集成成本比任何官方方案都低。

**混合场景，灵活切换后端** → LiteRT。delegate 体系最成熟，一个模型可在 CPU/GPU/NNAPI 之间无缝切换，适合需要适配不同硬件的应用。

## 我的选型心得

最终我在项目中采用了**双引擎策略**：常规视觉任务用 LiteRT（成熟稳定），LLM 部分用 llama.cpp（性能最优）。额外带了约 15MB 的二进制体积，但换来了每个场景下的最优性能。

如果只允许选一个引擎，我会选 ExecuTorch。不是单项指标最好，而是团队迭代速度最快，PyTorch 生态的趋势也最明确。ExecuTorch 的算子覆盖和 GPU 稳定性在持续提升，但具体能覆盖多大比例的移动端推理需求，还需要看后续版本的实际进展，这里不做预测性的数字承诺。

没有完美的引擎，只有适合当前场景的引擎。**模型格式、算子覆盖、硬件加速、团队熟悉度**——这四个维度能帮你做出 80% 的正确决策，剩下的 20% 靠实测。
