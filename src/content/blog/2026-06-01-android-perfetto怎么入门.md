---
translationKey: android-perfetto
title: "Android Perfetto 怎么入门？从一条 Trace 开始定位性能问题"
slug: android-perfetto
excerpt: "面向 Android 开发者介绍 Perfetto 入门方法，覆盖 trace 抓取、关键轨道、Binder、调度、渲染和启动分析。"
publishDate: '2026-06-01'
updatedDate: '2026-09-22'
tags:
- "Android"
- "Perfetto"
- "性能优化"
seo:
  title: "Android Perfetto 入门：Trace 抓取、轨道分析与性能定位"
  description: "用可执行命令抓取 Android Perfetto trace，读懂 sched、Binder、渲染轨道，并按状态和因果定位启动与掉帧问题。"
---

结论先说：Perfetto 不是把所有轨道都打开后“看哪条红”，而是用一次可复现操作同时验证线程状态、调度延迟和跨进程/渲染因果。`S`（sleeping）只说明线程正在等待；它既不能证明 CPU 慢，也不能证明卡顿由调度造成。只有线程已被唤醒、处于 runnable 状态却迟迟没有运行，才需要沿着 wakeup 和 CPU run queue 继续分析。

Perfetto 入门最有效的方式不是先读完整文档，而是抓一条真实性能问题的 trace，然后带着问题看轨道。没有问题意识地打开 trace，十几屏轨道只会让人迷路。

第一次使用 Perfetto，可以只解决一个问题：为什么这次启动慢，或者为什么这个列表滑动掉帧。问题越具体，trace 越容易读。

## 先确认版本和抓取方式

Android 11（R）及以后通常默认启用 `traced`；Android 9/10 的非 Pixel 设备可能需要先由测试环境执行 `adb shell setprop persist.traced.enable 1`。更早版本不能依赖设备内置工具，应使用官方 `record_android_trace`。以下命令都只应在可控制的测试设备上运行；未在本文环境实际执行，路径和权限仍应以设备输出为准。

先查询设备实际注册的数据源，再决定配置，而不是假设每台设备都有同一组 capability：

```bash
adb shell perfetto --query-raw
```

## 先抓一条足够干净的 trace

入门阶段不要一上来勾选所有数据源。数据越多，文件越大，UI 越卡，干扰也越多。启动和掉帧场景通常先保留这些：

- CPU scheduling / freq / idle
- Android app atrace categories
- Binder transactions
- Graphics / SurfaceFlinger / FrameTimeline
- Disk I/O

命令行的轻量模式只支持 atrace 分类和 ftrace event；`sched`、`freq`、`idle`、`am`、`wm`、`gfx`、`view`、`binder_driver` 都应以 `--query-raw` / `atrace --list_categories` 的实际输出为准。一个启动复现的最小抓取命令如下：

```bash
adb shell perfetto -o /data/misc/perfetto-traces/startup.trace -t 10s sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/startup.trace
```

若要明确收集调度、唤醒和线程/进程关联，使用完整配置更可靠。下面的 `linux.ftrace`、`linux.process_stats` 是可用数据源名；它不会自动打开 FrameTimeline 或所有厂商私有轨道：

```text
duration_ms: 10000
buffers: { size_kb: 32768 fill_policy: RING_BUFFER }
data_sources: {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "sched/sched_waking"
      ftrace_events: "power/cpu_frequency"
      atrace_categories: "am"
      atrace_categories: "wm"
      atrace_categories: "gfx"
      atrace_categories: "view"
    }
  }
}
data_sources: { config { name: "linux.process_stats" } }
```

在 Android 12 以前的非 root 设备，不要把配置文件路径直接交给 `perfetto -c`；SELinux 可能拒绝读取 `/data/local/tmp`。将配置通过 stdin 传入：`cat config.pbtx | adb shell perfetto --txt -c - -o /data/misc/perfetto-traces/startup.trace`。Android 12+ 可使用 `/data/misc/perfetto-configs/`。

抓 trace 前先清理场景：关闭无关后台任务，固定操作路径，重复三次取共同现象。只抓一次 trace 很容易被偶发系统负载误导。

## 读 trace 的顺序

我通常按四步读。

第一步，圈定时间窗口。比如启动问题，就找到从 Launcher 点击到首帧提交的区间；掉帧问题，就找到 UI 卡顿对应的那几帧。窗口没圈准，后面所有分析都可能偏。

第二步，看主线程。先区分它在 **Running**、可运行但未获调度，还是在 **Sleeping/Blocked**。后两者的处理方向相反：Sleeping 往往是 Binder、锁、I/O 或显式等待的结果，应找唤醒者/持锁者/服务端；Runnable 但未运行才需要看 `sched_waking` 到实际运行之间的延迟以及 CPU 是否被更高优先级工作占用。不能把 sleeping 直接解释成“CPU 慢”。

第三步，看等待原因。如果主线程 blocked，向下看 sched 状态和调用栈；如果停在 Binder，去看目标服务；如果是 disk I/O，确认是谁触发；如果是 monitor contention，找持锁线程。

第四步，看渲染链路。掉帧不是只有主线程慢，还可能是 RenderThread、GPU、SurfaceFlinger 或 BufferQueue 迟滞。FrameTimeline 能把 App 期望帧、实际提交、SurfaceFlinger 合成串起来，这是 Perfetto 相比旧 Systrace 更好用的地方。

## 常见轨道怎么看

Main thread 是业务和 Framework 调用的入口。启动时重点看 `bindApplication`、`ActivityThread`、`performLaunchActivity`、`Choreographer#doFrame`；滑动时重点看 input、measure/layout/draw、adapter bind 和 Compose recomposition。

RenderThread 负责把 UI 线程提交的 display list 转成渲染命令。如果 main thread 不忙但 RenderThread 忙，可能是复杂阴影、过度绘制、图片纹理上传或硬件层问题。

Binder 轨道用来看跨进程等待。主线程上出现长 Binder transaction，要继续追系统服务线程是否忙。很多启动慢问题不是应用本地代码慢，而是同步查询系统服务太多。

CPU sched 用来看线程是否真正拿到 CPU。一个方法耗时 100ms，不代表它运行了 100ms；它可能运行 20ms，剩下 80ms 在等待锁或 Binder，也可能在 runnable 队列里排队。先在 `sched_slice` 看 `end_state`，再用 `sched_waking` 确认唤醒时刻；只有“已唤醒 → runnable → 很晚才运行”这一段才是调度延迟。低端机和后台负载场景尤其要看这一层。

Disk I/O 用来看冷启动中的文件读取。首次打开数据库、读取 SharedPreferences、大图解码、扫描本地文件都会在这里留下痕迹。

## 不要只看 UI，学会用查询

Perfetto trace 本质上可以被 `trace_processor` 当成数据库查询。UI 适合定位窗口，SQL 适合批量验证。比如你想统计某类 Binder 调用、某个线程的运行时间、某个 slice 的 p95，SQL 比手动拖拽稳定得多。

入门阶段不需要一开始写复杂 SQL，但要形成意识：Perfetto 不只是图形界面，它是一套性能数据模型。后续做线上聚合、自动化回归、性能门禁，都会用到 trace_processor。

## 新手最容易犯的三个错误

第一个错误是抓太长。10 秒内能复现的问题，就不要抓 2 分钟。长 trace 会稀释注意力。

第二个错误是只看 App 进程。Android 性能问题经常跨进程，Binder、SurfaceFlinger、system_server 都可能是关键。

第三个错误是把 trace 当结论。trace 只能告诉你发生了什么，不能自动告诉你为什么这样设计。看到慢点后，还要回到源码、业务路径和线程模型里解释原因。

## 一次可执行的排查闭环

1. 固定启动或滑动路径，抓取至少三次同一操作，并记录 Android 版本、机型、是否冷启动和 trace 配置。
2. 在 UI 中圈定用户可见的异常窗口，先读主线程状态，再追 Binder、锁、I/O 或 RenderThread/GPU。
3. 对“CPU 不够”这一假设，必须检查 `sched_waking`、`sched_switch` 和 CPU 轨道；若线程一直是 Sleeping，改查等待依赖而非调度。
4. 修改后使用相同路径复抓。本文不提供任何实测耗时或收益数字，结果应由你的目标设备和版本分位数决定。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android Perfetto 与 Systrace：系统级性能分析和调优方法](/blog/android-system-performance-systrace-perfetto/)
- [Android Perfetto 追踪体系：ftrace、TrackEvent 与生产级性能监控](/blog/android-perfetto-ftrace-trackevent/)
- [Android App 启动优化指标：冷启动、首帧、TTID 与 Perfetto 分析](/blog/android-startup-metrics/)
<!-- /seo-internal-links -->

## 官方资料

- [Overview of system tracing](https://developer.android.com/topic/performance/tracing)
- [Capture a system trace on a device](https://developer.android.com/topic/performance/tracing/on-device)
- [Define custom trace events](https://developer.android.com/topic/performance/tracing/custom-events)
- [Perfetto command-line tool](https://developer.android.com/tools/perfetto)
