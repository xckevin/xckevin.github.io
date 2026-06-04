---
title: "Android Macrobenchmark: The Full Performance Benchmarking Workflow"
lang: en
translationKey: android-macrobenchmark-benchmarkrule
slug: android-macrobenchmark-benchmarkrule
excerpt: "A practical Macrobenchmark workflow for cold-start measurement, frame smoothness, custom trace metrics, and CI regression gates."
publishDate: '2026-05-26'
tags:
- "Android"
- "Performance"
- "Macrobenchmark"
- "CI/CD"
- "Startup Optimization"
seo:
  title: "Android Macrobenchmark: Startup, Scrolling, Trace Metrics, and CI Regression Gates"
  description: "Learn Android Macrobenchmark for startup and scrolling metrics, custom TraceSection metrics, Baseline Profiles, and CI performance regression control."
  pageType: article
---

Last year, while working on a home-screen redesign, the Compose rewrite looked smooth to the eye and passed QA. Two weeks after release, users started reporting that the page felt sluggish. The data showed cold-start P99 had increased by 400 ms. After that incident, I accepted one hard rule: **performance optimization cannot rely on feel. It needs data.**

The Macrobenchmark library in Android Jetpack is built for exactly this. It differs from Systrace and Perfetto: those are after-the-fact tracing tools, while Macrobenchmark is a **before-release measurement tool**. You run it in CI, compare it against a baseline, and block regressions. This article walks through the end-to-end workflow I use in projects.

## BenchmarkRule lifecycle control

Macrobenchmark uses `MacrobenchmarkRule` to manage the test lifecycle. The core API is `measureRepeated`:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun coldStartup() = benchmarkRule.measureRepeated(
        packageName = "com.example.app",
        metrics = listOf(StartupTimingMetric()),
        iterations = 10,
        startupMode = StartupMode.COLD
    ) {
        pressHome()
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            setPackage("com.example.app")
        }
        startActivityAndWait(intent)
    }
}
```

Several parameters directly determine whether the result reflects reality:

- **`iterations`**: the official recommendation is at least 10 runs. Too few iterations create high variance and an unstable median. In real projects I usually use 15 to 20 runs. The first few cold-start iterations are strongly affected by system cache warmup, so dropping the first two often gives a better steady-state signal.
- **`startupMode`**: in `COLD` mode, the framework kills the process and clears relevant caches before each iteration to simulate a first launch. `WARM` and `HOT` have their uses, but cold start is the metric I watch most closely because it is the most visible to users.
- **`compilationMode`**: the default is `Partial()`. If you want to understand the upper bound after full AOT compilation, use `Full()`, but do not use that number as the production baseline. Most real users will not be in that state.

One issue I have hit: `startActivityAndWait` can return too early on some customized ROMs, causing the measured value to be too small. The fix is to add a `timeToFullDisplay` signal through `reportFullyDrawn()`, or add a point in `onResume` to verify the actual rendering completion time.

## Three key cold-start metrics

Macrobenchmark's `StartupTimingMetric` extracts three timestamps from systrace:

| Metric | Meaning | Reference value |
|------|------|--------|
| `timeToInitialDisplay` | Time to first frame | < 500 ms |
| `timeToFullDisplay` | First frame plus data load completion | < 1.5 s |
| `timeToInteractive` (API 34+) | Time until interactive | < 2 s |

`timeToFullDisplay` depends on your app calling `reportFullyDrawn()`. Many teams miss this step, so the metric stays at 0. Add this in the Activity:

```kotlin
override fun onResume() {
    super.onResume()
    if (isDataReady) {
        reportFullyDrawn()
    }
}
```

Results are summarized as median, min/max, and standard deviation. I pay more attention to **P95**. Averages are not sensitive enough to outliers, while users often feel exactly those long-tail requests. You can parse the raw data from the `Measurements` object and compute percentiles yourself.

## Frame smoothness with FrameTimingMetric

A fast startup does not guarantee a smooth experience. Dropped frames while scrolling a list need `FrameTimingMetric`:

```kotlin
@Test
fun scrollList() = benchmarkRule.measureRepeated(
    packageName = "com.example.app",
    metrics = listOf(FrameTimingMetric()),
    iterations = 5,
    setupBlock = {
        // Start the app and navigate to the target screen first
        startActivityAndWait()
        device.findObject(By.res("list_page")).waitForExists(3000)
    }
) {
    val list = device.findObject(By.res("recycler_view"))
    list.setGestureMargin(device.displayWidth / 5)
    list.fling(Direction.DOWN)  // Simulate a fast scroll
    device.waitForIdle()
}
```

Macrobenchmark frame output includes `frameOverrunMs`, the amount by which a frame exceeds the 16.67 ms budget. Accumulated overrun, or total overrun divided by total frames, reflects real smoothness better than just counting dropped frames. In my projects, the gate triggers when **accumulated overrun exceeds 120 ms** and **dropped-frame rate exceeds 8%**.

The `fling` speed and direction should match real user behavior. For a feed, two fast flings followed by one slower scroll is closer to how users browse: skim twice, then slow down and read.

## Custom TraceSection metrics

System metrics do not cover every business-critical path. If you have a custom image loader or a complex parsing stage, a slowdown there can affect user experience even when `StartupTimingMetric` does not see it.

Use `TraceSectionMetric` to turn custom trace sections into measurable metrics:

```kotlin
// Instrument the business code
Trace.beginSection("image_decode_pipeline")
val bitmap = customDecoder.decode(inputStream)
Trace.endSection()

Trace.beginSection("json_parse_large_list")
val data = Gson().fromJson<List<Item>>(response)
Trace.endSection()
```

The test side captures those custom sections:

```kotlin
@Test
fun customMetrics() = benchmarkRule.measureRepeated(
    packageName = "com.example.app",
    metrics = listOf(
        TraceSectionMetric("image_decode_pipeline%"),
        TraceSectionMetric("json_parse_large_list%")
    ),
    iterations = 10,
    startupMode = StartupMode.COLD
) {
    startActivityAndWait(intent)
    device.waitForIdle()
}
```

The `%` suffix matches every trace section that starts with `image_decode_pipeline`, which avoids missing loop-generated names such as `image_decode_pipeline_0` and `image_decode_pipeline_1`.

In one project, I split the key business path into 12 trace sections and ran the full test weekly. **If any section grew by more than 15%, the system created a ticket automatically**. The team initially thought 12 sections were too many. After two months, we found that 3 sections barely changed, so we removed them. Measurement itself needs continuous tuning.

## CI integration and regression prevention

A one-off benchmark run has limited value. The real value comes from **continuous comparison**. A CI integration can look like this:

```bash
# Run on the release build because profile mode is not close enough to production
./gradlew :benchmark:pixel6Api33BenchmarkAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.class=\
        com.example.benchmark.ColdStartBenchmark

# Pull the JSON result
adb pull /sdcard/Android/media/com.example.benchmark/benchmarkData.json
```

There are four important design points:

1. **Fixed device**: benchmarks from different device models are not comparable. In CI, use one dedicated Pixel 6 or a fixed emulator configuration, and do not share it with unrelated jobs.
2. **Baseline storage**: after each run, store the JSON result in the Git repository under `benchmark/baselines/`, then compare automatically during merge requests.
3. **Threshold policy**: do not hard-fail on every small increase. That creates too many false positives. My policy is: above 5% posts a warning comment, and above 15% blocks the merge.
4. **Environment isolation**: before running CI benchmarks, turn off Bluetooth, Wi-Fi, and sync services, and fix brightness at 50%. A `setupBlock` can handle this:

```kotlin
setupBlock = {
    device.executeShellCommand("cmd batterymanager set status 1")  // Simulate charging
    device.executeShellCommand("settings put system screen_brightness 128")
    // Disable background services that may interfere
    device.executeShellCommand("cmd activity idle-maintenance")
}
```

After using this for more than a year, one lesson is clear: **do not trust emulator data too much**. The same code measured P50 at 380 ms on an emulator and 520 ms on a Pixel 6. Emulators are useful for quick validation, but baselines and alerts should use real-device data.

---

Putting Macrobenchmark to work comes down to three steps: choose the right metrics, such as startup, frames, and custom traces; run in a fixed environment with a dedicated device and standardized setup; and create a baseline for CI diffing. Data is more honest than you expect. This workflow blocked a supposedly harmless SDK upgrade three times before the issue was finally fixed.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first-frame Perfetto analysis](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android app startup optimization: metrics, execution path, tooling, and governance](/blog/app启动优化专项/)
- [RecyclerView caching explained: four cache levels, reuse, and Prefetch](/blog/2026-04-14-深入_android_recyclerview_缓存机制_从四级缓存到_prefetch_的性能设计/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/2026-04-14-深入_android_bitmap_内存模型_从_java_堆分配到_hardware_bitmap/)
<!-- /seo-internal-links -->
