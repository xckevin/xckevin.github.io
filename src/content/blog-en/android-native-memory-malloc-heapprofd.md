---
title: "Android Native Memory Analysis: From malloc_debug to heapprofd"
lang: en
translationKey: android-native-memory-malloc-heapprofd
slug: android-native-memory-malloc-heapprofd
excerpt: "A practical guide to Android native heap leak analysis, from quick malloc_debug checks to Perfetto heapprofd flamegraphs and sampling workflows."
publishDate: '2025-08-08'
tags:
- "Android"
- "Native Memory Analysis"
- "heapprofd"
- "Performance Optimization"
- "Perfetto"
seo:
  title: "Android Native Memory Leak Analysis with malloc_debug and heapprofd"
  description: "Learn an Android native memory leak workflow using malloc_debug for quick triage and Perfetto heapprofd for flamegraphs and code-level diagnosis."
  pageType: article
---

Last year I took over a memory issue in a video SDK. The Java heap looked normal, but the process PSS grew by about 30 MB every week. After a month, the app would inevitably crash. LeakCanary found nothing because the problem was in native code.

## Why native memory leaks are hard

Java leaks have a mature toolchain: LeakCanary, MAT, and Android Profiler can show reference chains clearly. Native code is different: **malloc and free are plain function calls. There is no GC and no reference graph to follow**. If a block is freed, it is freed. If it is not freed, it stays allocated forever. Nothing tells you who allocated it or why it was never released.

Android provides two main tools for native memory analysis: **malloc_debug** and **heapprofd**. The first is a lightweight option built into libc. The second is a sampling profiler in the Perfetto ecosystem.

## malloc_debug: the lightest entry point

`malloc_debug` is a debugging module built into bionic libc. It requires no extra dependency and can be enabled through system properties:

```bash
# Enable native allocation backtrace tracking
adb shell setprop libc.debug.malloc.options backtrace
adb shell setprop libc.debug.malloc.program <your_process_name>
# Restart the app so the setting takes effect
```

Once enabled, each malloc and free records a call stack. You can inspect Native Heap details with `dumpsys meminfo <pid>` or dump the heap with `am dumpheap`:

```bash
adb shell am dumpheap -n <pid> /data/local/tmp/native.txt
```

The output file shows unreleased allocations grouped by call stack.

The advantage of `malloc_debug` is that it is dependency-free and works across Android versions. The cost is **severe performance overhead**. It records a stack trace on every malloc. In high-frequency allocation paths, frame rate can drop from 60 fps to single digits. It also records allocation stacks but not free stacks, so it cannot cleanly distinguish "forgot to free" from "freed too early and caused a double free."

When investigating that video SDK, I first used `malloc_debug` to identify the leak source: allocations were coming from `av_malloc` on the video decode thread. But the performance cost was too high for complex scenarios, so I switched to heapprofd.

## heapprofd: Perfetto's native memory sampler

`heapprofd` was introduced in Android 10 and is integrated into Perfetto. Its core idea is **sampling instead of full tracing**. It does not track every malloc and free. Instead, it periodically samples the process heap and compares snapshots to find allocations that remain live.

```bash
# Record heapprofd data through the Perfetto command line
adb shell perfetto \
  -c - --txt \
  -o /data/misc/perfetto-traces/trace \
  <<EOF
buffers: {
  size_kb: 63488
}
data_sources: {
  config {
    name: "android.heapprofd"
    heapprofd_config {
      sampling_interval_bytes: 4096
      process_cmdline: "com.example.video"
      shmem_size_bytes: 8388608
      block_client: true
    }
  }
}
duration_ms: 30000
EOF
```

With `sampling_interval_bytes` set to 4096, heapprofd samples roughly once per 4 KB of allocation. This parameter balances performance and precision: too small hurts performance, too large misses small leaks. I usually tune it based on leak size. For leaks in the tens of MB, 8192 is enough. For KB-scale leaks, I lower it to 1024.

After recording, pull the trace file locally and open it in [Perfetto UI](https://ui.perfetto.dev). Switch to the heapprofd panel:

- **Flamegraph view**: groups allocations by call stack, making the hottest allocating functions obvious.
- **Timeline view**: shows how allocations from a call stack grow over time, which helps confirm a leak.
- **Allocations list**: shows individual live allocations and their allocation stacks.

In that investigation, the result was clear: the decode thread allocated many buffers through `av_malloc`, but `av_frame_free` did not correctly release the data pointers held by `AVFrame`. The root cause was an `av_frame_ref` without a matching `av_frame_unref`, which broke the reference count.

## A practical workflow

I summarize native memory leak investigation into three steps.

**Step 1: confirm the leak direction.** Use `dumpsys meminfo` to check whether Native Heap keeps growing, and rule out Java heap and Graphics memory noise. If Native Heap grows steadily while Java Heap stays flat, the problem is very likely in native code.

```bash
# Dump every 5 seconds and observe 10 samples
for i in $(seq 1 10); do
  adb shell dumpsys meminfo com.example.app | grep "Native Heap"
  sleep 5
done
```

**Step 2: sample with heapprofd.** Key settings:

- Record 30 to 60 seconds for the known leak scenario, covering one full leak cycle.
- If the leak happens after a specific operation, such as playing a video, start recording before the operation and continue for another 10 seconds afterward.
- Adjust the sampling interval based on leak speed. Faster leaks can use a larger interval.

**Step 3: locate the source in Perfetto UI.** After opening the trace, sort the flamegraph by total allocated size and find the largest call stack. Then switch to the timeline view to confirm whether that stack only grows and never drops. Finally, open individual allocation records to inspect the full call chain.

## malloc_debug vs heapprofd: how to choose

The tools serve different purposes: **malloc_debug is good for quick validation, while heapprofd is better for deep analysis**.

| | malloc_debug | heapprofd |
|---|---|---|
| Performance impact | Very high | Controllable through sampling |
| Data completeness | Full tracing | Sampled, small blocks may be missed |
| Free stack | Not recorded | Matched allocation data |
| Visualization | Text only | Flamegraph plus timeline |
| System requirement | No version limit | Android 10+ |

In real projects, I usually start with `malloc_debug` to quickly answer "is this a native leak?" and "which module is allocating?" It can give an answer in five minutes. Once confirmed, I switch to heapprofd for precise analysis and code-level diagnosis.

## A fallback when heapprofd is unavailable

heapprofd requires Android 10 or later, and some customized ROMs may disable the data source. On older devices, you can fall back to manually hooking malloc with `LD_PRELOAD`:

```cpp
// Use LD_PRELOAD to intercept malloc/free
void* malloc(size_t size) {
    void* ptr = __libc_malloc(size);
    // Record allocation data into a ring buffer
    record_allocation(ptr, size, __builtin_return_address(0));
    return ptr;
}
```

This approach is worse than heapprofd in both performance and stability, but it can still be useful on old devices. Use `_Unwind_Backtrace` for stack unwinding instead of `backtrace()`. On arm64, `backtrace()` depends on frame pointers and can become inaccurate after compiler optimization such as `-O2`.

## Verification after the fix

After fixing the code, do not only check whether Native Heap drops. Verify with **total PSS** as well. Native allocations do not map directly to PSS, but after the leak is fixed, PSS fluctuations should shrink significantly. I usually run a Monkey test and diff before and after:

```bash
# Record the baseline before the test
adb shell dumpsys meminfo com.example.app | grep "TOTAL PSS"
# Run 10,000 random operations
adb shell monkey -p com.example.app -v 10000
# Compare after the test; PSS growth should be under 5 MB
adb shell dumpsys meminfo com.example.app | grep "TOTAL PSS"
```

After the video SDK fix, PSS growth during a 30-minute stress test dropped from 80 MB to under 4 MB. Native memory bugs are often easy to fix once you reach the root cause. The hard part is finding the few missing `free` calls among millions of lines of C and C++. heapprofd flamegraphs plus a disciplined workflow turn that search from guesswork into a traceable process.
