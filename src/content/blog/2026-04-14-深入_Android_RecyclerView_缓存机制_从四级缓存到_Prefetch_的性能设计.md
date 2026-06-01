---
title: "深入 Android RecyclerView 缓存机制：从四级缓存到 Prefetch 的性能设计"
excerpt: "逐层拆解 RecyclerView 四级缓存体系（Scrap、Cache、ViewCacheExtension、RecycledViewPool）的设计意图与命中成本差异，结合 GapWorker 预取策略，给出列表滑动流畅度的实战调优方向。"
publishDate: 2026-04-14
tags:
  - Android
  - RecyclerView
  - 性能优化
  - 缓存机制
  - 列表优化
seo:
  title: "RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch"
  description: "深入解析 RecyclerView 四级缓存、ViewHolder 复用、RecycledViewPool、GapWorker 预取与列表性能优化实践。"
---

做列表滑动流畅度优化时，我遇到过一个反直觉的现象：同样的 ViewHolder 数量，把 `RecycledViewPool` 的缓存上限从 5 调到 20，帧率反而下降了。排查后发现，根本原因是我对缓存层级的理解不够精确——不同层级的缓存命中，成本差异很大。

这篇文章把 RecyclerView 的缓存体系逐层拆开看。

## 四级缓存全景

RecyclerView 的 `Recycler` 内部维护了四级缓存，按查找优先级排列：

| 层级 | 名称 | 是否需要 rebind | 典型容量 |
|------|------|----------------|----------|
| 1 | Scrap (mAttachedScrap / mChangedScrap) | 否 | 屏幕可见项 |
| 2 | Cache (mCachedViews) | 否 | 默认 2 |
| 3 | ViewCacheExtension | 自定义 | 自定义 |
| 4 | RecycledViewPool | **是** | 每类型默认 5 |

重点看第四列：前两级缓存命中后，ViewHolder 直接复用，**不走 `onBindViewHolder`**；而 RecycledViewPool 取出的 ViewHolder 需要重新绑定数据。这个差异直接决定了性能调优的方向。

## Scrap：布局过程中的临时暂存

Scrap 不是传统意义上的"缓存"，它更像布局过程中的临时停车场。当 RecyclerView 触发 `requestLayout` 或执行动画时，LayoutManager 先把屏幕上的所有 ViewHolder 批量 detach 到 Scrap 列表，重新布局后再逐个取回。

```java
// RecyclerView.Recycler 的核心逻辑简化
void scrapView(View view) {
    final ViewHolder holder = getChildViewHolderInt(view);
    if (holder.hasAnyOfTheFlags(ViewHolder.FLAG_REMOVED | ViewHolder.FLAG_INVALID)) {
        holder.setScrapContainer(this, true);  // 放入 mChangedScrap
    } else {
        holder.setScrapContainer(this, false); // 放入 mAttachedScrap
    }
}
```

两个子列表分工明确：`mAttachedScrap` 存放位置未变的项，`mChangedScrap` 存放数据发生变化的项（配合 `ItemAnimator` 做渐变动画）。Scrap 的生命周期仅限于一次 layout pass，布局完成后即清空。

我踩过的一个坑：调用 `notifyDataSetChanged()` 后，所有 ViewHolder 会被标记为 `FLAG_INVALID`，直接跳过 Scrap 进入 RecycledViewPool。这就是全量刷新比局部刷新（`DiffUtil`）慢得多的原因——前者强制所有项都走 rebind。

## Cache：滑出屏幕的短期记忆

`mCachedViews` 是一个 ArrayList，默认大小为 2。ViewHolder 被滑出屏幕后，先进入这个列表。Cache 按 **position** 匹配，命中后无需重新绑定。

用户小幅度来回滑动时，刚离开屏幕的项能瞬间恢复，体验非常丝滑。但 Cache 满了之后，最早进入的 ViewHolder 会被挤出，降级到 RecycledViewPool。

```kotlin
// 调整 Cache 大小
recyclerView.setItemViewCacheSize(4) // 默认 2，按场景适当增大
```

在实际项目中我发现，消息列表、Feed 流这类用户频繁上下滑动的场景，把 Cache 调到 4-5 有明显收益。但不宜再大——Cache 里的 ViewHolder 持有完整的 View 树和数据引用，内存开销不低。

## RecycledViewPool：跨类型的回收站

RecycledViewPool 按 `viewType` 分桶存储，每种类型默认上限 5 个。从这里取出的 ViewHolder 已经被 `resetInternal()` 清理过状态，必须重新调用 `onBindViewHolder`。

```kotlin
// 多 RecyclerView 共享 Pool（如 ViewPager2 + 多 Tab 列表）
val sharedPool = RecyclerView.RecycledViewPool()
sharedPool.setMaxRecycledViews(VIEW_TYPE_CARD, 10)
recyclerView1.setRecycledViewPool(sharedPool)
recyclerView2.setRecycledViewPool(sharedPool)
```

共享 Pool 在 ViewPager2 嵌套多个同构列表时很实用——切换 Tab 时不用重新 `onCreateViewHolder`，直接省掉 inflate 开销。

回到开头的问题：为什么把 Pool 上限调到 20 反而更慢？原因有两个：Pool 越大，缓存的废弃 ViewHolder 越多，GC 压力随之增加；而 Pool 命中本身就要走 bind 流程，并不比重新创建快多少（inflate 才是真正的大头）。**Pool 的核心价值是避免 inflate，而不是避免 bind。** 调优时应该关注 inflate 耗时，而非盲目加大 Pool。

## ViewCacheExtension：很少用但值得了解的扩展点

第三级 `ViewCacheExtension` 是一个抽象类，只有一个方法：

```java
public abstract View getViewForPositionAndType(Recycler recycler, int position, int type);
```

实际项目中很少有人用它，但在特定场景下确实有价值——比如列表中有固定的广告位或 Header，这些 View 数据不变，可以通过 Extension 直接返回缓存实例，完全跳过 bind 和 create。相当于给特定 position 开了一条快速通道。

## Prefetch：GapWorker 的预取策略

从 Support Library 25.1 开始，RecyclerView 引入了 `GapWorker` 实现预取。思路是：滑动时 RenderThread 在处理当前帧的渲染，UI 线程处于空闲状态。`GapWorker` 利用这段空闲窗口，提前创建和绑定即将进入屏幕的 ViewHolder。

```java
// GapWorker 的调度逻辑（简化）
void prefetch(long deadlineNs) {
    // 根据滑动方向和速度，预测需要的 position
    // 在 deadline 之前尽可能完成 create + bind
    while (hasMoreWork && System.nanoTime() < deadlineNs) {
        RecyclerView.ViewHolder holder = recyclerview.mRecycler
            .tryGetViewHolderForPositionByDeadline(position, deadlineNs);
        // ...
    }
}
```

`GapWorker` 通过 Choreographer 注册回调，在每帧的 VSYNC 信号后触发。它根据 LayoutManager 的 `collectAdjacentPrefetchPositions` 方法获取预取列表，LinearLayoutManager 默认预取滑动方向上的 1 个 item。

```kotlin
// 自定义预取数量
(recyclerView.layoutManager as LinearLayoutManager).apply {
    initialPrefetchItemCount = 3 // 嵌套内层列表建议设大一些
}
```

嵌套 RecyclerView（横向列表嵌在纵向列表里）场景下，`initialPrefetchItemCount` 的调优尤其关键。内层列表首次出现时需要一次性创建多个 ViewHolder，预取能把这部分开销分摊到前几帧，避免集中创建导致的掉帧。

## 缓存查找的完整路径

把查找流程串起来看，`tryGetViewHolderForPositionByDeadline` 的逻辑大致如下：

1. 从 `mChangedScrap` 中按 position 查找（仅 pre-layout 阶段）
2. 从 `mAttachedScrap` 和 `mCachedViews` 中按 position 精确匹配
3. 如果设置了 `stableId`，从 Scrap 和 Cache 中按 id 查找
4. 调用 `ViewCacheExtension.getViewForPositionAndType`
5. 从 `RecycledViewPool` 中按 viewType 查找
6. 全部未命中，调用 `onCreateViewHolder` 新建

**步骤 1-3 命中的 ViewHolder 不需要 rebind，步骤 5-6 需要。** 这就是性能差异的根源。

## 实战调优建议

几条在项目中验证过的策略：

- **用 `DiffUtil` 替代 `notifyDataSetChanged`**，让更多 ViewHolder 走 Scrap 而非 Pool，避免不必要的 rebind。
- **嵌套列表共享 RecycledViewPool**，配合 `initialPrefetchItemCount` 减少首次展示的卡顿。
- **`onBindViewHolder` 里避免重对象创建**，Pool 命中的 ViewHolder 每次都会走 bind，这里的耗时直接影响滚动帧率。
- **通过 `setHasStableIds(true)` 启用 id 匹配**，数据顺序变化但内容不变时，能提高 Cache 和 Scrap 的命中率。

RecyclerView 的缓存设计本质上是分层的时间-空间权衡：离屏幕越近的缓存越快但越贵，离屏幕越远的缓存越省内存但恢复成本越高。理解每一层的边界条件，才能做出有效的调优决策，而不是一味调大缓存数量。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/app启动优化专项/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [Android RenderThread 与 HWUI：渲染管线、DisplayList 与掉帧分析](/blog/2026-04-20-android_renderthread_与_hwui_渲染管线深度解析_从_displaylist/)
<!-- /seo-internal-links -->
