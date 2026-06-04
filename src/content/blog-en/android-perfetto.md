---
title: "Getting Started with Android Perfetto"
lang: en
translationKey: android-perfetto
slug: android-perfetto
excerpt: "A beginner-friendly Android Perfetto workflow covering trace capture, key tracks, Binder, scheduling, rendering, and startup analysis."
publishDate: '2026-06-01'
tags:
- "Android"
- "Perfetto"
- "Performance"
seo:
  title: "Android Perfetto: Trace Capture, Track Analysis, and Performance Debugging"
  description: "Learn how to get started with Android Perfetto across trace capture, sched, binder, gfx, view, startup optimization, frame drops, and performance analysis."
---

The fastest way to learn Perfetto is not to read the entire documentation first. Capture a trace from a real performance problem, then inspect the tracks with that problem in mind. If you open a trace without a question, the wall of tracks quickly becomes disorienting.

For a first Perfetto session, solve one problem: why this launch is slow, or why this list drops frames. The more specific the question, the easier the trace is to read.

## Capture a clean enough trace first

Do not enable every data source when you are just starting. More data means a larger file, a slower UI, and more noise. For startup and frame-drop scenarios, these sources are usually enough:

- CPU scheduling / freq / idle
- Android app atrace categories
- Binder transactions
- Graphics / SurfaceFlinger / FrameTimeline
- Disk I/O

If you use the command line, start with a simple configuration:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/startup.trace -t 10s sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/startup.trace
```

Before recording, clean up the scenario: close unrelated background work, keep the operation path fixed, and repeat three times to find the common pattern. A single trace can easily be distorted by one-off system load.

## A good order for reading a trace

I usually read a trace in four steps.

First, define the time window. For startup, find the range from Launcher click to first-frame submission. For jank, find the frames that match the visible stutter. If the window is wrong, every later conclusion can drift.

Second, inspect the main thread. Many Android UI stalls eventually show up as the main thread running for too long, waiting, or sleeping. Check whether it is executing lifecycle work, layout, drawing, Binder calls, or waiting on a lock.

Third, identify the reason for waiting. If the main thread is blocked, look down into scheduler state and call stacks. If it is waiting on Binder, inspect the target service. If it is disk I/O, find who triggered it. If it is monitor contention, find the thread holding the lock.

Fourth, inspect the rendering path. Dropped frames are not always caused by a slow main thread. RenderThread, GPU work, SurfaceFlinger, or BufferQueue latency can also be responsible. FrameTimeline connects the app's expected frame, actual submission, and SurfaceFlinger composition, which is one reason Perfetto is more useful than old Systrace.

## How to read common tracks

The main thread is the entry point for business code and Framework calls. During startup, focus on `bindApplication`, `ActivityThread`, `performLaunchActivity`, and `Choreographer#doFrame`. During scrolling, focus on input, measure/layout/draw, adapter binding, and Compose recomposition.

RenderThread turns the display list submitted by the UI thread into rendering commands. If the main thread is not busy but RenderThread is, suspect complex shadows, overdraw, image texture uploads, or hardware-layer issues.

Binder tracks reveal cross-process waits. If the main thread has a long Binder transaction, continue tracing into the system service thread. Many slow-startup problems are not caused by slow app-local code, but by too many synchronous system-service queries.

CPU sched shows whether a thread actually got CPU time. A method taking 100 ms did not necessarily run for 100 ms. It may have run for 20 ms and spent the other 80 ms queued. This layer matters especially on low-end devices and under background load.

Disk I/O shows file reads during cold start. First database open, SharedPreferences reads, large image decoding, and local file scans all leave traces here.

## Do not use only the UI. Learn to query.

A Perfetto trace can be queried as a database through `trace_processor`. The UI is good for finding the window. SQL is better for repeatable validation. If you want to count a class of Binder calls, calculate a thread's running time, or compute p95 for a slice type, SQL is more stable than dragging around manually.

You do not need complex SQL on day one, but build the habit early: Perfetto is not just a graphical viewer. It is a performance data model. Production aggregation, automated regression detection, and performance gates all eventually rely on `trace_processor`.

## Three common beginner mistakes

The first mistake is recording too long. If the issue reproduces within 10 seconds, do not capture 2 minutes. Long traces dilute attention.

The second mistake is looking only at the app process. Android performance problems often cross process boundaries. Binder, SurfaceFlinger, and `system_server` can all be central.

The third mistake is treating the trace as the conclusion. A trace tells you what happened. It does not automatically tell you why the system was designed that way. After finding the slow point, go back to source code, business flow, and the thread model to explain the cause.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android Perfetto and Systrace: system-level performance analysis and tuning](/blog/系统级性能分析与调优-systrace_perfetto/)
- [Android Perfetto tracing: ftrace, TrackEvent, and production-grade performance monitoring](/blog/2026-05-09-android_perfetto_追踪全链路深度解析_从内核_ftrace_数据源到_sdk_自定义_trackevent_的生产级性能监控体系/)
- [Android app startup metrics: cold start, first frame, TTID, and Perfetto analysis](/en/blog/android-startup-metrics/)
<!-- /seo-internal-links -->
