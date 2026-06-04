---
title: "ART Runtime and Advanced Memory Management (1): Foundations"
lang: en
translationKey: art-vm-advanced-memory-management-part1
slug: art-vm-advanced-memory-management-part1
excerpt: "Part 1 of ART Runtime and Advanced Memory Management: why ART, GC, and memory strategy are foundations for Android performance and stability."
publishDate: '2024-05-05'
tags:
- "Android"
- "ART"
- "Memory Management"
- "Runtime"
series:
  name: "ART Runtime and Advanced Memory Management"
  part: 1
  total: 4
seo:
  title: "ART Runtime and Advanced Memory Management (1): Foundations"
  description: "Understand why ART internals, GC behavior, native memory, and memory analysis tools are essential foundations for stable, smooth Android apps."
  pageType: article
---
> This is part 1 of the four-part "ART Runtime and Advanced Memory Management" series.

## Introduction: the foundation of performance and stability

In Android app development, memory management is a foundation of performance and stability. The notorious Out-of-Memory, or OOM, error is a common cause of app crashes, while frequent memory churn triggers garbage-collection pauses and leads to UI jank, seriously damaging user experience.

For Android developers, it is not enough to understand the Java heap and stack or know how to fix simple memory leaks. **You must deeply understand Android Runtime, ART, its internal mechanics, complex compilation strategies, garbage collector algorithms and behavior, advanced memory analysis tools such as MAT and Perfetto, native memory challenges, and systematic advanced optimization strategies for minimizing memory footprint, reducing GC impact, and eliminating OOM risk.** This is not only about robustness; it directly affects the smoothness users perceive.

This article explores ART and advanced memory management in depth, focusing on:

- **ART runtime analysis**: compare Dalvik and ART, and explain AOT/JIT/PGO compilation strategies.
- **Deep ART GC analysis**: heap structure, generational hypothesis, core GC algorithms such as CMS, GSS, and CC, concurrent GC, and pauses.
- **Advanced memory problem diagnosis**: deep causes of leaks, churn, fragmentation, and Bitmap problems.
- **Memory analysis tools**: master Android Studio Profiler, MAT, Perfetto, and command-line tools for memory analysis.
- **Native memory exploration**: native memory leak sources, detection tools such as HWASan/ASan and heapprofd, and management practices.
- **Advanced optimization strategies**: object pools, aggressive Bitmap optimization, efficient data structures, memory monitoring, and more.

---

## 1. ART: a modern runtime beyond Dalvik

ART replaced Dalvik as the official Android runtime starting with Android 5.0, Lollipop. Understanding its core features is the prerequisite for understanding memory behavior.

### Core differences from Dalvik

- **Dalvik**: mainly relied on Just-in-Time, JIT, compilation and bytecode interpretation. App startup was relatively fast because no precompilation was required, but runtime performance could be weaker, and JIT itself had overhead.
- **ART**: combines multiple compilation strategies. Its main goal is to translate DEX bytecode into native machine code for execution, improving runtime efficiency.

### ART core architecture

- **Executes DEX bytecode**: DEX remains the input format.
- **Provides a managed environment**: responsible for memory management, GC, thread scheduling, type-safety checks, JNI interaction, and more.
- **AOT, JIT, and interpreter coexist**: ART chooses the most efficient execution mode depending on the situation.

### ART's hybrid compilation strategy

#### AOT, Ahead-of-Time compilation

- **Timing**: during app installation or device idle time, the dex2oat tool compiles DEX bytecode, or part of it, into native OAT, Optimized Ahead-of-Time, files.
- **Benefits**: the app can directly execute native machine code at startup, improving startup speed. More expensive optimizations can run at compile time, so peak performance can be better in theory.
- **Drawbacks**: installation takes longer; OAT files consume extra storage; code that is rarely executed after startup may be compiled unnecessarily.

#### JIT, Just-in-Time compilation

- **Timing**: while the app is running, ART dynamically monitors and compiles frequently executed hot methods. Compiled native code is cached in memory.
- **Benefits**: compilation can reflect actual runtime behavior, covering hot code that AOT may miss. Performance is better than pure interpretation.
- **Drawbacks**: runtime compilation consumes CPU and power; the first execution before a method becomes hot may be slower because it is interpreted or not optimized; compilation results are usually kept in memory and may be lost after process restart, requiring JIT again.

#### Profile-Guided Optimization / Profile-Guided Compilation: the mainstream strategy

- **Mechanism**: this is the core strategy of modern ART, combining the strengths of AOT and JIT.
- **Runtime profiling**: ART collects code execution information at runtime, such as frequently called methods and code paths, and saves it as profile files, usually under `/data/misc/profiles/`.
- **Background optimized compilation**: when the device is idle and charging, the system background compiler daemon, dex2oat, uses collected profile files to **selectively** AOT-compile and optimize hot code in the app.
- **JIT supplement**: for code not covered by profiles or newly generated hot code, JIT still compiles at runtime.
- **Cloud Profiles**: Google Play can distribute anonymous aggregated startup profiles, helping apps perform more effective AOT compilation for critical startup paths on first install.
- **Goal**: fast startup for common code paths through profiled AOT, high performance for runtime hot code through JIT or profiled AOT, and avoidance of the storage and installation-time cost of full AOT.

**Interpreted execution**: for code that is not hot and has not been AOT-compiled, ART may still use the interpreter to execute DEX bytecode.

**Diagram: ART compilation strategy flow**

```plain
App Install / Idle Update                   App Runtime
       +-------------------------+              +------------------------+
       |      dex2oat Tool       |<-- Reads --- |   Runtime Profile      |
       | (Uses Profile if avail.)|   Profile    | (.prof file, collected)|
       +-----------+-------------+              +-----------+------------+
                   | Generates                            | Records Execution Freq.
                   V                                      |
       +-------------------------+                      |
       |  OAT File (Native Code)|                      |
       |  (AOT/Profiled AOT)   |                      |
       +-----------+-------------+                      |
                   | Loaded at App Start                V
                   V                        +------------------------+
+-------------------------------------> |     ART Runtime        |
| DEX Bytecode                       |  |----------------------| Executes
+-------------------------------------> | - Executes OAT code    | ----> Native Code
                                     | - JIT Compiler         | ----> Native Code (Runtime Compiled)
                                     |   (Compiles hot code)  |
                                     | - Interpreter          | ----> Interpreted Execution
                                     +------------------------+
```

**OAT file format**: an OAT file is an ELF-format file. It contains native machine code translated from DEX, sometimes a copy of the original DEX file for reflection and related needs, and metadata required by ART.

---

> Next, we will explore "Deep analysis of ART garbage collection (GC)" in this series.

**"ART Runtime and Advanced Memory Management" series**

1. **Introduction: the foundation of performance and stability** (this article)
2. Deep analysis of ART garbage collection (GC)
3. Advanced memory problem diagnosis
4. Native memory exploration: the part below the surface
