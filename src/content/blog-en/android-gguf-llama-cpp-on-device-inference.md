---
title: "Android On-Device Inference with GGUF and llama.cpp"
lang: en
translationKey: android-gguf-llama-cpp-on-device-inference
slug: android-gguf-llama-cpp-on-device-inference
excerpt: "A practical walkthrough for porting and tuning llama.cpp with GGUF to run a 7B model on a Snapdragon 8 Gen 2 phone."
publishDate: '2026-07-29'
tags:
- "Android"
- "On-Device AI"
- "llama.cpp"
seo:
  title: "Android GGUF llama.cpp On-Device Inference"
  description: "A practical guide to porting and tuning llama.cpp with GGUF to run 7B models on Snapdragon 8 Gen 2 Android phones."
  pageType: article
---

Last year, while building a local knowledge base app, I hit a tricky problem: how to get a 7B model running smoothly on a Snapdragon 8 Gen 2 phone. The solutions available at the time either locked you into a vendor SDK or were too slow to be usable. After a few detours, I eventually settled on the **GGUF** format plus **llama.cpp**.

Below I'll break down the entire porting and tuning process.

## GGUF: Why Not Safetensors or ONNX

The core tension between on-device inference and server inference is **memory bandwidth**. A phone's LPDDR5 memory has a theoretical bandwidth of roughly 50 GB/s, while a 7B-parameter FP16 model is about 14 GB—loading it alone already exceeds memory, not to mention inference.

GGUF (GPT-Generated Unified Format) solves exactly this problem. The idea is straightforward: use low-bit-width quantization to trade off memory usage against inference speed. Once a 7B model is quantized to Q4_K_M, its size shrinks to about 4 GB, which fits on a device with 8 GB of RAM.

Compare that with two other common formats:

**Safetensors** was designed for safe loading, not for inference optimization. It lacks metadata conventions for quantization levels, so each model author can define their own quantization scheme, leading to serious ecosystem fragmentation. Using Safetensors for on-device inference requires building an entire quantization configuration layer yourself, which is not worth the effort.

**ONNX** is generic enough as an inference framework, but in LLM scenarios it needs substantial adaptation to support structures such as KV Cache and RoPE. ONNX Runtime's mobile optimizations on Android are also far less mature than its server version, and the performance gap is obvious in practice.

GGUF's sharding granularity and bfloat16 support are both built into the specification, so no extra convention layer is needed. As for file structure, it uses a single-file layout with a key-value metadata header plus a tensor data area, enabling zero-copy `mmap` loading—a key advantage for saving memory on mobile.

## llama.cpp's Structure and Android Cross Compilation

llama.cpp is not a framework; it is an inference engine kernel: pure C/C++, no Python dependency, with core code under 50,000 lines. Porting it to Android means cross-compiling a C++ project.

The basic build command:

```bash
cmake -B build-android \
  -DCMAKE_TOOLCHAIN_FILE=$NDK_ROOT/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-26 \
  -DGGML_OPENMP=OFF \
  -DGGML_CPU_ARM_ARCH=armv8.2a \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build-android -j$(nproc)
```

I hit one pitfall: under the armeabi-v7a architecture, llama.cpp's NEON instruction path falls back, causing a cliff-like drop in performance. Just abandon 32-bit devices; supporting only arm64-v8a is enough.

The build outputs are `libllama.so` and the inference command-line tool. For actual integration, I used JNI to wrap the C API and expose it to Kotlin:

```cpp
// 关键 JNI 接口：加载模型并创建上下文
extern "C" JNIEXPORT jlong JNICALL
Java_com_example_llama_LlamaEngine_nativeInit(
    JNIEnv *env, jobject, jstring model_path, jint n_ctx) {
    
    const char *path = env->GetStringUTFChars(model_path, nullptr);
    
    llama_model_params mparams = llama_model_default_params();
    llama_model *model = llama_load_model_from_file(path, mparams);
    
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = n_ctx;
    cparams.n_threads = std::thread::hardware_concurrency();
    
    llama_context *ctx = llama_new_context_with_model(model, cparams);
    env->ReleaseStringUTFChars(model_path, path);
    return reinterpret_cast<jlong>(ctx);
}
```

The two parameters `n_ctx` (context window size) and `n_threads` (inference thread count) directly affect memory allocation and inference latency, and they will come up repeatedly during tuning.

## Three Performance Tuning Paths

Performance tuning is divided into three layers. They are independent of each other and can be stacked.

### Layer 1: Quantization Level Selection

GGUF's Q4_K_M is a sweet spot. Q4_0 is faster but has a noticeable perplexity loss; Q5 has better precision but a significantly larger size. Here are measured results for a 7B model on the Snapdragon 8 Gen 2:

| Quantization Level | Model Size | First Token Latency | Generation Speed |
|---------|---------|------------|---------|
| Q4_0    | 3.8 GB  | 1.2 s     | 18 tok/s |
| Q4_K_M  | 4.1 GB  | 1.3 s     | 16 tok/s |
| Q5_K_M  | 4.8 GB  | 1.5 s     | 12 tok/s |

Q4_K_M generates about 33% faster than Q5_K_M and is 15% smaller, while the precision difference is imperceptible in most question-and-answer scenarios.

### Layer 2: Thread and NUMA Affinity

The big.LITTLE architecture on phones is sensitive to thread assignment. By default, llama.cpp throws all compute threads onto every CPU core, but mixing big and little cores actually slows things down.

My approach was to bind inference threads to the big-core cluster and leave audio or UI threads on the little cores. Android has no standard API for `sched_setaffinity`, so you need `taskset` or reflection into hidden system interfaces. After core pinning, generation speed improved from 14 tok/s to 16 tok/s—not a huge gain, but stable.

### Layer 3: KV Cache Quantization

Starting with llama.cpp b3267, KV Cache supports 8-bit quantization (`cache_type_k=f16; cache_type_v=q8_0`), which helps noticeably with long-text inference. With it enabled, memory usage for a 4096-token context drops from ~2 GB to ~1.1 GB, and a 7B model on an 8 GB device no longer OOMs frequently during long conversations.

```cpp
cparams.cache_type_k = GGML_TYPE_F16;
cparams.cache_type_v = GGML_TYPE_Q8_0;  // 只量化 Value 缓存
```

The reason for quantizing only Value while keeping Query-Key in FP16 is that a slightly larger perturbation in Key has a bigger impact on Attention computation than in Value.

## Engineering Integration Trade-offs

On-device inference is not done once it runs. In a real product, you still need to handle several engineering problems.

**Model distribution**: GGUF models are often 4 GB or more, so they cannot be packed into an APK. I use APK Expansion Files or a private-directory download approach: fetch from a CDN on first launch, with support for resumable downloads and file integrity checks (SHA256).

**Unified management of GPU memory and system memory**: llama.cpp uses pure CPU inference, but GPU inference on Android via OpenCL or Vulkan backends is also worth attention. In my tests, Qualcomm's GPU backend has an advantage for models below 1B, while at the 7B level it becomes limited by GPU memory bandwidth, making the CPU approach more stable. This will certainly change in future chip generations.

**Streaming inference adaptation**: llama.cpp's callback mechanism natively supports token-by-token output, which I wrapped into a Kotlin coroutine `Flow`:

```kotlin
fun LlamaEngine.generateStream(prompt: String): Flow<String> = callbackFlow {
    nativeGenerateStream(ctx, prompt) { token ->
        trySend(token)
    }
    close()
}
```

In essence, this uses JNI callbacks to turn C's synchronous inference loop into an asynchronous Kotlin data stream.

## From Porting to Production

Across the whole chain, GGUF handles model storage and transfer efficiency, llama.cpp handles inference execution efficiency, and the engineering wrapper handles integration efficiency. Each layer manages its own part; missing any one of them makes the stack impractical.

My judgments from actual deployment:

1. **Prefer Q4_K_M** unless your scenario is unusually sensitive to accuracy. The memory you save is far better spent on the context window than on parameter precision.
2. **Don't optimize the GPU backend too early.** CPU inference on current mobile chips is far more mature and stable than GPU; get the CPU path solid first, then consider heterogeneous compute.
3. **KV Cache quantization is nearly zero-cost** and should be enabled by default. It is one of the few optimizations that gives you more without costing more.

The on-device AI inference stack has changed extremely fast over the past two years. Following llama.cpp's release notes is more valuable than following any intermediate wrapper layer—it is the core that truly defines on-device inference capability.
