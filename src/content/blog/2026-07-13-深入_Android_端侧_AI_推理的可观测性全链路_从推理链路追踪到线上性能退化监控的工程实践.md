---
title: 深入 Android 端侧 AI 推理的可观测性全链路：从推理链路追踪到线上性能退化监控的工程实践
slug: android-on-device-ai-observability
translationKey: android-on-device-ai-observability
excerpt: 本文介绍了一套端侧 AI 推理可观测性方案，通过 Trace 结构化记录推理全链路、构建多维性能画像，并基于画像漂移的三层递进规则引擎实现线上性能退化自动发现，解决了设备碎片化场景下模型推理劣化难以感知和定位的工程难题。
publishDate: '2026-07-13'
tags:
- Android
- AI推理
- 可观测性
- 性能优化
- TFLite
seo:
  title: 深入 Android 端侧 AI 推理的可观测性全链路：从推理链路追踪到线上性能退化监控的工程实践
  description: 基于 Trace 埋点、性能画像与三层退化检测规则引擎，构建端侧 AI 推理的可观测性体系，在设备碎片化场景下实现性能劣化的自动发现与精准定位。
---

去年 Q3，我们 App 的端侧图像分割模型在某品牌中端机上出现了 3 倍以上的推理延迟退化。尴尬的是：崩溃率没变、ANR 没涨、用户也没反馈——直到对比了同一机型两个版本的埋点数据，才发现劣化已经持续了 6 周。

后端服务有成熟的 APM 体系，Prometheus + Grafana + 分布式 Tracing 一应俱全。轮到端侧 AI 推理，大多数团队的做法是「打几个 log 看看耗时」，出了问题再翻代码。这种事后排查在模型迭代频繁、设备碎片化严重的 Android 生态里，根本兜不住底。

我落地了一套端侧 AI 推理可观测性方案，核心思路是：**用 Trace 结构化记录每一次推理的完整链路，基于 Trace 数据构建性能画像，再通过画像的漂移检测来发现线上退化。**

## 端侧 AI 推理的观测盲区

端侧推理链路比后端服务调用短得多，但观测难度反而更大。

**跨层调用被压缩在单进程内。** 后端一次请求经过网关、服务、缓存、数据库，天然有 RPC 边界做埋点。端侧推理从输入预处理到模型运行再到后处理，全在一个进程里跑完，调用边界模糊，必须在代码层面显式划分 Span。

**性能受设备异构性影响剧烈。** 同样是跑 MobileNetV3 的 FP16 推理，骁龙 8 Gen 3 用 QNN Delegate 可能只需 3ms，某款联发科中端机用 XNNPACK 回退到 CPU 推理要跑 25ms。后端可以通过扩容掩盖性能差异，端侧没法扩容——用户手里的设备是什么样就是什么样。

**模型文件分发和加载是额外的变数。** 模型更新后用户可能还在用旧版本、文件下载不完整、Delegate 初始化失败静默回退到 CPU——这些问题在纯埋点统计里很难关联到具体的推理质量劣化。

三个盲区叠加，导致端侧 AI 的性能退化往往是「温水煮青蛙」：单次推理慢 5ms 没人感知，但加上模型更新、系统升级、温度降频，累积效应会突然在某天爆发。

## 构建推理 Trace 的埋点体系

把每一次推理请求当作一次 Trace，把预处理、推理、后处理三个阶段当作三个 Span。数据结构参考了 OpenTelemetry 的 Span 模型，做了端侧简化。

```kotlin
data class InferenceSpan(
    val traceId: String,
    val spanName: String,
    val startTimeNanos: Long,
    val endTimeNanos: Long,
    val attributes: Map<String, String>,
    val events: List<SpanEvent>,
    val status: SpanStatus
)

data class SpanEvent(
    val name: String,
    val timestampNanos: Long,
    val attributes: Map<String, String>
)
```

Span 的 attributes 字段承载了上下文维度，推理耗时只是基础信息：

- **模型维度**：model_name、model_version、model_format（.tflite / .ort / .pte）
- **运行时维度**：delegate_type（GPU / NNAPI / XNNPACK）、delegate_status、thread_count
- **输入维度**：input_shape、input_dtype、preprocessing_ms
- **设备维度**：soc_model、api_level、thermal_status

每个 Span 还可以携带 Event，比如 delegate 初始化失败、模型加载回退——这些关键事件在排查线上问题时比平均耗时有用得多。

埋点接入方式上，我不推荐用 AOP 切面。推理代码的调用路径短而固定，AOP 带来的灵活性在端侧没有收益，反而增加排查成本。直接在 Interpreter 封装层显式埋点更可控：

```kotlin
class TracedInterpreter(
    private val delegate: Delegate,
    private val tracer: InferenceTracer
) {
    fun infer(input: ByteBuffer): Result<FloatArray> {
        val traceId = tracer.startTrace("image_seg")
        
        val preSpan = tracer.startSpan(traceId, "preprocess")
        val tensor = preprocess(input)
        tracer.endSpan(preSpan, mapOf("input_shape" to tensor.shape.toString()))
        
        val inferSpan = tracer.startSpan(traceId, "model_infer")
        val output = runModel(tensor)
        tracer.endSpan(inferSpan, mapOf(
            "delegate" to delegate.name,
            "inference_ms" to inferSpan.durationMs().toString()
        ))
        
        val postSpan = tracer.startSpan(traceId, "postprocess")
        val result = postprocess(output)
        tracer.endSpan(postSpan)
        
        tracer.endTrace(traceId)
        return Result.success(result)
    }
}
```

端侧对 Trace 数据做本地聚合：按模型+版本+设备档位分组，每 100 次推理或每 5 分钟上报一次聚合后的统计值（P50、P90、P99、成功率、各 Span 耗时占比）。单次 Trace 的全量数据不上报，只在采样策略触发时（比如 P99 超过阈值 2 倍）保留完整链路用于排查。

## 性能画像：从统计值到分布特征

聚合数据上报到后端后，单个模型的性能表现用一个多维向量来描述。我把它称为「性能画像（Performance Profile）」：

```
Profile = {
    model: "segmentation_v3",
    version: "20260701",
    soc_bucket: "mid_range_snapdragon",
    percentiles: { p50: 45ms, p90: 72ms, p99: 130ms },
    span_ratio: { preprocess: 0.15, infer: 0.70, postprocess: 0.15 },
    success_rate: 0.997,
    delegate_distribution: { GPU: 0.92, CPU: 0.08 },
    sample_size: 2840
}
```

画像的核心价值不在单个数值，而在**分布形态**。P50 是 45ms 但 P99 是 130ms，跨度接近 3 倍，说明存在明显的长尾延迟。进一步把设备按温度状态分组，发现高温降频时 P99 飙升到 200ms——这个信息为后续的退化检测提供了分组基线。

建画像时两个经验。

**SOC 分桶策略比机型分组更有效。** Android 设备型号上千种，按机型建画像会导致数据稀疏。我的做法是按 SOC 型号 + 性能档位（基于 GeekBench 跑分数据）分成 6-8 个桶，同一桶内设备推理性能差异通常在 15% 以内，足够用于退化检测。

**画像需要版本化存储。** 每次模型更新、推理引擎版本变更、甚至系统 WebView 版本变化（会影响 NNAPI 行为），都应该生成新的画像 ID。保留最近 10 个版本的画像数据，用于退化检测时的基线对比。

## 退化检测：画像漂移的自动发现

有了持续更新的性能画像，退化检测变成了时序数据的异常检测。这里没有用复杂的 ML 模型，而是一个三层递进的规则引擎：

**第一层：单指标阈值告警。** P99 推理耗时超过基线的 150%、成功率低于 99%、CPU 回退率超过 20%——任一条件触发即告警。最灵敏，但误报率也最高。

**第二层：画像向量距离。** 把当前画像和基线画像的多个维度（P50/P90/P99/成功率/Span 占比）归一化后计算余弦相似度。相似度低于 0.85 且持续 3 个上报周期，判定为有效退化。这一层过滤掉了大部分瞬态抖动。

```kotlin
fun cosineSimilarity(current: Profile, baseline: Profile): Double {
    val cur = current.toNormalizedVector()
    val base = baseline.toNormalizedVector()
    val dot = cur.zip(base).sumOf { (a, b) -> a * b }
    val normCur = sqrt(cur.sumOf { it * it })
    val normBase = sqrt(base.sumOf { it * it })
    return dot / (normCur * normBase)
}
```

**第三层：设备分群下钻。** 第二层检测到退化后，自动按设备厂商、Android 版本、温度状态分群，找出退化最严重的子群。实践中发现，厂商的系统更新经常改变 NNAPI 驱动行为，导致特定品牌机型集中退化——这种问题的根因和 App 代码完全无关，但需要快速定位才能推动厂商修复或做降级。

三层递进带来的实际收益是告警自带上下文。收到「segmentation_v3 的 P99 延迟从 80ms 退化到 150ms」比「推理耗时告警」有行动力得多，附加上「影响设备集中在小米 HyperOS 2.0 的骁龙 7+ Gen 2 机型」就能直接定位到具体驱动版本。

## 平衡采样率与存储成本

全量上报 Trace 数据在端侧场景下不现实。一个 DAU 千万级的 App，每人每天触发 50 次推理，全量上报每天就是 5 亿条 Trace，存储和传输成本都扛不住。

我的策略是三层采样：

- **统计采样**：100% 上报聚合统计数据（每个模型+设备分组的 P50/P90/P99 等），数据量最小、价值最高。
- **异常采样**：单次推理耗时超过 P99 基线的 2.5 倍时，保留完整 Trace 并上报。这部分数据量约占总量 1%，但覆盖了绝大部分需要排查的异常 case。
- **随机采样**：以 0.1% 的概率随机保留完整 Trace，用于离线分析和新指标探索。

端侧存储用环形缓冲区，内存中保留最近 200 条 Trace，触发异常采样时才序列化写入磁盘并上报。正常 Trace 在内存中完成聚合后就丢弃，不落盘。

这套方案运行半年，日均上报数据量控制在 200MB 以内，磁盘缓存峰值不超过 50MB，覆盖了 3 次模型退化事件和 2 次厂商驱动兼容性问题——ROI 符合预期。

## 踩坑实录

**NNAPI 的 delegate 状态不可靠。** `Interpreter.Options.addDelegate` 调用成功不代表模型实际跑在 GPU 上。NNAPI 内部会根据算子支持情况做静默回退。解决方案：在 Span 的 events 中记录 `nnapi_fallback` 事件，通过 TFLite 的 `Interpreter.getInputTensor` 和 `getOutputTensor` 的 `index()` 变化来间接判断回退行为。

**SystemClock.elapsedRealtimeNanos 在部分设备上有漂移。** 单次推理耗时在 10-100ms 量级，时钟漂移影响不大，但长时间运行后聚合的时间戳可能不准。解决方案是定期用 `System.currentTimeMillis` 做校准，差值超过 5% 时触发告警但不影响推理本身。

**画像冷启动需要 3-5 天数据积累。** 新模型上线后，画像数据量不足导致基线不稳定。线上采用「预热期」策略：前 3 天只收集数据不触发告警，第 4 天开始用滑动窗口计算基线，之后逐日更新。

端侧可观测性不是后端体系的简单移植。它的核心挑战在于数据采集的轻量化和退化检测的自动化——前者决定了你能采集多少数据，后者决定了你能否在用户感知之前发现问题。搭建这套体系投入了约 3 人周，但它替我发现了 5 次靠人工排查不可能定位的线上问题，后续的维护成本几乎为零。
