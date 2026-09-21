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

- [Android AICore and Gemini Nano: system services, model access, and local inference](/blog/android-aicore-gemini-nano/)
- [Android ML Kit pipeline: from visual detection to CameraX integration](/blog/android-ml-kit-vision-camerax/)
- [Android NNAPI internals: HAL abstraction and Qualcomm/MediaTek NPU paths](/blog/android-nnapi-hal-npu/)
- [Android 16 App Functions: semantic indexing and cross-app intelligent actions](/blog/android-16-app-functions-semantic-index/)

## Performance and Resource Control

- [Android on-device AI benchmark design: latency, throughput, power, and thermal degradation](/blog/android-on-device-ai-benchmark/)
- [Profiling NPU scheduling and memory bandwidth with Perfetto](/blog/android-on-device-ai-perfetto-npu-profiling/)
- [Memory-bandwidth optimization: from GPU shared memory to NPU zero-copy paths](/blog/android-on-device-ai-memory-bandwidth/)
- [Power and thermal management for on-device inference](/blog/android-on-device-ai-power-thermal-management/)
- [Dynamic inference policy based on temperature, battery, and memory pressure](/blog/android-on-device-ai-system-health/)
- [Memory management for local AI: model-load peaks and KV cache recycling](/blog/android-on-device-ai-memory-kv-cache/)

## LLM, RAG, and UI Integration

- [Streaming local LLM output: from token generation to incremental Compose rendering](/blog/android-on-device-llm-streaming-output/)
- [Context-window engineering: prompt compression and conversation state machines](/blog/android-on-device-llm-context-window/)
- [Local RAG on Android: from vector databases to knowledge-augmented inference](/blog/android-on-device-rag-vector-database/)
- [Prompt engineering for on-device inference: token budgets and few-shot templates](/blog/android-on-device-ai-prompt-engineering/)
- [Compose UI architecture for local AI chat: streaming rendering and multi-turn state](/blog/android-on-device-ai-chat-compose-ui/)

## Production Governance

- [Hybrid edge-cloud AI inference: model routing and offline fallback](/blog/android-hybrid-ai-routing-offline-fallback/)
- [Dynamic model delivery and version management on Android](/blog/android-on-device-ai-model-delivery-versioning/)
- [Concurrent inference scheduling: singleton engines, priority queues, and backpressure](/blog/android-on-device-ai-concurrency-backpressure/)
- [Model security: encrypted storage, TEE inference, and IP protection](/blog/android-on-device-ai-model-security-tee/)
- [Realtime video-stream inference: from CameraX frame callbacks to GPU processing](/blog/android-on-device-ai-realtime-video/)
- [Multimodal local AI: Gemini Nano multimodality and real-time Compose interaction](/blog/android-multimodal-on-device-ai/)

## Next Step

For resource pressure, frame stability, and tracing methods, continue with [Android Performance](/en/android-performance/). For streaming and chat UI, continue with [Jetpack Compose](/en/jetpack-compose/). For release gates and model governance, continue with [Mobile Engineering](/en/android-engineering/).
