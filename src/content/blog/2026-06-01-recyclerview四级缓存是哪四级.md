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

RecyclerView 的性能核心不是“少创建几个 View”这么简单，而是通过多层缓存决定一个位置上的 ViewHolder 能否快速复用。越靠前的缓存，复用成本越低；越靠后，越可能重新绑定甚至重新创建。

理解四级缓存，能解释很多列表问题：为什么滑回去很快，为什么跨类型列表容易卡，为什么共享 RecycledViewPool 能优化嵌套列表，为什么 DiffUtil 写错会让复用失效。

## 第一层：Attached Scrap

Attached Scrap 保存的是当前还附着在 RecyclerView 上、但在一次 layout 过程中暂时被分离的 ViewHolder。它们通常不需要重新绑定，因为还是同一批屏幕内 item。

典型场景是布局计算过程中 RecyclerView 先 detach，再根据新位置 attach 回去。如果 item 没有发生实质变化，从这一层拿回来成本最低。

这也是为什么 RecyclerView 在一次布局过程里能高效移动、复用屏幕内已有 View，而不是每次 layout 都销毁重建。

## 第二层：Cached Views

Cached Views 保存的是刚刚滑出屏幕的一小批 ViewHolder。它们保留了 position 和绑定状态，用户短距离反向滑动时可以直接拿回来。

默认缓存数量不大，因为这层缓存持有完整 View 树和数据绑定状态，数量太多会占内存。对于 item 复杂、用户经常来回滑的列表，可以谨慎调整 `setItemViewCacheSize()`，但不要把它当成通用优化开关。

如果数据集频繁变化，position 失效，Cached Views 的命中价值会下降。稳定的 itemId、合理的 DiffUtil 和清晰的数据变更通知，会直接影响这一层的效果。

## 第三层：ViewCacheExtension

ViewCacheExtension 是开发者自定义缓存入口，实际项目里用得不多。它允许你在 RecyclerView 默认缓存之外提供 View。

这层能力很强，但也很容易破坏 RecyclerView 自己的复用模型。除非你非常确定场景，例如特定类型 item 有可预测的复用规则，否则不建议优先使用。多数性能问题通过 DiffUtil、ViewHolder 绑定优化、RecycledViewPool 调整就能解决。

## 第四层：RecycledViewPool

RecycledViewPool 保存的是按 viewType 分类的废弃 ViewHolder。它不再绑定具体 position，拿出来后通常需要重新 `onBindViewHolder`。

这一层的价值在于减少 `onCreateViewHolder`。创建 ViewHolder 往往包含 inflate XML、创建子 View、初始化监听器，这些比普通 bind 更贵。复杂 item、嵌套 RecyclerView、横向列表尤其依赖 Pool。

嵌套列表常见优化是给多个子 RecyclerView 共享同一个 RecycledViewPool，并为高频 viewType 设置合适的 max recycled views。这样不同模块里的同类 item 可以复用同一批 ViewHolder。

## Prefetch 在做什么

GapWorker 会根据滑动方向和 LayoutManager 提供的信息，提前预取即将出现的 item。它的目标是把创建和绑定尽量挪到真正上屏之前，减少用户感知到的掉帧。

Prefetch 不是越多越好。预取太少，上屏时才创建 ViewHolder，会卡；预取太多，会抢占主线程或后台线程资源，甚至提前加载大量图片。嵌套 RecyclerView 中，`initialPrefetchItemCount` 要根据首屏可见数量设置，不要盲目放大。

## 列表卡顿通常不是缓存层单独的问题

缓存命中只能减少创建和部分绑定成本，但如果 `onBindViewHolder` 本身很重，命中 Pool 也会卡。常见问题包括：bind 中同步解码图片、格式化复杂字符串、读取数据库、创建大量对象、重复设置监听器、触发嵌套 layout。

优化顺序建议是：

1. 用 Perfetto 或 FrameMetrics 确认卡顿发生在滑动哪一段。
2. 看 `onCreateViewHolder` 是否频繁，判断 Pool 是否不够。
3. 看 `onBindViewHolder` 是否过重，拆出异步和预计算。
4. 检查 DiffUtil、stableId、notifyDataSetChanged 是否破坏复用。
5. 对嵌套列表共享 RecycledViewPool 并调 prefetch。

RecyclerView 的缓存机制很成熟，但它只能帮你复用 ViewHolder，不能替你修正过重的绑定逻辑。列表性能最终还是缓存、数据变更、图片加载和布局复杂度共同决定的。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch](/blog/2026-04-14-深入_android_recyclerview_缓存机制_从四级缓存到_prefetch_的性能设计/)
- [Android 渲染机制与图形栈：View、HWUI、SurfaceFlinger 全链路](/blog/android渲染机制与图形栈深入理解/)
- [Bitmap 为什么容易导致 OOM？Android 图片内存模型入门](/blog/android-bitmap-oom/)
<!-- /seo-internal-links -->
