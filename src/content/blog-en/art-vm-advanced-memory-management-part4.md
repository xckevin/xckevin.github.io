---
title: "ART Runtime and Advanced Memory Management (4): Native Memory"
lang: en
translationKey: art-vm-advanced-memory-management-part4
slug: art-vm-advanced-memory-management-part4
excerpt: "Part 4 of ART Runtime and Advanced Memory Management: native memory sources, detection tools, optimization strategies, and memory discipline."
publishDate: '2024-05-05'
tags:
- "Android"
- "ART"
- "Memory Management"
- "Runtime"
series:
  name: "ART Runtime and Advanced Memory Management"
  part: 4
  total: 4
seo:
  title: "ART Runtime and Advanced Memory Management (4): Native Memory"
  description: "Explore Android native memory issues, HWASan, ASan, heapprofd, MTE, object pooling, Bitmap optimization, collections, and largeHeap tradeoffs."
  pageType: article
---
> This is part 4 of the four-part "ART Runtime and Advanced Memory Management" series. In the previous article, we explored "Advanced memory problem diagnosis."

## 5. Native memory exploration: the part below the surface

Java developers often ignore native memory, but it can be an invisible cause of OOM.

### Common sources

- **JNI code**:
  - Forgetting to call `env->ReleaseStringUTFChars()` or `Release<PrimitiveType>ArrayElements()` to release string or array copies obtained from Java.
  - Creating global JNI references with `env->NewGlobalRef()` but forgetting to call `env->DeleteGlobalRef()` when no longer needed.
  - Allocating memory in native code with `malloc` or `new` and forgetting `free` or `delete`.
- **Graphics resources**: Bitmap pixel data, especially before Android 4.4 when pixel data mainly lived in Native Heap, plus OpenGL/Vulkan textures and buffers.
- **Third-party libraries**: C/C++ libraries may leak internally.
- **System libraries/frameworks**: SQLite caches, network-library buffers, and similar resources also use native memory.

### Detection tools

- **`dumpsys meminfo`**: provides an overview of native memory usage. Growth trend is an important clue.
- **HWASan, Hardware-assisted AddressSanitizer, and ASan, AddressSanitizer**
  - **Principle**: instrument memory-access instructions at compile time. At runtime, detect common native memory errors such as use-after-free, heap buffer overflow, stack buffer overflow, use-after-return, use-after-scope, double-free, and invalid-free.
  - **Usage**: modify app build configuration, such as `build.gradle`, `Android.mk`, or `Android.bp`, to enable related compiler options. HWASan requires compatible hardware and OS support, but has much lower performance overhead than ASan and is better suited for broad testing. ASan has higher overhead and may be used only in specific debugging scenarios.
  - **Value**: for apps containing JNI or substantial C/C++ code, **strongly recommended** to enable HWASan/ASan in testing. They catch many fatal memory errors that are hard to find through code review.
- **Native Heap Profiling**
  - **heapprofd, Perfetto**: Perfetto's built-in native heap profiler. It records malloc/free events and call stacks in traces. Analyzing the trace reveals allocation hotspots and detects leaks, such as long-lived allocations that were not freed. It must be enabled through a configuration file and has some performance overhead.
  - **`libc.debug.malloc` / Malloc Debug**: Android C library debugging mechanisms. Use `setprop libc.debug.malloc <level>` to enable different levels of memory issue detection, such as fill and guard checks. Errors appear in Logcat.
  - **Malloc Hooks**: allow custom functions to hook malloc, free, realloc, and similar calls to implement custom memory tracking or analysis.
- **MTE, Memory Tagging Extension, ARMv9**
  - **Principle**: hardware assigns tags to memory pointers and memory regions. On memory access, hardware checks whether the pointer tag matches the memory tag. A mismatch triggers an exception.
  - **Benefits**: extremely low overhead, suitable for memory safety detection in production or near-production environments.
  - **Status**: requires newer ARM CPUs and Android version support, and is being rolled out gradually.

---

## 6. Advanced memory optimization strategies

After mastering tools, apply strategies to optimize memory.

### Establish memory baselines and monitoring

- During development, establish memory usage baselines for key scenarios such as startup, core screens, and complex operations.
- Use CI and automated tests to run memory analysis regularly, such as Heap Dump comparison and Allocation Tracking, preventing memory regressions and leaks from being introduced.
- Consider integrating a lightweight memory monitoring SDK into the app to report key metrics, such as PSS, Java Heap usage, large allocation events, and OOM rate, to the backend and understand real online behavior.

### Object pooling

- **Scenario**: for objects that are expensive to create, short-lived, and frequently created and destroyed, such as Paint, Rect, Path, I/O or network buffers, and some custom beans, use object pools for reuse.
- **Implementation**: use simple pools from `androidx.core.util.Pools`, such as SimplePool and SynchronizedPool, or implement a custom pool based on requirements.
- **Notes**:
  - Reset object state after acquiring an object from the pool.
  - Correctly release objects back to the pool with `release()` after use, or the pool itself can leak.
  - Control pool size to avoid the pool consuming too much memory or holding too many objects that are no longer needed.
  - Thread safety: use thread-safe pools in multi-threaded environments.

### Aggressive Bitmap optimization

#### Load on demand, downsampling

Never load a Bitmap larger than the pixels required by the display area. Use `BitmapFactory.Options` with `inJustDecodeBounds` to obtain dimensions and calculate `inSampleSize` for sampled scaling, or use `BitmapRegionDecoder` to load a partial region.

#### Memory reuse, `inBitmap`, API 11+

**A key optimization.** Reuse an existing, no-longer-needed Bitmap memory block when decoding a new Bitmap. Requirements:

- The reusable Bitmap must be mutable, meaning `isMutable() == true`.
- The new Bitmap's allocation size must be less than or equal to the reused Bitmap's allocation size, `getAllocationByteCount()`. Before Android 4.4, KitKat, exact size match was required.
- Color configuration, `Bitmap.Config`, usually needs to be compatible.
- Developers need to manage a reusable Bitmap collection themselves, often together with LruCache.

#### Choose the right `Bitmap.Config`

- **ARGB_8888**: default, highest quality, includes alpha channel, 4 bytes per pixel.
- **RGB_565**: no alpha, trades color precision for memory, 2 bytes per pixel. Suitable when transparency is not needed and color requirements are moderate.
- **ALPHA_8**: alpha channel only, used for masks and similar cases, 1 byte per pixel.
- **HARDWARE**, API 26+: special config where Bitmap data lives only in GPU/graphics memory and CPU cannot directly access pixels. It saves Java/Native Heap and uploads to GPU quickly. Drawbacks: no CPU pixel operations, and not all drawing operations are supported. Suitable for images rendered directly by GPU without CPU read/write.

#### Smart caching

- **Memory cache, LruCache**: cache recently used decoded Bitmaps. Size should be set dynamically based on device memory class, `ActivityManager.getMemoryClass()`, usually 1/8 to 1/4 of available memory. Keys are typically image URLs or IDs; values are cached Bitmaps.
- **Disk cache, DiskLruCache**: cache original or compressed image files. Images fetched from the network should be stored in disk cache first. Size should also be limited.
- **Combined use**: check memory cache first, then disk cache, and finally load from network or local file.

### Efficient data structures and algorithms

#### Choose memory-friendly collections

- For `int -> Object` mappings, prefer the SparseArray family, including SparseArray, SparseIntArray, SparseBooleanArray, and LongSparseArray, over `HashMap<Integer, Object>`. They avoid key boxing and extra Entry object overhead.
- For lists of many primitive values, consider third-party libraries such as fastutil and Eclipse Collections, or primitive collections from androidx.collection such as LongList and FloatList, to avoid automatic boxing.

#### Algorithm complexity

Pay attention to algorithm space complexity, and avoid algorithms that require large amounts of extra memory when better alternatives exist.

#### Serialization format

Protobuf is usually more compact than JSON, and serialization/deserialization may create fewer intermediate objects.

#### Use memory mapping carefully, `MappedByteBuffer`

- **Scenario**: when frequently accessing large read-only files such as resource data, dictionaries, or model files, memory mapping can avoid loading the entire file into heap memory. The operating system loads file pages into memory on demand.
- **Benefits**: greatly reduces Java heap usage and provides fast access, close to direct memory access.
- **Drawbacks**: mapped memory is not managed by GC; file modifications need special handling; address space is also limited; file close and Buffer release must be handled correctly.

### Code-level micro-optimizations

- **Avoid boxing/unboxing in loops**: check performance-sensitive paths.
- **StringBuilder**: use StringBuilder for string concatenation, and pre-set capacity with `StringBuilder(capacity)` to reduce internal array expansion.
- **Lambda and inner classes**: anonymous Lambdas or inner classes may capture outer-class references. If lifetimes do not match, leaks can occur. Prefer static inner classes or ensure references are cleared promptly.

### `android:largeHeap="true"`: a last resort

- **Effect**: request a larger Java heap limit for the app in the Manifest.
- **Risks**:
  - It only raises the OOM threshold and does not solve root memory problems such as leaks or waste.
  - The app may consume too much system memory, affecting other apps and system smoothness, and increasing the chance that the app is killed in the background.
  - GC pauses may become longer because the heap is larger.
- **When to use**: **only when** the app truly needs to process a legitimate single large-memory operation that cannot be optimized, such as ultra-high-resolution image editing, and all other optimization options have been exhausted. Even then, consider it carefully and fully test its impact on overall system performance.

---

## 7. Conclusion: memory optimization is hard, but persistence works

Android memory management is a broad field involving the ART runtime, multiple compilation strategies, complex GC algorithms, Java heap, native heap, and application-level code patterns. OOM crashes and jank caused by memory churn are long-term challenges for developers.

Android developers must go beyond surface symptoms and deeply understand ART internals and GC mechanics. More importantly, they need to **skillfully use advanced analysis tools such as MAT, Perfetto, and HWASan/ASan, tracking memory problems like investigators**. The issue may be a hidden Java leak, a subtle native memory error, or memory churn caused by inefficient patterns. Only with deep understanding and precise diagnosis can you create truly effective optimization strategies, such as fine-grained Bitmap management, object pooling, and careful data-structure selection.

Effective memory management is not a one-time fix. It is a continuous process that must be integrated into architecture design, daily development, code review, and automated testing. Only then can we build high-quality Android apps that are stable, reliable, and exceptionally smooth. The ability to control memory is a core marker of a top Android engineer.

---

**"ART Runtime and Advanced Memory Management" series**

1. Introduction: the foundation of performance and stability
2. Deep analysis of ART garbage collection (GC)
3. Advanced memory problem diagnosis
4. **Native memory exploration: the part below the surface** (this article)
