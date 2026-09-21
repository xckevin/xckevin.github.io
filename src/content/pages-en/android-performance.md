---
title: Android Performance
lang: en
translationKey: android-performance
seo:
  title: Android Performance Optimization
  description: Android performance notes covering cold start, rendering, memory, Bitmap, ANR, Perfetto, Macrobenchmark, and production stability.
---

This topic turns performance optimization from intuition into a verifiable workflow: define the metric, use traces to locate the bottleneck, then confirm the gain through benchmarks and production monitoring.

## Learning Path

1. Cold start: from Zygote fork to first frame.
2. Rendering: View, RenderThread, HWUI, and SurfaceFlinger.
3. Memory: Bitmap, leaks, native heap, and OOM.
4. Tools: Perfetto, Systrace, and Macrobenchmark.
5. Special topics: audio, lists, stability, and production governance.

## Core Articles

- [Android startup optimization: from Zygote fork to first frame with Perfetto](/blog/android-cold-start-zygote-systrace/)
- [Android app startup optimization: metrics, paths, tools, and governance](/blog/app-startup-optimization/)
- [RecyclerView cache internals: four cache levels, reuse, and Prefetch](/blog/android-recyclerview-cache-prefetch-deep-dive/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/android-bitmap-memory-model-hardware-bitmap/)
- [Android RenderThread and HWUI: rendering pipeline, DisplayList, and jank analysis](/blog/android-renderthread-hwui/)
- [Android rendering and graphics stack: View, HWUI, and SurfaceFlinger](/blog/android-rendering-graphics-stack/)
- [Android Perfetto and Systrace: system-level performance analysis](/blog/android-system-performance-systrace-perfetto/)
- [Android Perfetto tracing: ftrace, TrackEvent, and production-grade performance monitoring](/blog/android-perfetto-ftrace-trackevent/)
- [Android audio system: AudioFlinger, mixing policy, and AAudio low latency](/blog/android-audio-system-audioflinger-aaudio/)
- [Android Macrobenchmark in practice: startup, scrolling, and performance regression testing](/blog/android-macrobenchmark-benchmarkrule/)

## Runtime, Memory, and Graphics Performance

- [Android ART garbage collection internals](/blog/android-art-garbage-collection/)
- [Android ART dex2oat: from DEX bytecode to OAT machine code with AOT/JIT compilation](/blog/android-art-dex2oat-pipeline/)
- [Android native memory analysis: from malloc_debug to heapprofd](/blog/android-native-memory-malloc-heapprofd/)
- [Android Vulkan rendering: from OpenGL ES migration to GPU driver tuning](/blog/android-vulkan-opengl-es-gpu/)
- [Android power management: from WakeLock misuse to Doze-mode engineering](/blog/android-battery-optimization-battery-historian/)
- [Android AlarmManager scheduling: Binder calls, AlarmManagerService, and exact wakeups under Doze](/blog/android-alarmmanager-scheduling/)
- [Android DEX bytecode and MultiDex loading](/blog/android-dex-bytecode-multidex/)
- [Android Media3 playback architecture: from ExoPlayer to MediaSession](/blog/android-media3-exoplayer-mediasession/)
- [Android networking stack: from DNS to HTTP/3 QUIC](/blog/android-network-stack-dns-http3-quic/)
- [Android font rendering: Typeface loading and Skia glyph rasterization](/blog/android-font-rendering-typeface-skia/)

## Performance Debugging Framework

- Define the metric first: P50, P90, P99, first frame, dropped frames, memory peak.
- Collect evidence: Perfetto trace, logs, ANR trace, heap dump, benchmark results.
- Break down the path: main thread, Binder, I/O, rendering, GC, scheduling.
- Verify the fix: local benchmarks, staged monitoring, and regression gates.

## Next Step

If the performance issue is tied to UI state updates, continue with [Jetpack Compose Deep Dives](/en/jetpack-compose/). If the bottleneck involves model inference, NPU scheduling, power, or thermal behavior, go to [Android On-device AI](/en/android-on-device-ai/). If the issue comes from builds, tests, or release pipelines, go to [Mobile Engineering](/en/android-engineering/).
