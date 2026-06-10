---
title: 深入 Android 端侧 AI 推理的初始化与预热优化
slug: android-on-device-ai-inference-warmup
translationKey: android-on-device-ai-inference-warmup
excerpt: 系统性拆解端侧AI推理冷启动的三大延迟来源——模型加载、GPU Delegate初始化和KV Cache预填充，通过并行化、预热推理和长生命周期复用将首次推理从3.2秒优化至80ms。
publishDate: '2026-06-09'
tags:
- Android
- 端侧AI
- 性能优化
- TFLite
- GPU推理
seo:
  title: 深入 Android 端侧 AI 推理的初始化与预热优化
  description: 拆解端侧AI推理冷启动的延迟来源，从模型加载、GPU Delegate初始化到KV Cache预填充，一套组合优化将首次推理从3.2秒降至80ms，附内存取舍策略。
---

去年在做端侧大模型落地时，我遇到一个让人抓狂的问题：用户点击 AI 功能按钮后，第一次推理耗时 3.2 秒才返回结果，但第二次同样的请求只要 400ms。这 8 倍的差距，逼得我系统性地拆解**端侧推理的"冷启动"**问题。

这事的本质和 App 冷启动优化一样：慢不是因为某个环节慢，而是一串同步阻塞操作叠在一起。下面按模型加载 → 引擎初始化 → KV Cache 三条线，逐一拆解延迟来源和治理手段。

## 延迟来源拆解

用 MediaPipe LLM Inference 跑 Gemma 2B 模型，在 Pixel 8 上实测各阶段耗时：

| 阶段 | 耗时 | 占比 |
|------|------|------|
| 模型文件加载（mmap） | 180ms | 5.6% |
| TFLite 运行时初始化 | 120ms | 3.8% |
| 模型解析与图构建 | 450ms | 14.1% |
| GPU Delegate 初始化 | 820ms | 25.6% |
| KV Cache 预填充（Prefill） | 1550ms | 48.4% |
| 首次 Decode | 80ms | 2.5% |
| **总计** | **3200ms** | 100% |

GPU Delegate 是最大的单点开销。TFLite 的 GPU 后端在首次推理前需要编译 shader、分配显存缓冲，这个初始化是 lazy 的——只有实际跑推理时才触发，所以用户感知到的"卡"恰恰集中在这 820ms。

KV Cache 预填充占近一半时间。Prefill 阶段需要一次性处理整个 prompt 的所有 token，计算量是 Decode 阶段的几十倍。如果你的 system prompt 有 500 token，GPU 需要并行计算 500 次 Attention。这不是"加载慢"，是纯粹的计算量大。

## 模型加载：把 IO 和解析解耦

模型文件加载本身并不慢，慢的是"加载完等着解析，解析完等着初始化"这种串行模式。

### mmap 映射替代完整读取

MediaPipe 默认用 mmap 加载 `.bin` 权重文件，这个选型是对的。但有个细节容易忽略：mmap 的预读取策略。

```cpp
// 主动触发预读取，让系统按顺序预读后续页
madvise(addr, file_size, MADV_SEQUENTIAL | MADV_WILLNEED);
```

`MADV_SEQUENTIAL` 告诉内核你会顺序访问，`MADV_WILLNEED` 让内核提前把接下来的页读入 page cache。实测这个改动让模型加载阶段从 180ms 降到 110ms——原理是把磁盘 IO 从"用时才读"变成"提前预热"。

### 图构建与加载并行化

模型加载（IO 操作）和图构建（CPU 操作）完全可以并行：

```kotlin
// 并行加载模型权重和构建推理图
val weightJob = CoroutineScope(Dispatchers.IO).async {
    loadModelWeights(modelPath)  // mmap + madvise
}
val graphJob = CoroutineScope(Dispatchers.Default).async {
    buildInferenceGraph(config)  // 解析模型结构
}

val (weights, graph) = weightJob.await() to graphJob.await()
initializeEngine(weights, graph)
```

IO 线程和 CPU 线程互不竞争，总耗时取两者最大值加少量合并开销。实测这个优化带来的提升有限（约 60ms），因为真正的瓶颈在后面。

## GPU Delegate 初始化：最容易被低估的成本

踩过的一个坑是：GPU Delegate 初始化慢，不是因为 GPU 性能差，而是 **shader 编译和算子选择在首次推理时才触发**。

TFLite GPU Delegate 内部有一套算子匹配逻辑：对于模型的每个算子，它要检查能否在 GPU 上执行、生成对应的 GLSL/CL shader、编译并缓存。这个过程是 lazy 的，而且**每次创建新的 Interpreter 都会重新走一遍**。

### 预热推理

在后台线程跑一次空的推理调用，提前触发 Delegate 初始化：

```kotlin
// 空 prompt 预热，触发 GPU Delegate 初始化和 shader 编译
lifecycleScope.launch(Dispatchers.Default) {
    interpreter.runWarmup()  // 内部执行一次 minimal forward pass
}
```

这个"空跑"耗时约 800ms，但它把代价从用户交互路径上移走了。关键一点：**预热必须在同一个 Delegate 实例上做**，新建 Interpreter 的预热无效。

### Delegate 实例复用

更彻底的方案是保持 Interpreter 和 Delegate 长生命周期：

```kotlin
class InferenceService : Service() {
    private lateinit var interpreter: Interpreter

    override fun onCreate() {
        interpreter = createInterpreterWithWarmup()
    }
}
```

把 Interpreter 托管在 Service 中，进程存活期间只初始化一次。代价是常驻内存增加约 200-400MB（取决于模型大小），需要结合低内存回调做降级回收。

## KV Cache 预填充：从事后计算到提前算好

Prefill 的 1.5 秒来自对 system prompt 的大量矩阵运算。优化方向很直接：**把 system prompt 的 KV Cache 提前算好、缓存起来**。

### 方案一：在模型加载时预计算

```kotlin
// 启动阶段预计算 system prompt 的 KV Cache
savedStateHandle.setSavedStateProvider("kv_cache") {
    val kvCache = interpreter.prefillSystemPrompt(SYSTEM_PROMPT)
    kvCache.serializeToBundle()
}
```

首次启动仍然是慢的，但后续启动可以从缓存恢复。问题是：KV Cache 序列化后的体积很大（2B 模型约 50-80MB），读写本身有 IO 开销，而且跨进程恢复需要重建对象图。我实测下来，串行序列化加反序列化反而拖慢了整体时间。

### 方案二：Long-lived Context 模式

保持 Interpreter 长生命周期后，KV Cache 天然常驻内存。另一个好处是：用户连续对话时，历史轮次的 KV Cache 也不需要重复计算。这是目前我在项目中采用的方案：

```kotlin
class ChatSession(private val interpreter: Interpreter) {
    private var currentKvCache: KvCache? = null

    init {
        // 应用启动时预填充 system prompt
        currentKvCache = interpreter.prefill(SYSTEM_PROMPT)
    }

    suspend fun chat(userInput: String): String {
        // 每次对话仅计算新增 token 的 KV，增量追加
        val newCache = interpreter.decodeWithCache(
            userInput, currentKvCache
        )
        currentKvCache = newCache
        return interpreter.generate(newCache)
    }
}
```

## 效果与取舍

整套优化在 Pixel 8 上的效果：

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 模型加载 + 解析 | 750ms | 520ms |
| GPU Delegate 初始化 | 820ms | 0ms（预热后） |
| KV Cache 预填充 | 1550ms | 0ms（长驻） |
| **首次推理总延迟** | **3200ms** | **80ms** |
| 常驻内存增加 | — | +380MB |

3.2 秒变 80ms，代价是 380MB 内存。对于端侧 AI 这种低频但强感知的功能，用户对"点了没反应"的容忍度远低于"占点内存"。但如果你的应用本身已经是内存大户（比如社交 App 的图片缓存），就需要做动态决策，在低内存设备上降级为单次预热模式。

做决策时我用的启发式规则很简单：

```kotlin
val shouldKeepAlive = Runtime.getRuntime().maxMemory() > 6 * 1024 * 1024 * 1024L // 6GB+
```

8GB 以上设备长驻，6GB 以下设备用预热后释放的策略。

把端侧推理的初始化优化放到冷启动优化的框架里看，两者的方法论几乎一致：延迟初始化 → 提前初始化 → 常驻复用，每一步都在"资源占用"和"响应速度"之间做权衡。没有银弹，根据设备能力和业务场景做差异化策略就是最好的方案。
