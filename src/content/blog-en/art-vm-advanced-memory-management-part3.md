---
title: "ART Runtime and Advanced Memory Management (3): Diagnosis"
lang: en
translationKey: art-vm-advanced-memory-management-part3
slug: art-vm-advanced-memory-management-part3
excerpt: "Part 3 of ART Runtime and Advanced Memory Management: diagnosing leaks, churn, fragmentation, Bitmap memory, OOM, and memory tools."
publishDate: '2024-05-05'
tags:
- "Android"
- "ART"
- "Memory Management"
- "Runtime"
series:
  name: "ART Runtime and Advanced Memory Management"
  part: 3
  total: 4
seo:
  title: "ART Runtime and Advanced Memory Management (3): Diagnosis"
  description: "Diagnose advanced Android memory problems with heap dumps, MAT, Perfetto, Profiler, GC paths, OOM analysis, and command-line tools."
  pageType: article
---
> This is part 3 of the four-part "ART Runtime and Advanced Memory Management" series. In the previous article, we explored "Deep analysis of ART garbage collection (GC)."

## 3. Advanced memory problem diagnosis

After understanding ART and GC mechanics, we can diagnose common memory problems more deeply.

### Memory leaks, Java Heap: root-cause tracing

#### Beyond Activity/Context leaks

Watch for more hidden leak sources:

- **Static collections**: static Lists or Maps holding references to objects no longer needed.
- **Singletons holding Context/View**: singletons live too long. If they hold short-lived `Context` or View references, they cause leaks.
- **Inner classes / Lambda references**: non-static inner classes or Lambda expressions implicitly hold references to outer classes. If an inner-class instance such as Handler, Thread, or AsyncTask outlives the outer object such as Activity, the outer object leaks.
- **Listeners/callbacks not unregistered**: after registering listeners with system services or other long-lived objects, forgetting to unregister them on component destruction, such as `unregisterReceiver`, `removeCallbacks`, or `removeListener`.
- **Threads/thread pools**: threads or thread-pool tasks hold Activity/Fragment references, and the threads are not stopped or managed correctly.
- **Third-party libraries**: some libraries may leak internally.

**Diagnostic key**: find the leaked object's **strong reference chain, or GC Root Path**, meaning the shortest strong-reference path from a GC Root such as static variables, active thread stacks, or JNI references to the leaked object.

### Memory churn: a GC catalyst

- **Essence**: creating and destroying many objects in a short period.
- **Harm**:
  - **Frequent Minor GC**: increases CPU consumption and may cause brief jank.
  - **Object promotion**: many short-lived objects may survive Minor GC because they are still referenced when GC happens, then be incorrectly promoted to the old generation, increasing old-generation pressure and Major GC frequency.
  - **Heap fragmentation with older GC**: modern GC mitigates this, but extreme churn can still worsen fragmentation.
- **Common sources**:
  - Object creation in `onDraw`: creating Paint, Rect, Path, and similar objects inside `onDraw`.
  - **String concatenation in loops**: using `+` creates many intermediate String and StringBuilder objects.
  - **Frequent primitive boxing/unboxing**: using primitives where objects are needed, or vice versa, causing automatic boxing/unboxing.
  - **Inefficient data processing**: for example, reading streams byte by byte and repeatedly creating small buffers.
  - **Logging libraries**: misconfigured logging can create many strings in loops.

### Heap fragmentation: the invisible killer

- **Symptom**: total free Java heap memory is sufficient, but there is no **continuous** block large enough for a large object allocation, causing OOM.
- **Cause**: non-moving GC algorithms, such as the sweep phase of CMS, reclaim discontinuous small blocks. Mixed objects with different lifetimes can also contribute.
- **Mitigation**: modern ART's concurrent copying/compacting GC, such as CC, effectively solves fragmentation. LOS isolates large objects and reduces main-heap fragmentation. Reducing memory churn also helps.

### Bitmap memory problems: the heavy consumer

- **Core challenge**: Bitmap memory usage is usually far larger than file size because decoded pixels are uncompressed and stay resident. Formula: width x height x bytes per pixel. ARGB_8888 uses 4 bytes per pixel; RGB_565 uses 2 bytes per pixel.
- **Common traps**:
  - **Loading the original image**: loading an unscaled high-resolution image into memory even when only a small thumbnail is displayed.
  - **Memory leaks**: Bitmap objects are held by Views or data structures that are no longer needed.
  - **Improper `inBitmap` usage**: Bitmap memory is not reused correctly. Requirements include API 11+, compatible size, same config, and mutability.
  - **Poor cache strategy**: memory cache, such as LruCache, is too large or its size is not managed correctly.

### OOM, Out-of-Memory Error

- **Diverse causes**:
  - **Real leak**: accumulated memory leaks exhaust heap space.
  - **Single large allocation**: the app tries to allocate a huge object, such as a giant Bitmap or very long array, exceeding remaining heap or continuous-space limits.
  - **Fragmentation**: as above, total space is enough but continuous space is not.
  - **Concurrent allocation pressure**: multiple threads request large amounts of memory at the same time.
  - **Native memory exhaustion**: Java heap still has space, but total process memory, including native memory, reaches the system limit.
  - **VM limits**: early Android versions or low-end devices have lower per-app heap limits.
- **Diagnosis**: Heap Dump at OOM time is key. Analyze which thread attempted to allocate what type and size of object. Combine this with `dumpsys meminfo` to inspect overall memory distribution at that moment.

---

## 4. Memory analysis tools

Mastering tools is the key to solving complex memory problems.

### Android Studio Profiler, Memory

- **Real-time monitoring**: observe Java Heap, Native Heap, Code, Graphics, and other memory trends to quickly find abnormal growth.
- **Allocation Tracking**: start and stop object-allocation recording. Analyze which objects were created during a specific operation, such as entering a screen or executing a feature, including count, size, and call stack. **This is especially useful for locating memory churn sources.** Note its performance overhead.
- **Heap Dump**: trigger manually or capture automatically on OOM. You can do initial analysis in Profiler by viewing class instances and reference relationships, but **for complex analysis, export HPROF and open it in MAT**.
- **GC events**: GC events appear on the timeline, so you can observe frequency and impact on app behavior.

### MAT, Memory Analyzer Tool: the Heap Dump analysis workhorse

#### Core capabilities

- **Dominator Tree**: **the most important view**. It shows domination relationships between objects. If object A dominates object B, every strong-reference path to B must pass through A. The root of the dominator tree is GC Roots. By checking nodes with the largest Retained Size, meaning the total size of the object and all objects it dominates, you can quickly find major memory consumers. Expand dominator nodes layer by layer, inspect their children, and find objects that unreasonably retain large memory.
- **Histogram**: lists all instances by class name, with count, Shallow Heap, and Retained Heap. Useful for quickly finding:
  - Classes with abnormal instance counts, which may indicate leaks or cache problems.
  - Classes with abnormally large Shallow Heap, such as huge `byte[]` or String instances.
  - Classes with abnormally large Retained Heap, meaning they dominate substantial memory.
- **Leak Suspects Report**: MAT automatically analyzes likely memory leak points, often Activity, Fragment, Bitmap, and similar objects, and shows the reference path to GC Roots. It is a good starting point for leak analysis.

#### OQL, Object Query Language

OQL is a SQL-like language for complex queries on Heap Dumps. It is extremely powerful.

**Examples**:

```sql
SELECT * FROM instanceof android.app.Activity
```

Find all Activity instances.

```sql
SELECT * FROM android.graphics.Bitmap bmp WHERE bmp.mWidth > 1920
```

Find Bitmaps wider than 1920 pixels.

```sql
SELECT toString(o.key) FROM java.util.HashMap$Node o WHERE o.key.@clazz.getName() = "com.example.MyKeyClass"
```

Find HashMap entries with a specific key type.

```sql
SELECT * FROM MATCHER dominators(OBJECT_ADDRESS)
```

Find objects that dominate a specified object.

- **Path to GC Roots**: right-click an object and choose "Path to GC Roots" -> "with all references" to find the reference chain preventing collection.
- **Merge Shortest Paths to GC Roots**: view all shortest strong-reference paths from an object set to GC Roots.
- **Compare Heap Dumps**: load two Heap Dumps from different times. MAT can analyze differences between them, including which objects increased or decreased, helping locate memory growth caused by a specific operation.

### Perfetto: joint UI and memory analysis

#### Memory-related tracks

- `mem.java_heap`: Java heap allocation size.
- `mem.native_heap`: native heap allocation size.
- `mem.graphics`: graphics memory, mainly GL textures and buffers.
- `mem.total_pss`: total process PSS, Proportional Set Size, which accounts for shared memory proportionally.
- `mem.locked`: locked memory such as `mlock()`.
- `mem.rss`: total process Resident Set Size.

#### Memory events

- **Memory Counters**: the tracks above are periodically sampled counter values.
- **Heap Graph / Heap Profile**, requires data-source configuration: records detailed Java/native heap allocation information, similar to Profiler but integrated into a Perfetto trace. It has relatively high overhead.
- **Java Heap GC Events**: records GC start, end, and pause time.

#### Analysis value

Perfetto's biggest advantage is **correlation analysis**. You can correlate memory spikes and GC pause events with UI jank events on the same timeline, such as Actual frame timeline versus Expected frame timeline, CPU Scheduling, Binder transactions, and more. This helps determine whether a memory issue directly caused a performance problem. For example, check whether a jank event immediately follows a long GC pause.

### Command-line tools

**`adb shell dumpsys meminfo <package_name|pid>`**

**How to read it:** understand each field:

- **PSS Total**: proportional shared memory plus private memory. A good measure of the physical memory actually consumed by the process.
- **Private Dirty**: private modified RAM owned by the process. This is the main exclusive portion that the system cannot page out.
- **Private Clean**: private unmodified RAM, such as code and resources mapped from files. The system can page it out under memory pressure.
- **Swap PSS**: swap space used by the process, such as ZRAM, if enabled.
- **Heap Size / Heap Alloc / Heap Free**: total Java heap size, allocated size, and free size.
- **Native Heap**: PSS, Private Dirty, and Private Clean for native memory.
- **Stack**: Java and native thread stacks.
- **Graphics**: graphics-related memory such as driver and texture caches.
- **Code**: memory used by app code, including DEX, OAT, and `.so`.
- **Ashmem, GL mtrack, Unknown**: other shared memory or memory that cannot be categorized precisely.
- **`--unreachable`**, Android 11+: shows memory size of currently unreachable objects in the Java heap that GC has not yet reclaimed, helping assess potential GC pressure.

**`adb shell am dumpheap <pid> /sdcard/heap.hprof`**: manually trigger a Heap Dump for a specified process and save it to the device.

**`adb bugreport`**: generate a compressed bugreport containing extensive system state, including meminfo and procrank, for offline analysis.

---

> Next, we will explore "Native memory exploration: the part below the surface" in this series.

**"ART Runtime and Advanced Memory Management" series**

1. Introduction: the foundation of performance and stability
2. Deep analysis of ART garbage collection (GC)
3. **Advanced memory problem diagnosis** (this article)
4. Native memory exploration: the part below the surface
