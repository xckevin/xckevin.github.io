---
title: Which Metrics Should Android Startup Optimization Track First?
lang: en
translationKey: android-startup-metrics
slug: android-startup-metrics
excerpt: A practical guide to Android startup metrics, phase breakdowns, Perfetto trace signals, and production governance priorities.
publishDate: '2026-06-01'
updatedDate: '2026-09-22'
tags:
- Android
- Startup Optimization
- Perfetto
seo:
  title: 'Android Startup Metrics: Cold Start, TTID, and Perfetto'
  description: Learn which Android startup metrics to track, including cold start, first frame, TTID, main-thread blocking, Binder calls, and Perfetto trace signals.
  pageType: article
---

The essential distinction is that TTID and TTFD are different metrics, and neither is the same as a product-specific “first useful content” event. TTID is the framework's automatically reported time to the first displayed frame. TTFD is available only when the app calls `reportFullyDrawn()` after the screen is truly ready for interaction. Keep both separate from custom product milestones before deciding that an optimization helped.

Do not start startup optimization by changing code. Start by defining the metrics. Otherwise it is easy to move time from one phase to another, make the report look faster, and still leave the user's first screen unchanged.

I prefer to think of Android startup as a chain: process creation, application initialization, first Activity creation, first-frame rendering, and first useful content becoming interactive. Each phase has its own observation points. You cannot understand startup by looking only at `Application.onCreate()`.

## Separate the different startup times first

A cold start begins when the process does not exist and runs from Launcher click to first-screen display. It includes Zygote fork, app process initialization, class loading, resource loading, main Activity creation, and first-frame rendering. A warm start usually reuses an existing process. A hot start may only bring an existing Activity back to the foreground. If you mix all three in one metric, your optimization conclusions will be distorted.

At minimum, production metrics should separate these concepts:

- **Process start**: From click to the app process becoming runnable. This is affected by system load, fork cost, package size, and cold-page loading.
- **Application init**: Total time spent in `attachBaseContext`, `ContentProvider` initialization, and `Application.onCreate()`.
- **TTID (time to initial display)**: startup through the first displayed UI frame. For a cold start it includes process initialization; for cold and warm starts it includes Activity creation and first draw. The framework reports it automatically, including through Logcat's `Displayed` value.
- **TTFD (time to full display)**: startup through the point at which the app declares its full interactive content ready. It depends on `reportFullyDrawn()`; without that call, there is no comparable TTFD signal.
- **Product first-useful-content**: for example, primary data and imagery being usable. This is custom instrumentation and must not be used to infer TTID or TTFD.

Google Play Console, Firebase Performance, and custom instrumentation do not define startup time in exactly the same way. Before starting a focused effort, write down the measurement definition. All later optimizations and retrospectives should use the same definition.

### When to call `reportFullyDrawn()`

Call it once when the primary content is visible, the screen is interactive, and no asynchronous result that determines the initial experience remains pending. Do not put it in `onCreate()`, in the first-frame callback, or behind unrelated work that might never finish. The first two make TTFD look like TTID; the last includes work that is not startup.

```kotlin
import android.os.Bundle
import androidx.activity.ComponentActivity

class HomeActivity : ComponentActivity() {
    private var firstContentReported = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val reporter = fullyDrawnReporter
        reporter.addReporter()
        setContentView(R.layout.activity_home)

        viewModel.homeUiState.observe(this) { state ->
            render(state)
            if (state.hasPrimaryContent && !state.isLoading && !firstContentReported) {
                firstContentReported = true
                // ComponentActivity schedules reporting through its draw executor.
                reporter.removeReporter()
            }
        }
    }
}
```

`render()` only changes the view tree; it does not prove pixels have been drawn. `FullyDrawnReporter` calls `Activity.reportFullyDrawn()` once all reporter locks are released, through ComponentActivity’s draw-aware reporting executor. The boolean prevents repeated scheduling from later emissions. Define primary content before adding the lock, and ensure every valid terminal state eventually releases it; otherwise TTFD becomes missing rather than accurate.

## What to inspect first in Perfetto

Do not click randomly through dozens of tracks in a startup trace. First define the time window: Launcher initiates startup, the app process appears, the main thread runs `bindApplication`, Activity lifecycle executes, and the first frame reaches the screen. Once that window is clear, expand outward from the main thread.

On the main thread, focus on these signals:

- Whether there is an obvious gap between `ActivityThread.main` and `handleBindApplication`.
- Whether `ContentProvider` initialization takes a large amount of time before `Application`.
- Whether `Application.onCreate()` performs disk I/O, networking-library initialization, database open, or reflection scanning.
- Whether `Activity.onCreate/onStart/onResume` synchronously performs work unrelated to the first screen.
- Whether the path from `Choreographer#doFrame` to `DrawFrame` is blocked by layout, image decoding, or synchronous Binder calls.

If the main thread is waiting, keep following the reason. Is a Binder transaction stuck in a system service? Is it blocked by `monitor contention`? Is CPU saturated by background threads? The biggest startup-analysis mistake is seeing that the main thread is "slow" and not tracing the underlying cause.

## Verify with Macrobenchmark, not a timed debug launch

Run Macrobenchmark against a release-like target variant: it must be **non-debuggable**, `profileable`, and preferably minified. The benchmark test module may be debuggable; the app being measured must not be. Do not treat a one-off debug launch while attached to an IDE as a release conclusion. Keep startup mode, device state, and data fixed, and distinguish cold from warm startup. This is a minimal cold-start benchmark skeleton:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule val benchmarkRule = MacrobenchmarkRule()

    @Test fun startup() = benchmarkRule.measureRepeated(
        packageName = "com.example.app",
        metrics = listOf(StartupTimingMetric()),
        iterations = 10,
        startupMode = StartupMode.COLD
    ) {
        pressHome()
        startActivityAndWait()
    }
}
```

This code was not run for this article and no timing improvement is claimed. Interpret results alongside device thermal state, install state, and build type; do not compare values collected under different conditions.

## Four common startup bottlenecks

The first is premature initialization. Analytics, push, IM, ads, A/B testing, and telemetry SDKs all like to live in `Application.onCreate()`. Eventually cold start turns into a meeting where everyone gets a turn to speak. The fix is not simply throwing everything onto a background thread. Split initialization by first-screen necessity: required for the first screen stays synchronous, needed immediately after the first frame is rendered, and uncertain work becomes lazy.

The second is disk I/O. First SharedPreferences load, database open, large JSON reads, and local file scans can all trigger cold-page reads. You can inspect the `disk` track in Perfetto and use StrictMode in debug builds to expose these problems earlier. During startup, the rule is: read less, read sequentially, and read later.

The third is class loading and reflection. Large routing tables, DI containers, JSON reflection, and plugin frameworks all increase class-loading cost. If KSP or annotation processing can generate an index at compile time, do not scan the classpath during startup. If reflection can be delayed until after the first screen, do not block the main thread with it.

The fourth is making the first frame too "real." Many screens try to load the full list, complex images, animations, multiple Fragments, and secondary modules in the first frame. The startup first frame should show the skeleton and core information first, then defer non-first-screen regions until after first frame. The goal is not to do less work forever. It is to make the first frame do only the necessary work.

## In production, watch p95 instead of averages

Startup wins cannot be judged only on a developer machine. Low-end devices, cold pages, first launch after install, system load, and the device distribution in rollout all change the result. Averages are easily diluted by high-end devices. At minimum, track p50, p90, p95, and p99.

A practical release gate is to record startup p95, first-frame p95, `Application.onCreate()` p95, and first-useful-content p95 for every release. If any metric regresses beyond the threshold compared with the previous stable version, block the release or trigger a focused review. Startup optimization is not a one-time project. It is an engineering discipline that needs version gates to hold the line.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [Android app startup optimization program: metrics, flow, tools, and governance](/en/blog/app-startup-optimization/)
- [Android Perfetto: trace capture, track analysis, and performance debugging](/en/blog/android-perfetto/)
<!-- /seo-internal-links -->

## Official references

- [App startup time and `reportFullyDrawn`](https://developer.android.com/topic/performance/vitals/launch-time)
- [`FullyDrawnReporter`](https://developer.android.com/reference/androidx/activity/FullyDrawnReporter)
- [Write a Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview)
