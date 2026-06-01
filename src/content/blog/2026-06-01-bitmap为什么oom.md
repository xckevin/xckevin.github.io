---
title: "Bitmap 为什么容易导致 OOM？Android 图片内存模型入门"
slug: android-bitmap-oom
excerpt: "解释 Bitmap 内存占用、Java 堆与 Native 堆差异、Hardware Bitmap、采样压缩和图片加载优化。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Bitmap"
- "内存优化"
seo:
  title: "Bitmap 为什么容易导致 OOM？Android 图片内存模型解析"
  description: "讲解 Android Bitmap OOM 原因，覆盖像素内存、Java 堆、Native 堆、Hardware Bitmap、采样压缩与图片缓存策略。"
---

Bitmap 容易导致 OOM 的根本原因是：图片文件大小和解码后的像素内存不是一回事。一个几百 KB 的 JPG，解码成 `ARGB_8888` 后可能占用数 MB 甚至几十 MB。

文件体积是压缩后的存储大小，Bitmap 占用的是运行时像素缓冲。OOM 看的是后者。

## 先算清楚一张图占多少内存

Bitmap 内存大致可以按这个公式估算：

```text
width * height * bytesPerPixel
```

`ARGB_8888` 每个像素 4 字节，一张 4000 x 3000 的图片解码后约 45.8 MB。列表里同时持有 5 张这样的图，就已经接近很多设备上单进程可用内存的危险区。

更容易踩坑的是缩略图。服务端返回一张 2MB 的高清图，客户端只显示成 120dp 的头像。如果不按目标尺寸采样解码，内存仍然按原图尺寸分配。用户看到的是小图，内存里却躺着大图。

## Java 堆、Native 堆和 Hardware Bitmap

Android 早期 Bitmap 像素数据主要放在 Native 堆，后来不同版本在 Java 堆和 Native 堆之间有过调整。现在开发者更应该关注的是：Bitmap 内存不一定都体现在 Java 对象大小上，但它一定会计入进程整体内存压力。

`Hardware Bitmap` 又是另一类。它把像素数据放到 GPU 友好的内存里，适合只读显示，能减少 CPU 到 GPU 的上传成本。但它不能随便在 Canvas 上修改，也不适合需要频繁像素操作的场景。

所以图片优化不能只问“这张图在不在 Java 堆”。真正要看的是进程 PSS、图像缓存、GPU 纹理、Native 分配和生命周期。

## 为什么列表图片最容易出问题

列表场景有三个放大器。

第一，图片数量多。单张图 2MB 不可怕，几十张同时在内存缓存、解码队列、预加载队列里就会很可怕。

第二，生命周期复杂。ViewHolder 复用后，旧请求如果没有取消，图片可能加载到错误的 item 上，也可能让无用 Bitmap 多活一段时间。

第三，预加载容易过度。为了滑动流畅，图片库会提前解码即将出现的图片。但预加载距离过大、缓存过大、原图尺寸过大，会把流畅性优化变成内存问题。

RecyclerView 图片优化要同时看两条线：滑动帧率和内存曲线。只看其中一个，很容易从卡顿优化成 OOM，或者从 OOM 优化成白屏闪烁。

## 实战里怎么避免 Bitmap OOM

第一，按展示尺寸解码。头像、封面、缩略图都应该请求合适尺寸，或者在客户端用 `inSampleSize`、图片库 resize/override 控制解码尺寸。不要把原图交给 ImageView 自己缩放。

第二，选择合适的像素格式。对不需要透明通道的图，`RGB_565` 可以把每像素 4 字节降到 2 字节，但会损失色彩质量。它适合部分缩略图，不适合高质量大图。

第三，控制内存缓存。Glide、Coil、Fresco 都有内存缓存和 BitmapPool 策略。缓存不是越大越好，应该根据页面类型、设备内存等级和列表密度调整。

第四，及时取消请求。ViewHolder 解绑、页面销毁、Fragment view 销毁时，要让图片请求跟生命周期绑定。现代图片库已经做了很多封装，但自定义 Target、自定义下载器时很容易绕开生命周期。

第五，大图分区加载。长图、超大图、地图类图片、漫画类图片不要完整解码到内存。Subsampling、Tile、RegionDecoder 这类方案更合适。

## OOM 排查看什么

线上遇到图片 OOM，先看崩溃堆栈里是否有 `BitmapFactory`、图片库解码、纹理上传、列表预加载。然后结合内存快照看 Bitmap 数量、尺寸分布和持有链。

如果大部分 Bitmap 尺寸远大于 View 展示尺寸，优先治理采样；如果 Bitmap 数量异常，优先看缓存和生命周期；如果 Java 堆不高但进程内存高，继续看 Native/GPU 侧内存。

图片 OOM 很少靠“手动 recycle 一下”解决。真正稳定的方案是尺寸正确、缓存有界、生命周期清晰、超大图走专门链路。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [RecyclerView 四级缓存是哪四级？从复用链路理解列表性能](/blog/recyclerview-cache-levels/)
<!-- /seo-internal-links -->
