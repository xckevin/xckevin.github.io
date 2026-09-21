---
title: 'Android Gemini Nano 与端侧 AI'
seo:
  title: 'Android Gemini Nano 与端侧 AI：AICore、ML Kit GenAI、LLM 推理与多模态'
  description: '整理 Android Gemini Nano、AICore、ML Kit GenAI APIs、端侧 LLM、RAG、多模态推理、性能评测、功耗热管理和模型安全文章。'
---

Android AI 的工程关注点正在从“什么是 Gemini Nano”转向“怎样在 App 里落地端侧生成式 AI”。这个页面围绕 Gemini Nano、AICore、ML Kit GenAI APIs、Android on-device AI、端侧 LLM 和多模态推理相关问题整理阅读路径。

## 先判断是否适合端侧 AI

端侧 AI 适合低延迟、弱网/离线、隐私敏感、推理成本可控的场景，例如摘要、改写、图片描述、语音识别、智能输入、本地内容检索和小型 RAG。它不适合把所有云端大模型能力硬搬到手机上，尤其是长上下文、复杂推理和大规模知识检索。

## 技术入口

1. AICore：系统级服务，负责模型访问、更新、安全和硬件加速。
2. Gemini Nano：面向端侧任务的 Gemini 模型族，适合低延迟和隐私优先的体验。
3. ML Kit GenAI APIs：更高层的能力入口，屏蔽部分模型版本差异。
4. AI Edge / LiteRT / MediaPipe LLM：适合更自定义的端侧模型推理链路。
5. Compose UI：处理流式输出、多轮对话、多模态输入和状态反馈。

## 核心阅读

- [Android 端侧 AI 专题](/android-on-device-ai/)
- [深入 Android AICore 与 Gemini Nano 端侧推理全链路](/blog/android-aicore-gemini-nano/)
- [Android 端侧大模型推理全链路：从 LiteRT 到 MediaPipe LLM Inference](/blog/android-local-llm-litert-mediapipe/)
- [Android 端侧 LLM 推理的流式输出：从 Token 生成到 Compose UI 增量渲染](/blog/android-on-device-llm-streaming-output/)
- [Android 端侧 RAG 检索增强生成实战](/blog/android-on-device-rag-vector-database/)
- [Android 端侧多模态 AI 推理：Gemini Nano Multimodality 与 Compose 实时交互](/blog/android-multimodal-on-device-ai/)

## 性能与生产化

- [端侧 AI 推理 Benchmark：延迟、吞吐、功耗与热退化](/blog/android-on-device-ai-benchmark/)
- [用 Perfetto 追踪 NPU 调度与内存带宽瓶颈](/blog/android-on-device-ai-perfetto-npu-profiling/)
- [端侧 AI 推理的内存管理：模型加载峰值与 KV Cache 回收](/blog/android-on-device-ai-memory-kv-cache/)
- [端侧 AI 推理的并发调度与流控：优先级队列和背压治理](/blog/android-on-device-ai-concurrency-backpressure/)
- [端侧 AI 模型安全：加密存储、TEE 推理与 IP 保护](/blog/android-on-device-ai-model-security-tee/)

## 官方参考

- [Gemini Nano | Android Developers](https://developer.android.com/ai/gemini-nano)
- [ML Kit GenAI APIs](https://developers.google.com/ml-kit/genai)
- [AI on Android](https://developer.android.com/ai)

## 相关专题

- [Jetpack Compose 迁移与性能优化](/compose-first-migration/)：端侧 AI 聊天、流式输出和多模态交互通常需要 Compose UI 配合。
- [Android 性能优化](/android-performance/)：端侧模型的内存、温度、功耗和帧率问题都需要系统性能方法论。
