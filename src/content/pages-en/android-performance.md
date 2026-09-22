---
title: Android Performance and Stability
lang: en
translationKey: android-performance
seo:
  title: 'Android Performance: Startup, Perfetto and WebView Stability'
  description: Android performance notes covering cold start, rendering, memory, Bitmap, ANR, Perfetto, Macrobenchmark, and production stability.
---

Start with slow startup, dropped frames or a WebView renderer exit. Define the symptom before collecting evidence; each route below leads to concrete tool steps and a way to verify the result.

## Choose a debugging route

| Symptom | Read first | Next action |
| --- | --- | --- |
| Slow startup with unclear first-frame and usable-screen metrics | [TTID, TTFD and startup benchmarks](/en/blog/android-startup-metrics/) | Fix the startup conditions, then inspect the critical path in Perfetto |
| Jank without a usable trace or a clear explanation | [Getting started with Perfetto](/en/blog/android-perfetto/) | Reproduce the issue and inspect the main thread, scheduling and frame timing |
| A blank WebView or a renderer-exit callback | [WebView renderer crashes and recovery](/en/blog/webview-render-process-crash-deep-dive/) | Separate exit signals from causes and verify destruction and recreation |
| A Compose list scrolls poorly | [LazyColumn performance debugging](/en/blog/jetpack-compose-lazycolumn-performance/) | Use a release build and examine item identity, state reads and frame duration |

## From a metric to a regression check

1. [Define startup metrics](/en/blog/android-startup-metrics/): separate cold, warm and hot starts, and distinguish first frame from usability.
2. [Capture and read a Perfetto trace](/en/blog/android-perfetto/): map a user action to thread work and waiting time.
3. Change one evidence-supported bottleneck while preserving the device, dataset, build type and capture conditions.
4. Repeat measurements with [Macrobenchmark](/en/blog/android-macrobenchmark-benchmarkrule/). Compare distributions and check for regressions.
5. For a renderer exit, follow the [WebView stability workflow](/en/blog/webview-render-process-crash-deep-dive/). A performance trace alone does not establish a crash cause.

## Core Articles

- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [Android app startup optimization: metrics, paths, tools, and governance](/en/blog/app-startup-optimization/)
- [RecyclerView cache internals: four cache levels, reuse, and Prefetch](/en/blog/android-recyclerview-cache-prefetch-deep-dive/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/en/blog/android-bitmap-memory-model-hardware-bitmap/)
- [Android RenderThread and HWUI: rendering pipeline, DisplayList, and jank analysis](/en/blog/android-renderthread-hwui/)
- [Android rendering and graphics stack: View, HWUI, and SurfaceFlinger](/en/blog/android-rendering-graphics-stack/)
- [Android Perfetto and Systrace: system-level performance analysis](/en/blog/android-system-performance-systrace-perfetto/)
- [Android Perfetto tracing: ftrace, TrackEvent, and production-grade performance monitoring](/en/blog/android-perfetto-ftrace-trackevent/)
- [Android audio system: AudioFlinger, mixing policy, and AAudio low latency](/en/blog/android-audio-system-audioflinger-aaudio/)
- [Android Macrobenchmark in practice: startup, scrolling, and performance regression testing](/en/blog/android-macrobenchmark-benchmarkrule/)

## Runtime, Memory, and Graphics Performance

- [Android ART garbage collection internals](/en/blog/android-art-garbage-collection/)
- [Android ART dex2oat: from DEX bytecode to OAT machine code with AOT/JIT compilation](/en/blog/android-art-dex2oat-pipeline/)
- [Android native memory analysis: from malloc_debug to heapprofd](/en/blog/android-native-memory-malloc-heapprofd/)
- [Android Vulkan rendering: from OpenGL ES migration to GPU driver tuning](/en/blog/android-vulkan-opengl-es-gpu/)
- [Android power management: from WakeLock misuse to Doze-mode engineering](/en/blog/android-battery-optimization-battery-historian/)
- [Android AlarmManager scheduling: Binder calls, AlarmManagerService, and exact wakeups under Doze](/en/blog/android-alarmmanager-scheduling/)
- [Android DEX bytecode and MultiDex loading](/en/blog/android-dex-bytecode-multidex/)
- [Android Media3 playback architecture: from ExoPlayer to MediaSession](/en/blog/android-media3-exoplayer-mediasession/)
- [Android networking stack: from DNS to HTTP/3 QUIC](/en/blog/android-network-stack-dns-http3-quic/)
- [Android font rendering: Typeface loading and Skia glyph rasterization](/en/blog/android-font-rendering-typeface-skia/)

## Performance Debugging Framework

- Define the metric first: P50, P90, P99, first frame, dropped frames, memory peak.
- Collect evidence: Perfetto trace, logs, ANR trace, heap dump, benchmark results.
- Break down the path: main thread, Binder, I/O, rendering, GC, scheduling.
- Verify the fix: local benchmarks, staged monitoring, and regression gates.

## Next Step

If the performance issue is tied to UI state updates, continue with [Jetpack Compose Deep Dives](/en/jetpack-compose/). If the bottleneck involves model inference, NPU scheduling, power, or thermal behavior, go to [Android On-device AI](/en/android-on-device-ai/). If the issue comes from builds, tests, or release pipelines, go to [Mobile Engineering](/en/android-engineering/).
