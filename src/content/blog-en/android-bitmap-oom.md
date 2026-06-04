---
title: "Why Bitmap Causes OOM on Android: A Practical Guide to Image Memory"
lang: en
translationKey: android-bitmap-oom
slug: android-bitmap-oom
excerpt: "Explains Bitmap memory usage, Java heap vs. native heap, Hardware Bitmap, sampling, compression, and image loading optimization."
publishDate: '2026-06-01'
tags:
- "Android"
- "Bitmap"
- "Memory Optimization"
- "Performance"
seo:
  title: "Why Bitmap Causes OOM on Android: Image Memory Model Explained"
  description: "Learn why Android Bitmap causes OOM, including pixel memory, Java heap, native heap, Hardware Bitmap, sampling, and image cache strategy."
  pageType: article
---

Bitmap often causes OOM because file size and decoded pixel memory are not the same thing. A JPEG that is only a few hundred KB on disk can take several MB, or even tens of MB, after it is decoded as `ARGB_8888`.

File size is the compressed storage size. Bitmap memory is the runtime pixel buffer. OOM is about the latter.

## First, calculate how much memory an image uses

Bitmap memory can be roughly estimated with this formula:

```text
width * height * bytesPerPixel
```

`ARGB_8888` uses 4 bytes per pixel. A 4000 x 3000 image takes about 45.8 MB after decoding. If a list holds five images like that at the same time, many devices are already close to dangerous territory for per-process memory.

Thumbnails are an even more common trap. The server returns a 2 MB high-resolution image, but the client only displays it as a 120dp avatar. If you do not decode it with sampling based on the target size, memory is still allocated for the original dimensions. The user sees a small image, but memory holds a large one.

## Java heap, native heap, and Hardware Bitmap

In early Android versions, Bitmap pixel data mainly lived in the native heap. Later versions moved through different arrangements between Java heap and native heap. Today, the more useful takeaway is this: Bitmap memory may not be fully reflected in the Java object size, but it still contributes to overall process memory pressure.

`Hardware Bitmap` is a separate category. It stores pixels in GPU-friendly memory, works well for read-only display, and can reduce CPU-to-GPU upload cost. But it cannot be freely modified with Canvas, and it is not suitable for flows that frequently read or manipulate pixels.

So image optimization should not stop at the question, "Is this image on the Java heap?" The real picture includes process PSS, image caches, GPU textures, native allocations, and lifecycle.

## Why list images fail so easily

List screens have three multipliers.

First, there are many images. A single 2 MB image is not scary. Dozens of images in memory cache, decode queues, and preload queues can become scary very quickly.

Second, lifecycle is complicated. After a ViewHolder is reused, an old request that was not canceled can load into the wrong item, or it can keep an unnecessary Bitmap alive longer than needed.

Third, preloading can be excessive. Image libraries decode upcoming images to keep scrolling smooth. But if the preload distance is too large, the cache is too large, or source images are too large, a smoothness optimization becomes a memory problem.

RecyclerView image optimization has to follow two lines at the same time: scroll frame rate and the memory curve. If you only watch one, it is easy to turn jank into OOM, or OOM into blank-image flicker.

## How to avoid Bitmap OOM in practice

First, decode to the display size. Avatars, covers, and thumbnails should request the right size from the server, or use `inSampleSize`, image-library resize, or image-library override APIs to control decoded dimensions on the client. Do not hand the original image to ImageView and let it scale visually.

Second, choose the right pixel format. For images that do not need transparency, `RGB_565` reduces memory from 4 bytes per pixel to 2 bytes per pixel, at the cost of color quality. It can work for some thumbnails, but it is not appropriate for high-quality large images.

Third, bound the memory cache. Glide, Coil, and Fresco all have memory cache and BitmapPool policies. Bigger is not automatically better. Tune the cache based on page type, device memory class, and list density.

Fourth, cancel requests promptly. When a ViewHolder is unbound, a page is destroyed, or a Fragment view is destroyed, image requests should be tied to lifecycle. Modern image libraries handle a lot of this for standard usage, but custom Targets and custom downloaders can easily bypass lifecycle handling.

Fifth, load very large images in regions. Long images, huge images, maps, and comic pages should not be fully decoded into memory. Subsampling, tiles, and RegionDecoder-style approaches are better fits.

## What to inspect when diagnosing OOM

When image-related OOM appears in production, first check whether the crash stack includes `BitmapFactory`, image-library decoding, texture upload, or list preloading. Then use memory snapshots to inspect Bitmap count, size distribution, and retainers.

If most Bitmaps are much larger than their rendered Views, fix sampling first. If the Bitmap count is abnormal, look at cache policy and lifecycle. If the Java heap is not high but process memory is high, keep investigating native and GPU-side memory.

Image OOM is rarely fixed by "just call recycle manually." The stable solution is correct dimensions, bounded caches, clear lifecycle, and a dedicated path for truly huge images.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android performance optimization](/en/android-performance/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [What are the four RecyclerView cache levels? Understanding list performance through the reuse pipeline](/blog/recyclerview-cache-levels/)
<!-- /seo-internal-links -->
