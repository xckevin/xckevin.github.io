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

- [Android startup optimization: from Zygote fork to first frame with Perfetto](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android app startup optimization: metrics, paths, tools, and governance](/blog/app启动优化专项/)
- [RecyclerView cache internals: four cache levels, reuse, and Prefetch](/blog/2026-04-14-深入_android_recyclerview_缓存机制_从四级缓存到_prefetch_的性能设计/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [Android RenderThread and HWUI: rendering pipeline, DisplayList, and jank analysis](/blog/2026-04-20-android_renderthread_与_hwui_渲染管线深度解析_从_displaylist/)
- [Android rendering and graphics stack: View, HWUI, and SurfaceFlinger](/blog/android渲染机制与图形栈深入理解/)
- [Android Perfetto and Systrace: system-level performance analysis](/blog/系统级性能分析与调优-systrace_perfetto/)
- [Android Perfetto tracing: ftrace, TrackEvent, and production-grade performance monitoring](/blog/2026-05-09-android_perfetto_追踪全链路深度解析_从内核_ftrace_数据源到_sdk_自定义_trackevent_的生产级性能监控体系/)
- [Android audio system: AudioFlinger, mixing policy, and AAudio low latency](/blog/2026-05-12-深入_android_音频系统全链路_从_audioflinger_混音策略到_aaudio_低延迟/)
- [Android Macrobenchmark in practice: startup, scrolling, and performance regression testing](/blog/2026-05-26-深入_android_macrobenchmark_性能基准测试全链路_从_benchmarkrul/)

## Runtime, Memory, and Graphics Performance

- [Android ART garbage collection internals](/blog/2025-05-26-深入_android_art_垃圾回收机制全链路_从_dalvik_mark-sweep_到_con/)
- [Android ART dex2oat: from DEX bytecode to OAT machine code with AOT/JIT compilation](/blog/2026-02-20-深入_android_art_dex2oat_编译管线全链路_从_dex_字节码到_oat_机器码的/)
- [Android native memory analysis: from malloc_debug to heapprofd](/blog/2025-08-08-深入_android_native_内存分析全链路_从_malloc_debug_到_heappro/)
- [Android Vulkan rendering: from OpenGL ES migration to GPU driver tuning](/blog/2025-09-26-深入_android_vulkan_图形渲染全链路_从_opengl_es_迁移到_gpu_驱动调优/)
- [Android power management: from WakeLock misuse to Doze-mode engineering](/blog/2025-06-04-深入_android_app_电量优化全链路_从_battery_historian_到后台任务收敛/)
- [Android AlarmManager scheduling: Binder calls, AlarmManagerService, and exact wakeups under Doze](/blog/2025-05-29-深入_android_alarmmanager_定时调度全链路_从_alarmmanagerserv/)
- [Android DEX bytecode and MultiDex loading](/blog/2025-05-08-深入_android_dex_字节码格式与_multidex_加载全链路解析/)
- [Android Media3 playback architecture: from ExoPlayer to MediaSession](/blog/2025-05-05-深入_android_media3_媒体播放架构_从_exoplayer_演进到_mediasess/)
- [Android networking stack: from DNS to HTTP/3 QUIC](/blog/2025-05-06-深入_android_网络协议栈全链路_从_dns_解析到_http_3_quic_的移动网络优化工/)
- [Android font rendering: Typeface loading and Skia glyph rasterization](/blog/2025-10-15-深入_android_字体渲染架构_从_typeface_加载到_skia_字形光栅化的全链路解析/)

## Performance Debugging Framework

- Define the metric first: P50, P90, P99, first frame, dropped frames, memory peak.
- Collect evidence: Perfetto trace, logs, ANR trace, heap dump, benchmark results.
- Break down the path: main thread, Binder, I/O, rendering, GC, scheduling.
- Verify the fix: local benchmarks, staged monitoring, and regression gates.

## Next Step

If the performance issue is tied to UI state updates, continue with [Jetpack Compose Deep Dives](/en/jetpack-compose/). If the bottleneck involves model inference, NPU scheduling, power, or thermal behavior, go to [Android On-device AI](/en/android-on-device-ai/). If the issue comes from builds, tests, or release pipelines, go to [Mobile Engineering](/en/android-engineering/).
