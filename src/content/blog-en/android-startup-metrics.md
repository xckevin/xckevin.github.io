---
title: "Which Metrics Should Android Startup Optimization Track First?"
lang: en
translationKey: android-startup-metrics
slug: android-startup-metrics
excerpt: "A practical guide to Android startup metrics, phase breakdowns, Perfetto trace signals, and production governance priorities."
publishDate: '2026-06-01'
tags:
- "Android"
- "Startup Optimization"
- "Perfetto"
seo:
  title: "Android App Startup Metrics: Cold Start, First Frame, TTID, and Perfetto Analysis"
  description: "Learn which Android startup metrics to track, including cold start, first frame, TTID, main-thread blocking, Binder calls, and Perfetto trace signals."
---

Do not start startup optimization by changing code. Start by defining the metrics. Otherwise it is easy to move time from one phase to another, make the report look faster, and still leave the user's first screen unchanged.

I prefer to think of Android startup as a chain: process creation, application initialization, first Activity creation, first-frame rendering, and first useful content becoming interactive. Each phase has its own observation points. You cannot understand startup by looking only at `Application.onCreate()`.

## Separate the different startup times first

A cold start begins when the process does not exist and runs from Launcher click to first-screen display. It includes Zygote fork, app process initialization, class loading, resource loading, main Activity creation, and first-frame rendering. A warm start usually reuses an existing process. A hot start may only bring an existing Activity back to the foreground. If you mix all three in one metric, your optimization conclusions will be distorted.

At minimum, production metrics should split startup into four categories:

- **Process start**: From click to the app process becoming runnable. This is affected by system load, fork cost, package size, and cold-page loading.
- **Application init**: Total time spent in `attachBaseContext`, `ContentProvider` initialization, and `Application.onCreate()`.
- **First frame**: The first `Choreographer#doFrame` after Activity creation completes and submits to the rendering pipeline.
- **First useful content**: The time when the user can actually see the core content. For many products, this matters more than the platform first-frame metric.

Google Play Console, Firebase Performance, and custom instrumentation do not define startup time in exactly the same way. Before starting a focused effort, write down the measurement definition. All later optimizations and retrospectives should use the same definition.

## What to inspect first in Perfetto

Do not click randomly through dozens of tracks in a startup trace. First define the time window: Launcher initiates startup, the app process appears, the main thread runs `bindApplication`, Activity lifecycle executes, and the first frame reaches the screen. Once that window is clear, expand outward from the main thread.

On the main thread, focus on these signals:

- Whether there is an obvious gap between `ActivityThread.main` and `handleBindApplication`.
- Whether `ContentProvider` initialization takes a large amount of time before `Application`.
- Whether `Application.onCreate()` performs disk I/O, networking-library initialization, database open, or reflection scanning.
- Whether `Activity.onCreate/onStart/onResume` synchronously performs work unrelated to the first screen.
- Whether the path from `Choreographer#doFrame` to `DrawFrame` is blocked by layout, image decoding, or synchronous Binder calls.

If the main thread is waiting, keep following the reason. Is a Binder transaction stuck in a system service? Is it blocked by `monitor contention`? Is CPU saturated by background threads? The biggest startup-analysis mistake is seeing that the main thread is "slow" and not tracing the underlying cause.

## Four common startup bottlenecks

The first is premature initialization. Analytics, push, IM, ads, A/B testing, and telemetry SDKs all like to live in `Application.onCreate()`. Eventually cold start turns into a meeting where everyone gets a turn to speak. The fix is not simply throwing everything onto a background thread. Split initialization by first-screen necessity: required for the first screen stays synchronous, needed immediately after the first screen moves after first frame, and uncertain work becomes lazy.

The second is disk I/O. First SharedPreferences load, database open, large JSON reads, and local file scans can all trigger cold-page reads. You can inspect the `disk` track in Perfetto and use StrictMode in debug builds to expose these problems earlier. During startup, the rule is: read less, read sequentially, and read later.

The third is class loading and reflection. Large routing tables, DI containers, JSON reflection, and plugin frameworks all increase class-loading cost. If KSP or annotation processing can generate an index at compile time, do not scan the classpath during startup. If reflection can be delayed until after the first screen, do not block the main thread with it.

The fourth is making the first frame too "real." Many screens try to load the full list, complex images, animations, multiple Fragments, and secondary modules in the first frame. The startup first frame should show the skeleton and core information first, then defer non-first-screen regions until after first frame. The goal is not to do less work forever. It is to make the first frame do only the necessary work.

## In production, watch p95 instead of averages

Startup wins cannot be judged only on a developer machine. Low-end devices, cold pages, first launch after install, system load, and the device distribution in rollout all change the result. Averages are easily diluted by high-end devices. At minimum, track p50, p90, p95, and p99.

A practical release gate is to record startup p95, first-frame p95, `Application.onCreate()` p95, and first-useful-content p95 for every release. If any metric regresses beyond the threshold compared with the previous stable version, block the release or trigger a focused review. Startup optimization is not a one-time project. It is an engineering discipline that needs version gates to hold the line.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android app startup optimization program: metrics, flow, tools, and governance](/blog/app启动优化专项/)
- [Android Perfetto: trace capture, track analysis, and performance debugging](/en/blog/android-perfetto/)
<!-- /seo-internal-links -->
