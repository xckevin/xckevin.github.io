---
title: 深入 Android ML Kit 全链路实战：从视觉检测 Pipeline 到 CameraX 集成的端侧智能工程落地
excerpt: 基于工业缺陷检测实战，深入剖析 ML Kit 检测管线机制、CameraX 集成最佳实践与端侧推理优化全链路，分享从选型到落地的完整工程经验。
publishDate: '2025-08-01'
tags:
- Android
- ML Kit
- CameraX
- 端侧推理
- 计算机视觉
seo:
  title: 深入 Android ML Kit 全链路实战：从视觉检测 Pipeline 到 CameraX 集成的端侧智能工程落地
  description: 以工业缺陷检测为实战场景，详解 ML Kit 检测管线机制、CameraX 集成要点（背压策略、分辨率选择、ImageProxy 管理）、多模型 Pipeline 设计及端侧推理优化的完整工程实践。
---

去年在做一款工业巡检 App，需求是在产线不停机的前提下，用手机摄像头实时检测零件表面缺陷。当时团队里所有人都在聊大模型（LLM），但遇到这种纯视觉任务时，LLM 完全使不上劲——延迟太高、模型太大、推理成本扛不住。最终转向了 **ML Kit** 的端侧视觉能力，配合 CameraX 构建了一套实时分析链路。

记录一下当时的工程选型和落地细节。

## ML Kit 的定位：端侧视觉的"瑞士军刀"

ML Kit 本质是 Google 把移动端视觉能力封装成了一套统一 API。它的核心优势不是"最强精度"，而是 **开箱即用 + 零服务端依赖**。

它提供两大类能力：

- **基础视觉 API**：人脸检测、文字识别（OCR）、条码扫描、图像标记、目标检测、姿态检测、自拍分割。这些模型已内置在 Play Services 中，不需要额外下载。
- **自定义模型 API**：对接 TensorFlow Lite 模型，适合企业级定制场景，比如我们当时的缺陷检测模型。

容易忽略的一点：ML Kit 的检测管线（Detection Pipeline）不是简单的一帧一帧独立处理。它在内部维护了帧间状态追踪，这对连续视频流的稳定性很关键——下面展开讲这个机制。

## 检测管线的工作机制

以目标检测（Object Detection）为例，ML Kit 的处理链路分三步：

```
CameraX 输出帧 → InputImage 封装 → 检测器推理 → 结果回调
```

**InputImage** 是整个管线的入口数据格式。它需要从 CameraX 的 `ImageProxy` 转换而来，这里有个容易踩坑的细节。

创建 InputImage 有两种方式：

```kotlin
// 方式一：从 ByteBuffer（推荐，零拷贝）
val image = InputImage.fromByteBuffer(
    buffer,
    width, height, rotation,
    InputImage.IMAGE_FORMAT_YUV_420_888
)

// 方式二：从 Bitmap（会做格式转换，有额外开销）
val image = InputImage.fromBitmap(bitmap, rotation)
```

实际项目中 **必须用方式一**。CameraX 输出的 YUV 数据直接传入，避免 RGB 转换带来的 15-25ms 延迟。高帧率场景下，这点优化累积起来帧率能差一档。

拿到 InputImage 后，检测器的运行很简单：

```kotlin
objectDetector.process(image)
    .addOnSuccessListener { results ->
        for (obj in results) {
            val box = obj.boundingBox
            val labels = obj.labels
            // 拿到检测框和分类标签
        }
    }
    .addOnFailureListener { e -> /* 处理错误 */ }
```

回调里的 **DetectedObject** 包含四个关键字段：边界框（boundingBox）、分类标签（labels）、追踪 ID（trackingId）、以及四个角点坐标。追踪 ID 是 ML Kit 自动维护的，同一物体在连续帧中保持相同 ID，省去了自己写追踪逻辑的麻烦。

## CameraX 集成：帧率与检测节奏的平衡

CameraX 的 `ImageAnalysis` 用例是连接相机取流和 ML Kit 的桥梁。官方推荐的做法是用 `setAnalyzer` 注册回调：

```kotlin
val imageAnalysis = ImageAnalysis.Builder()
    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
    .setTargetResolution(Size(640, 480))
    .build()

imageAnalysis.setAnalyzer(executor) { imageProxy ->
    val mediaImage = imageProxy.image
    if (mediaImage != null) {
        val inputImage = InputImage.fromMediaImage(
            mediaImage, imageProxy.imageInfo.rotationDegrees
        )
        objectDetector.process(inputImage)
            .addOnCompleteListener {
                imageProxy.close() // 必须手动关闭
            }
    }
}
```

三个关键决策：

**背压策略选 `STRATEGY_KEEP_ONLY_LATEST`**。当检测耗时超过帧间隔时（比如一帧处理耗时 150ms，但摄像头以 30fps 生产帧），CameraX 会直接丢弃旧帧，只保留最新一帧给分析器。这避免了帧积压导致的内存暴涨，代价是可能跳过某些帧——对实时检测场景是可接受的取舍。

**分辨率设 640×480**（VGA）。当时测试过 1080p 输入，检测准确率提升不到 2%，但推理延迟从 60ms 飙升到 180ms。对端侧模型来说，输入分辨率是性价比最高的调优杠杆。

**`imageProxy.close()` 必须调用**。漏了这行会导致 ImageProxy 不归还到共享缓冲区，30 帧左右 CameraX 就抛异常停止出帧。这个问题在日志里表现为 "ImageProxy is already closed" 或缓冲区耗尽，排查起来非常痛苦。

## 构建完整 Pipeline：检测 + 分类 + 反馈

工业场景光有检测不够，需要串联多个能力。以缺陷检测为例，我们的 Pipeline 是这样的：

```
CameraX 帧 → 目标检测（定位缺陷区域）→ 图像分类（判断缺陷类型）→ 结果聚合 → UI 反馈
```

核心代码结构：

```kotlin
class InspectionPipeline(private val context: Context) {
    private val detector = ObjectDetection.getClient(...)
    private val classifier = ImageClassification.getClient(...)
    private var lastResults: InspectionResult? = null

    fun process(imageProxy: ImageProxy) {
        val inputImage = InputImage.fromMediaImage(
            imageProxy.image!!, imageProxy.imageInfo.rotationDegrees
        )

        detector.process(inputImage).addOnSuccessListener { detections ->
            if (detections.isEmpty()) {
                lastResults = InspectionResult.Normal
                imageProxy.close()
                return@addOnSuccessListener
            }

            // 对每个检测到的区域做分类
            val detection = detections.first()
            val cropImage = cropToDetectionBox(inputImage, detection.boundingBox)
            classifier.process(cropImage).addOnSuccessListener { labels ->
                lastResults = when (labels.firstOrNull()?.text) {
                    "scratch" -> InspectionResult.Scratch(detection.boundingBox)
                    "dent" -> InspectionResult.Dent(detection.boundingBox)
                    else -> InspectionResult.Unknown
                }
                imageProxy.close()
            }
        }
    }
}
```

Pipeline 设计上我做了两个取舍：

**检测到目标后才触发分类**，而非每帧都跑分类器。这减少了 70% 的分类器调用次数——大部分生产画面其实是正常的，不需要分类判断。

**只取第一个检测结果做分类**。需求上检测到任意缺陷就应该报警，不需要对多个目标逐一分类。如果场景需要多目标分析，这个简化不适用。

## 端侧推理的工程落地经验

踩过的三个坑：

**第一个坑：模型加载时机。** 检测器和分类器加起来约 15MB，如果在 `onCreate` 里同步加载，首帧延迟超过 2 秒。正确做法是异步预加载：

```kotlin
// 在 Application 或 Splash 阶段完成
lifecycleScope.launch(Dispatchers.IO) {
    ObjectDetection.getClient(options) // 触发下载
}
```

ML Kit 的模型是懒加载的，首次调用 `process()` 时才真正初始化。提前调 `getClient()` 只是创建配置对象，**需要先跑一次空推理（warm-up）来触发模型加载**。我的做法是传一张 1×1 像素的空白帧进去，消耗约 200ms，换来了后续帧的零等待。

**第二个坑：线程模型。** `setAnalyzer` 的回调在 CameraX 内部线程上执行，如果在这里做同步耗时操作，会阻塞出帧。用 `addOnSuccessListener` 的异步回调没有这个问题，但如果 Pipeline 逻辑很重，应该把结果处理放到独立的 HandlerThread：

```kotlin
val analysisThread = HandlerThread("ml-inference").apply { start() }
val analysisHandler = Handler(analysisThread.looper)
```

不过实际项目中我发现，ML Kit 本身的推理已经在内部线程池执行，额外再开线程往往收益不大。重点反而是控制并发帧数——用 `AtomicBoolean` 做单帧保护：

```kotlin
private val isProcessing = AtomicBoolean(false)

setAnalyzer { imageProxy ->
    if (isProcessing.compareAndSet(false, true)) {
        pipeline.process(imageProxy) {
            isProcessing.set(false)
        }
    } else {
        imageProxy.close() // 跳过，但要关掉
    }
}
```

**第三个坑：设备兼容性。** ML Kit 的基础模型依赖 Google Play Services，部分国产手机（尤其海外版）的 Play Services 版本过低会导致模型不可用。用 `GoogleApiAvailability` 做运行时检查，降级策略是引导用户更新或切换到 TFLite 自定义模型。

## 端侧智能的适用边界

做完这个项目后我对"端侧该做什么"有了更清晰的认识。

ML Kit 擅长的领域：规则明确的视觉任务（检测、分类、OCR）、对延迟敏感的场景（<50ms 推理）、离线环境。不适合的领域：需要语义理解的任务（交给 LLM）、高精度需求（考虑云端大模型）、模型频繁更新的场景。

当时技术选型讨论中，产品经理想直接用 GPT-4V 的 API 做缺陷分析。我坚持端侧方案，理由很简单：工厂网络不稳定、延迟要求 <200ms、数据不能出园区。这三个约束直接把云端方案排除掉了。

如果场景也有类似约束，ML Kit + CameraX 的组合值得放进工具箱。它不是最"前沿"的方案，但在端侧实时视觉分析这件事上，它的成熟度目前还没有替代品。
