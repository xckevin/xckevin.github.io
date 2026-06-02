---
title: 深入 Android ART 垃圾回收机制全链路
excerpt: 从线上 OOM 排查切入，系统梳理 ART 垃圾回收从 CMS 到 Concurrent Copying 再到分代优化的三次演进，并给出分配风暴、大对象空间、启动期 GC 抑制等实战性能调优策略。
publishDate: '2025-05-26'
tags:
- Android
- ART
- GC
- 性能优化
- 内存管理
seo:
  title: 深入 Android ART 垃圾回收机制全链路
  description: 从 Dalvik 到 ART 三代 GC 演进全景：CMS、Concurrent Copying、Generational CC，结合分配风暴、LOS 空间与对象池选型，解析 GC 对应用性能的真实影响与调优实践。
---

## 从一次线上 OOM 说起

去年排查一个图片加载 OOM，我在 Heap Dump 里发现大量 Bitmap 对象明明已经不可达，却迟迟没被回收。Profiler 显示 GC 频繁触发但单次回收量很小——典型的 GC 效率问题，不是简单的"内存不够用"。

这让我重新审视了 ART 运行时的 GC 机制。之前写过的 Bitmap 内存模型文章偏重分配策略，这篇把回收侧的链路补全。

## Dalvik 时代的 GC：为什么卡顿不可避免

Dalvik 虚拟机的 GC 算法是 **Mark-Sweep**，分两步走：标记阶段从 GC Roots 出发遍历对象图，找出所有存活对象；清除阶段回收未标记的内存。

两个阶段都会 Stop-The-World。标记期间所有线程暂停，清除期间同样暂停。堆越大、对象越多，暂停时间越长。一个 256MB 堆的 Dalvik 应用，一次 GC 暂停 100-200ms 很常见，对 60fps 渲染来说就是 6-12 帧的卡顿。

Dalvik 后期引入了 Concurrent Mark-Sweep（CMS），标记阶段可以和业务线程并发执行，但仍有两次短 STW：初始标记和重新标记。CMS 不整理内存，碎片化严重时，即使有足够空闲内存，分配大对象也可能失败，触发 OOM。

## ART 的三次进化

Android 5.0 以 ART 替代 Dalvik 成为默认运行时，GC 策略经历了三次关键迭代。

### Android 5.0-7.0：CMS + 碎片整理

ART 初代 GC 保留了 CMS 思路，增加了一个关键改进：应用进入后台时执行 Compacting GC，整理内存碎片。

逻辑是前台不整理以保证流畅度，后台空闲时再整理。问题在于：如果用户长时间不切后台，碎片化依然累积。我遇到过一款重度图片应用，前台运行 2 小时后 Bitmap 分配频繁失败，只能主动引导用户重启。

GC 日志特征是前台的 `GC_CONCURRENT` 和后台的 `GC_FOR_ALLOC`：

```bash
# 前台并发 GC
I/art: Explicit concurrent mark sweep GC freed 28743(2MB) AllocSpace objects,
  0(0B) LOS objects, 40% free, 25MB/42MB

# 后台碎片整理
I/art: Background sticky concurrent mark sweep GC freed 15234(1MB) AllocSpace objects,
  8(512KB) LOS objects, 19% free, 34MB/42MB
```

### Android 8.0-9.0：Concurrent Copying GC

Android 8.0 引入 Concurrent Copying GC（CC GC），这是 ART GC 架构最大的一次跃迁。

CC GC 借鉴了半空间复制算法：将堆分为 From-Space 和 To-Space，GC 时把存活对象从 From 拷贝到 To，整个 From-Space 直接标记为空闲。不需要扫描死对象——死对象所在的 From 区整体释放，回收时间与存活对象数量成正比，而非堆总大小。

CC GC 通过 Read Barrier 实现了拷贝过程与业务线程并发。工作原理：

```java
// Read Barrier 伪代码
Object readField(Object obj) {
    Object ref = obj.field;
    // 如果对象已移动到 To-Space，更新引用
    if (isForwarded(ref)) {
        ref = getForwardingAddress(ref);
        obj.field = ref; // 自愈：修复引用到新位置
    }
    return ref;
}
```

线程读取对象字段时，Read Barrier 检查对象地址。如果对象已被 GC 拷贝到新位置，Barrier 自动返回新地址并修复引用。这个开销很小——每个引用读取多一次条件判断，对整体性能影响约 3-5%。

CC GC 之后前台 GC 暂停时间从 CMS 的 10-20ms 降到了 1-3ms，基本告别 GC 引起的丢帧。

### Android 10+：Generational CC GC 与分代优化

Android 10 加入分代回收。大多数对象创建后很快就不再使用，少数长期存活。分成 Young Generation 和 Old Generation 后，Minor GC 只扫描 Young 区，频率高但极快；Major GC 扫描全堆，频率低。

ART 的实现叫 Generational Concurrent Copying GC，结合了 CC GC 的并发拷贝和分代回收的局部性优势。Region 空间管理替代了整堆的 From/To 切换——每个 Region 独立跟踪存活对象密度，GC 只回收低密度 Region。

一个 512MB 堆的应用，Young GC 通常在 0.5-1ms 内完成，对帧率几乎无感知。

## GC 如何影响你的应用性能

理解机制之后，回到实际问题：GC 在哪些场景下会实实在在影响用户体验？

### 分配风暴

短时间内大量对象分配，超过 GC 回收速度。典型场景是 RecyclerView 快速滑动时，每个 item 创建大量临时对象。

```kotlin
// 反例：onBind 中频繁分配
override fun onBindViewHolder(holder: ViewHolder, position: Int) {
    val formatter = SimpleDateFormat("yyyy-MM-dd") // 每次绑定都创建
    holder.dateText.text = formatter.format(items[position].date)
}
```

GC 日志会出现密集的 `GC_FOR_ALLOC`，每帧渲染时间超过 16ms。把 `SimpleDateFormat` 提取为 companion object 或 ThreadLocal 就能消除这类分配。

### 大对象与 LOS 空间

Bitmap、大数组分配在 Large Object Space（LOS），不走常规堆。LOS 的回收策略更保守——只在 Full GC 时才清理。这就是开篇那个 OOM 的根因：Bitmap 不可达但留在 LOS 里，等不到 Full GC。

Bitmap 复用（`inBitmap`）和 `LruCache` 是实用的缓解手段。Pixel 设备上 Android 14+ 的 Hardware Buffer 机制把 Bitmap 内存移到 GPU 管理，进一步绕过了 ART 堆的压力。

### GC 时机与关键路径

应用启动阶段是 GC 敏感期。ART 在冷启动时会触发大量类加载和初始化，分配密集。如果此时触发并发 GC，CPU 竞争会让启动时间增加 20-50%。

Android 的做法是启动期抑制 GC——AMS 在应用启动的首几秒延迟非紧急 GC。开发者能配合的是：延迟初始化非关键模块，避免在 `Application.onCreate` 里加载大资源。

### 监听 GC 行为

线上监控 GC 频率和暂停时间是判断内存健康度的直接指标：

```kotlin
val memoryInfo = Debug.MemoryInfo()
Debug.getMemoryInfo(memoryInfo)

// Android 11+ 可以更精细地监听
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    // 关注 gcCount 和 gcTime 趋势
}
```

`gcCount` 增长斜率变大、`gcTime` 累计超过阈值（如 50ms/秒），说明分配压力过大，需要排查热点。

## 选 GC 还是选对象池

技术选型上有个常被讨论的问题：手动管理对象池还是信任 GC？我的经验——

- **短生命周期、小对象**：交给 GC。CC GC 拷贝这类对象几乎零成本，自己写池反而增加代码复杂度和常驻内存。
- **中等生命周期**（如 ViewHolder）：利用 RecyclerView 内置的回收池，不要另起炉灶。
- **大对象、复用频率高**（如网络缓冲区、Bitmap）：手动池化。ByteArrayPool、BitmapPool 这类方案已经足够成熟。
- **跨线程共享对象**：尽量避免。跨线程引用让 GC 难以快速判断可达性，增加标记开销。

ART 的 GC 已经从"能不用就别用"进化到了"放心用，只在关键路径上关注"。理解它的工作方式，不是为了对抗 GC，而是让你的代码在 GC 运行的时候少一点压力。
