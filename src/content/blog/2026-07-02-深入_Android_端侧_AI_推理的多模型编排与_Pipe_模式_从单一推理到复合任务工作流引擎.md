---
title: 深入 Android 端侧 AI 推理的多模型编排与 Pipe 模式：从单一推理到复合任务工作流引擎的设计与实践
slug: android-on-device-ai-multi-model-orchestration
translationKey: android-on-device-ai-multi-model-orchestration
excerpt: 从单模型推理的舒适区出发，探讨 Android 端侧 AI 任务中 Pipe 串联、路由表分支到动态图执行的多模型编排实践，涵盖模型管理、错误兜底与协程调度的工程取舍。
publishDate: '2026-07-02'
tags:
- Android
- Kotlin
- 端侧AI
- 架构设计
- 模型编排
seo:
  title: 深入 Android 端侧 AI 推理的多模型编排与 Pipe 模式：从单一推理到复合任务工作流引擎的设计与实践
  description: 从Pipe串行编排到动态路由图执行，深入探讨Android端侧AI的多模型协同推理与工作流引擎设计，涵盖路由表、错误降级与协程调度的工程实践。
---

去年在做一个相册整理功能时，需求听起来不复杂：识别照片中的物体，如果是宠物就按品种分类，如果是文档就提取文字摘要。单看每个子任务，跑个模型就够了。但串起来之后，状态管理、模型切换、错误兜底的问题全冒出来了。

单一模型推理是舒适区，复合 AI 任务才是工程化的真正战场。

## 单模型推理的舒适区

在 Android 上跑一个 TFLite 或 MediaPipe 模型，代码通常长这样：

```kotlin
val interpreter = Interpreter(modelBuffer)
val output = Array(1) { FloatArray(NUM_CLASSES) }
interpreter.run(inputBuffer, output)
```

十几行代码，一个模型，一个输入，一个输出。但实际产品中，用户要的不是"这张图有 87% 概率是猫"，而是"帮我把猫的照片挑出来并按品种整理"。你需要的不再是单一推理，而是多模型协作的工作流。

问题出在衔接处：前一个模型的输出是后一个模型的输入，中间的格式转换、异常处理、资源调度都需要你自己管。每个模型可能来自不同框架（TFLite、ONNX、NNAPI），内存占用和加载时机也各不相同。

## Pipe：串行编排的基础范式

最直接的方案是把模型像管道一样串起来——上一个的输出 pipe 到下一个的输入。这是 Pipe 模式（Pipeline Pattern）的核心。

```kotlin
class ImageAnalysisPipeline(
    private val detector: ObjectDetector,   // 物体检测
    private val classifier: BreedClassifier, // 品种分类
    private val ocr: TextRecognizer         // 文字识别
) {
    suspend fun process(image: Bitmap): AnalysisResult {
        val objects = detector.detect(image)

        return objects.map { obj ->
            when (obj.category) {
                "pet" -> {
                    val breed = classifier.classify(obj.cropFrom(image))
                    PetResult(breed, obj.boundingBox)
                }
                "document" -> {
                    val text = ocr.recognize(obj.cropFrom(image))
                    DocumentResult(text, obj.boundingBox)
                }
                else -> GenericResult(obj.category, obj.boundingBox)
            }
        }
    }
}
```

这个 Pipeline 的核心价值不是"串联"，而是输入输出的适配层。每个模型对输入的尺寸、格式、归一化方式要求不同，你需要在中转处做裁剪、缩放、色彩空间转换。把这层逻辑封装进 Pipe，后续加新模型时才不会散落得到处都是。

## 条件分支：把 if-else 升级为路由表

上面的 `when` 分支硬编码了路由逻辑，模型少还好，一旦有 5 个以上的下游模型，代码就成了一锅粥。

更工程化的做法是声明式路由表——把"什么条件下走哪个模型"从代码逻辑中抽离出来：

```kotlin
data class RouteRule(
    val condition: (DetectionResult) -> Boolean,
    val handler: suspend (DetectionResult) -> AnalysisResult
)

class RoutedPipeline(private val rules: List<RouteRule>) {
    suspend fun route(result: DetectionResult): AnalysisResult {
        val matched = rules.firstOrNull { it.condition(result) }
            ?: return FallbackResult(result)
        return matched.handler(result)
    }
}

// 配置路由表
val pipeline = RoutedPipeline(listOf(
    RouteRule({ it.confidence > 0.8f && it.category == "pet" }) { obj ->
        PetResult(classifier.classify(obj.crop), obj.bbox)
    },
    RouteRule({ it.category == "text_block" }) { obj ->
        DocumentResult(ocr.recognize(obj.crop), obj.bbox)
    }
))
```

路由表让每个 rule 可以独立单测，路由规则也能动态下发而不用发版。最关键的是兜底路径清晰——未命中时走 Fallback，不会悄无声息地丢数据。

我曾踩过一个坑：分类模型返回的 label 列表线上更新后，硬编码的 `when` 分支漏了一个新类别，导致那部分图片直接跳过了分类。改成路由表加兜底后，新类别至少能拿到 `GenericResult`，用户侧不会出现"明明有结果却看不到"的情况。

## 动态路由：让工作流学会绕路

Pipe 和简单分支只能走固定路径。文档识别失败了怎么办？回退用 CPU 模型重试？还是走服务端 OCR？这就引出了动态路由。

```kotlin
class AdaptiveRouter(
    private val primary: ModelNode,
    private val fallback: ModelNode,
    private val maxRetries: Int = 1
) {
    suspend fun execute(input: ModelInput): ModelOutput {
        for (attempt in 0..maxRetries) {
            try {
                return primary.run(input)
            } catch (e: ModelException) {
                if (attempt == maxRetries) break
                // 降级策略：换模型 or 降低精度
                primary.adjustPreference(Preference.LOW_LATENCY)
            }
        }
        return fallback.run(input) // 最终兜底
    }
}
```

动态路由的本质是把决策逻辑从编译时移到运行时。你需要维护每个节点的健康状态——加载是否成功、推理耗时是否超阈值、内存压力是否过大——然后根据实时状态选择路径。

我的实践是抽象一个 `ExecutionGraph`，每个节点有 `onSuccess` 和 `onFailure` 两条边，整个工作流是一张有向图而非一条线。这样不仅能做降级，还能做并行分支：比如识别到宠物后，同时跑品种分类和情绪检测，最后合并结果，省去串行等待的时间。

## 工程实践的三个取舍

模型管理上，我的习惯是懒加载加 LRU 淘汰。大部分模型不需要常驻内存，用软引用或直接 unload，只在推理前加载。一个 50M 的模型从磁盘加载到 GPU 大概 200-300ms，这个开销可以接受。

线程模型用协程就够了。每个模型推理放在 `Dispatchers.Default` 上，管道本身是 `Flow`——天然支持背压和取消。NNAPI 的委托器内部已经有线程池，不需要额外操心。

兜底策略上，我倾向于宁可给粗略结果，也不能空白。比如宠物品种分类失败时，至少告诉用户"这是一只宠物"，而不是什么都不返回。用户体验的底线是信息不丢失——你少一个维度用户不会注意到，但缺了整个结果，用户就会觉得功能坏了。

## 从 Pipe 到工作流引擎

回头看，从最初的串行 Pipeline 到路由表，再到动态图执行，本质上是在解决同一个问题：如何让多个独立模型协同完成一个复合任务，且不把工程复杂度炸开。

实际选型时按场景来：两三个模型的简单串联，Pipe 模式足够，别过度设计。固定多分支的场景，路由表加兜底策略，把条件从代码中抽离。需要降级和并行分支的动态决策链路，才上 `ExecutionGraph` 加运行时路由。

命名上统一用 `Node` 而非 `Model`，因为一个节点可以是对服务端的 RPC 调用，也可以是纯规则逻辑，不必绑定到本地模型。这个抽象层次会让后续扩展顺畅得多——加新能力时你只需要实现一个 `Node` 接口，而不是去改一堆 `if (model is TFLiteModel)` 的判断。
