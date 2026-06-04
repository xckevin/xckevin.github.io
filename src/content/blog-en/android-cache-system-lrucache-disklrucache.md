---
title: "Android Cache Systems: LruCache, DiskLruCache, and Offline-first Design"
lang: en
translationKey: android-cache-system-lrucache-disklrucache
slug: android-cache-system-lrucache-disklrucache
excerpt: "A practical deep dive into Android caching, from LruCache and DiskLruCache internals to three-level cache coordination, consistency, and offline-first engineering."
publishDate: '2025-12-25'
tags:
- "Android"
- "LruCache"
- "DiskLruCache"
- "Cache Architecture"
- "Performance Optimization"
seo:
  title: "Android Cache Systems with LruCache and DiskLruCache"
  description: "Understand Android cache architecture from LruCache internals to DiskLruCache journals, three-level caching, offline-first writes, and memory pressure handling."
  pageType: article
---

While optimizing performance for an image loading library, I once hit a strange issue: during fast RecyclerView scrolling, images that had already loaded were requested from the network again. After debugging, we found that the memory cache was too small. Bitmaps were being evicted frequently, and when the system fell back to disk cache, I/O could not keep up with scroll speed. If any part of a three-level cache is weak, performance can drop sharply.

This article does not repeat how to use image libraries. Instead, it breaks down the internal mechanics of each cache layer and the problems that only appear when those layers work together.

## LruCache: more than LRU

Internally, `LruCache` maintains a `LinkedHashMap` created with `accessOrder=true`. Every time `get()` hits an entry, that entry moves to the tail of the linked list. When eviction is needed, entries are removed from the head. The head is the least recently used item.

```kotlin
val cache = object : LruCache<String, Bitmap>(maxSize) {
    override fun sizeOf(key: String, value: Bitmap): Int {
        return value.byteCount
    }
}
```

A common mistake is forgetting that the unit of `maxSize` is defined by `sizeOf()`. By default, each entry counts as 1. If you use `maxSize = 100` for Bitmaps, you are allowing 100 images, potentially hundreds of MB, not 100 KB. Always override `sizeOf()` and use `bitmap.byteCount` to reflect real memory usage.

The `entryRemoved()` callback runs on the same thread that calls `put()` or `remove()`. If the UI thread triggers it and you recycle Bitmaps there, keep the work lightweight and avoid disk I/O.

Eviction is not continuous. It is triggered only when new data is written through `put()`, and a single write may evict multiple entries until the total size falls below the limit. The `LinkedHashMap` order determines which entries are evicted.

## DiskLruCache: journal-driven persistence

`DiskLruCache` comes from Jake Wharton's open source library; it is not built into the Android SDK. Its core design is a journal file that records the state of every cache operation.

```
DIRTY abc123
CLEAN abc123 4096
READ abc123
DIRTY def456
```

Each line represents one operation. The write flow is: append `DIRTY` plus the key, write the data, then append `CLEAN` plus the key and file size. If the process crashes after `DIRTY` but before `CLEAN`, those `DIRTY` entries are discarded during the next initialization. The write is atomic.

```java
DiskLruCache cache = DiskLruCache.open(dir, appVersion, 1, 10 * 1024 * 1024);
DiskLruCache.Editor editor = cache.edit(MD5.hash(url));
OutputStream out = editor.newOutputStream(0);
// Write data
editor.commit(); // Append a CLEAN line; the entry becomes visible to readers now
```

The `appVersion` parameter deserves attention. Every time the cache format changes, increment this value and `DiskLruCache` automatically clears the old cache. That is cleaner than writing custom migration logic. One production lesson: do not try too hard to support old cache formats. Clearing and rebuilding is often safer.

The key format limit is another easy trap: only `[a-z0-9_-]{1,120}` is allowed. If a URL is used as a key, hash it first with MD5 or SHA-256.

## Three-level coordination and consistency

A standard three-level cache data flow looks like this:

```
Request -> LruCache (memory, return immediately on hit)
        | miss
        v
     DiskLruCache (disk, backfill memory on hit)
        | miss
        v
     Network (write to disk + memory)
```

Simply chaining the layers is not enough. Memory might store a compressed thumbnail while disk stores the original image, meaning one logical URL can correspond to two different pieces of data. Cache key design determines the correctness of the whole system:

```kotlin
// Wrong: thumbnail and original image share the same key
val thumbKey = url.md5()

// Correct: encode dimensions into the key
val thumbKey = "${url.md5()}_${width}x${height}"
```

For API response caching, I usually include the API version in the key:

```kotlin
val cacheKey = "${endpoint}_v${apiVersion}_${requestBody}".md5()
```

When the backend changes response fields, old cache entries automatically become invalid and will not cause parsing crashes.

## Offline first: write locally first, then sync to the server

Caching is a natural fit for read-heavy scenarios. Write operations invert the model: local storage becomes the primary data source, and the server becomes the backup.

```kotlin
suspend fun savePost(post: Post) {
    // 1. Write locally first so the user sees the result immediately
    db.postDao().insert(post.toEntity())

    // 2. Sync to the server asynchronously
    scope.launch {
        try {
            api.uploadPost(post)
            db.postDao().markSynced(post.id)
        } catch (e: Exception) {
            db.postDao().markPending(post.id) // Mark for retry
            syncScheduler.schedule()          // Retry automatically next time
        }
    }
}
```

This pattern significantly improves the experience on weak networks because user operations are no longer blocked by network latency. Last Write Wins is usually enough for conflict resolution. More complex collaborative scenarios may need CRDTs.

One practice is easy to overlook: do not cache non-2xx HTTP responses. If a 500 error is cached for 24 hours, the user may see an error page all day. Cache only successful responses within the range allowed by `Cache-Control`.

## Dynamic adjustment under memory pressure

`LruCache` size should not be hard-coded. Device memory varies widely, so I calculate the size at runtime:

```kotlin
val maxMem = Runtime.getRuntime().maxMemory() / 1024
val cacheSize = (maxMem / 8).toInt() // 1/8 of heap memory
```

One eighth is a starting point, not a rule. Image-heavy apps can increase it to one quarter, while text-heavy apps can reduce it to one sixteenth. Pair this with `onTrimMemory()` to shrink the cache when the system is under memory pressure:

```kotlin
override fun onTrimMemory(level: Int) {
    when (level) {
        TRIM_MEMORY_RUNNING_MODERATE -> cache.trimToSize(cache.maxSize() / 2)
        TRIM_MEMORY_RUNNING_CRITICAL -> cache.evictAll()
    }
}
```

`DiskLruCache` cleans itself differently. It is not triggered by memory pressure. It is triggered by its capacity limit: when the total size exceeds `maxSize`, old files are removed in LRU order. The `journal` file is also compacted periodically, merging redundant historical operations into a smaller set of state lines so the log does not grow forever.

## Pre-release checklist

Before shipping, I always check three things:

1. **Cache size is observable**: without monitoring, you are flying blind. Log the ratio between `cache.size()` and `cache.maxSize()` regularly, and pair it with production disk-usage monitoring.

2. **Clear cache on version upgrade**: bind the `DiskLruCache` `appVersion` to `versionCode`. When the cache format changes, you do not need migration code; the cache can be rebuilt directly.

3. **Disk operations are thread-safe**: `LruCache` is synchronized internally, but `DiskLruCache` is not. Converge all disk reads and writes onto one single-threaded scheduler to avoid corrupting the journal with concurrent writes.

The engineering difficulty in caching is not the design pattern. It is the edge cases: fallback behavior during network jitter, compatibility when schemas change, and graceful degradation under memory pressure. Once those are covered, the cache system is ready for production.
