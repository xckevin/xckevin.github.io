---
title: "Android Simpleperf Flame Graphs: From CPU Sampling to Performance Bottleneck Analysis"
lang: en
translationKey: android-simpleperf-flamegraph-cpu-profiling
slug: android-simpleperf-flamegraph-cpu-profiling
excerpt: "A deep dive into Android Simpleperf, covering flame graph generation, call-stack analysis, cold-start hotspots, RenderThread investigation, multi-thread CPU attribution, and how to combine Simpleperf with Systrace."
publishDate: '2026-06-02'
tags:
- "Android"
- "Performance Optimization"
- "Simpleperf"
- "Flame Graphs"
- "CPU Sampling"
seo:
  title: "Android Simpleperf Flame Graphs: CPU Sampling and Bottleneck Analysis"
  description: "Use Android Simpleperf for flame graphs, call-stack analysis, cold-start hotspots, RenderThread profiling, and Systrace correlation."
  pageType: article
---

When optimizing cold start performance, I encountered an issue: Systrace showed a 200ms idle gap on the main thread, yet CPU usage remained high. Systrace tells you "what happened and when," but it does not explain why the CPU is busy when the root cause is computation-heavy logic. This is where Simpleperf comes in—Android's CPU profiling tool.

## What is Simpleperf?

**Simpleperf** is a CPU performance analysis tool bundled with the Android NDK, implemented using the Linux `perf_event` subsystem. Unlike Systrace, which tracks system events and function call timings, Simpleperf directly samples the CPU instruction execution state—it tells you "where the CPU time was spent."

Simpleperf's workflow:

1. Interrupts the CPU at a fixed frequency (default 4000Hz).
2. Records the currently executing thread, function address, and call stack.
3. Aggregates the sample data to generate a call graph.

The core concept here is the **sampling model**: it does not count how many times a function was called, but how often that function was on the CPU when a sample was taken. That sample count, multiplied by the sampling interval, estimates the CPU time consumed by the function. The higher the sampling frequency and the longer the recording duration, the closer the statistics will be to the true distribution.

```bash
# Record CPU samples for all threads during app cold start
simpleperf record -p $(pidof com.example.app) \
  --duration 10 \
  -f 4000 \
  -o perf.data
```

After sampling, the `perf.data` file contains raw sample point data. Next, this needs to be converted into a readable analysis report.

## Report Generation and the Essence of Flame Graphs

Simpleperf includes a built-in `report` command that can output a text report, but when dealing with thousands of function call relationships, plain text makes it hard to quickly pinpoint bottlenecks. **Flame Graphs** are a vectorized call stack visualization technique invented by Brendan Gregg; they show the entire picture in one graph.

Steps to generate a Flame Graph:

```bash
# 1. Convert perf.data to script format
simpleperf report -i perf.data \
  --sort comm,pid,tid,dso,symbol \
  -g --csv > perf.csv

# 2. Convert to folded stack format (using simpleperf built-in script or custom script)
python3 report_html.py -i perf.data -o report.html
```

You can also generate a call graph directly using the `simpleperf report` `-g` option:

```bash
simpleperf report -i perf.data -g --sort comm,symbol
```

The width of the x-axis in a Flame Graph represents the proportion of time a function was sampled, and the y-axis is the call stack depth. To understand this graph, remember one rule: **the wider the function, the more CPU time it consumed**. The wide, flat area at the top indicates the hot spot that needs optimization.

## Understanding the Call Stack: Inferring Bottlenecks from Top-Level Functions

The easiest mistake when looking at a Flame Graph is "jumping to the top"—seeing a high percentage for a leaf function and optimizing it. However, in most cases, the leaf function is just being called frequently by higher-level logic; the root cause is in the calling code.

I prefer an analysis approach that is "top-down":

1. Find the business entry point at the bottom of the Flame Graph (e.g., `Activity.onCreate`, `Choreographer.doFrame`).
2. Scan upwards along the call stack, observing the width change at each level.
3. A sudden narrowing of width suggests that the actual time consumption is being distributed across a few child calls—the more drastic the width change, the more concentrated the bottleneck.
4. Uniform width suggests a dispersed call chain with no obvious bottleneck.

Suppose you find that the `measure()` phase accounts for 30% of the CPU time. The Flame Graph will show a wide plateau between `ViewRootImpl.performTraversals` and `measure()`. At this point, you should investigate which View's `onMeasure` is repeatedly triggering layout passes, rather than optimizing `measure()` itself.

Another easily overlooked metric is the **function stack width**. If the parent function is very wide but the child function suddenly narrows significantly, it means the parent function's own logic (excluding child calls) consumed a large amount of CPU—this often points to pure computation-heavy code like loops, serialization, or string manipulation.

## Practical Example: Analyzing Cold Start CPU Hotspots

Using application cold start as an example, record the entire startup process from `Application.onCreate` to the first frame draw. The resulting Flame Graph usually presents several typical scenarios.

**Scenario 1: Excessive Class Loading and Initialization**

If `ClassLoader.loadClass` or `DexFile` related calls have high proportions in the Flame Graph, it indicates extensive reflection or first-time class references in the code. Direct countermeasures include checking if JSON parsing libraries use reflection or using R8 to reduce the number of classes.

**Scenario 2: SharedPreferences Blocking**

If `QueuedWork.waitToFinish` occupies width in the Flame Graph, it means that `apply()` in SP has accumulated a large number of pending disk write tasks, blocking the main thread during Activity lifecycle transitions. This requires migrating SP to DataStore or splitting files to reduce contention.

**Scenario 3: Lock Contention**

Large widths on `pthread_mutex_lock` or `art::Monitor::Lock` indicate a lock conflict between the main thread and background threads. The advantage of the Flame Graph here is that you can see the actual call chain waiting for the lock one level up, directly pinpointing the business code causing the wait.

```bash
# Filter samples by thread to quickly locate which thread holds the lock
simpleperf report -i perf.data --sort tid,comm,symbol \
  --filter "symbol == /lock/"
```

The command above can filter all samples waiting for a lock. Combined with the thread ID, you can determine if a worker thread holds the lock while the main thread waits, or vice versa.

## Analyzing Call Chains for Rendering Jitters

Analyzing the Flame Graph for the RenderThread differs from analyzing the main thread logic. Main thread hotspots are concentrated in the specific timings of Measure, Layout, and Draw; the RenderThread deals with GPU instruction generation functions.

**Typical Bottlenecks**:

- High proportion in `Skia` drawing functions $\rightarrow$ Over-drawing or too many complex paths.
- Large width in `glDrawArrays`/`glDrawElements` $\rightarrow$ Too many Draw Calls.
- Appearance of `Bitmap` decoding related functions $\rightarrow$ Texture loading executing on the main thread.

`android::uirenderer::renderthread::CanvasContext::draw` is the key entry point for analyzing the RenderThread. The call chain seen above this point directly reflects the rendering workload after every Vsync signal.

In practice, it is very helpful to insert trace markers in the code using Choreographer callbacks:

```kotlin
// Insert trace markers at key rendering points
override fun onDraw(canvas: Canvas) {
    Trace.beginSection("CustomView.onDraw")
    super.onDraw(canvas)
    Trace.endSection()
}
```

Simpleperf will sample these trace markers, appearing as distinct colored blocks on the Flame Graph, separating "business drawing" from "framework drawing" and making it easy to quantify the specific overhead of a custom View.

## Multi-threading Scenarios: CPU Time Allocation Per Thread

A single-threaded Flame Graph only shows the call stack of one thread, but applications usually run dozens of threads concurrently. Simpleperf supports analyzing CPU time allocation across threads:

```bash
simpleperf report -i perf.data --sort tid,comm --percent-limit 5
```

`--percent-limit 5` filters out threads with less than 5% usage, keeping only the main consumers. This command directly answers the question: **Is the CPU time consumed by the main thread, or is it distributed across background threads?**

If it's the latter, optimizing the main thread will be pointless. I made this mistake early in my optimization career—spending two days optimizing main thread logic only to find that the thread pool size was poorly allocated, and 8 threads simultaneously decoding Bitmaps saturated the P-cores, causing scheduling delays rather than slow computation itself.

Thread-level analysis can also reveal **thread scheduling issues**: if many threads each consume 1-3% of the CPU, the individual usage might be low, but the cumulative effect is significant. These threads are often background tasks created by third-party SDKs, requiring investigation into whether they can be consolidated.

## Symbol Resolution and Environment Setup

The quality of the Flame Graph heavily depends on whether the **symbol information** is complete. A call stack without symbols will only show addresses or `unknown`, making analysis impossible.

Two key points:

**1. Ensure Native Symbols are Retained.** If you use `-Os` optimization or strip the `.so`, simpleperf cannot resolve function names. Add this during compilation:

```gradle
android {
    buildTypes {
        release {
            // Keep symbol tables for simpleperf to use
            packagingOptions {
                jniLibs {
                    keepDebugSymbols += "**/*.so"
                }
            }
        }
    }
}
```

Debug builds usually retain symbols by default, but Release builds are often stripped. If you need to analyze production performance, you must retain a symbol-rich `.so` file during the build and inject symbols offline using the `--symfs` parameter.

**2. Specify the Symbol File Path.** If symbols are not in the default search path:

```bash
simpleperf report -i perf.data \
  --symfs /path/to/symbols \
  -g --csv > report.csv
```

The symbol file directory structure must strictly follow the `$SYMFS/<library_path>` hierarchy.

## Three Commonly Used Analysis Commands

The three most frequently used simpleperf commands:

```bash
# Sort by function to check CPU hotspots (fastest way to find Top N hot functions)
simpleperf report -i perf.data --sort symbol -n

# View the upstream/downstream relationship of hot functions using the call graph
simpleperf report -i perf.data -g --sort comm,symbol

# View sample counts and the full call stack for a specific function
simpleperf report -i perf.data \
  --filter "symbol == /yourFunctionName/" \
  -g --csv
```

The first command directly lists the Top 10 hot functions to create an optimization checklist, which you can investigate one by one. The second is used to verify if the call stack changes as expected after modifying code. The third is suitable for deep-diving into a specific function—if you find an abnormal width on the Flame Graph, use this to confirm the upstream calling source.

## Methodology Complementing Systrace

Simpleperf and Systrace solve two different types of problems:

- **Systrace** answers "what happened and when," and "why this operation took longer than expected."
- **Simpleperf** answers "where the CPU time was spent," and "which line of code has the highest computational load."

In real-world work, I prefer to first use Systrace to draw a timeline, identifying the precise time interval of a stuttering frame or slow path. Then, I use Simpleperf to sample within that interval to see what the CPU was doing. The typical combined workflow:

1. **Systrace Localization**: A 400ms blank block is observed between 800ms and 1200ms during startup.
2. **Simpleperf Sampling**: Sampling the same interval reveals that 30% of CPU time was spent in `HashMap.get`.
3. **Code Review**: It turns out there was an $O(n^2)$ HashMap traversal logic during initialization.

Without the time anchor from Systrace, it's hard to know which interval to sample; without the micro-level CPU data from Simpleperf, you can't determine the exact computational bottleneck within that blank interval. Combining them translates the subjective feeling of "lag" into a quantifiable, actionable technical instruction—you don't have to guess where the bottleneck is; let the data tell you.

If using Systrace is inconvenient for your Release build (some OEM ROMs block `atrace`), Simpleperf only requires root or debuggable status, and it can even use the `simpleperf app_profiler` command line to sample on non-debug builds, offering broader compatibility. This is why Simpleperf is the more reliable choice for third-party application performance analysis.
