---
title: Ollama 在 Apple Silicon 上全面转向 MLX 驱动（预览版）
excerpt: Ollama 0.19 预览版基于 Apple MLX 框架重构，在 Apple Silicon 上实现了大幅性能提升，同时引入 NVFP4 量化格式和智能缓存优化，让本地大模型推理更快更高效。
publishDate: 2026-04-02
tags:
  - Ollama
  - MLX
  - Apple Silicon
  - LLM
  - 本地推理
seo:
  title: Ollama 在 Apple Silicon 上全面转向 MLX 驱动（预览版）
  description: Ollama 0.19 预览版基于 Apple MLX 框架重构，在 Apple Silicon 上大幅提升推理性能，支持 NVFP4 量化和智能缓存，加速编程智能体和个人助手体验。
---



> **总结**：随着本地大模型应用场景日益丰富，推理性能成为 macOS 用户的核心痛点。Ollama 0.19 预览版基于 Apple 的机器学习框架 MLX 进行了底层重构，充分利用统一内存架构（Unified Memory Architecture），在 M5 系列芯片上实现了预填充速度 1810 tokens/s、生成速度 112 tokens/s 的显著提升。同时引入 NVFP4 量化格式和智能缓存机制，进一步优化了编程智能体和个人助手的使用体验。对于使用 Mac 进行本地模型推理的开发者而言，这是一次质的飞跃。

![Ollama 在 Apple Silicon 上展示高性能推理的示意图](../../assets/ollama-在-apple-silicon-上全面转向-mlx-驱动-1.png)

今天，我们发布了在 Apple Silicon 上运行 Ollama 最快方式的预览版——由 Apple 的机器学习框架 MLX 驱动。

这释放了全新的性能潜力，**加速你在 macOS 上最严苛的工作场景：**

- 个人助手，如 OpenClaw
- 编程智能体（Coding Agent），如 Claude Code、OpenCode 或 Codex

### Apple Silicon 上的极致性能，由 MLX 驱动

Apple Silicon 上的 Ollama 现已构建在 Apple 的机器学习框架 MLX 之上，充分利用其统一内存架构（Unified Memory Architecture）。

这使得 Ollama 在所有 Apple Silicon 设备上都获得了大幅加速。在 Apple 的 M5、M5 Pro 和 M5 Max 芯片上，Ollama 利用了全新的 GPU 神经加速器（GPU Neural Accelerators），同时加速首 token 生成时间（TTFT）和生成速度（tokens/s）。

**预填充（Prefill）性能：**

| 版本 | tokens/s |
|------|----------|
| Ollama 0.19 | **1810** |
| Ollama 0.18 | 1154 |

**解码（Decode）性能：**

| 版本 | tokens/s |
|------|----------|
| Ollama 0.19 | **112** |
| Ollama 0.18 | 58 |

测试于 2026 年 3 月 29 日进行，使用阿里巴巴的 Qwen3.5-35B-A3B 模型以 NVFP4 量化，对比 Ollama 0.18 使用 Q4_K_M 量化的旧实现。Ollama 0.19 在使用 int4 量化时还将获得更高性能（预填充 1851 tokens/s，解码 134 tokens/s）。

### NVFP4 支持：更高质量的响应与生产环境一致性

Ollama 现在采用 NVIDIA 的 [NVFP4](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/) 格式，在保持模型精度的同时降低推理工作负载的内存带宽和存储需求。

随着越来越多的推理服务商采用 NVFP4 格式扩展推理能力，Ollama 用户可以获得与生产环境一致的推理结果。

此外，Ollama 还支持运行经 NVIDIA [Model Optimizer](https://github.com/NVIDIA/Model-Optimizer) 优化的模型。未来将根据 Ollama 的研究和硬件合作伙伴的设计意图与使用场景，提供更多精度格式的支持。

### 改进的缓存机制，响应更灵敏

Ollama 的缓存系统已全面升级，使编程和智能体（Agentic）任务更加高效。

- **更低的内存占用：** Ollama 现在会跨会话复用缓存，这意味着更少的内存占用，同时在使用 Claude Code 等工具共享系统提示词时能获得更多缓存命中。
- **智能检查点：** Ollama 会在提示词的关键位置存储缓存快照，从而减少提示词处理量，加快响应速度。
- **更智能的淘汰策略：** 即使旧的分支被丢弃，共享前缀也能存活更长时间。

### 快速上手

[下载 Ollama 0.19](https://ollama.com/download)

本预览版加速了全新的 [Qwen3.5-35B-A3B](https://ollama.com/library/qwen3.5) 模型，采样参数已针对编程任务进行调优。

请确保你的 Mac 拥有 32GB 以上的统一内存。

**Claude Code：**

```bash
ollama launch claude --model qwen3.5:35b-a3b-coding-nvfp4
```

**OpenClaw：**

```bash
ollama launch openclaw --model qwen3.5:35b-a3b-coding-nvfp4
```

**直接与模型对话：**

```bash
ollama run qwen3.5:35b-a3b-coding-nvfp4
```

### 未来模型支持

我们正在积极推进对更多模型的支持。对于在已支持架构上微调的自定义模型，我们将推出更便捷的导入方式。与此同时，我们也会持续扩展支持的模型架构列表。

### 致谢

感谢：

- MLX 贡献者团队，构建了出色的加速框架
- NVIDIA 的贡献者们，在 NVFP4 量化、NVFP4 模型优化器、MLX CUDA 支持、Ollama 优化和测试方面的工作
- GGML 和 llama.cpp 团队，构建了蓬勃发展的本地推理框架和社区
- 阿里巴巴 Qwen 团队，开源了优秀的模型并给予了大力协作

---

> 本文翻译自：[Ollama is now powered by MLX on Apple Silicon in preview](https://ollama.com/blog/mlx)
