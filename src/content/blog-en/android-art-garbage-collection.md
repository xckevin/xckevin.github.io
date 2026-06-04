---
title: "Inside Android ART Garbage Collection"
lang: en
translationKey: android-art-garbage-collection
slug: android-art-garbage-collection
excerpt: "A practical look at ART garbage collection, from Dalvik mark-sweep to CMS, Concurrent Copying, generational GC, allocation storms, LOS behavior, and startup tuning."
publishDate: '2025-05-26'
tags:
- "Android"
- "ART"
- "Garbage Collection"
- "Performance Optimization"
- "Memory Management"
seo:
  title: "Inside Android ART Garbage Collection: CMS, CC, and Generational GC"
  description: "Trace Android GC from Dalvik mark-sweep to ART CMS, Concurrent Copying, and generational GC, with practical fixes for allocation storms and LOS pressure."
  pageType: article
---

## Starting from a production OOM

While investigating an image-loading OOM last year, I found a large number of `Bitmap` objects in the heap dump that were clearly unreachable but had not been collected. The profiler showed frequent GC runs, yet each one reclaimed very little memory. That is a classic GC efficiency problem, not just "the app does not have enough memory."

It made me revisit how GC works in the ART runtime. My earlier article on the `Bitmap` memory model focused on allocation strategy; this one completes the story from the reclamation side.

## GC in the Dalvik era: why jank was inevitable

Dalvik's GC algorithm was **Mark-Sweep**. It works in two phases: the mark phase starts from GC roots and traverses the object graph to find all live objects; the sweep phase reclaims memory that was not marked.

Both phases are Stop-The-World. All threads pause during marking, and they pause again during sweeping. The larger the heap and the more objects it contains, the longer the pause. In a Dalvik app with a 256 MB heap, a single GC pause of 100-200 ms was common. For 60 fps rendering, that is a 6-12 frame stall.

Later Dalvik versions introduced Concurrent Mark-Sweep (CMS). The mark phase could run concurrently with application threads, but two short STW pauses remained: initial marking and remarking. CMS also did not compact memory. When fragmentation became severe, allocating a large object could fail even if the heap had enough total free space, causing an OOM.

## ART's three major evolutions

Android 5.0 replaced Dalvik with ART as the default runtime, and ART's GC strategy went through three important iterations.

### Android 5.0-7.0: CMS plus compaction

The first generation of ART GC kept the CMS model and added one key improvement: when the app moved to the background, ART could run a compacting GC to defragment memory.

The idea was simple: avoid compaction in the foreground to keep the UI smooth, then compact during background idle time. The problem was equally simple: if the user never backgrounded the app for a long time, fragmentation still accumulated. I once saw an image-heavy app run in the foreground for two hours and then fail `Bitmap` allocations frequently. The only practical workaround was to guide users to restart it.

The GC logs usually show foreground `GC_CONCURRENT` and background `GC_FOR_ALLOC` patterns:

```bash
# Foreground concurrent GC
I/art: Explicit concurrent mark sweep GC freed 28743(2MB) AllocSpace objects,
  0(0B) LOS objects, 40% free, 25MB/42MB

# Background compaction
I/art: Background sticky concurrent mark sweep GC freed 15234(1MB) AllocSpace objects,
  8(512KB) LOS objects, 19% free, 34MB/42MB
```

### Android 8.0-9.0: Concurrent Copying GC

Android 8.0 introduced Concurrent Copying GC (CC GC), the largest architectural shift in ART GC.

CC GC borrows from semispace copying. The heap is split into From-Space and To-Space. During GC, live objects are copied from From to To, then the whole From-Space is marked free. There is no need to scan dead objects individually. The cost is proportional to the number of live objects, not the total heap size.

CC GC uses read barriers to run copying concurrently with application threads:

```java
// Read barrier pseudocode
Object readField(Object obj) {
    Object ref = obj.field;
    // If the object has moved to To-Space, update the reference
    if (isForwarded(ref)) {
        ref = getForwardingAddress(ref);
        obj.field = ref; // Self-healing: fix the reference to the new location
    }
    return ref;
}
```

When a thread reads an object field, the read barrier checks the object's address. If GC has already copied that object to a new location, the barrier returns the new address and fixes the reference. The cost is small: one extra conditional check per reference read, usually about a 3-5% impact on overall performance.

After CC GC, foreground GC pauses dropped from CMS's 10-20 ms range to around 1-3 ms. GC-induced frame drops largely disappeared.

### Android 10+: Generational CC GC

Android 10 added generational collection. Most objects die shortly after allocation, while a smaller set survives for a long time. After splitting the heap into a young generation and an old generation, minor GC only scans the young space and runs frequently but very quickly. Major GC scans the whole heap but runs less often.

ART's implementation is called Generational Concurrent Copying GC. It combines concurrent copying with the locality benefits of generational collection. Region-based space management replaces whole-heap From/To switching. Each region independently tracks live-object density, and GC reclaims only low-density regions.

For an app with a 512 MB heap, young GC often finishes in 0.5-1 ms, which is almost invisible to frame rendering.

## How GC affects application performance

After understanding the mechanism, we can return to the practical question: when does GC visibly affect user experience?

### Allocation storms

An allocation storm happens when a large number of objects are allocated in a short time, faster than GC can reclaim them. A common case is fast `RecyclerView` scrolling where every item binding creates many temporary objects.

```kotlin
// Anti-pattern: frequent allocation in onBind
override fun onBindViewHolder(holder: ViewHolder, position: Int) {
    val formatter = SimpleDateFormat("yyyy-MM-dd") // Created on every bind
    holder.dateText.text = formatter.format(items[position].date)
}
```

The GC log will show dense `GC_FOR_ALLOC` entries, and frame rendering time will exceed 16 ms. Moving `SimpleDateFormat` to a companion object or `ThreadLocal` removes this class of allocation.

### Large objects and LOS

`Bitmap` objects and large arrays are allocated in the Large Object Space (LOS), not the regular heap. LOS reclamation is more conservative and usually happens only during full GC. That was the root cause of the opening OOM: unreachable `Bitmap` objects stayed in LOS and never got a timely full GC.

`Bitmap` reuse with `inBitmap` and `LruCache` are practical mitigations. On Pixel devices running Android 14+, the Hardware Buffer path moves more `Bitmap` memory under GPU management, further reducing pressure on the ART heap.

### GC timing on critical paths

App startup is GC-sensitive. During cold start, ART performs heavy class loading and initialization, creating dense allocations. If concurrent GC starts at the same time, CPU contention can add 20-50% to startup time.

Android's response is to suppress GC during startup. AMS delays non-urgent GC in the first few seconds of process launch. Developers can cooperate by delaying non-critical initialization and avoiding large resource loads in `Application.onCreate`.

### Monitoring GC behavior

Monitoring GC frequency and pause time in production is a direct signal for memory health:

```kotlin
val memoryInfo = Debug.MemoryInfo()
Debug.getMemoryInfo(memoryInfo)

// Android 11+ can monitor this in more detail
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    // Watch trends in gcCount and gcTime
}
```

If the slope of `gcCount` increases or cumulative `gcTime` exceeds a threshold such as 50 ms per second, allocation pressure is too high and hot paths need investigation.

## Choose GC or object pools?

One practical design question comes up often: should you manually manage object pools or trust GC? My rule of thumb:

- **Short-lived small objects**: leave them to GC. CC GC handles them at almost zero cost, while a custom pool adds complexity and resident memory.
- **Medium-lived objects** such as `ViewHolder`: use built-in pools like `RecyclerView`'s recycling mechanism instead of building your own.
- **Large, frequently reused objects** such as network buffers and `Bitmap` instances: pool them manually. `ByteArrayPool` and `BitmapPool` patterns are mature enough.
- **Objects shared across threads**: avoid them where possible. Cross-thread references make reachability harder to evaluate quickly and increase marking cost.

ART's GC has evolved from "avoid it if you can" to "trust it, but watch critical paths." Understanding how it works is not about fighting GC. It is about writing code that gives GC less pressure when it runs.
