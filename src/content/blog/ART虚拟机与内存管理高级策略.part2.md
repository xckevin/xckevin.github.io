---
title: "ART 虚拟机与内存管理高级策略（2）：ART 垃圾回收（GC）深度剖析"
excerpt: "「ART 虚拟机与内存管理高级策略」系列第 2/4 篇：ART 垃圾回收（GC）深度剖析"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - ART
  - 内存管理
  - 虚拟机
series:
  name: "ART 虚拟机与内存管理高级策略"
  part: 2
  total: 4
seo:
  title: "ART 虚拟机与内存管理高级策略（2）：ART 垃圾回收（GC）深度剖析"
  description: "「ART 虚拟机与内存管理高级策略」系列第 2/4 篇：ART 垃圾回收（GC）深度剖析"
---
# ART 虚拟机与内存管理高级策略（2）：ART 垃圾回收（GC）深度剖析

> 本文是「ART 虚拟机与内存管理高级策略」系列的第 2 篇，共 4 篇。在上一篇中，我们探讨了「引言：性能与稳定的基石」的相关内容。

## 二、ART 垃圾回收（GC）深度剖析

ART 的 GC 机制是其内存管理的核心，设计目标是在回收内存的同时，尽可能减少对应用线程的影响（即减少卡顿）。

### 托管堆（Managed Heap）结构

#### 分代假说（Generational Hypothesis）

大多数 Java 对象生命周期很短（「大部分对象朝生夕灭」）。基于此，ART 通常采用分代堆的设计（具体实现可能因设备、版本而异）。

#### 年轻代（Young Generation / Nursery）

- 新创建的对象通常分配在这里
- 空间相对较小，GC 频繁发生（称为 Minor GC）
- **目标**：快速回收大量短生命周期的对象
- **常用算法**：半区复制（Semi-Space Copying, GSS）。将年轻代分为 Eden 区和两个大小相等的 Survivor 区（From/To）。对象在 Eden 分配，Eden 满后触发 Minor GC，存活对象被拷贝到 To 区，然后清空 Eden 和 From 区，最后 From 和 To 区角色互换。这种算法速度快，能解决内存碎片，但需要额外一倍的空间
- 存活多次 Minor GC 的对象会被**晋升（Promote）**到老年代

#### 老年代（Old Generation / Tenured Space）

- 存放生命周期较长的对象（从年轻代晋升而来）
- GC 频率较低，但单次 GC 耗时可能更长（称为 Major GC 或 Full GC，虽然 ART 尽量避免 Full GC）
- **常用算法**：CMS（Concurrent Mark-Sweep），或更现代的并发标记/整理/复制算法（如 Concurrent Copying - CC）

#### 大对象空间（Large Object Space, LOS）

- 用于存放超过特定大小阈值的对象（如大型 `byte[]`、Bitmap 数据）
- 单独管理，通常不进行复制（避免高昂的拷贝成本），采用标记-清除或类似算法。GC 时与其他区域分开处理

#### Zygote 空间

由 Zygote 预加载的对象位于特殊区域，被所有 fork 出的子进程共享（写时复制）。

**（图示：分代堆结构（概念））**

```plain
+-------------------------------------------------------------------+ Java Heap
| +------------------------+ +------------------------------------+ |
| |    Young Generation    | |          Old Generation            | |
| |------------------------| |------------------------------------| |
| |  Eden Space            | |                                    | |
| |  (New Allocations)     | | (Long-lived / Promoted Objects)    | |
| |                        | |                                    | |
| |---+--------------------| |                                    | |
| | S0|         S1         | |                                    | |
| |(From/To Survivor Space)| |                                    | |
| +------------------------+ +------------------------------------+ |
+-------------------------------------------------------------------+
| +----------------------------------------------------------------+ |
| |                  Large Object Space (LOS)                      | |
| |                  (Very Large Objects)                          | |
| +----------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

### 核心 GC 算法理念

ART 会根据堆状态和运行情况动态选择 GC 策略。

#### CMS（Concurrent Mark-Sweep）

- **阶段**：初始标记（STW，短暂停）、并发标记（与应用并发）、重新标记（STW，较短暂停）、并发清除（与应用并发）
- **优点**：主要标记阶段并发，减少了长暂停
- **缺点**：清除阶段不整理内存，会产生**内存碎片**；并发阶段可能需要应用线程配合（如更新标记）；可能发生「Concurrent Mode Failure」导致退化为 Full GC（长暂停）。在较新的 ART 版本中逐渐被取代

#### GSS（Generational Semi-Space）

年轻代常用，如前所述。快速、高效、无碎片，但有空间开销。

#### CC（Concurrent Copying）/ 其他并发整理算法

- **目标**：在并发执行的同时，移动和整理对象（通常是老年代），以消除碎片，提高后续分配速度
- **关键技术**：可能使用**读屏障（Read Barrier）**。当应用线程读取对象引用时，会触发一个小的代码片段（读屏障），检查该对象是否已被 GC 移动，如果移动了则更新引用到新地址。这使得 GC 可以在应用运行时移动对象
- **优点**：减少了长暂停时间，解决了碎片问题
- **缺点**：读屏障会带来微小的运行时性能开销；实现更复杂

#### Sticky CMS（Sticky Concurrent Mark-Sweep）

ART 早期的一种优化，是 CMS 的变体。它只清除自上次 GC 以来新分配的对象，从而缩小扫描范围、加快回收速度。

#### 动态选择

ART 会根据当前是前台应用还是后台应用、堆内存使用情况等因素，选择不同的 GC 类型（如 `kCollectorTypeHeapTrim`、`kCollectorTypeHomogeneousSpaceCompact`、`kCollectorTypeInstrumentation` 等），以平衡吞吐量和暂停时间。

### 并发性与暂停（Pause Time）

- **并发 GC（Concurrent GC）**：GC 的大部分工作（如标记、部分清除/复制）与应用线程并行执行
- **「Stop-the-World」（STW）暂停**：即使是并发 GC，也需要在某些关键阶段短暂地暂停所有应用线程，以保证数据一致性（如扫描线程栈和全局变量获取根引用集合、处理引用更新等）。ART 的目标是将这些暂停时间缩短到几毫秒甚至更低，以避免影响用户体验（尤其是避免超过 16ms 导致掉帧）

### 读/写屏障（Read/Write Barriers）

- **目的**：在并发 GC（特别是移动对象的并发 GC）中，协调应用线程对对象图的修改和 GC 线程对对象图的遍历/移动
- **读屏障**：在读取对象引用时插入的代码，用于确保读到的是对象移动后的正确引用
- **写屏障**：在写入对象引用时插入的代码，用于通知 GC 线程某个对象的引用关系发生了变化（例如，一个老年代对象引用了一个年轻代对象）
- **影响**：屏障技术是实现低暂停并发 GC 的关键，但它们本身会给应用代码带来一些微小的运行时开销

### GC 触发时机

- **堆分配超限**：当向某个内存区域（如 Eden 区）分配内存时，如果剩余空间不足，则触发 GC（通常是 Minor GC）
- **堆增长限制**：当整体堆内存使用量达到某个阈值（根据设备内存和配置动态调整）时，可能触发更全面的 GC（如 Major GC 或并发整理）
- **显式调用**：`System.gc()` 或 `Runtime.getRuntime().gc()`。**强烈不推荐**应用层调用，因为它只是一个「建议」，不保证执行，且可能在不合适的时机触发昂贵的 GC，破坏 ART 的自我调节
- **系统事件**：如低内存状态、应用进入后台等，系统可能会触发 GC 或 Heap Trim

### 解读 GC 日志

查看 Logcat 中的 GC 日志对于分析内存行为至关重要。日志通常包含：

- **触发原因（Reason）**：如 Alloc、Background、Explicit
- **收集器类型（Collector Type）**：如 MarkSweep、Copying、Concurrent MarkSweep、Concurrent Copying
- **暂停时间（Pause Time）**：STW 暂停的总时长（需要重点关注）
- **并发耗时（Concurrent Time）**：并发阶段的耗时
- **释放内存（Memory Freed）**：本次 GC 回收了多少内存
- **堆大小变化（Heap Size）**：GC 前后的堆内存占用情况

**示例**：

```
I/art: Compiler allocated 11MB to compile void android.widget.TextView.<init>(...) (JIT/AOT)
```

```
I/art: Explicit concurrent mark sweep GC freed 11(356B) AllocSpace objects, 0(0B) LOS objects, 40% free, 5MB/9MB, paused 1.234ms total 100.123ms
```

（需要关注 paused 时间）

---

---

> 下一篇我们将探讨「高级内存问题诊断」，敬请关注本系列。

**「ART 虚拟机与内存管理高级策略」系列目录**

1. 引言：性能与稳定的基石
2. **ART 垃圾回收（GC）深度剖析**（本文）
3. 高级内存问题诊断
4. Native 内存探秘：冰山下的部分
