---
title: "What Are RecyclerView's Four Cache Levels? Understanding ViewHolder Reuse"
lang: en
translationKey: android-recyclerview-four-level-cache
slug: android-recyclerview-four-level-cache
excerpt: "A practical explanation of RecyclerView's four cache levels, ViewHolder reuse order, RecycledViewPool, Prefetch, and how they affect scrolling performance."
publishDate: '2026-06-01'
tags:
- "Android"
- "RecyclerView"
- "Performance Optimization"
seo:
  title: "RecyclerView's Four Cache Levels and ViewHolder Reuse Explained"
  description: "Learn how RecyclerView's four cache levels, ViewHolder reuse, RecycledViewPool, Prefetch, DiffUtil, and stable IDs shape Android list performance."
  pageType: article
---

RecyclerView performance is not just about "creating fewer Views." Its real strength is a layered cache system that decides whether the ViewHolder for a position can be reused quickly. The earlier a cache level is hit, the lower the reuse cost. The later the hit, the more likely RecyclerView must rebind or even recreate the ViewHolder.

Understanding the four cache levels explains many list behavior questions: why scrolling back can be fast, why mixed-type lists can stutter, why sharing a `RecycledViewPool` helps nested lists, and why a bad `DiffUtil` implementation can break reuse.

## Level 1: Attached Scrap

Attached Scrap stores ViewHolders that are still attached to RecyclerView but are temporarily detached during a layout pass. They usually do not need to be rebound because they still represent the same on-screen items.

A typical case is a layout calculation where RecyclerView first detaches existing children, then attaches them again based on updated positions. If the item did not materially change, retrieving it from this level is the cheapest path.

This is why RecyclerView can efficiently move and reuse on-screen Views during a layout pass instead of destroying and recreating everything on each layout.

## Level 2: Cached Views

Cached Views store a small number of ViewHolders that just moved off-screen. They preserve position and binding state, so they can be returned directly when the user scrolls back a short distance.

The default cache size is small because this level holds complete View trees and binding state. Too many entries increase memory usage. For complex items in lists where users often scroll back and forth, `setItemViewCacheSize()` can help, but it should not be treated as a generic optimization switch.

If the dataset changes frequently and positions become invalid, Cached Views lose much of their value. Stable item IDs, a correct `DiffUtil`, and precise data-change notifications directly affect this cache level.

## Level 3: ViewCacheExtension

`ViewCacheExtension` is a custom cache hook for developers. It lets you provide Views outside RecyclerView's default cache path.

This level is powerful, but it can also disrupt RecyclerView's own reuse model. Unless you are very sure about the scenario, such as a specific item type with predictable reuse rules, it should not be your first choice. Most performance problems can be solved with `DiffUtil`, optimized ViewHolder binding, and `RecycledViewPool` tuning.

## Level 4: RecycledViewPool

`RecycledViewPool` stores discarded ViewHolders grouped by `viewType`. They are no longer tied to a specific position, so taking one from the pool usually requires `onBindViewHolder`.

This level reduces `onCreateViewHolder` calls. Creating a ViewHolder often includes inflating XML, creating child Views, and initializing listeners, which is usually more expensive than ordinary binding. Complex items, nested RecyclerViews, and horizontal lists depend heavily on the pool.

A common nested-list optimization is to share one `RecycledViewPool` across multiple child RecyclerViews and set a reasonable max recycled count for high-frequency view types. That allows similar items in different modules to reuse the same group of ViewHolders.

## What Prefetch does

`GapWorker` uses scroll direction and information from `LayoutManager` to prefetch items that are likely to appear soon. Its goal is to move creation and binding work before the item actually reaches the screen, reducing visible jank.

More prefetching is not always better. Too little prefetching means ViewHolders are created only when they become visible, which can stutter. Too much prefetching can consume main-thread or background-thread resources and may even load many images too early. In nested RecyclerViews, set `initialPrefetchItemCount` based on the number of items visible in the first viewport instead of blindly increasing it.

## List jank is rarely caused by one cache level alone

Cache hits reduce creation cost and some binding cost, but if `onBindViewHolder` itself is heavy, hitting the pool can still jank. Common problems include synchronous image decoding in bind, expensive string formatting, database reads, excessive object allocation, repeatedly setting listeners, and triggering nested layouts.

A practical optimization order:

1. Use Perfetto or FrameMetrics to identify which part of scrolling causes jank.
2. Check whether `onCreateViewHolder` is frequent to decide whether the pool is too small.
3. Check whether `onBindViewHolder` is too heavy, then move work to async paths or precompute it.
4. Inspect `DiffUtil`, stable IDs, and `notifyDataSetChanged` usage to see whether they break reuse.
5. Share `RecycledViewPool` for nested lists and tune prefetch.

RecyclerView's cache system is mature, but it can only help reuse ViewHolders. It cannot fix overly heavy binding logic for you. List performance is ultimately shaped by caching, data-change quality, image loading, and layout complexity together.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [What is Android Binder? A practical guide to the Binder IPC model](/en/blog/android-binder/)
- [Why Bitmap often causes OOM: Android image memory model basics](/en/blog/android-bitmap-oom/)
<!-- /seo-internal-links -->
