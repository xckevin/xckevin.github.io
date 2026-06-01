---
title: "Android 性能优化专题"
seo:
  title: "Android 性能优化：启动、渲染、内存、Perfetto 与 Macrobenchmark"
  description: "系统整理 Android 性能优化文章，覆盖冷启动、RecyclerView、Bitmap、RenderThread、HWUI、Perfetto、AudioFlinger 与性能基准测试。"
---

这个专题把性能优化从经验判断转成可验证流程：先定义指标，再用 trace 找瓶颈，最后通过基准测试和线上监控确认收益。

## 学习路径

1. 冷启动：从 Zygote fork 到首帧上屏。
2. 渲染：View、RenderThread、HWUI 和 SurfaceFlinger。
3. 内存：Bitmap、泄漏、Native 堆和 OOM。
4. 工具：Perfetto、Systrace、Macrobenchmark。
5. 专项：音频、列表、稳定性和线上治理。

## 核心文章

- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/app启动优化专项/)
- [RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch](/blog/2026-04-14-深入_android_recyclerview_缓存机制_从四级缓存到_prefetch_的性能设计/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
- [Android RenderThread 与 HWUI：渲染管线、DisplayList 与掉帧分析](/blog/2026-04-20-android_renderthread_与_hwui_渲染管线深度解析_从_displaylist/)
- [Android 渲染机制与图形栈：View、HWUI、SurfaceFlinger 全链路](/blog/android渲染机制与图形栈深入理解/)
- [Android Perfetto 与 Systrace：系统级性能分析和调优方法](/blog/系统级性能分析与调优-systrace_perfetto/)/)
- [Android Perfetto 追踪体系：ftrace、TrackEvent 与生产级性能监控](/blog/2026-05-09-android_perfetto_追踪全链路深度解析_从内核_ftrace_数据源到_sdk_自定义_trackevent_的生产级性能监控体系/)
- [Android 音频系统原理：AudioFlinger、混音策略与 AAudio 低延迟](/blog/2026-05-12-深入_android_音频系统全链路_从_audioflinger_混音策略到_aaudio_低延迟/)
- [Android Macrobenchmark 实战：启动、滚动与性能回归测试](/blog/2026-05-26-深入_android_macrobenchmark_性能基准测试全链路_从_benchmarkrul/)

## 性能排查框架

- 先确认指标：P50、P90、P99、首帧、掉帧、内存峰值。
- 再抓证据：Perfetto trace、log、ANR trace、heap dump、benchmark。
- 然后拆链路：主线程、Binder、I/O、渲染、GC、调度。
- 最后做验证：本地 benchmark、灰度监控、回归门禁。

## 下一步

如果性能问题和 UI 状态更新有关，继续阅读 [Jetpack Compose 深度解析](/jetpack-compose/)。如果问题来自构建、测试和发布链路，转到 [移动端工程化](/android-engineering/)。
