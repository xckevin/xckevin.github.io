---
title: "Phased Android Startup Initialization with background and activity StartTypes"
lang: en
translationKey: app-startup-phased-initialization-starttype
slug: app-startup-phased-initialization-starttype
excerpt: "Putting every initialization task into Application makes cold-start cost unpredictable. This article presents a phased startup framework that separates background and activity StartTypes with explicit dependencies, thread scheduling, fallback behavior, and timing metrics."
publishDate: '2026-06-04'
tags:
- "Android"
- "Startup Optimization"
- "Performance Optimization"
- "Architecture"
- "App Startup"
seo:
  title: "Phased Android Startup Initialization with StartType"
  description: "Design an Android startup framework with background and activity StartTypes, dependency rules, scheduling, fallback behavior, and timing metrics."
  pageType: article
---

Android application startup typically involves several stages: process creation, Application initialization, first Activity creation, first-frame rendering, and initial data loading. Early implementations often call a sequence of initialization methods directly from `Application.onCreate`. As the product grows, this becomes hard to control: task ordering relies on manual maintenance, execution time is hard to measure, dependencies are opaque, and main-thread work gets mixed with background work. If one SDK becomes slower, cold start regresses immediately; if a new initializer is added carelessly, it may load classes and resources far earlier than necessary.

In our project, the startup lifecycle is split into three layers. The first layer injects app-specific information such as brand, package name, version, and site type into each app shell's Application. The second layer, `AppCommon`'s `MainApplication`, handles process detection, site configuration, locale wrapping, delayed Firebase initialization, and foreground/background lifecycle registration. The third layer, `AppStartUpManager`, orchestrates infrastructure startup tasks. The important boundary is the split between `StartType.TYPE_BACKGROUND` and `StartType.TYPE_ACTIVITY`.

## A Crucial Judgment Often Overlooked

Application startup does not equate to the user actively opening the app. The process might be launched due to push notifications, system recovery, content providers, background tasks, or dynamic module services. If we run the full foreground initialization in such cases, it wastes resources and might cause SDKs that depend on an Activity to execute at the wrong time.

Our approach is to first determine in `attachBaseContext` whether it's the main process and if it's a "no visible entry" scenario. In `onCreate`, based on this result, we choose either `TYPE_BACKGROUND` or wait until the first non-placeholder Activity is created before switching to `TYPE_ACTIVITY`. This effectively splits Application startup into two states: "process available" and "UI available."

The sanitized logic can be abstracted as follows:

```kotlin
class MainApplication : Application() {
    private var mainProcess = false
    private var noVisibleEntry = false

    override fun attachBaseContext(base: Context) {
        mainProcess = ProcessInspector.isMainProcess(base)
        noVisibleEntry = LaunchInspector.isStartedWithoutActivity(base)

        if (mainProcess && !noVisibleEntry) {
            StartupPerf.markProcessStart()
        }
        super.attachBaseContext(wrapLocaleAndSite(base))
    }

    override fun onCreate() {
        super.onCreate()
        StartupManager.initProcessConfig(this)

        if (!mainProcess || noVisibleEntry) {
            StartupManager.start(this, StartType.BACKGROUND)
            return
        }

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacksAdapter() {
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                if (!activity.isPlaceholderLauncher()) {
                    StartupManager.start(this@MainApplication, StartType.ACTIVITY)
                }
            }
        })
    }
}
```

The focus of this logic is not the specific APIs, but the order of judgment: first identify the process, then identify if it's truly entering the foreground, and finally decide the set of tasks to run. Background startup only performs process-level minimum capabilities, such as basic logging, necessary configurations, and lightweight network security components. Foreground startup completes page routing, prefetching, theming, debugging panels, and third-party capabilities dependent on Activities.

## Task Model: Making Dependencies Explicit

The core of the startup framework is upgrading initialization logic from a "call order" to a "schedulable model." Each task declares its execution phase, thread requirements, dependencies, and fallback strategy:

```kotlin
enum class StartType { BACKGROUND, ACTIVITY }

interface StartupTask {
    val id: String
    val type: StartType
    val dependsOn: List<String>
    val threadMode: ThreadMode
    val required: Boolean

    fun run(context: StartupContext)
}
```

`background` tasks are registered and started during the Application phase, suitable for work that doesn't require a page context, such as reading lightweight configurations, basic logging, crash protection, or thread pool preparation. `activity` tasks execute after the first Activity is available, suitable for window adaptation, page observation, installing routing interceptors, or capabilities requiring Activity Results.

The scheduler starts tasks in stages, first filtering by the current `StartType`, and then executing based on dependencies. Background thread tasks can run concurrently; main thread tasks must be queued and their execution time controlled:

```kotlin
class StartupScheduler(
    private val tasks: List<StartupTask>,
    private val executor: TaskExecutor,
    private val monitor: StartupMonitor
) {
    fun start(type: StartType, context: StartupContext) {
        val selected = tasks.filter { it.type == type }
        val sorted = topologicalSort(selected, tasks)

        sorted.forEach { task ->
            executor.run(task.threadMode) {
                monitor.trace(task.id, type) {
                    try {
                        task.run(context)
                    } catch (error: Throwable) {
                        handleFailure(task, error)
                    }
                }
            }
        }
    }

    private fun handleFailure(task: StartupTask, error: Throwable) {
        if (task.required) throw error
        monitor.recordIgnoredFailure(task.id, error)
    }
}
```

The failure strategy needs to be layered: crash collection, critical configuration, and compliance-related initialization are hard dependencies; analytics enhancement, preloading, and experience optimization are usually soft dependencies. Failures in soft dependencies must be recorded but should not prevent the user from entering the app.

## Incorporating Startup Performance into the Telemetry Loop

Another point worth emphasizing is the observability of startup performance. We record the startup start point near `attachBaseContext`, record key page creations and the first resume in the Activity lifecycle, and then pass the performance events to a unified telemetry system. This combination—"staged + observable + main/sub-process isolation + initialization after page appearance"—forms a powerful combination, rather than just asynchronous initialization.

Tasks can also be provided by modules and aggregated on the host side. To prevent task bloat, we require every task to declare a budget reason:

```kotlin
@StartupBudget(maxCostMs = 20, reason = "Route table needs to be installed before interaction on the first page")
class RouteInstallTask : StartupTask { ... }
```

The budget is not for show; it forces new startup tasks to justify their value and cost. Later, during performance regressions, the team can quickly pinpoint anomalous tasks based on the budget.

## Points to Note During Implementation

Do not interpret `background` as "just run on a background thread." Background tasks also consume CPU, IO, and lock resources; excessive concurrency can affect first-screen rendering. The background thread pool during startup needs concurrency limits.

For `activity` tasks, idempotency is crucial. Screen rotation, multi-window usage, deep linking, and task stack restoration can cause Activity lifecycles to trigger multiple times. The framework should provide a `startOnce` semantic, and the task itself must be able to handle repeated calls.

Multi-process scenarios require upfront design. Tasks can declare which process they apply to, such as the main process, push process, or independent web process. By default, all processes execute the full startup task, which is usually a performance and stability risk.

---

The essence of staged initialization is turning startup from a hardcoded call sequence into a schedulable model. That requires a task model, dependency declarations, thread scheduling, fallback behavior, timing metrics, and review discipline. With those pieces in place, startup optimization stops being a one-time cleanup and becomes a maintainable engineering system.
