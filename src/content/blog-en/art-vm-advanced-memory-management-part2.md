---
title: "ART Runtime and Advanced Memory Management (2): ART GC"
lang: en
translationKey: art-vm-advanced-memory-management-part2
slug: art-vm-advanced-memory-management-part2
excerpt: "Part 2 of ART Runtime and Advanced Memory Management: a deep look at ART heap structure, GC algorithms, pauses, barriers, and GC logs."
publishDate: '2024-05-05'
tags:
- "Android"
- "ART"
- "Memory Management"
- "Runtime"
series:
  name: "ART Runtime and Advanced Memory Management"
  part: 2
  total: 4
seo:
  title: "ART Runtime and Advanced Memory Management (2): ART GC"
  description: "Explore ART garbage collection in depth, including generational heaps, LOS, CMS, GSS, Concurrent Copying, barriers, pause time, and GC logs."
  pageType: article
---
> This is part 2 of the four-part "ART Runtime and Advanced Memory Management" series. In the previous article, we explored "Introduction: the foundation of performance and stability."

## 2. Deep analysis of ART garbage collection (GC)

ART GC is the core of memory management. Its design goal is to reclaim memory while minimizing the impact on application threads, especially jank caused by pauses.

### Managed heap structure

#### Generational hypothesis

Most Java objects have short lifetimes. Based on this observation, ART usually uses a generational heap design, though exact implementation may vary by device and version.

#### Young Generation / Nursery

- Newly created objects are usually allocated here.
- The space is relatively small, and GC runs frequently. This is called Minor GC.
- **Goal**: quickly reclaim many short-lived objects.
- **Common algorithm**: Semi-Space Copying, or GSS. The young generation is split into Eden and two equally sized Survivor spaces, From and To. Objects are allocated in Eden. When Eden is full, Minor GC copies live objects to To, clears Eden and From, then swaps the roles of From and To. This algorithm is fast and avoids fragmentation, but requires extra space.
- Objects that survive multiple Minor GCs are **promoted** to the old generation.

#### Old Generation / Tenured Space

- Stores long-lived objects promoted from the young generation.
- GC is less frequent, but a single collection may take longer. It is called Major GC or Full GC, although ART tries to avoid Full GC.
- **Common algorithms**: CMS, Concurrent Mark-Sweep, or more modern concurrent mark/compact/copy algorithms such as Concurrent Copying, CC.

#### Large Object Space, LOS

- Stores objects above a specific size threshold, such as large `byte[]` arrays and Bitmap data.
- Managed separately. It usually does not copy objects, avoiding expensive copy cost, and uses mark-sweep or similar algorithms. During GC, it is handled separately from other regions.

#### Zygote space

Objects preloaded by Zygote live in a special region shared by forked child processes through copy-on-write.

**Diagram: conceptual generational heap structure**

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

### Core GC algorithm ideas

ART dynamically chooses GC strategies based on heap state and runtime conditions.

#### CMS, Concurrent Mark-Sweep

- **Phases**: initial mark, a short STW pause; concurrent mark, which runs with the app; remark, another short STW pause; and concurrent sweep, which runs with the app.
- **Benefits**: the main marking phase is concurrent, reducing long pauses.
- **Drawbacks**: sweeping does not compact memory, so it creates **fragmentation**. Concurrent phases may require application-thread cooperation, such as mark updates. Concurrent Mode Failure may occur and degrade into Full GC with a long pause. CMS has gradually been replaced in newer ART versions.

#### GSS, Generational Semi-Space

Commonly used for the young generation as described above. It is fast, efficient, and fragmentation-free, but has space overhead.

#### CC, Concurrent Copying, and other concurrent compaction algorithms

- **Goal**: move and compact objects, usually in the old generation, while running concurrently, eliminating fragmentation and improving later allocation speed.
- **Key technique**: may use **read barriers**. When an application thread reads an object reference, a small code fragment, the read barrier, checks whether the object has been moved by GC. If it has, the reference is updated to the new address. This lets GC move objects while the app is running.
- **Benefits**: reduces long pauses and solves fragmentation.
- **Drawbacks**: read barriers add a small runtime overhead, and implementation is more complex.

#### Sticky CMS

An early ART optimization and a CMS variant. It clears only objects newly allocated since the previous GC, reducing the scan range and speeding up collection.

#### Dynamic selection

ART chooses different GC types according to factors such as foreground/background state and heap usage, including `kCollectorTypeHeapTrim`, `kCollectorTypeHomogeneousSpaceCompact`, and `kCollectorTypeInstrumentation`, balancing throughput and pause time.

### Concurrency and pause time

- **Concurrent GC**: most GC work, such as marking and part of sweeping or copying, runs in parallel with application threads.
- **Stop-the-World, STW, pauses**: even concurrent GC needs to briefly pause all application threads at key phases to ensure data consistency, such as scanning thread stacks and global variables to collect root references, or handling reference updates. ART aims to keep these pauses down to a few milliseconds or less to avoid user-visible impact, especially frame drops over the 16 ms frame budget.

### Read/write barriers

- **Purpose**: in concurrent GC, especially moving concurrent GC, coordinate application-thread modifications to the object graph with GC traversal and movement.
- **Read barrier**: code inserted when reading object references to ensure the reference points to the correct post-move object.
- **Write barrier**: code inserted when writing object references to notify GC that an object's reference relationship changed. For example, an old-generation object now references a young-generation object.
- **Impact**: barriers are key to low-pause concurrent GC, but they also add small runtime overhead to application code.

### GC trigger timing

- **Heap allocation limit exceeded**: when allocating in a memory region such as Eden and remaining space is insufficient, GC is triggered, usually Minor GC.
- **Heap growth limit**: when overall heap usage reaches a threshold dynamically adjusted by device memory and configuration, a more comprehensive GC such as Major GC or concurrent compaction may be triggered.
- **Explicit calls**: `System.gc()` or `Runtime.getRuntime().gc()`. Application-layer calls are **strongly discouraged** because they are only suggestions, are not guaranteed to run, and may trigger expensive GC at inappropriate times, disrupting ART's self-regulation.
- **System events**: low-memory state, app entering background, and similar events may cause the system to trigger GC or heap trim.

### Reading GC logs

Logcat GC logs are essential for analyzing memory behavior. They usually include:

- **Reason**: such as Alloc, Background, or Explicit.
- **Collector Type**: such as MarkSweep, Copying, Concurrent MarkSweep, or Concurrent Copying.
- **Pause Time**: total STW pause duration, which deserves special attention.
- **Concurrent Time**: duration of concurrent phases.
- **Memory Freed**: how much memory this GC reclaimed.
- **Heap Size change**: heap usage before and after GC.

**Examples**:

```plain
I/art: Compiler allocated 11MB to compile void android.widget.TextView.<init>(...) (JIT/AOT)
```

```plain
I/art: Explicit concurrent mark sweep GC freed 11(356B) AllocSpace objects, 0(0B) LOS objects, 40% free, 5MB/9MB, paused 1.234ms total 100.123ms
```

Focus on the `paused` time.

---

> Next, we will explore "Advanced memory problem diagnosis" in this series.

**"ART Runtime and Advanced Memory Management" series**

1. Introduction: the foundation of performance and stability
2. **Deep analysis of ART garbage collection (GC)** (this article)
3. Advanced memory problem diagnosis
4. Native memory exploration: the part below the surface
