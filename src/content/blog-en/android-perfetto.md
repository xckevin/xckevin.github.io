---
title: "Getting Started with Android Perfetto"
lang: en
translationKey: android-perfetto
slug: android-perfetto
excerpt: "A beginner-friendly Android Perfetto workflow covering trace capture, key tracks, Binder, scheduling, rendering, and startup analysis."
publishDate: '2026-06-01'
updatedDate: '2026-09-22'
tags:
- "Android"
- "Perfetto"
- "Performance"
seo:
  title: "Android Perfetto: Trace Capture, Track Analysis, and Performance Debugging"
  description: "Capture Android Perfetto traces with working commands, interpret sched and rendering states, and diagnose startup or jank by evidence."
---

The key point is this: Perfetto is not a matter of enabling every track and looking for red. Use one reproducible interaction to connect thread states, scheduling latency, and cross-process or rendering causes. `S` (sleeping) only says a thread is waiting. It does not prove that the CPU is slow or that scheduling caused the stall. Investigate CPU contention only when a thread has been woken, is runnable, and still is not scheduled promptly.

The fastest way to learn Perfetto is not to read the entire documentation first. Capture a trace from a real performance problem, then inspect the tracks with that problem in mind. If you open a trace without a question, the wall of tracks quickly becomes disorienting.

For a first Perfetto session, solve one problem: why this launch is slow, or why this list drops frames. The more specific the question, the easier the trace is to read.

## Confirm the Android version and capture mode

Android 11 (R) and later normally enable `traced` by default. On non-Pixel Android 9/10 test devices, you may need `adb shell setprop persist.traced.enable 1`; older releases cannot rely on the on-device tool and should use the official `record_android_trace` script. The commands below were not run in this article's environment, so confirm paths and permissions on the target device.

Query the data sources registered on the device before choosing a config. Do not assume every device exposes the same capability:

```bash
adb shell perfetto --query-raw
```

## Capture a clean enough trace first

Do not enable every data source when you are just starting. More data means a larger file, a slower UI, and more noise. For startup and frame-drop scenarios, these sources are usually enough:

- CPU scheduling / freq / idle
- Android app atrace categories
- Binder transactions
- Graphics / SurfaceFlinger / FrameTimeline
- Disk I/O

The lightweight command-line mode supports only atrace categories and ftrace events. Check `--query-raw` or `atrace --list_categories` for the device's actual availability. A minimal startup capture is:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/startup.trace -t 10s sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/startup.trace
```

For explicit scheduler, wakeup, and process/thread association data, use a full config. `linux.ftrace` and `linux.process_stats` below are data-source names; this does not automatically enable FrameTimeline or vendor-specific tracks:

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

On non-rooted devices before Android 12, do not pass a file in `/data/local/tmp` directly to `perfetto -c`; SELinux can prevent it from being read. Pipe it through stdin instead: `cat config.pbtx | adb shell perfetto --txt -c - -o /data/misc/perfetto-traces/startup.trace`. Android 12+ can use `/data/misc/perfetto-configs/`.

Before recording, clean up the scenario: close unrelated background work, keep the operation path fixed, and repeat three times to find the common pattern. A single trace can easily be distorted by one-off system load.

## A good order for reading a trace

I usually read a trace in four steps.

First, define the time window. For startup, find the range from Launcher click to first-frame submission. For jank, find the frames that match the visible stutter. If the window is wrong, every later conclusion can drift.

Second, inspect the main thread. Separate **Running**, runnable-but-not-scheduled, and **Sleeping/Blocked**. The latter two require different paths: Sleeping usually follows Binder, a lock, I/O, or an explicit wait, so find the waker, holder, or server. Runnable-but-not-running is when `sched_waking`, the run queue, and CPU contention matter. Do not read sleeping as “the CPU is slow.”

Third, identify the reason for waiting. If the main thread is blocked, look down into scheduler state and call stacks. If it is waiting on Binder, inspect the target service. If it is disk I/O, find who triggered it. If it is monitor contention, find the thread holding the lock.

Fourth, inspect the rendering path. Dropped frames are not always caused by a slow main thread. RenderThread, GPU work, SurfaceFlinger, or BufferQueue latency can also be responsible. FrameTimeline connects the app's expected frame, actual submission, and SurfaceFlinger composition, which is one reason Perfetto is more useful than old Systrace.

## How to read common tracks

The main thread is the entry point for business code and Framework calls. During startup, focus on `bindApplication`, `ActivityThread`, `performLaunchActivity`, and `Choreographer#doFrame`. During scrolling, focus on input, measure/layout/draw, adapter binding, and Compose recomposition.

RenderThread turns the display list submitted by the UI thread into rendering commands. If the main thread is not busy but RenderThread is, suspect complex shadows, overdraw, image texture uploads, or hardware-layer issues.

Binder tracks reveal cross-process waits. If the main thread has a long Binder transaction, continue tracing into the system service thread. Many slow-startup problems are not caused by slow app-local code, but by too many synchronous system-service queries.

CPU sched shows whether a thread actually got CPU time. A method taking 100 ms did not necessarily run for 100 ms. It may have run for 20 ms and spent the rest waiting for Binder or a lock, or it may have been queued while runnable. Read `end_state` in `sched_slice`, then use `sched_waking` to establish the wakeup time. Only a long “woken → runnable → running” interval is scheduling latency.

Disk I/O shows file reads during cold start. First database open, SharedPreferences reads, large image decoding, and local file scans all leave traces here.

## Do not use only the UI. Learn to query.

A Perfetto trace can be queried as a database through `trace_processor`. The UI is good for finding the window. SQL is better for repeatable validation. If you want to count a class of Binder calls, calculate a thread's running time, or compute p95 for a slice type, SQL is more stable than dragging around manually.

You do not need complex SQL on day one, but build the habit early: Perfetto is not just a graphical viewer. It is a performance data model. Production aggregation, automated regression detection, and performance gates all eventually rely on `trace_processor`.

## Three common beginner mistakes

The first mistake is recording too long. If the issue reproduces within 10 seconds, do not capture 2 minutes. Long traces dilute attention.

The second mistake is looking only at the app process. Android performance problems often cross process boundaries. Binder, SurfaceFlinger, and `system_server` can all be central.

The third mistake is treating the trace as the conclusion. A trace tells you what happened. It does not automatically tell you why the system was designed that way. After finding the slow point, go back to source code, business flow, and the thread model to explain the cause.

## An executable diagnostic loop

1. Fix the launch or scroll path and capture the same interaction at least three times. Record Android version, device, cold/warm state, and trace config.
2. Mark the user-visible interval in the UI, then read main-thread state before following Binder, locks, I/O, or RenderThread/GPU.
3. Before claiming CPU contention, inspect `sched_waking`, `sched_switch`, and CPU tracks. If the thread remains Sleeping, investigate its dependency instead.
4. Repeat the same capture after a change. This article reports no measured timings or gains; validate the result on your target devices and percentiles.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android Perfetto and Systrace: system-level performance analysis and tuning](/en/blog/android-system-performance-systrace-perfetto/)
- [Android Perfetto tracing: ftrace, TrackEvent, and production-grade performance monitoring](/en/blog/android-perfetto-ftrace-trackevent/)
- [Android app startup metrics: cold start, first frame, TTID, and Perfetto analysis](/en/blog/android-startup-metrics/)
<!-- /seo-internal-links -->

## Official references

- [Overview of system tracing](https://developer.android.com/topic/performance/tracing)
- [Capture a system trace on a device](https://developer.android.com/topic/performance/tracing/on-device)
- [Define custom trace events](https://developer.android.com/topic/performance/tracing/custom-events)
- [Perfetto command-line tool](https://developer.android.com/tools/perfetto)
