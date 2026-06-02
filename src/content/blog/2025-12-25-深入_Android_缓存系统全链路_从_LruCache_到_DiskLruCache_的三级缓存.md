---
title: 深入 Android 缓存系统全链路：从 LruCache 到 DiskLruCache 的三级缓存架构与离线优先工程实践
excerpt: 深入剖析 Android LruCache 与 DiskLruCache 的内部机制，详解三级缓存架构的联动设计、一致性问题及离线优先工程实践。
publishDate: '2025-12-25'
tags:
- Android
- LruCache
- DiskLruCache
- 缓存架构
- 性能优化
seo:
  title: 深入 Android 缓存系统全链路：从 LruCache 到 DiskLruCache 的三级缓存架构与离线优先工程实践
  description: 深入 Android 缓存体系：从 LruCache 内部机制到 DiskLruCache 日志驱动设计，详解三级缓存联动、离线优先策略、内存压力降级等工程实践。
---

做图片加载库的性能优化时，我遇到过一个诡异的问题：RecyclerView 快速滑动时，已经加载过的图片居然重新走了一遍网络请求。排查后发现，内存缓存设得太小，Bitmap 频繁被回收，降级到磁盘缓存时 I/O 又顶不住滑动速度。三级缓存缺了任何一环，性能都会断崖式下跌。

本文不打算重复图片库的用法，而是拆解每一层缓存的内部机制，以及它们拼在一起时才会暴露的问题。

## LruCache：不止于 LRU

LruCache 内部维护一个 `LinkedHashMap`，构造时传入 `accessOrder=true`。每次 `get()` 命中，该条目会被移到链表尾部；需要驱逐时，从头部开始删——头部就是最久未访问的条目。

```kotlin
val cache = object : LruCache<String, Bitmap>(maxSize) {
    override fun sizeOf(key: String, value: Bitmap): Int {
        return value.byteCount
    }
}
```

一个常见的坑：`maxSize` 的单位由 `sizeOf()` 决定，默认每个条目计 1。如果你用 `maxSize = 100` 存 Bitmap，实际上存了 100 张图（可能几百 MB），而不是 100KB。务必重写 `sizeOf()`，用 `bitmap.byteCount` 反映真实内存占用。

`entryRemoved()` 回调在调用 `put()` 或 `remove()` 的线程上执行。UI 线程调用时如果在这里 recycle Bitmap，操作务必轻量，不要做磁盘 I/O。

驱逐时机不是实时的——只在 `put()` 写入新数据时触发，且每次可能驱逐多个条目直到总大小回到上限以下。`LinkedHashMap` 的 `eldest()` 方法决定谁被驱逐。

## DiskLruCache：日志驱动的持久化

DiskLruCache 来自 Jake Wharton 的开源库，Android SDK 没有内置。它的核心设计是 journal 日志文件，记录了所有缓存操作的状态行。

```
DIRTY abc123
CLEAN abc123 4096
READ abc123
DIRTY def456
```

每行一个操作。写入流程：先追加一行 `DIRTY` + key，写完数据后追加 `CLEAN` + key + 文件大小。如果进程在 `DIRTY` 之后、`CLEAN` 之前崩溃，下次初始化时这些 `DIRTY` 条目会被丢弃——写入是原子的。

```java
DiskLruCache cache = DiskLruCache.open(dir, appVersion, 1, 10 * 1024 * 1024);
DiskLruCache.Editor editor = cache.edit(MD5.hash(url));
OutputStream out = editor.newOutputStream(0);
// 写入数据
editor.commit(); // 追加 CLEAN 行，此时才对读取可见
```

`appVersion` 这个参数值得多说两句。每次缓存格式变更时递增这个值，DiskLruCache 会自动清空旧缓存，比手动写迁移逻辑干净得多。我在生产环境踩过的坑：不要试图兼容旧缓存格式，直接清掉重建反而更安全。

key 的格式限制也容易踩坑：只允许 `[a-z0-9_-]{1,120}`。URL 做 key 时，必须先 MD5 或 SHA-256 哈希。

## 三层联动与一致性问题

标准的三级缓存数据流：

```
请求 → LruCache（内存，命中直接返回）
        ↓ miss
     DiskLruCache（磁盘，命中后回填内存）
        ↓ miss
     Network（网络，写入磁盘 + 内存）
```

但仅仅串起来不够。内存里存的可能是压缩后的缩略图，磁盘上存的是原图，同一个 key 对应两份不同数据。缓存 key 的设计决定了整个系统的正确性：

```kotlin
// 错误：缩略图和原图共用一个 key
val thumbKey = url.md5()

// 正确：将尺寸编码进 key
val thumbKey = "${url.md5()}_${width}x${height}"
```

对于 API 响应缓存，我习惯把接口版本也打入 key：

```kotlin
val cacheKey = "${endpoint}_v${apiVersion}_${requestBody}".md5()
```

后端改了返回字段时，旧缓存自动失效，不会出现解析崩溃。

## 离线优先：先写本地，后同步服务端

读多写少的场景用缓存加速很自然。写操作的处理思路反过来了：本地存储是第一数据源，服务端是备份。

```kotlin
suspend fun savePost(post: Post) {
    // 1. 先写本地（用户立即看到结果）
    db.postDao().insert(post.toEntity())

    // 2. 异步同步到服务端
    scope.launch {
        try {
            api.uploadPost(post)
            db.postDao().markSynced(post.id)
        } catch (e: Exception) {
            db.postDao().markPending(post.id) // 标记待重试
            syncScheduler.schedule()          // 下次自动重试
        }
    }
}
```

弱网环境下这个模式的体验提升很明显——用户的操作不卡在网络延迟上。冲突解决用「最后写入胜出（Last Write Wins）」基本够用，复杂协作场景才需要 CRDT。

一条容易被忽略的实践：不要缓存 HTTP 非 2xx 的响应。一个 500 错误被缓存 24 小时，用户会看到一整天的错误页面。只缓存在 `Cache-Control` 允许范围内的成功响应。

## 内存压力下的动态调整

LruCache 的大小不能写死。不同设备的内存差距悬殊，我的做法是运行时动态计算：

```kotlin
val maxMem = Runtime.getRuntime().maxMemory() / 1024
val cacheSize = (maxMem / 8).toInt() // 堆内存的 1/8
```

1/8 是起点，不是铁律。图片密集型应用拉到 1/4，纯文本可以压到 1/16。配合 `onTrimMemory()` 在系统内存紧张时主动缩容：

```kotlin
override fun onTrimMemory(level: Int) {
    when (level) {
        TRIM_MEMORY_RUNNING_MODERATE -> cache.trimToSize(cache.maxSize() / 2)
        TRIM_MEMORY_RUNNING_CRITICAL -> cache.evictAll()
    }
}
```

DiskLruCache 的清理策略不同。它不靠内存压力触发，而是靠容量上限：总大小超过 `maxSize` 时，按 LRU 顺序删除旧文件。`journal` 文件也会定期裁剪（compact），把冗余的历史操作合并成精简状态行，防止日志无限膨胀。

## 上线前的检查清单

发版前我必查的三项：

1. **缓存大小可观测**：不加监控就是盲飞。定期输出 `cache.size()` 和 `cache.maxSize()` 的比值，配合线上的磁盘占用监控。

2. **版本升级清缓存**：把 DiskLruCache 的 `appVersion` 绑定到 `versionCode`。缓存格式变更时不需要写迁移代码，直接重建。

3. **磁盘操作线程安全**：LruCache 自带 `synchronized`，但 DiskLruCache 不是。所有磁盘读写收敛到一个单线程调度器，避免 journal 并发写坏的场景。

缓存的工程难度不在设计模式，而在边界条件——网络抖动时的回退策略、Schema 变更时的兼容处理、内存压力下的优雅降级。把这些兜住了，才是生产可用的缓存体系。
