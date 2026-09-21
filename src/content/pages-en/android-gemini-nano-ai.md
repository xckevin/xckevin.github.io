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
- [Android AICore and Gemini Nano: the full on-device inference path](/blog/android-aicore-gemini-nano/)
- [Android local LLM inference: from LiteRT to MediaPipe LLM Inference](/blog/android-local-llm-litert-mediapipe/)
- [Streaming local LLM output: from token generation to incremental Compose rendering](/blog/android-on-device-llm-streaming-output/)
- [Local RAG on Android: retrieval-augmented generation with a local vector database](/blog/android-on-device-rag-vector-database/)
- [Multimodal local AI: Gemini Nano multimodality and real-time Compose interaction](/blog/android-multimodal-on-device-ai/)

## Performance and Production Concerns

- [On-device AI benchmark design: latency, throughput, power, and thermal degradation](/blog/android-on-device-ai-benchmark/)
- [Using Perfetto to trace NPU scheduling and memory-bandwidth bottlenecks](/blog/android-on-device-ai-perfetto-npu-profiling/)
- [Memory management for local AI: model-load peaks and KV cache recycling](/blog/android-on-device-ai-memory-kv-cache/)
- [Concurrent inference scheduling: priority queues and backpressure control](/blog/android-on-device-ai-concurrency-backpressure/)
- [Model security: encrypted storage, TEE inference, and IP protection](/blog/android-on-device-ai-model-security-tee/)

## Official References

- [Gemini Nano on Android](https://developer.android.com/ai/gemini-nano)
- [ML Kit GenAI APIs](https://developers.google.com/ml-kit/genai)
- [AI on Android](https://developer.android.com/ai)

## Related Topics

- [Compose-first Migration](/en/compose-first-migration/): local AI chat, streaming output, and multimodal interaction usually need a solid Compose UI architecture.
- [Android Performance](/en/android-performance/): local models expose memory, temperature, power, and frame-rate problems quickly.
