---
title: Gemini Nano on Android
lang: en
translationKey: android-gemini-nano-ai
seo:
  title: Gemini Nano and AICore on Android
  description: Notes about Gemini Nano, AICore, Android on-device AI APIs, local inference constraints, privacy, latency, and product integration.
---

This topic focuses on Gemini Nano and AICore on Android.

Android AI engineering is moving from "what is Gemini Nano?" to "how do we ship on-device generative AI inside a real app?" This page organizes notes around Gemini Nano, AICore, ML Kit GenAI APIs, Android on-device AI, local LLM inference, RAG, and multimodal interaction.

## First Decide Whether On-device AI Fits

On-device AI is strongest when latency, offline use, privacy, and predictable inference cost matter. Good candidates include summarization, rewriting, image description, speech recognition, smart input, local content retrieval, and small RAG workflows.

It is not a good fit for simply copying every cloud LLM capability onto a phone. Long-context reasoning, complex multi-step planning, and large-scale knowledge retrieval still often need cloud assistance or a hybrid route.

## Technical Entry Points

1. AICore: a system-level service for model access, updates, security, and hardware acceleration.
2. Gemini Nano: the Gemini model family designed for local, low-latency, privacy-first tasks.
3. ML Kit GenAI APIs: higher-level capability APIs that abstract part of the model-version complexity.
4. AI Edge, LiteRT, and MediaPipe LLM: better suited for custom local inference pipelines.
5. Compose UI: useful for streaming output, multi-turn conversations, multimodal input, and state feedback.

## Core Reading

- [Android On-device AI engineering notes](/en/android-on-device-ai/)
- [Android AICore and Gemini Nano: the full on-device inference path](/blog/2025-05-21-深入_android_aicore_与_gemini_nano_端侧推理全链路_从系统服务架构到_l/)
- [Android local LLM inference: from LiteRT to MediaPipe LLM Inference](/blog/2026-04-17-android_端侧大模型推理全链路_从_litert_到_mediapipe_llm_infere/)
- [Streaming local LLM output: from token generation to incremental Compose rendering](/blog/2025-12-16-深入_android_端侧_llm_推理的流式输出全链路_从_token_生成到_compose_u/)
- [Local RAG on Android: retrieval-augmented generation with a local vector database](/blog/2025-12-18-深入_android_端侧_rag_检索增强生成实战_从本地向量数据库到_llm_推理的知识增强全链/)
- [Multimodal local AI: Gemini Nano multimodality and real-time Compose interaction](/blog/2026-05-11-深入_android_端侧多模态_ai_推理全链路_从_gemini_nano_multimodal/)

## Performance and Production Concerns

- [On-device AI benchmark design: latency, throughput, power, and thermal degradation](/blog/2026-04-17-深入_android_端侧_ai_推理_benchmark_评测体系_从延迟_吞吐_功耗三维度量到热/)
- [Using Perfetto to trace NPU scheduling and memory-bandwidth bottlenecks](/blog/2025-11-17-深入_android_端侧_ai_推理性能剖析_用_perfetto_追踪_npu_调度与内存带宽瓶/)
- [Memory management for local AI: model-load peaks and KV cache recycling](/blog/2026-05-04-深入_android_端侧_ai_推理的内存管理策略_从模型加载的内存峰值优化到_kv_cache_/)
- [Concurrent inference scheduling: priority queues and backpressure control](/blog/2026-05-07-深入_android_端侧_ai_推理的并发调度与流控架构_从单例引擎到多请求优先级队列的背压治理/)
- [Model security: encrypted storage, TEE inference, and IP protection](/blog/2026-05-08-深入_android_端侧_ai_模型安全防护全链路_从模型加密存储到_tee_推理的_ip_保护架/)

## Official References

- [Gemini Nano on Android](https://developer.android.com/ai/gemini-nano)
- [ML Kit GenAI APIs](https://developers.google.com/ml-kit/genai)
- [AI on Android](https://developer.android.com/ai)

## Related Topics

- [Compose-first Migration](/en/compose-first-migration/): local AI chat, streaming output, and multimodal interaction usually need a solid Compose UI architecture.
- [Android Performance](/en/android-performance/): local models expose memory, temperature, power, and frame-rate problems quickly.
