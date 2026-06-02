---
title: "Android 端侧 AI 专题"
seo:
  title: "Android 端侧 AI：Gemini Nano、AICore、NNAPI、LLM、RAG 与多模态推理"
  description: "系统整理 Android 端侧 AI 工程实践，覆盖 Gemini Nano、AICore、NNAPI、ML Kit、端侧 LLM、RAG、多模态推理、模型管理、性能评测、功耗热管理和模型安全。"
---

这个专题关注 AI 能力如何真正落到 Android 设备上：模型如何加载、推理如何调度、功耗和内存如何控制、端云如何协同，以及 Compose UI 如何承接流式输出和多模态交互。

它和 [AI 开发工具](/ai-dev-tools/) 的区别是：AI 开发工具关注研发流程提效，端侧 AI 关注 Android 应用里的 AI 推理、系统能力和工程落地。

## 学习路径

1. 先理解 Android AI 生态入口：AICore、Gemini Nano、ML Kit、NNAPI。
2. 再看推理性能：Benchmark、NPU 调度、内存带宽、功耗热管理。
3. 接着处理 LLM 工程：Prompt、上下文窗口、流式输出、RAG。
4. 最后补齐生产化能力：模型下发、并发调度、动态降级、模型安全和多模态交互。

## 平台与能力入口

- [深入 Android AICore 与 Gemini Nano 端侧推理全链路：从系统服务架构到 LoRA 微调适配的 Google AI 生态工程实践](/blog/2025-05-21-深入_android_aicore_与_gemini_nano_端侧推理全链路_从系统服务架构到_l/)
- [深入 Android ML Kit 全链路实战：从视觉检测 Pipeline 到 CameraX 集成的端侧智能工程落地](/blog/2025-08-01-深入_android_ml_kit_全链路实战_从视觉检测_pipeline_到_camerax_集/)
- [深入 Android NNAPI 全链路：从 HAL 硬件抽象到 Qualcomm/MTK NPU 厂商驱动的端侧 AI 推理加速架构](/blog/2025-08-07-深入_android_nnapi_全链路_从_hal_硬件抽象到_qualcomm_mtk_npu_/)
- [Android 16 App Functions 深度解析：从语义索引到意图路由的端侧 AI 实践](/blog/2026-02-17-深入_android_16_app_functions_全链路_从语义索引构建到跨应用智能操作的_a/)

## 推理性能与系统资源

- [深入 Android 端侧 AI 推理 Benchmark 评测体系：从延迟/吞吐/功耗三维度量到热影响下的性能退化分析](/blog/2026-04-17-深入_android_端侧_ai_推理_benchmark_评测体系_从延迟_吞吐_功耗三维度量到热/)
- [深入 Android 端侧 AI 推理性能剖析：用 Perfetto 追踪 NPU 调度与内存带宽瓶颈](/blog/2025-11-17-深入_android_端侧_ai_推理性能剖析_用_perfetto_追踪_npu_调度与内存带宽瓶/)
- [深入 Android 端侧 AI 推理的内存带宽优化：从 GPU 共享内存到 NPU 零拷贝的异构数据传输架构](/blog/2025-11-20-深入_android_端侧_ai_推理的内存带宽优化_从_gpu_共享内存到_npu_零拷贝的异构数/)
- [深入 Android 端侧 AI 推理的功耗与热管理全链路：从 SoC DVFS 调度到 Thermal Throttling 的性能稳定性工程实践](/blog/2025-11-21-深入_android_端侧_ai_推理的功耗与热管理全链路_从_soc_dvfs_调度到_therm/)
- [端侧 AI 推理稳不住？温度、电量、内存三维协同降级策略](/blog/2026-04-27-深入_android_端侧_ai_推理与系统健康度的协同优化_基于设备温度_电量和内存压力的动态推理/)
- [深入 Android 端侧 AI 推理的内存管理策略：从模型加载的内存峰值优化到 KV Cache 的动态回收机制](/blog/2026-05-04-深入_android_端侧_ai_推理的内存管理策略_从模型加载的内存峰值优化到_kv_cache_/)

## LLM、RAG 与交互架构

- [深入 Android 端侧 LLM 推理的流式输出全链路：从 Token 生成到 Compose UI 增量渲染的实时交互架构](/blog/2025-12-16-深入_android_端侧_llm_推理的流式输出全链路_从_token_生成到_compose_u/)
- [深入 Android 端侧 LLM 的上下文窗口工程：从 Prompt 压缩到对话状态机的全链路实践](/blog/2025-12-17-深入_android_端侧_llm_的上下文窗口工程_从_prompt_压缩到对话状态机的全链路实践/)
- [深入 Android 端侧 RAG 检索增强生成实战：从本地向量数据库到 LLM 推理的知识增强全链路](/blog/2025-12-18-深入_android_端侧_rag_检索增强生成实战_从本地向量数据库到_llm_推理的知识增强全链/)
- [深入 Android 端侧 AI 推理的 Prompt 工程实战](/blog/2026-04-28-深入_android_端侧_ai_推理的_prompt_工程实战_从_token_预算控制到少样本模/)
- [Android 端侧 AI 聊天的 Compose UI 架构：流式渲染与多轮对话的声明式工程实践](/blog/2026-02-10-android_端侧_ai_聊天的_compose_ui_架构_流式渲染与多轮对话的声明式工程实践/)

## 生产化治理

- [深入 Android 端云协同 AI 推理架构：从模型路由策略到离线降级的混合智能调度全链路](/blog/2025-11-13-深入_android_端云协同_ai_推理架构_从模型路由策略到离线降级的混合智能调度全链路/)
- [深入 Android 端侧 AI 模型动态下发与版本管理全链路](/blog/2025-12-08-深入_android_端侧_ai_模型动态下发与版本管理全链路_从_app_bundle_条件分发到/)
- [端侧大模型推理调度层设计：优先级队列与背压控制实战](/blog/2026-05-07-深入_android_端侧_ai_推理的并发调度与流控架构_从单例引擎到多请求优先级队列的背压治理/)
- [深入 Android 端侧 AI 模型安全防护全链路：从模型加密存储到 TEE 推理的 IP 保护架构](/blog/2026-05-08-深入_android_端侧_ai_模型安全防护全链路_从模型加密存储到_tee_推理的_ip_保护架/)
- [深入 Android 端侧 AI 推理的实时视频流处理全链路](/blog/2026-05-06-深入_android_端侧_ai_推理的实时视频流处理全链路_从_camerax_帧回调到_gpu_/)
- [深入 Android 端侧多模态 AI 推理全链路：从 Gemini Nano Multimodality 到 Compose 实时交互的工程实践](/blog/2026-05-11-深入_android_端侧多模态_ai_推理全链路_从_gemini_nano_multimodal/)

## 下一步

端侧 AI 的瓶颈经常落在性能、Compose UI 和工程化治理上。建议继续阅读 [Android 性能优化](/android-performance/)、[Jetpack Compose 深度解析](/jetpack-compose/) 和 [移动端工程化](/android-engineering/)。
