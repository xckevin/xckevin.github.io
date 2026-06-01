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

Bitmap 容易 OOM 的根本原因是图片解码后的像素内存远大于文件体积。一个几百 KB 的 JPG，解码成 ARGB_8888 后可能占用数 MB 甚至几十 MB。

内存占用大致等于宽度 x 高度 x 每像素字节数。ARGB_8888 每像素 4 字节，一张 4000 x 3000 图片解码后约 45.8 MB。

## 深入阅读

- [返回专题页](/android-performance/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
