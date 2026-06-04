---
title: "Android RecyclerView Cache: Four Levels, Reuse, and Prefetch"
excerpt: "A deep dive into RecyclerView's four cache layers, their different hit costs, GapWorker prefetch, and practical tuning for smoother scrolling."
publishDate: 2026-04-14
lang: en
slug: android-recyclerview-cache-prefetch-deep-dive
translationKey: android-recyclerview-cache-prefetch-deep-dive
tags:
  - Android
  - RecyclerView
  - Performance Optimization
  - Cache Mechanism
  - List Optimization
seo:
  title: "RecyclerView Cache: Four Levels, Reuse, and Prefetch"
  description: "A practical deep dive into RecyclerView cache layers, ViewHolder reuse, RecycledViewPool, GapWorker prefetch, and list performance tuning."
  pageType: article
---

While optimizing list scrolling smoothness, I ran into a counterintuitive result: with the same number of ViewHolders, raising the `RecycledViewPool` limit from 5 to 20 actually lowered the frame rate. Investigation showed that the root cause was an imprecise understanding of the cache hierarchy. A cache hit at one layer can cost very different work from a hit at another layer.

This article breaks down RecyclerView's cache system layer by layer.

## The Four-Level Cache at a Glance

RecyclerView's `Recycler` maintains four cache layers, searched in priority order:

| Level | Name | Requires Rebind | Typical Capacity |
|------|------|----------------|----------|
| 1 | Scrap (`mAttachedScrap` / `mChangedScrap`) | No | Visible items |
| 2 | Cache (`mCachedViews`) | No | Default 2 |
| 3 | ViewCacheExtension | Custom | Custom |
| 4 | RecycledViewPool | **Yes** | Default 5 per type |

The key column is the fourth one: after a hit in the first two layers, the ViewHolder is reused directly and **does not go through `onBindViewHolder`**. A ViewHolder taken from RecycledViewPool must be rebound. That difference directly determines the direction of performance tuning.

## Scrap: Temporary Holding During Layout

Scrap is not a traditional "cache." It is more like a temporary parking area during layout. When RecyclerView triggers `requestLayout` or runs animations, LayoutManager first detaches all on-screen ViewHolders into Scrap lists, then retrieves them one by one during the new layout.

```java
// Simplified core logic from RecyclerView.Recycler.
void scrapView(View view) {
    final ViewHolder holder = getChildViewHolderInt(view);
    if (holder.hasAnyOfTheFlags(ViewHolder.FLAG_REMOVED | ViewHolder.FLAG_INVALID)) {
        holder.setScrapContainer(this, true);  // Put into mChangedScrap.
    } else {
        holder.setScrapContainer(this, false); // Put into mAttachedScrap.
    }
}
```

The two sublists have clear roles. `mAttachedScrap` stores items whose positions have not changed, while `mChangedScrap` stores items whose data has changed, usually together with `ItemAnimator` for change animations. Scrap lives only for a single layout pass and is cleared once layout finishes.

One pitfall I have hit: after calling `notifyDataSetChanged()`, all ViewHolders are marked with `FLAG_INVALID`, so they skip Scrap and go directly to RecycledViewPool. This is why full refreshes are much slower than partial refreshes with `DiffUtil`: the former forces every item through rebind.

## Cache: Short-Term Memory for Off-Screen Items

`mCachedViews` is an ArrayList with a default size of 2. After a ViewHolder scrolls off screen, it enters this list first. Cache matches by **position**, and a hit does not require rebinding.

When users scroll slightly back and forth, recently disappeared items can be restored instantly, making the experience very smooth. Once Cache is full, the earliest ViewHolder in it is pushed out and downgraded into RecycledViewPool.

```kotlin
// Adjust Cache size.
recyclerView.setItemViewCacheSize(4) // Default is 2; increase moderately by scenario.
```

In real projects, I have found clear benefits from raising Cache to 4-5 for message lists and feed streams where users often scroll up and down. But it should not be much larger. ViewHolders in Cache retain complete View trees and data references, so their memory cost is not small.

## RecycledViewPool: A Cross-Type Recycling Bin

RecycledViewPool stores ViewHolders in buckets by `viewType`, with a default limit of 5 per type. A ViewHolder taken from this pool has already had its state cleaned by `resetInternal()`, so `onBindViewHolder` must be called again.

```kotlin
// Share a Pool across multiple RecyclerViews, such as ViewPager2 + multiple tab lists.
val sharedPool = RecyclerView.RecycledViewPool()
sharedPool.setMaxRecycledViews(VIEW_TYPE_CARD, 10)
recyclerView1.setRecycledViewPool(sharedPool)
recyclerView2.setRecycledViewPool(sharedPool)
```

A shared Pool is useful when ViewPager2 contains multiple homogeneous lists. Switching tabs does not need to call `onCreateViewHolder` again, which saves the inflate cost directly.

Back to the opening question: why did raising the Pool limit to 20 make things slower? There are two reasons. A larger Pool keeps more discarded ViewHolders around, increasing GC pressure. And a Pool hit still runs the bind path; it is not necessarily much faster than creating a new holder when bind is the expensive part. Inflate is the real heavyweight operation. **The core value of Pool is avoiding inflate, not avoiding bind.** Tuning should focus on inflate time rather than blindly enlarging the Pool.

## ViewCacheExtension: Rarely Used, but Worth Understanding

The third layer, `ViewCacheExtension`, is an abstract class with one method:

```java
public abstract View getViewForPositionAndType(Recycler recycler, int position, int type);
```

Few projects use it, but it does have value in specific cases. For example, if the list has fixed ad slots or headers whose data never changes, an Extension can return cached instances directly, completely skipping bind and create. It is effectively a fast path for specific positions.

## Prefetch: GapWorker's Strategy

Starting with Support Library 25.1, RecyclerView introduced `GapWorker` for prefetching. The idea is this: while scrolling, RenderThread is handling rendering for the current frame and the UI thread may be idle. `GapWorker` uses that idle window to create and bind ViewHolders that are about to enter the screen.

```java
// Simplified GapWorker scheduling logic.
void prefetch(long deadlineNs) {
    // Predict needed positions from scroll direction and velocity.
    // Complete as much create + bind work as possible before the deadline.
    while (hasMoreWork && System.nanoTime() < deadlineNs) {
        RecyclerView.ViewHolder holder = recyclerview.mRecycler
            .tryGetViewHolderForPositionByDeadline(position, deadlineNs);
        // ...
    }
}
```

`GapWorker` registers a callback through Choreographer and runs after each frame's VSYNC signal. It asks LayoutManager for prefetch targets through `collectAdjacentPrefetchPositions`. LinearLayoutManager defaults to prefetching one item in the scroll direction.

```kotlin
// Customize prefetch count.
(recyclerView.layoutManager as LinearLayoutManager).apply {
    initialPrefetchItemCount = 3 // Increase for nested inner lists.
}
```

Tuning `initialPrefetchItemCount` is especially important for nested RecyclerViews, such as horizontal lists inside a vertical list. When an inner list first appears, it may need to create several ViewHolders at once. Prefetching spreads that cost across earlier frames and avoids a concentrated creation spike that would otherwise drop frames.

## The Complete Cache Lookup Path

Putting the lookup flow together, `tryGetViewHolderForPositionByDeadline` roughly follows this sequence:

1. Search `mChangedScrap` by position, only during pre-layout
2. Search `mAttachedScrap` and `mCachedViews` by exact position
3. If `stableId` is enabled, search Scrap and Cache by id
4. Call `ViewCacheExtension.getViewForPositionAndType`
5. Search `RecycledViewPool` by viewType
6. If everything misses, call `onCreateViewHolder` to create a new one

**ViewHolders found in steps 1-3 do not require rebind; steps 5-6 do.** That is the root of the performance difference.

## Practical Tuning Advice

Several strategies have held up in real projects:

- **Use `DiffUtil` instead of `notifyDataSetChanged`** so more ViewHolders go through Scrap instead of Pool, avoiding unnecessary rebinds.
- **Share RecycledViewPool for nested lists**, together with `initialPrefetchItemCount`, to reduce first-display jank.
- **Avoid heavy object creation inside `onBindViewHolder`** because every Pool hit runs bind, and bind time directly affects scroll frame rate.
- **Enable id matching with `setHasStableIds(true)`** so Cache and Scrap hit rates improve when data order changes but content stays the same.

RecyclerView's cache design is fundamentally a layered time-space tradeoff. Caches closer to the screen are faster but more expensive, while caches farther from the screen use less memory but cost more to restore. Understanding the boundary conditions of each layer is what lets you tune effectively instead of simply increasing cache sizes.

<!-- seo-internal-links -->

## Further Reading

- [Back to the topic: Android Performance Optimization](/android-performance/)
- [Android Startup Optimization: From Zygote Fork to First Frame with Perfetto](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android App Startup Optimization: Metrics, Pipeline, Tools, and Governance](/blog/app启动优化专项/)
- [Android Bitmap Memory Model: Java Heap, Native Heap, and Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [Android RenderThread and HWUI: Rendering Pipeline, DisplayList, and Dropped-Frame Analysis](/blog/2026-04-20-android_renderthread_与_hwui_渲染管线深度解析_从_displaylist/)
<!-- /seo-internal-links -->
