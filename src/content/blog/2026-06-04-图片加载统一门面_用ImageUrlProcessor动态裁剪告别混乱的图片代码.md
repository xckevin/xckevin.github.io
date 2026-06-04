---
title: 图片加载统一门面：用 ImageUrlProcessor 动态裁剪与门面模式告别混乱的图片代码
excerpt: 图片加载是移动端体验的基础能力，但如果每个页面都直接调用底层库，URL 拼接规则、尺寸参数、预加载逻辑就会散落全项目。本文介绍一种图片加载统一门面设计，通过 ImageUrlProcessor 集中处理动态裁剪，配合门面接口、预加载调度和监控，让业务只关心展示意图。
publishDate: '2026-06-04'
tags:
- Android
- 图片加载
- 性能优化
- 门面模式
- 架构设计
seo:
  title: 图片加载统一门面：用 ImageUrlProcessor 动态裁剪与门面模式告别混乱的图片代码
  description: 图片加载统一门面设计，通过 ImageUrlProcessor 集中处理动态裁剪，配合门面接口隔离底层库、预加载调度和监控，让业务代码只关心资源和展示意图。
---

移动端图片加载通常涉及多个层次：URL 处理、加载行为、生命周期管理、性能观测。如果所有页面都直接调用底层图片库，这些问题很难统一解决。比如某个页面忘记传尺寸参数，导致下载原图；另一个页面自己拼接裁剪参数，和服务端约定不一致；还有页面为了避免闪烁关闭缓存，结果造成流量浪费。更麻烦的是，一旦底层图片库升级或替换，全项目都要改。

我们项目里的图片体系主要落在 `common/imageloader` 下。`ImageLoaderUtil` 是业务侧统一入口，Glide 的 `GlideImageLoaderStrategy` 承接底层实现，`ImageUrlProcessor` 负责 URL 处理，`ImagePreloader` 与 `StaggeredGridPreloader` 负责预加载，`transformation` 包提供圆角、圆形、模糊等转换，`progress` 包提供下载进度回调。这个结构和业务高度相关：内容卡片、详情页、搜索结果、Feed、视觉搜索、启动页都大量依赖图片，同一张图片会在不同场景下以不同尺寸、质量和裁剪策略出现。

## 门面 + 配置对象 + ImageUrlProcessor + 预加载

我们采用了"门面 + 配置对象 + ImageUrlProcessor + 预加载"四段式：页面只描述目标场景、ImageView 容器和期望质量，基础设施决定真实 URL、裁剪宽高、DPR、格式、质量、优先级、回调和缓存策略。

```kotlin
data class ImageRequest(
    val source: ImageSource,
    val scene: String,
    val targetSize: Size,
    val scaleType: ScaleType,
    val placeholder: Placeholder?,
    val errorPlaceholder: Placeholder?,
    val cornerRadiusDp: Float,
    val cachePolicy: ImageCachePolicy,
    val priority: Priority,
    val lifecycle: LifecycleRef?
)

interface ImageLoaderFacade {
    fun load(request: ImageRequest, target: ImageTarget): Disposable
    fun preload(request: ImageRequest): Disposable
    fun clear(target: ImageTarget)
    fun pause(scene: String)
    fun resume(scene: String)
    fun trimMemory(level: Int)
}
```

## ImageUrlProcessor：动态裁剪的核心

ImageUrlProcessor 的核心价值不是简单在 URL 后面拼一个固定宽高，而是把 UI 容器尺寸、屏幕密度、业务场景、网络状态、图片原始比例、服务端裁剪能力统一计算成"最合适的远端图片规格"。

例如一个 180dp 宽的卡片，在 3x 屏幕上需要约 540px 的物理宽度；如果容器高度由比例决定，可以按目标宽高生成裁剪参数；如果弱网或省流模式开启，可以降低质量等级；如果进入预加载场景，可以选择稍低优先级但保持同一裁剪 key，保证预加载和正式加载命中同一缓存。

```kotlin
class ImageUrlProcessor(
    private val device: DeviceInfo,
    private val network: NetworkProfile,
    private val cdn: CdnRule
) {
    fun process(source: ImageSource, target: ImageTargetInfo, scene: String): ProcessedImage {
        val policy = scenePolicy(scene)
        val pxWidth = bucket(target.widthDp * device.density, policy.sizeBucket)
        val pxHeight = target.heightDp
            ?.let { bucket(it * device.density, policy.sizeBucket) }
            ?: policy.aspectRatio?.let { (pxWidth / it).toInt() }

        val quality = if (network.saveDataMode) policy.quality.downgrade() else policy.quality
        val format = if (policy.allowFormatUpgrade && device.supportModernFormat)
            ImageFormat.MODERN else ImageFormat.COMPAT

        val url = cdn.buildUrl(source.safeId, pxWidth, pxHeight, quality, format)
        return ProcessedImage(
            url = url,
            cacheKey = "${source.stableId}:$pxWidth:$pxHeight:$quality:$format",
            logAlias = "scene=$scene,width=$pxWidth,quality=$quality,format=$format"
        )
    }

    private fun bucket(value: Float, bucket: Int): Int {
        return ((value / bucket).roundToInt() * bucket).coerceAtLeast(bucket)
    }
}
```

尺寸分桶非常关键。不能每一个像素差异都生成不同 URL，否则缓存会碎片化。把 517px、528px、540px 归一到同一个 540px 桶，兼顾清晰度和缓存命中。

## 预加载调度器：让位给可见内容

预加载体系的目标是提前准备"即将可见"的图片，而不是盲目下载所有图片。预加载管理器需要支持去重、优先级控制、窗口控制、网络条件判断和取消机制：

```kotlin
class ImagePreloadManager(
    private val loader: ImageLoaderFacade,
    private val policy: PreloadPolicy
) {
    private val running = mutableMapOf<String, Disposable>()

    fun preloadNext(scene: String, items: List<ImageSource>, viewport: ViewportInfo) {
        if (!policy.allowPreload()) return
        val candidates = policy.pickCandidates(items, viewport)

        running.keys.filter { it !in candidates.map { it.stableKey() } }
            .forEach { key -> running.remove(key)?.dispose() }

        candidates.forEach { source ->
            val key = source.stableKey()
            if (running.containsKey(key)) return@forEach
            running[key] = loader.preload(ImageRequest(
                source = source, scene = scene,
                targetSize = policy.preloadSize(),
                cachePolicy = ImageCachePolicy.DiskOnly,
                priority = Priority.Low, lifecycle = null, ...
            ))
        }
    }
}
```

当前屏图片永远优先于预加载。预加载任务应使用低优先级，必要时暂停或取消。

## 落地中的关键约束

门面不要泄漏底层类型。如果 ImageRequest 中出现了具体图片库的 Transformation 或 RequestOptions，隔离就失败了。底层类型只能存在于 Adapter 内部。

URL 处理必须有统一入口。即使某些页面需求特殊，也应通过扩展 ImageOptions 或资源类型配置来表达，而不是允许页面手写拼接逻辑。

监控不要记录完整 URL。图片 URL 常包含签名、尺寸参数、资源路径，日志中应使用别名、哈希和安全维度。取消不算失败——列表复用和页面销毁会产生大量取消事件，如果直接计入失败率，会误导稳定性判断。

---

图片加载统一门面的价值，在于把"页面怎么调用图片库"升级为"客户端如何管理图片资源"。工程上要避免两个极端：完全裸用底层库，短期简单但长期难维护；把门面设计得过度复杂，让业务构造请求比直接加载还麻烦。更合理的方式是提供稳定默认值和少量明确扩展点：普通图片一行配置即可加载，复杂场景可以通过 ImageRequest 精细声明。最终，一个成熟的图片体系应该让业务只关心资源和展示意图，让基础设施负责 URL 处理、缓存策略、预加载、生命周期、监控和降级。