---
title: "Android Studio Profiler in Practice: CPU Tracing to Memory Allocation Diagnostics"
lang: en
translationKey: android-studio-profiler-cpu-memory
slug: android-studio-profiler-cpu-memory
excerpt: "A practical guide to the full Android Studio Profiler toolkit, covering CPU sampling vs. instrumentation, flame graph reading, memory allocation tracking, heap dump diffing, and layered diagnosis with Systrace and Perfetto."
publishDate: '2026-06-14'
tags:
- "Android"
- "Performance"
- "CPU Profiler"
- "Memory Profiler"
- "Systrace"
seo:
  title: "Android Studio Profiler Guide: CPU, Memory, Systrace, Perfetto"
  description: "Android performance diagnostics with Studio Profiler: CPU sampling, flame graphs, memory leak detection, and Systrace/Perfetto triage."
  pageType: article
---

Last week I was tracking down a production ANR. The stack trace pointed at `onBindViewHolder` on the main thread. The code logic was fine, but the trace file had a large green block swallowed by `RVFling`. Half the team used Perfetto, others stuck with Systrace, and someone only looked at the Profiler flame graph — conclusions did not align, and communication overhead was high.

The tools are not the problem. The gap between tools is. Android has no shortage of diagnostic tools; what is missing is a mental model for chaining them together.

## CPU Profiler: From Call Stacks to Trace Collection

CPU Profiler is essentially sampling against the ART runtime. In sampling mode, the VM captures the current thread's call stack at a fixed frequency (default 1000Hz), producing a call tree and flame graph.

Sampling vs. instrumentation:

| Dimension | Sample | Instrumented |
|---|---|---|
| Mechanism | Periodic call-stack snapshots | Probes inserted at every method entry/exit |
| Overhead | Very low | Very high — app becomes noticeably slow |
| Accuracy | Good for macro hotspots; short functions may be missed | Precise down to call count and per-method duration |
| Use case | Production issues, long-tail latency | Algorithm micro-optimization, unit-level benchmarks |

```kotlin
// A typical sampling misattribution: a 30μs function called at high frequency appears as a hotspot
inline fun fastOp() { /* 30μs */ }  // if a sample lands before the function returns, it shows as a hotspot

// The real hotspot is the loop itself, not fastOp
repeat(10000) { fastOp() }
```

For production trace collection I prefer `Debug.startMethodTracingSampling()`. The default `startMethodTracing` is full instrumentation — never use it in production. An instrumented app is one to two orders of magnitude slower, which means the profiler itself becomes the performance problem.

When you click Record, the config dialog offers several options. Here is how to choose:

- **Sample Java Methods**: sampling mode, the everyday default
- **Trace Java Methods**: instrumentation mode, only for micro-benchmarks
- **Sample C/C++ Functions**: native-layer sampling, requires symbol tables
- **Trace System Calls**: syscall tracing, for I/O and Binder bottlenecks

Few people notice the **Trace duration** setting. The default 5 seconds is insufficient for many scenarios — cold start analysis should be 10-15 seconds, while reproducing a frame-drop jank usually takes 3-5 seconds.

## Reading Flame Graphs: Width Matters More Than Depth

Flame graphs have a fixed reading protocol.

**Read the width.** The wider a call-stack bar, the more CPU time it consumes. This is the first signal for locating hotspots.

**Read the flatness.** If the top of the flame graph is very flat (many small bars in a row), CPU cost is spread across many small functions with no single hotspot. This is usually an architecture problem, not an implementation problem.

**Read the color.** Orange is system calls, green is application code, blue is third-party libraries. A wall of orange likely means I/O or Binder communication is blocking.

```kotlin
// This code shows up as a wide green bar in the flame graph — a classic "not a system issue" signal
fun parseResponse(json: String): List<Item> {
    val list = mutableListOf<Item>()
    for (i in 0 until json.length) {  // reading one char per iteration — String is UTF-16
        // The flame graph flags this line as a hotspot
    }
    return list
}
```

Reframe this: the flame graph answers "**where did CPU time go**", not "**why is it slow**". A function blocked on `Binder.transact()` waiting for a return will rarely be hit by sampling — it is in a suspended state, consuming no CPU.

## Memory Profiler: Leak Detection and Allocation Tracking

Since Android Studio 4.0, the Memory Profiler integrates two analysis paths: **live allocation tracking** and **heap dump diffing**.

Allocation Tracking records every single object allocation — and I mean every. With it on, memory usage spikes and the app slows dramatically. This feature is for short, targeted captures:

1. Start recording before the suspicious operation
2. Stop immediately after the operation completes
3. Sort by allocation count to find abnormally frequent objects

Do not sort by Allocation Size — that number is cumulative and gets amplified by high-frequency small objects. **Sort by Allocations (count)** to expose loops that repeatedly `new` the same thing.

```kotlin
// A typical memory leak trap in a logging utility
object Logger {
    private val listeners = mutableListOf<LogCallback>()  // a teammate added a reference but never removes it

    fun log(msg: String) {
        listeners.forEach { it.onLog(msg) }
    }
}

// Heap dump diff will immediately expose: the Activity reference held by listeners is never released
```

Heap Dump Diff is the ace for locating leaks:

1. Dump once before opening the Activity
2. Close the Activity, manually trigger GC, then dump again
3. Compare instance counts of the same Class between the two snapshots

If an Activity's instance count does not return to zero in the second snapshot, it is being held. Use **Path to GC Root** to trace the reference chain — typically three to five steps to the leak point.

## Network Profiler and Energy Profiler: The Overlooked Dimensions

Network Profiler shows more than request latency. It exposes three metrics that are easy to overlook in daily development:

- **Concurrent connections**: Android caps concurrent connections per domain at 5-6. Exceeding the limit does not error out; subsequent requests queue. If the back half of a request batch has noticeable latency, check concurrency first.
- **Payload size**: Look at the raw payload, not the compressed size. With Retrofit and Gson, deserialization time is roughly linear with payload size.
- **Request timing**: The Timeline view directly reveals which requests are serial. Serial is not inherently wrong, but serial requests with no dependencies are parallelization candidates.

Energy Profiler is rarely used. Its display dimension is not battery percentage — it tracks three hardware resources: **CPU wake locks, WiFi locks, and Alarm wakeups**.

```kotlin
// This shows up as a sustained blue line in Energy Profiler — a wakelock
class UploadService : Service() {
    private lateinit var wakeLock: PowerManager.WakeLock

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "UploadService")
        wakeLock.acquire(10 * 60 * 1000L) // 10 minutes — aggressive
        // Energy Profiler will warn for the entire 10 minutes
        return START_STICKY
    }
}
```

A wakelock held longer than 1 minute triggers an Energy Profiler warning. That threshold is reasonable — the vast majority of upload tasks do not need to hold the lock that long.

## Systrace and Perfetto: The Key to Layered Diagnosis

There is a clear division of labor between Profiler and Systrace/Perfetto:

| Tool | Question it answers |
|---|---|
| CPU Profiler | Which method consumed the CPU time |
| Memory Profiler | Who allocated and who leaked the memory |
| Systrace | What happened at the system scheduling level |
| Perfetto | Multi-process timing + custom trace points |

Systrace reads from `/sys/kernel/debug/tracing/trace` at the granularity of kernel scheduling events. You can see **which thread a CPU core was running at a given millisecond**, but not what method executed inside that thread.

A practical tip: use `Trace.beginSection` to plant custom markers in Systrace.

```kotlin
import android.os.Trace

fun loadFeed() {
    Trace.beginSection("FeedLoad")
    // network request + parse + database write
    Trace.endSection()
}
```

This marker appears in both Systrace and Perfetto timelines, and **Perfetto can directly correlate it with Android Studio Profiler's CPU Trace**. If the CPU Profiler shows normal duration for the same time window but Systrace shows the thread in `sleeping` state, the bottleneck is not computation but waiting — likely Disk I/O or a Binder call blocking.

Perfetto's SQL query interface for timeline events is rarely mentioned but very useful:

```sql
-- Query main-thread scheduling delays directly in Perfetto's SQL panel
SELECT
  ts, dur, sched.utid, thread.name
FROM sched
JOIN thread USING (utid)
WHERE thread.name = 'main'
  AND dur > 10000000  -- scheduling delays over 10ms
ORDER BY dur DESC
LIMIT 20
```

This SQL lists every slice where the main thread was suspended for more than 10ms — far more efficient than scanning the timeline by eye.

## Case Study: Layered Triage of a Frame Drop

Here is a real investigation. A scrolling list dropped one frame every 3-4 seconds, with Choreographer skip-frame logs at 20+ per minute.

**Layer 1 — CPU Profiler:** Sampled 5 seconds of scrolling. The flame graph had a suspicious thick blue bar — Glide's `decodeStream`.

**Layer 2 — Memory Profiler:** Enabled allocation tracking. `decodeStream` allocated a 1.5MB `byte[]` on every call. The critical finding: it was called 40 times, but the list only scrolled past 8 items.

**Layer 3 — Systrace:** Ran `adb shell atrace gfx input view -t 5` to capture frame rendering scheduling. Confirmed the frame-drop timestamps aligned exactly with `decodeStream`'s disk I/O wait periods.

The conclusion was clear: the Adapter's `onBindViewHolder` called Glide to load the original image directly, with no thumbnail and no disk cache hit. The problem was not Glide — it was how it was being used. After changing the load strategy, the frame drops disappeared.

The three layers each played their role: **Profiler located the hotspot method → Allocation Tracking confirmed the allocation anomaly → Systrace verified the causal chain**. Using any one in isolation shows only a fragment.

## Toolchain Integration Practices

**Run a cold start before capturing traces.** Method timings can differ 3-5x before and after JIT warmup. A freshly installed app and an app that has been running for two days produce completely different Profiler data for the same method.

**Make Perfetto your main tool.** Systrace's UI is essentially unmaintained. Perfetto can import Systrace files for finer analysis. Viewing Systrace in `chrome://tracing` is a 2019 practice.

**Build enum constants for custom trace points** instead of scattering string literals.

```kotlin
object TraceSections {
    const val FEED_LOAD = "FeedLoad"
    const val IMAGE_DECODE = "ImageDecode"
    const val DB_WRITE = "DatabaseWrite"
}
```

**For production, use `Debug.startMethodTracingSampling` with a sampling rate.** Do not use the default `bufferSize` — the default 8MB is insufficient for long traces; start at 32MB. Set `flags` to `0` (the default 1000Hz sampling frequency is fine).

Perfetto's `trace_processor_shell` can convert trace files to plain JSON or CSV, which you can feed to scripts for automated performance regression detection in CI.
