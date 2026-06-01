---
title: "RecyclerView 四级缓存是哪四级？从复用链路理解列表性能"
slug: recyclerview-cache-levels
excerpt: "解释 RecyclerView 四级缓存、ViewHolder 复用顺序、RecycledViewPool 和 Prefetch 对滑动性能的影响。"
publishDate: '2026-06-01'
tags:
- "Android"
- "RecyclerView"
- "性能优化"
seo:
  title: "RecyclerView 四级缓存是哪四级？ViewHolder 复用机制解析"
  description: "用简明路径解释 RecyclerView 四级缓存、ViewHolder 复用、RecycledViewPool、Prefetch 与列表滑动性能优化。"
---

RecyclerView 的性能核心不是“少创建几个 View”这么简单，而是通过多层缓存决定一个位置上的 ViewHolder 能否快速复用。

## 四级缓存概览

常见分析里会把 RecyclerView 缓存理解成四层：Attached Scrap、Cached Views、ViewCacheExtension、RecycledViewPool。越靠前的缓存，复用成本越低。

## Prefetch 在做什么

GapWorker 会根据滑动方向提前预取即将出现的 item，让创建和绑定尽量发生在真正上屏之前。

## 深入阅读

- [返回专题页](/android-performance/)
- [RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch](/blog/2026-04-14-深入_android_recyclerview_缓存机制_从四级缓存到_prefetch_的性能设计/)
- [Android 渲染机制与图形栈：View、HWUI、SurfaceFlinger 全链路](/blog/android渲染机制与图形栈深入理解/)
