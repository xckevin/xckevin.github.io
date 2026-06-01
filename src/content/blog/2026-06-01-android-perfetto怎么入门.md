---
title: "Android Perfetto 怎么入门？从一条 Trace 开始定位性能问题"
slug: android-perfetto
excerpt: "面向 Android 开发者介绍 Perfetto 入门方法，覆盖 trace 抓取、关键轨道、Binder、调度、渲染和启动分析。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Perfetto"
- "性能优化"
seo:
  title: "Android Perfetto 入门：Trace 抓取、轨道分析与性能定位"
  description: "介绍 Android Perfetto 入门方法，覆盖 trace 抓取、sched、binder、gfx、view、启动优化、渲染掉帧和性能分析流程。"
---

Perfetto 入门最有效的方式不是先读完整文档，而是抓一条真实性能问题的 trace，然后带着问题看轨道。没有问题意识地打开 trace，十几屏轨道只会让人迷路。

第一次使用 Perfetto，可以只解决一个问题：为什么这次启动慢，或者为什么这个列表滑动掉帧。问题越具体，trace 越容易读。

## 先抓一条足够干净的 trace

入门阶段不要一上来勾选所有数据源。数据越多，文件越大，UI 越卡，干扰也越多。启动和掉帧场景通常先保留这些：

- CPU scheduling / freq / idle
- Android app atrace categories
- Binder transactions
- Graphics / SurfaceFlinger / FrameTimeline
- Disk I/O

如果用命令行，可以从简单配置开始：

```bash
adb shell perfetto -o /data/misc/perfetto-traces/startup.trace -t 10s sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/startup.trace
```

抓 trace 前先清理场景：关闭无关后台任务，固定操作路径，重复三次取共同现象。只抓一次 trace 很容易被偶发系统负载误导。

## 读 trace 的顺序

我通常按四步读。

第一步，圈定时间窗口。比如启动问题，就找到从 Launcher 点击到首帧提交的区间；掉帧问题，就找到 UI 卡顿对应的那几帧。窗口没圈准，后面所有分析都可能偏。

第二步，看主线程。Android UI 的大量卡顿最终都会体现为 main thread 长时间执行、等待或睡眠。看它在跑生命周期、布局、绘制、Binder，还是被锁住。

第三步，看等待原因。如果主线程 blocked，向下看 sched 状态和调用栈；如果停在 Binder，去看目标服务；如果是 disk I/O，确认是谁触发；如果是 monitor contention，找持锁线程。

第四步，看渲染链路。掉帧不是只有主线程慢，还可能是 RenderThread、GPU、SurfaceFlinger 或 BufferQueue 迟滞。FrameTimeline 能把 App 期望帧、实际提交、SurfaceFlinger 合成串起来，这是 Perfetto 相比旧 Systrace 更好用的地方。

## 常见轨道怎么看

Main thread 是业务和 Framework 调用的入口。启动时重点看 `bindApplication`、`ActivityThread`、`performLaunchActivity`、`Choreographer#doFrame`；滑动时重点看 input、measure/layout/draw、adapter bind 和 Compose recomposition。

RenderThread 负责把 UI 线程提交的 display list 转成渲染命令。如果 main thread 不忙但 RenderThread 忙，可能是复杂阴影、过度绘制、图片纹理上传或硬件层问题。

Binder 轨道用来看跨进程等待。主线程上出现长 Binder transaction，要继续追系统服务线程是否忙。很多启动慢问题不是应用本地代码慢，而是同步查询系统服务太多。

CPU sched 用来看线程是否真正拿到 CPU。一个方法耗时 100ms，不代表它运行了 100ms；它可能运行 20ms，剩下 80ms 在排队。低端机和后台负载场景尤其要看这一层。

Disk I/O 用来看冷启动中的文件读取。首次打开数据库、读取 SharedPreferences、大图解码、扫描本地文件都会在这里留下痕迹。

## 不要只看 UI，学会用查询

Perfetto trace 本质上可以被 `trace_processor` 当成数据库查询。UI 适合定位窗口，SQL 适合批量验证。比如你想统计某类 Binder 调用、某个线程的运行时间、某个 slice 的 p95，SQL 比手动拖拽稳定得多。

入门阶段不需要一开始写复杂 SQL，但要形成意识：Perfetto 不只是图形界面，它是一套性能数据模型。后续做线上聚合、自动化回归、性能门禁，都会用到 trace_processor。

## 新手最容易犯的三个错误

第一个错误是抓太长。10 秒内能复现的问题，就不要抓 2 分钟。长 trace 会稀释注意力。

第二个错误是只看 App 进程。Android 性能问题经常跨进程，Binder、SurfaceFlinger、system_server 都可能是关键。

第三个错误是把 trace 当结论。trace 只能告诉你发生了什么，不能自动告诉你为什么这样设计。看到慢点后，还要回到源码、业务路径和线程模型里解释原因。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android Perfetto 与 Systrace：系统级性能分析和调优方法](/blog/系统级性能分析与调优-systrace_perfetto/)
- [Android Perfetto 追踪体系：ftrace、TrackEvent 与生产级性能监控](/blog/2026-05-09-android_perfetto_追踪全链路深度解析_从内核_ftrace_数据源到_sdk_自定义_trackevent_的生产级性能监控体系/)
- [Android App 启动优化指标：冷启动、首帧、TTID 与 Perfetto 分析](/blog/android-startup-metrics/)
<!-- /seo-internal-links -->
