---
title: Android 端侧大模型推理全链路：从 LiteRT 到 MediaPipe LLM Inference API 的引擎选型与工程化实践
excerpt: 深入探讨 Android 端侧 LLM 推理的引擎选型（LiteRT、ONNX Runtime、MediaPipe LLM Inference API）、INT4 量化策略、GPU Delegate 调度优化与机型降级方案，提供可落地的工程化实践参考。
publishDate: '2026-04-17'
tags:
- Android
- 端侧推理
- 大模型
- 性能优化
- MediaPipe
seo:
  title: Android 端侧大模型推理全链路：从 LiteRT 到 MediaPipe LLM Inference API 的引擎选型与工程化实践
  description: 深入解析 Android 端侧 LLM 推理的引擎选型、INT4 量化策略、GPU Delegate 初始化优化、KV Cache 内存管理与多机型降级方案，助力工程落地。
---

去年底在做一个本地 AI 助手功能时，我们遇到了一个让人头疼的问题：同一个 Gemma 2B 模型，在 Pixel 8 上首 token 延迟 3.2 秒，在中端 Snapdragon 778G 机器上直接 OOM。当时摆在面前的有三条路：LiteRT（原 TFLite）、ONNX Runtime Mobile、MediaPipe LLM Inference API。最终我们在不同场景下选了不同方案，这篇文章是对这段经历的系统梳理。

## 端侧推理的核心矛盾

移动端跑 LLM，本质上是在用 PC 时代的算法压榨手机时代的硬件。一个 7B 参数的模型 FP16 精度下需要 14GB 内存，远超任何 Android 设备的可用上限。即便是 1B 参数的小模型，FP16 也要 2GB，在 4GB RAM 的设备上几乎不可行。

**瓶颈不是算力，而是内存带宽和容量。** 现代手机 SoC 的 NPU 算力其实不弱，但 LPDDR5 内存带宽只在 50–80 GB/s 量级，LLM 推理是典型的内存密集型（memory-bound）任务。Transformer 的 KV Cache 随序列长度线性增长，在 PC 上不是问题，在手机上却是决定成败的关键。

破局方向只有两条：**减小模型体积**（量化）和**减少内存搬运次数**（调度优化）。端侧 LLM 的所有工程决策，都在这两个维度上做取舍。

## 引擎全景：LiteRT、ONNX Runtime 与 MediaPipe

### LiteRT（原 TFLite）

Google 在 2024 年将 TensorFlow Lite 更名为 LiteRT（Lite Runtime），同时从 TensorFlow 仓库独立出来，纳入 `com.google.ai.edge` 生态。更名不只是品牌操作，底层有几件实质性的变化：Delegate 机制重构后，GPU Delegate 和 NNAPI Delegate 的 fallback 逻辑更稳定；正式支持 INT4 量化，结合 `LiteRT Model Maker` 可以做 PTQ（训练后量化）；引入 `LiteRtCompiledModel` API，支持离线编译缓存，减少首次加载时的编译开销。

对于需要精细控制推理流程或使用自定义模型的场景，LiteRT 是灵活性最高的选择。它的问题是对 LLM 并非原生设计——Transformer 的动态 shape、KV Cache 管理都需要开发者自己处理，工程量不小。

### ONNX Runtime Mobile

如果模型来自 PyTorch 训练，ONNX Runtime 的转换链路更短（`torch.onnx.export` → ORT Mobile），跨平台一致性也更有优势，这点确实成立。

但在 Android 上，ONNX Runtime 的 GPU 加速依赖 OpenCL EP（Execution Provider），稳定性和性能在部分机型上不如 LiteRT 的 GPU Delegate。实测下来，Snapdragon 系列上 LiteRT GPU Delegate 通常比 ORT OpenCL EP 快 15–30%。

ONNX Runtime 适合的场景比较明确：模型需要跨 Android/iOS/服务端复用，或者团队的工具链是 PyTorch-centric 的。

### MediaPipe LLM Inference API

这是 Google 专门为端侧 LLM 推理设计的高层 API，底层使用 `MediaPipe Tasks` + `LiteRT` 实现。它的定位是把 LLM 推理变成一个开箱即用的组件，开发者不需要关心 KV Cache、采样逻辑、Tokenizer 等细节。

```kotlin
// 初始化 LLM 推理任务
val options = LlmInference.LlmInferenceOptions.builder()
    .setModelPath("/data/local/tmp/gemma-2b-it-gpu-int4.bin")
    .setMaxTokens(1024)
    .setTopK(40)
    .setTemperature(0.8f)
    .setRandomSeed(42)
    .build()

val llmInference = LlmInference.createFromOptions(context, options)

// 流式推理
llmInference.generateResponseAsync(prompt) { partialResult, done ->
    runOnUiThread { updateUI(partialResult) }
}
```

接入成本极低，代价是可定制性几乎为零。采样策略固定为 Top-K，不支持 Top-P 或 Beam Search，不支持自定义 Tokenizer，不支持多轮对话的 system prompt 注入（截至 2025 Q4 版本）。MediaPipe LLM Inference API 适合快速验证产品 idea，生产级的复杂场景还是得绕回 LiteRT。

## 量化策略：INT8 vs INT4 vs 混合量化

量化不是可选项，是端侧 LLM 能跑起来的前提。问题是选哪种。

### INT8 PTQ

最成熟的方案，工具链完备，精度损失在大多数任务上可以接受。对于 1B 以下的小模型，INT8 PTQ 通常是最稳的选择：模型体积减半，推理速度在 CPU 上有 1.5–2x 提升（SIMD 指令集对 INT8 运算有专门优化）。

### INT4 与 Block-wise 量化

INT4 量化是 2024–2025 年端侧 LLM 的主战场。Gemma 2B INT4 只有约 1.3GB，在 6GB RAM 的设备上留出了足够的系统空间。

直接做 INT4 均匀量化精度损失通常不可接受，实践中用的是 **Block-wise 量化**（也叫 Group Quantization）：把权重分成若干 block，每组独立计算 scale 和 zero point，通常 32 或 128 个元素一组。

```python
# 使用 ai_edge_torch 做 INT4 block-wise 量化
import ai_edge_torch
from ai_edge_torch.quantize import QuantConfig, BlockwiseQuantizationConfig

quant_config = QuantConfig(
    weight_quant=BlockwiseQuantizationConfig(
        num_bits=4,
        block_size=32,  # 每 32 个元素一组
        symmetric=True
    )
)

edge_model = ai_edge_torch.convert(
    pytorch_model,
    sample_inputs,
    quant_config=quant_config
)
edge_model.export("gemma2b_int4.tflite")
```

踩过的一个坑：block_size 越小，精度越好，但 metadata overhead 越大，模型文件反而可能变大。对于 2B 量级的模型，block_size=32 是经验上比较好的平衡点。

### 混合量化

Attention 层的权重对量化更敏感，FFN 层相对鲁棒。混合量化的思路是 Attention 层用 INT8，FFN 层用 INT4，在体积和精度之间找更好的权衡。

MediaPipe 官方提供的 Gemma 预量化模型（`gemma-2b-it-gpu-int4.bin`）实际上就是混合量化的结果，并非所有层都是 INT4。这也是为什么它的质量比自己随便做个 INT4 PTQ 好不少——别小看这个差距，自制量化模型在某些推理任务上会出现明显退化。

## GPU Delegate 调度与内存映射

### GPU Delegate 的初始化成本

GPU Delegate 是 LiteRT 在 Android 上最重要的加速路径，但有一个常见陷阱：**第一次初始化会触发 OpenCL/OpenGL Shader 编译**，在某些设备上需要 2–5 秒。

解决方案是 Delegate 序列化：将编译好的 GPU Program 缓存到磁盘，下次初始化直接加载。

```kotlin
val gpuOptions = GpuDelegateFactory.Options().apply {
    setSerializationParams(
        context.cacheDir.absolutePath,  // 缓存目录
        "gemma2b_gpu_cache"             // 缓存 key
    )
    inferencePreference = GpuDelegateFactory.Options.INFERENCE_PREFERENCE_SUSTAINED_SPEED
}

val delegate = GpuDelegateFactory().create(gpuOptions)
val interpreterOptions = Interpreter.Options().addDelegate(delegate)
```

第一次运行仍然会慢，但后续启动可以从 3 秒降到 200ms 以内。这个优化在生产中几乎是必做项。

### 内存映射加载

模型文件直接 `mmap` 到内存地址空间，避免把整个模型复制到 heap。LiteRT 默认支持这种方式：

```kotlin
// 使用 MappedByteBuffer 而不是直接读文件
val modelBuffer: MappedByteBuffer = FileInputStream(modelFile).channel
    .map(FileChannel.MapMode.READ_ONLY, 0, modelFile.length())

val interpreter = Interpreter(modelBuffer, options)
```

`mmap` 让操作系统按需调入内存页，不需要一次性占用全部物理内存。对于 INT4 的 1.3GB 模型，`mmap` 方式的 RSS（Resident Set Size）通常比直接 load 低 20–40%，在内存压力大的设备上可以显著降低被 LMK（Low Memory Killer）杀死的概率。

### KV Cache 的内存预算

KV Cache 大小由 `最大序列长度 × 层数 × 头数 × 维度 × 2 × 精度字节数` 决定。Gemma 2B 在 128 token 长度下 KV Cache 约 50MB，512 token 下约 200MB。

MediaPipe LLM Inference API 的 `setMaxTokens` 参数会在初始化时预分配 KV Cache——好处是避免推理中途的内存分配抖动，坏处是哪怕只推理一句话，也要占用 `setMaxTokens` 对应的全量内存。

在实际项目中，我把 `setMaxTokens` 设为 512 而非文档推荐的 1024。对话场景里 512 token 的上下文窗口通常够用，内存节省了一半，OOM 率也明显下降。

## 机型适配与降级策略

端侧 AI 的最大工程挑战不是让高端机跑起来，而是让中低端机优雅降级。

我们在项目中实现了一套三档策略：

**高端机（Snapdragon 8 Gen 2+，8GB+ RAM）**：GPU Delegate + INT4，全功能，流式输出。

**中端机（Snapdragon 778G，6GB RAM）**：GPU Delegate + INT4，但限制 KV Cache 长度，关闭部分能力。

**低端机或功能不支持时**：直接降级到云端 API，本地不跑模型。

```kotlin
fun selectInferenceStrategy(context: Context): InferenceStrategy {
    val memInfo = ActivityManager.MemoryInfo()
    (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
        .getMemoryInfo(memInfo)
    
    val availableRam = memInfo.totalMem / (1024 * 1024) // MB
    val hasGpuDelegate = checkGpuDelegateSupport(context)
    
    return when {
        availableRam >= 7000 && hasGpuDelegate -> InferenceStrategy.LOCAL_GPU_INT4
        availableRam >= 5000 && hasGpuDelegate -> InferenceStrategy.LOCAL_GPU_INT4_LIMITED
        else -> InferenceStrategy.REMOTE_API
    }
}
```

检测 GPU Delegate 是否真实可用（而不是只看 API 是否存在）需要实际跑一个小模型做探测，这个冷启动成本可以在 App 首次安装时后台完成，结果缓存到 SharedPreferences。

## 实践建议

走过这段路，我的几个判断：

**引擎选型**：产品快速验证用 MediaPipe LLM Inference API，有定制化需求就回到 LiteRT 手动管理，跨平台复用场景才考虑 ONNX Runtime。不要为了"技术先进性"硬上复杂方案。

**量化策略**：别自己从头做量化，优先用官方或社区已验证的量化模型（Gemma、Phi-3 Mini 都有官方 INT4 版本）。自己做量化需要评估集和大量实验，投入产出比不高。

**内存管理**：`mmap` 加载 + 合理的 `maxTokens` 预算 + 机型降级，这三件事做好，OOM 率基本能降到可接受的水平。KV Cache 长度控制往往比优化模型本身更容易见效。

端侧 LLM 还处于快速演进阶段，今天的最优方案半年后可能就过时了。持续跟踪 Google AI Edge 和 MediaPipe 的更新，比深挖某个技术细节的性价比高得多。
