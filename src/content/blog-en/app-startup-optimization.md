---
title: "Android App Startup Optimization Program"
lang: en
translationKey: app-startup-optimization
slug: app-startup-optimization
excerpt: "A systematic Android startup optimization guide covering startup types, cold-start phases, Perfetto and Macrobenchmark diagnostics, Baseline Profiles, and monitoring."
publishDate: '2024-03-07'
tags:
- "Android"
- "Performance Optimization"
- "Startup Optimization"
seo:
  title: "Android App Startup Optimization: Metrics, Flow, Tools, Governance"
  description: "Optimize Android startup with cold-start analysis, main-thread task cleanup, async initialization, Baseline Profiles, Macrobenchmark, and online monitoring."
  pageType: article
---
## Introduction: startup speed defines the first impression

App startup speed is the user's first impression of an application, and it is one of the key factors that determines whether users stay. An app that starts slowly, shows a long white screen, or stays black for too long can easily make users lose patience and uninstall it. In a highly competitive mobile market, an app that feels like it opens instantly has a clear advantage. For that reason, startup optimization is one of the Android performance projects with the highest return on investment.

Startup is not just Activity loading. It involves process creation, application initialization, resource loading, layout rendering, and many other complex and time-consuming steps. It often crosses application code, the framework layer, system services, and even hardware. To optimize startup performance thoroughly, you need both a global view and low-level insight.

For an Android expert, the responsibility is not only to fix visible slow startup symptoms, but to **lead the team in systematically measuring, diagnosing, and optimizing the whole startup path**. That means understanding every step from process creation to first-frame rendering, mastering advanced diagnostic tools such as Systrace and Perfetto, and applying advanced strategies such as concurrent initialization, lazy loading, and Baseline Profiles to compress startup time as much as possible.

This article covers the startup optimization program in depth:

- **Startup type definitions:** differences between cold start, warm start, and hot start, plus their optimization priorities.
- **Cold-start path analysis:** stage-by-stage analysis of common bottlenecks in process creation, `Application` initialization, Activity initialization, and first-frame rendering.
- **Startup performance diagnosis:** precise measurement and bottleneck location with Perfetto/Systrace, Macrobenchmark, and related tools.
- **Core optimization strategies:** concurrency, deferral, rendering, and other optimizations for each startup stage.
- **Baseline Profiles:** the closest thing to a modern Android startup optimization silver bullet.
- **Startup performance monitoring:** build a measurement system for continuous tracking and improvement.

## 1. Startup types: optimize the right scenario

Before optimization, clarify the scenario being optimized. Android app startup is usually divided into three categories.

### 1. Cold start

- **Scenario:** the app process **does not exist** in the system, such as the first launch after device reboot or after the process has been killed by the system. This is the **slowest** startup type.
- **Process:** the system executes the most complete startup flow:
  1. Zygote forks a new app process.
  2. The ART runtime starts and loads application code, including DEX files.
  3. The `Application` object is created, and `attachBaseContext()` and `onCreate()` are called.
  4. The Activity object is created, and `onCreate()`, `onStart()`, and `onResume()` are called.
  5. The first Measure, Layout, and Draw pass runs, and the first frame is rendered to the screen.
- **Optimization focus:** cold start is the core target because it takes the longest, includes all possible startup phases, and produces the most visible gains.

### 2. Warm start

- **Scenario:** the app process **already exists** in the background, but the Activity instance needs to be recreated. For example, the user presses Back to exit the Activity and reopens it shortly afterward, or the system destroys the Activity instance under memory pressure while keeping the process alive.
- **Process:** process creation and `Application.onCreate()` are skipped. The main work is Activity creation, from `onCreate` to `onResume`, and UI rendering.
- **Optimization focus:** Activity `onCreate` logic, especially layout loading and data initialization, plus first-frame rendering performance. Warm start is usually faster than cold start, but Activity creation still matters.

### 3. Hot start

- **Scenario:** both the app process and target Activity instance are **alive** in background memory, such as when the user presses Home to background the app and then opens it again.
- **Process:** the system only brings the existing Activity to the foreground and calls `onStart()` and `onResume()`. It usually does not recreate the Activity or rerun layout rendering unless the UI content needs updates.
- **Optimization focus:** keep `onStart()` and `onResume()` lightweight. This is the **fastest** startup type, and usually has little room for optimization unless `onResume` contains unnecessary expensive work.

**The rest of this article focuses mainly on cold start, which has the highest optimization difficulty and return.**

## 2. Deep dive into the cold-start path: eliminate bottlenecks one by one

Every step of cold start can become a performance bottleneck.

**Diagram: cold-start stages and potential bottlenecks**

```plain
|-------------------------- System Responsibility --------------------------| |---------------------- Application Responsibility ----------------------->|

+------------------+     +-------------------+     +---------------------+     +-----------------------+     +-----------------------+     +----------------+
| Intent Received  | --> | Zygote Fork       | --> | ART Start / App Load| --> | Application.onCreate()| --> | Activity.onCreate()   | --> | First Frame Draw | Time -->
| (by AMS)         |     | (Process Creation)|     | (Class Loading etc.)|     | (App-wide Init)       |     | (UI Init, Layout...)  |     | (Measure/Layout/Draw)|
+------------------+     +--------+----------+     +----------+----------+     +-----------+-----------+     +-----------+-----------+     +--------+-------+
                              ^                      ^                           ^                           ^                              ^
                              |                      |                           |                           |                              |
                          Bottleneck?            Bottleneck?                 Bottleneck?                 Bottleneck?                    Bottleneck?
                        (System Load,           (MultiDex?,              (Sync I/O, Network,        (Complex Layout Inflate,         (Complex Layout M/L,
                         Slow Zygote)           Class Verify/Link,       Heavy Lib Init,             Sync Data Load,                  Heavy Draw Ops,
                                                Static Init)             Complex DI Graph)           Heavy Resource Load)             GPU Upload)
```

### Stage 1: process launch

- **Operation:** after AMS receives the startup Intent, it asks the Zygote process to `fork()` a new app process. The kernel creates the process, and the ART runtime begins initialization.
- **Duration:** usually tens to hundreds of milliseconds, heavily affected by current system load.
- **Bottlenecks:** busy system, slow Zygote response, I/O contention.
- **Application-side room for optimization:** limited and indirect. Mainly reduce the app's overall package size, reduce the number of processes, and avoid competing for resources during startup to create better conditions for the system.

### Stage 2: application initialization, `Application.attachBaseContext()` and `Application.onCreate()`

- `attachBaseContext()`: called after the `Application` object is created and before `onCreate`. **It must be extremely lightweight.** It is usually used only for MultiDex initialization on Android versions below 5.0, or for a very small number of operations that must finish before `onCreate` and do not depend on a fully initialized `Context`.
- `Application.onCreate()`: the application-level initialization entry point. **It very easily becomes a startup bottleneck** because it runs synchronously on the main thread and its duration is directly counted in startup time.
- **Common bottlenecks:**
  - **Synchronous I/O:** reading or writing files on the main thread, especially SharedPreferences, which should be firmly replaced with DataStore, or initializing and accessing databases. **Must be made asynchronous.**
  - **Synchronous networking:** making network requests on the main thread to fetch configuration or data. **Absolutely forbidden.**
  - **Complex DI initialization:** some DI frameworks, especially reflection-based ones, can be expensive when initializing the dependency graph.
  - **Expensive third-party SDK initialization:** many SDKs ask to initialize synchronously in `Application.onCreate`, but their internals may include I/O, network, or complex computation. Audit them carefully and look for asynchronous or lazy initialization options.
  - **Premature initialization of nonessential components:** business modules, managers, or utilities that are not needed during startup should not be initialized immediately.

### Stage 3: Activity initialization, `Activity.onCreate()` to `onResume()`

- `Activity.onCreate()`: the main work is setting up the UI with `setContentView` and initializing logic related to that screen. **This is another major bottleneck area.**
- `onStart()` and `onResume()`: usually not long-running, but expensive operations should still be avoided.
- **Common bottlenecks:**
  - **Layout loading, `setContentView` / inflate:**
    - **Complex XML:** deeply nested XML layouts and complex hierarchies make XML parsing and View object creation expensive.
    - **Custom View:** constructors or `onMeasure` methods may contain expensive work.
  - **Resource loading:** loading large Bitmaps or parsing complex Drawables, styles, or themes on the main thread.
  - **Main-thread blocking:** synchronously waiting in `onCreate` for network or database data before updating UI.
  - **ViewModel/Presenter initialization:** expensive work in the ViewModel constructor or `init` block.

### Stage 4: first-frame rendering

- **Operation:** after `Activity.onResume`, Choreographer schedules the first Measure, Layout, and Draw pass to render UI content.
- **Common bottlenecks:**
  - **Complex Measure/Layout:** same layout issues as Activity initialization.
  - **Expensive `onDraw`:** complex custom View drawing logic.
  - **Overdraw:** increases GPU rendering time.
  - **Large GPU resource uploads:** first render needs to upload images, vector drawables, and other resources to GPU memory.
  - **Shader compilation:** first use of complex effects may trigger shader compilation jank.
- **Reference:** for detailed rendering optimization, see the Android rendering mechanism and graphics stack articles.

### Key metrics

- **TTID, Time To Initial Display:** the time from the system receiving the startup Intent to the target Activity's first frame being drawn on screen, usually when the background has been drawn. It is measured by the system and visible in Logcat. **This is the core technical metric for cold-start speed.**
- **TTFD, Time To Full Display:** the time from startup Intent to the app's **main content being fully rendered and interactive**. This better reflects user perception. There is **no** unified system measurement standard for it, so apps usually measure it with custom `Trace.beginSection` and `Trace.endSection` instrumentation, such as from `Activity.onCreate` until the first screen of list data has loaded and displayed.

## 3. Startup performance diagnosis: sharpen the tools first

Precise diagnosis is the foundation of optimization.

### 1. Logcat

- **Filter:** use the ActivityTaskManager tag on Android 10 and later, or ActivityManager on earlier versions.
- **Find:** search for log lines containing `Displayed`, for example `ActivityTaskManager: Displayed com.example.app/.MainActivity: +350ms`. The `+350ms` value is the system-measured TTID.
- **Use:** quickly obtain a TTID baseline and compare before and after optimization. It cannot locate specific bottlenecks.

### 2. Method tracing, Debug only

- **Tool:** Android Studio CPU Profiler -> Trace Java Methods / Sample C/C++ Functions.
- **Limitations:** **the overhead is huge and seriously distorts real performance and timing**. Use it only in Debug builds for a **rough** analysis of time distribution inside specific methods such as `onCreate`. **Never** use it to measure accurate startup time.

### 3. System tracing, Perfetto/Systrace: the primary weapon for startup optimization

- **Capture:**
  - Command-line Perfetto: **the best approach**. It can precisely control the trace start time and cover the full cold-start process from process launch.
    - **Timed trace:** `adb shell perfetto -c config.pbtxt --timed-trace -o /data/local/tmp/trace.pftrace`, when startup duration can be estimated.
    - **Trigger-based trace, recommended:** use `trigger_config` with the `am start` command. For example, configure a `trigger_config` that listens to `am_start_trigger`, then run in another adb window: `adb shell cmd activity trigger-start-trace com.example.app/.MainActivity && adb shell am start -S -W com.example.app/.MainActivity`. This captures the trace exactly from `am start`.
  - **Trace configuration:** must include key categories: `sched` for CPU scheduling, `freq` for CPU frequency, `idle` for CPU idle, `am` for ActivityManager, `wm` for WindowManager, `view` for the View system, `dalvik` for ART and GC, `diskio`, `binder_driver`, `gfx`, and `input`.
- **Analysis flow:**
  1. **Load the trace into Perfetto UI, `ui.perfetto.dev`.**
  2. **Find the startup start point:** locate the `ActivityTaskManager: AppLaunch_dispatching` event or similar system event corresponding to `am start`.
  3. **Find process creation:** locate the app process `sched_process_fork` event.
  4. **Find key phases:** expand the main-thread track of the app process and look for key slices, combining them with custom app trace points when needed:
     - `Application.attachBaseContext` / `Application.onCreate`
     - `ActivityThreadMain` / `handleBindApplication`
     - `Activity.onCreate` / `Activity.performCreate`
     - `Activity.onResume`
     - `Choreographer#doFrame`, especially the first few frames
     - `inflate`, for layout loading
  5. **Measure duration:** use Perfetto's time-range selection tool to measure each phase.
  6. **Identify the bottleneck phase:** find the longest phase.
  7. **Dig into the cause:**
     - Check main-thread state: during the expensive phase, is the main thread Running, Runnable and waiting for CPU, Sleeping while waiting for I/O, a lock, or Binder, or in Uninterruptible Sleep waiting for kernel work?
     - **Check CPU activity:** is it preempted by other threads or processes? Is CPU frequency too low?
     - **Check Binder calls:** is a long synchronous Binder call blocking the main thread?
     - Check the disk I/O track: are there many reads or writes?
     - **Check GC activity:** are there long GC pauses?
     - **Use custom app trace points:** precisely locate expensive logic blocks in app code.

### 4. Jetpack Macrobenchmark

- **Purpose:** measure app **startup time, TTID/TTFD**, and **runtime performance such as scroll smoothness** in a **near-real user environment**, with non-Debug mode and compilation optimizations. It is the **gold standard** for measuring optimization effect and preventing performance regressions.
- **Usage:**
  - Add the `androidx.benchmark:benchmark-macro-junit4` dependency.
  - Write JUnit4 tests using `MacrobenchmarkRule`.
  - Use `measureRepeated`, specify the package name, startup mode such as `StartupMode.COLD`, `WARM`, or `HOT`, and iteration count.
  - The test library automatically handles process killing, cache clearing for cold start, app launching, trace stopping, and result collection.
- **Output:** median, P90, P95, and other statistics, plus associated Perfetto trace files for detailed analysis.

Macrobenchmark **must** be integrated into CI. Establish baselines for key performance metrics such as median cold-start TTID, set thresholds, and automatically detect performance regressions.

## 4. Core optimization strategies: compress startup across the full path

The following strategies can be applied to different cold-start stages.

### 1. Stage 1: process initialization optimization, indirect impact

- **Reduce APK size:** publish with App Bundle, enable R8/Proguard obfuscation and code shrinking, enable resource shrinking with `shrinkResources`, and optimize image format such as WebP and image size. Smaller packages load faster.
- **Avoid unnecessary multi-process design:** every process has startup and memory overhead.

### 2. Stage 2: `Application.onCreate` optimization

- **Core principle:** lazy initialization plus concurrent initialization.
- **Lazy initialization:**
  - **Load on demand:** do not initialize everything in `onCreate`. Initialize only components **absolutely required** by the startup flow. Defer other components until first use.
  - **DI framework support:** use Dagger/Hilt `Lazy<T>` or `Provider<T>` for lazy dependency instantiation.
- **Concurrent initialization:**
  - **Identify parallelizable tasks:** find initialization tasks that do not depend on each other and can run on background threads.
  - **Jetpack App Startup library:**
    - **Principle:** define the `Initializer<T>` interface, implement `create()` to perform initialization, and declare dependencies in `dependencies()`. App Startup merges multiple ContentProviders into one, reducing startup overhead, and initializes components on the main thread in dependency order.
    - **Benefits:** declarative API, automatic dependency ordering, support for lazy initialization through manual triggering, and reduced ContentProvider startup overhead.
  - **Manual concurrency:** use `ExecutorService` or Kotlin Coroutines with `viewModelScope` / `lifecycleScope` and `Dispatchers.IO` / `Default` to manage background initialization tasks. Thread synchronization and dependencies must be handled manually, so complexity is higher.
- **Make I/O asynchronous:** any storage access required during the Application phase, such as reading configuration, must use asynchronous APIs such as DataStore or Room suspend DAO.
- **SDK initialization audit:** strictly review third-party SDKs:
  - Must it initialize in `Application.onCreate`?
  - Can it be delayed?
  - Is initialization synchronously blocking?
  - Does it provide an asynchronous initialization API?
  - Contact the SDK vendor about performance problems when needed.

### 3. Stage 3: `Activity.onCreate` optimization

- **Layout loading optimization:**
  - **Simplify layouts:** use ConstraintLayout to flatten hierarchies and avoid excessive nesting.
  - **Reuse layouts:** use `<include>`.
  - **ViewStub:** for complex views that are not required at startup but may be shown later, use ViewStub for lazy loading and call `inflate()` only when needed.
  - **Asynchronous layout loading:** `AsyncLayoutInflater` can move XML parsing and View creation to a background thread. **Note:** carefully handle whether the View has finished loading before use. This is suitable for complex layouts outside the first-screen critical path.
  - **Compose:** for new screens, Compose initial composition performance, especially with Baseline Profiles, may outperform complex XML layout inflation. Measure and compare in practice.
- **Asynchronous data loading:** **never** synchronously wait for network or database data in `onCreate`, `onStart`, or `onResume`. Use ViewModel plus Coroutines/Flow and LiveData/StateFlow to load data in the background and update UI through reactive APIs. The UI should handle loading and failure states.
- **Defer noncritical work:** move work not required for first-screen rendering, such as setting complex listeners, starting nonurgent services, or preloading non-first-screen data, until after `onResume` with `Handler.post` or `View.post`, or delay it further.

### 4. Stage 4: first-frame rendering optimization

- **Startup window background, `windowBackground`:**
  - **Purpose:** avoid showing the system default white or black background, often called a white screen or black screen, and provide immediate visual feedback.
  - **Implementation:** set `android:windowBackground` in the Activity theme to a simple Drawable, such as a solid color or app logo. WindowManager draws this Drawable before any content View is loaded.
  - **Note:** the background should be static and lightweight. Do not put animations or complex layouts here.
- **SplashScreen API, Android 12+:**
  - **Official solution:** provides a more standard and controllable startup-screen API. It supports icon, background color, icon animation, and graceful transition to the app's main UI. The compatibility library `androidx.core:core-splashscreen` supports older versions.
- **General rendering optimization:** apply common UI rendering optimizations: reduce overdraw, optimize custom View drawing, simplify layouts, and so on.

### 5. General advanced optimization techniques

- **Class loading optimization:** mainly handled by ART PGO and Baseline Profiles.
- **MultiDex optimization:** mainly affects Android versions below 5.0. Keep the main DEX file as small as possible and include only startup-critical core classes. Use R8/Proguard code shrinking.
- **Baseline Profiles:** **a core technology for modern Android startup optimization.**
  - **Principle:** provide the ART compiler with a "script" that tells it which classes and methods are frequently used in the app's **critical user paths**, especially startup paths. During AOT compilation with dex2oat, ART prioritizes compiling and optimizing this code and lays it out more compactly in DEX files.
  - **Effects:**
    - **Reduce interpretation and JIT:** critical-path code directly executes optimized native code.
    - **Reduce page faults:** related class and method code is more likely to be physically contiguous in memory, reducing disk I/O caused by code access during startup.
    - **Significantly improve startup speed, TTID/TTFD, and smoothness after first interaction.**
  - **Generation:** use the Jetpack **Macrobenchmark** library to write benchmark tests that record startup and key interaction flows. The test library automatically generates `baseline-prof.txt`.
  - **Integration:** place `baseline-prof.txt` under `app/src/main/` or `src/release/`. Add the `androidx.profileinstaller` dependency so the app can ask the system to use the profile for background compilation optimization when installed or updated, through Google Play or `adb install`.

Applications **must** generate and integrate Baseline Profiles, and they should establish a continuous update mechanism as code and user behavior change.

## 5. Continuous startup performance monitoring

Optimization is not a one-time action. Continuous monitoring is needed to prevent regressions.

### 1. Automated benchmarks, Macrobenchmark

As described above, integrate it into CI, set performance thresholds, and alert automatically.

### 2. Real user monitoring, RUM

- **Tools:** Firebase Performance Monitoring, Sentry, Bugsnag, Dynatrace, self-built APM, and others.
- **Metrics:** collect cold-start and warm-start TTID from real users when tools support it, plus custom TTFD metrics.
- **Analysis:** analyze startup data by app version, device model, OS version, country or region, and other dimensions to find scenario-specific problems and verify online optimization effects.

### 3. Regular manual testing

Regularly run manual cold-start tests on representative high-end, mid-range, and low-end devices. Combine subjective perception with Logcat TTID evaluation.

## 6. Conclusion: extreme startup speed comes from deep optimization

App startup optimization is a comprehensive engineering challenge involving system internals, app architecture, code implementation, build configuration, and more. To achieve excellent startup performance, Android experts need:

- **Global view:** understand the full path from process creation to first-frame rendering.
- **Precise diagnosis:** use system-level tools such as Perfetto to locate bottlenecks.
- **Strategy composition:** systematically apply concurrent initialization, lazy loading, layout optimization, rendering optimization, and related techniques.
- **Adopt new technology:** fully use modern techniques such as Baseline Profiles.
- **Data-driven practice:** rely on Macrobenchmark and RUM to build reliable measurement and monitoring systems.

Optimizing startup speed is fundamentally about completing the most necessary work in the most efficient way within a limited time window. This requires deep understanding and careful design of code execution timing, threading model, resource loading, and system interaction. Only through continuous measurement, analysis, and optimization can an app keep approaching the goal of instant launch and deliver the best possible first impression.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android performance optimization](/en/android-performance/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [RecyclerView cache mechanism: four-level cache, reuse, and Prefetch](/en/blog/android-recyclerview-four-level-cache/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/en/blog/android-bitmap-oom/)
- [Android RenderThread and HWUI: rendering pipeline, DisplayList, and frame-drop analysis](/en/blog/android-renderthread-hwui/)
<!-- /seo-internal-links -->
