---
title: Android On-device AI
lang: en
translationKey: android-on-device-ai
seo:
  title: Android On-device AI Engineering
  description: Android on-device AI notes covering Gemini Nano, AICore, NNAPI, LiteRT, MediaPipe, local LLMs, RAG, multimodal inference, and model governance.
---

This topic covers Android on-device AI engineering.

It focuses on how AI capabilities actually land inside Android apps: how models are loaded, how inference is scheduled, how memory and power are controlled, how edge and cloud paths work together, and how Compose screens handle streaming or multimodal output.

This is different from [AI Development Tools](/en/ai-dev-tools/), which is about using AI to write and operate software. This page is about building AI features that run on Android devices.

## Learning Path

1. Start with platform capabilities: AICore, Gemini Nano, ML Kit, NNAPI, LiteRT, and MediaPipe.
2. Benchmark the full pipeline instead of only the model: latency, throughput, NPU/GPU/CPU usage, memory bandwidth, power, and thermal behavior.
3. Design LLM product behavior: prompt budget, context windows, streaming output, local RAG, and conversation state.
4. Productionize the system: model distribution, versioning, concurrency, fallback, security, multimodal input, and privacy boundaries.

## Platform and Capability Entry Points

- [Android AICore and Gemini Nano: system services, model access, and local inference](/blog/2025-05-21-深入_android_aicore_与_gemini_nano_端侧推理全链路_从系统服务架构到_l/)
- [Android ML Kit pipeline: from visual detection to CameraX integration](/blog/2025-08-01-深入_android_ml_kit_全链路实战_从视觉检测_pipeline_到_camerax_集/)
- [Android NNAPI internals: HAL abstraction and Qualcomm/MediaTek NPU paths](/blog/2025-08-07-深入_android_nnapi_全链路_从_hal_硬件抽象到_qualcomm_mtk_npu_/)
- [Android 16 App Functions: semantic indexing and cross-app intelligent actions](/blog/2026-02-17-深入_android_16_app_functions_全链路_从语义索引构建到跨应用智能操作的_a/)

## Performance and Resource Control

- [Android on-device AI benchmark design: latency, throughput, power, and thermal degradation](/blog/2026-04-17-深入_android_端侧_ai_推理_benchmark_评测体系_从延迟_吞吐_功耗三维度量到热/)
- [Profiling NPU scheduling and memory bandwidth with Perfetto](/blog/2025-11-17-深入_android_端侧_ai_推理性能剖析_用_perfetto_追踪_npu_调度与内存带宽瓶/)
- [Memory-bandwidth optimization: from GPU shared memory to NPU zero-copy paths](/blog/2025-11-20-深入_android_端侧_ai_推理的内存带宽优化_从_gpu_共享内存到_npu_零拷贝的异构数/)
- [Power and thermal management for on-device inference](/blog/2025-11-21-深入_android_端侧_ai_推理的功耗与热管理全链路_从_soc_dvfs_调度到_therm/)
- [Dynamic inference policy based on temperature, battery, and memory pressure](/blog/2026-04-27-深入_android_端侧_ai_推理与系统健康度的协同优化_基于设备温度_电量和内存压力的动态推理/)
- [Memory management for local AI: model-load peaks and KV cache recycling](/blog/2026-05-04-深入_android_端侧_ai_推理的内存管理策略_从模型加载的内存峰值优化到_kv_cache_/)

## LLM, RAG, and UI Integration

- [Streaming local LLM output: from token generation to incremental Compose rendering](/blog/2025-12-16-深入_android_端侧_llm_推理的流式输出全链路_从_token_生成到_compose_u/)
- [Context-window engineering: prompt compression and conversation state machines](/blog/2025-12-17-深入_android_端侧_llm_的上下文窗口工程_从_prompt_压缩到对话状态机的全链路实践/)
- [Local RAG on Android: from vector databases to knowledge-augmented inference](/blog/2025-12-18-深入_android_端侧_rag_检索增强生成实战_从本地向量数据库到_llm_推理的知识增强全链/)
- [Prompt engineering for on-device inference: token budgets and few-shot templates](/blog/2026-04-28-深入_android_端侧_ai_推理的_prompt_工程实战_从_token_预算控制到少样本模/)
- [Compose UI architecture for local AI chat: streaming rendering and multi-turn state](/blog/2026-02-10-android_端侧_ai_聊天的_compose_ui_架构_流式渲染与多轮对话的声明式工程实践/)

## Production Governance

- [Hybrid edge-cloud AI inference: model routing and offline fallback](/blog/2025-11-13-深入_android_端云协同_ai_推理架构_从模型路由策略到离线降级的混合智能调度全链路/)
- [Dynamic model delivery and version management on Android](/blog/2025-12-08-深入_android_端侧_ai_模型动态下发与版本管理全链路_从_app_bundle_条件分发到/)
- [Concurrent inference scheduling: singleton engines, priority queues, and backpressure](/blog/2026-05-07-深入_android_端侧_ai_推理的并发调度与流控架构_从单例引擎到多请求优先级队列的背压治理/)
- [Model security: encrypted storage, TEE inference, and IP protection](/blog/2026-05-08-深入_android_端侧_ai_模型安全防护全链路_从模型加密存储到_tee_推理的_ip_保护架/)
- [Realtime video-stream inference: from CameraX frame callbacks to GPU processing](/blog/2026-05-06-深入_android_端侧_ai_推理的实时视频流处理全链路_从_camerax_帧回调到_gpu_/)
- [Multimodal local AI: Gemini Nano multimodality and real-time Compose interaction](/blog/2026-05-11-深入_android_端侧多模态_ai_推理全链路_从_gemini_nano_multimodal/)

## Next Step

For resource pressure, frame stability, and tracing methods, continue with [Android Performance](/en/android-performance/). For streaming and chat UI, continue with [Jetpack Compose](/en/jetpack-compose/). For release gates and model governance, continue with [Mobile Engineering](/en/android-engineering/).
