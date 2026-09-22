---
title: "Android 性能与稳定性专题"
seo:
  title: "Android 性能优化：启动、渲染、内存、Perfetto 与 Macrobenchmark"
  description: "系统整理 Android 性能优化文章，覆盖冷启动、RecyclerView、Bitmap、RenderThread、HWUI、Perfetto、ART、Native 内存、Vulkan、AudioFlinger 与性能基准测试。"
---

从启动慢、滑动掉帧或 WebView 崩溃进入，先确定要测量的现象，再收集能解释它的证据。每条路线都连接到具体的工具操作与验证步骤。

## 按症状开始排查

| 现象 | 第一篇 | 接着做什么 |
| --- | --- | --- |
| 冷启动慢，首帧与可用时间混在一起 | [启动指标：TTID、TTFD 与 Macrobenchmark](/blog/android-startup-metrics/) | 固定启动条件，再用 Perfetto 定位关键路径 |
| 有卡顿但不知道 trace 怎么抓、怎么看 | [Perfetto 入门与抓取流程](/blog/android-perfetto/) | 复现一次问题，检查主线程、调度和帧时间 |
| WebView 白屏或收到渲染进程退出回调 | [WebView 渲染进程崩溃与恢复](/blog/webview-render-process-crash-deep-dive/) | 区分退出信号与根因，验证销毁和重建流程 |
| Compose 列表滑动不流畅 | [LazyColumn 性能排查](/blog/jetpack-compose-lazycolumn-performance/) | 使用 release 构建，检查列表身份、状态读取与帧耗时 |

## 从测量到回归的阅读顺序

1. [定义启动指标](/blog/android-startup-metrics/)：分开冷、温、热启动以及首帧与可用时间。
2. [抓取并阅读 Perfetto trace](/blog/android-perfetto/)：把用户操作与线程工作、等待时间对应起来。
3. 选择一个有证据支持的瓶颈进行修改，保留设备、数据集、构建类型和采样条件。
4. 用 [Macrobenchmark](/blog/android-macrobenchmark-benchmarkrule/) 重复测量，比较分布并检查回归。
5. 若问题表现为进程退出，沿 [WebView 稳定性排查](/blog/webview-render-process-crash-deep-dive/) 收集事件；性能 trace 不能单独证明崩溃根因。

## 核心文章

- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/android-cold-start-zygote-systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/app-startup-optimization/)
- [RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch](/blog/android-recyclerview-cache-prefetch-deep-dive/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/android-bitmap-memory-model-hardware-bitmap/)
- [Android RenderThread 与 HWUI：渲染管线、DisplayList 与掉帧分析](/blog/android-renderthread-hwui/)
- [Android 渲染机制与图形栈：View、HWUI、SurfaceFlinger 全链路](/blog/android-rendering-graphics-stack/)
- [Android Perfetto 与 Systrace：系统级性能分析和调优方法](/blog/android-system-performance-systrace-perfetto/)
- [Android Perfetto 追踪体系：ftrace、TrackEvent 与生产级性能监控](/blog/android-perfetto-ftrace-trackevent/)
- [Android 音频系统原理：AudioFlinger、混音策略与 AAudio 低延迟](/blog/android-audio-system-audioflinger-aaudio/)
- [Android Macrobenchmark 实战：启动、滚动与性能回归测试](/blog/android-macrobenchmark-benchmarkrule/)

## 运行时、内存与图形性能

- [深入 Android ART 垃圾回收机制全链路](/blog/android-art-garbage-collection/)
- [深入 Android ART dex2oat 编译管线：从 DEX 字节码到 OAT 机器码的 AOT/JIT 混合编译](/blog/android-art-dex2oat-pipeline/)
- [深入 Android Native 内存分析全链路：从 malloc_debug 到 heapprofd 的 Native 堆内存泄漏排查实战](/blog/android-native-memory-malloc-heapprofd/)
- [深入 Android Vulkan 图形渲染全链路：从 OpenGL ES 迁移到 GPU 驱动调优的低开销渲染架构](/blog/android-vulkan-opengl-es-gpu/)
- [Android 电源管理深度解析：从 Wakelock 滥用到 Doze 模式的省电工程实践](/blog/android-battery-optimization-battery-historian/)
- [深入 Android AlarmManager 定时调度全链路：从 AlarmManagerService Binder 调用到 Doze 模式下的精确唤醒架构解析](/blog/android-alarmmanager-scheduling/)
- [深入 Android DEX 字节码格式与 MultiDex 加载全链路解析](/blog/android-dex-bytecode-multidex/)
- [深入 Android Media3 媒体播放架构：从 ExoPlayer 演进到 MediaSession 统一播放管线的全链路解析](/blog/android-media3-exoplayer-mediasession/)
- [深入 Android 网络协议栈全链路：从 DNS 解析到 HTTP/3 QUIC 的移动网络优化工程实践](/blog/android-network-stack-dns-http3-quic/)
- [深入 Android 字体渲染架构：从 Typeface 加载到 Skia 字形光栅化的全链路解析](/blog/android-font-rendering-typeface-skia/)

## 性能排查框架

- 先确认指标：P50、P90、P99、首帧、掉帧、内存峰值。
- 再抓证据：Perfetto trace、log、ANR trace、heap dump、benchmark。
- 然后拆链路：主线程、Binder、I/O、渲染、GC、调度。
- 最后做验证：本地 benchmark、灰度监控、回归门禁。

## 下一步

如果性能问题和 UI 状态更新有关，继续阅读 [Jetpack Compose 深度解析](/jetpack-compose/)。如果瓶颈来自模型推理、NPU、功耗和热管理，转到 [Android 端侧 AI](/android-on-device-ai/)。如果问题来自构建、测试和发布链路，转到 [移动端工程化](/android-engineering/)。
