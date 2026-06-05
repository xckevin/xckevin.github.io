---
title: "A Unified Image Loading Facade with ImageUrlProcessor"
lang: en
translationKey: image-loading-facade-imageurlprocessor-dynamic-resizing
slug: image-loading-facade-imageurlprocessor-dynamic-resizing
excerpt: "If every page calls the image library directly, URL rules, size parameters, and preload logic scatter across the codebase. This article introduces a unified image-loading facade built around ImageUrlProcessor, preload scheduling, and observability."
publishDate: '2026-06-04'
tags:
- "Android"
- "Image Loading"
- "Performance Optimization"
- "Facade Pattern"
- "Architecture"
seo:
  title: "Unified Android Image Loading with ImageUrlProcessor"
  description: "Build a unified Android image-loading facade with ImageUrlProcessor for dynamic resizing, library isolation, preload scheduling, and cleaner business code."
  pageType: article
---

Mobile image loading spans URL processing, loading behavior, lifecycle management, caching, and observability. If every screen calls the underlying image library directly, these concerns become difficult to manage consistently. One screen might forget to pass size parameters and download full-resolution images; another might construct crop parameters manually and drift from backend rules; a third might disable cache to avoid flicker and waste bandwidth. If the underlying image library is upgraded or replaced, all of that scattered code becomes migration work.

In our project, the image system lives mainly under `common/imageloader`. `ImageLoaderUtil` is the unified entry point for product code. Glide's `GlideImageLoaderStrategy` handles the underlying implementation, `ImageUrlProcessor` manages URL processing, `ImagePreloader` and `StaggeredGridPreloader` handle preloading, the `transformation` package provides effects such as rounded corners, circles, and blur, and the `progress` package exposes download progress callbacks. This structure is closely tied to product surfaces: content cards, detail pages, search results, feeds, visual search, and splash screens all rely heavily on images, and the same image may appear with different size, quality, and crop requirements.

## Facade + Configuration Object + ImageUrlProcessor + Preloading

We adopted a four-part pattern: "Facade + Configuration Object + ImageUrlProcessor + Preloading." Pages only need to describe the target scenario, the `ImageView` container, and the desired quality. The infrastructure layer then determines the actual URL, crop dimensions, DPR, format, quality, priority, callbacks, and caching strategy.

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

## ImageUrlProcessor: The Core of Dynamic Cropping

The core value of `ImageUrlProcessor` is not simply appending fixed dimensions to a URL. Instead, it unifies the calculation of the "most appropriate remote image specification" by considering the UI container size, screen density, business context, network status, original image aspect ratio, and server-side cropping capabilities.

For example, a card with a width of 180dp on a 3x screen requires a physical width of about 540px. If the container height is determined by aspect ratio, cropping parameters can be generated based on target dimensions. If weak network or data-saving mode is active, the quality level can be reduced. If entering a preloading scenario, we can opt for a slightly lower priority while maintaining the same crop key to ensure preloading and actual loading hit the same cache.

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

Size bucketing is crucial. We cannot generate a different URL for every pixel difference; otherwise, the cache will become fragmented. By grouping 517px, 528px, and 540px into the same 540px bucket, we balance clarity and cache hit rate.

## Preload Scheduler: Yielding to Visible Content

The goal of the preloading system is to prepare images that are "about to become visible," not to blindly download every image. The preloading manager must support deduplication, priority control, viewport management, network condition checking, and cancellation mechanisms:

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

Images currently on screen always take precedence over preloading. Preloading tasks should use low priority and should be paused or canceled if necessary.

## Key Constraints in Implementation

The facade must not leak underlying types. If `ImageRequest` contains specific image library `Transformation` or `RequestOptions`, the isolation fails. Underlying types should only exist within the Adapter.

URL processing must have a unified entry point. Even if certain pages have special requirements, they should be expressed through extending `ImageOptions` or resource type configurations, rather than allowing pages to write manual concatenation logic.

Monitoring should not record the full URL. Image URLs often contain signatures, size parameters, and resource paths; logs should use aliases, hashes, and safe dimensions. Cancellation should not count as failure—list recycling and page destruction generate many cancellation events, and counting them directly will mislead stability assessments.

---

The value of a unified image-loading facade is shifting the question from "how does this page call the image library?" to "how does the client manage image resources?" Avoid two extremes: calling the underlying library directly, which is simple at first but difficult to maintain; and designing a facade so complex that constructing a request is harder than loading the image directly. A better approach is to provide stable defaults and a few explicit extension points: simple configuration for ordinary images, and precise `ImageRequest` declarations for complex cases. A mature image system lets product code describe the resource and display intent, while URL processing, caching, preloading, lifecycle management, monitoring, and fallback remain infrastructure concerns.
