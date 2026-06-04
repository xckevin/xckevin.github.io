---
title: 启动框架分阶段初始化：background/activity 两类 StartType 的设计与实践
excerpt: App 启动阶段承载大量初始化逻辑，如果全部堆在 Application 中，冷启动耗时不可控。本文介绍一种分阶段初始化框架，将任务按 background 和 activity 两类 StartType 拆分，配合依赖声明、线程调度、异常降级和耗时监控，让初始化在正确时间完成必要工作。
publishDate: '2026-06-04'
tags:
- Android
- 启动优化
- 性能优化
- 架构设计
- App Startup
seo:
  title: 启动框架分阶段初始化：background/activity 两类 StartType 的设计与实践
  description: Android 启动框架分阶段初始化设计，将任务按 background 和 activity 两类 StartType 拆分，配合依赖声明、线程调度、异常降级和耗时监控优化冷启动体验。
---

Android 应用启动通常经历进程创建、Application 初始化、首个 Activity 创建、首帧绘制、首屏数据加载等阶段。早期工程常见做法是在 Application 的 `onCreate` 中直接调用一串初始化方法，业务增长后问题逐渐暴露：任务顺序靠人工维护，耗时难以统计，依赖关系不透明，主线程和后台任务混在一起。某个 SDK 初始化耗时增加，可能直接影响冷启动；某个业务模块新增初始化，也可能无意中提前拉起大量类和资源。

我们项目里把启动链路拆成三层来看。第一层在各 App 壳的 Application 中注入品牌、包名、版本、站点类型等差异化信息；第二层在 AppCommon 的 MainApplication 中处理进程判断、站点配置、语言包装、Firebase 延迟初始化、前后台生命周期注册；第三层由 AppStartUpManager 统一编排基础设施启动任务。这里最值得讲的，是 `StartType.TYPE_BACKGROUND` 和 `StartType.TYPE_ACTIVITY` 的边界。

## 一个容易被忽略的关键判断

Application 启动不等于用户主动打开应用。进程可能因为推送、系统恢复、内容提供者、后台任务、动态模块服务等原因被拉起，此时如果直接跑完整前台初始化，会浪费资源，甚至让某些依赖 Activity 的 SDK 在错误时机执行。

我们的处理思路是：在 `attachBaseContext` 阶段先判断是否主进程、是否"无 Activity 启动场景"；在 `onCreate` 阶段根据这个结果选择 `TYPE_BACKGROUND` 或等待首个非启动占位 Activity 创建后再切到 `TYPE_ACTIVITY`。这相当于把 Application 启动拆成"进程可用"和"界面可用"两个状态。

脱敏后的判断逻辑可以抽象为：

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

这段逻辑的重点不是具体 API，而是判断顺序：先识别进程，再识别是否真的进入前台，再决定启动任务集合。后台启动只做进程级最小能力，例如基础日志、必要配置、轻量网络安全组件；前台启动才补齐页面路由、预取、主题、调试面板、依赖 Activity 的三方能力。

## 任务模型：让依赖显式化

启动框架的核心是把初始化逻辑从"调用顺序"升级为"可调度模型"。每个任务声明自己的执行阶段、线程要求、依赖任务和降级策略：

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

`background` 任务在 Application 阶段注册并启动，适合处理不需要页面上下文的工作，例如轻量配置读取、基础日志、崩溃保护、线程池准备。`activity` 任务在首个 Activity 可用后执行，适合处理窗口适配、页面观察、路由拦截器安装、需要 Activity Result 的能力。

调度器按阶段启动任务，先筛选当前 StartType，再根据依赖关系执行。对于后台线程任务，可以并发执行；对于主线程任务，需要排队并控制耗时：

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

异常策略需要分层：崩溃采集、关键配置、合规相关初始化是强依赖；埋点增强、预加载、体验优化通常为弱依赖。弱依赖失败要记录，但不应阻止用户进入 App。

## 启动性能纳入埋点闭环

另一个值得强调的点是启动性能的可观测性。我们在 `attachBaseContext` 附近记录启动起点，在 Activity 生命周期中记录关键页面创建和首个 resume，再把 perf 事件交给统一埋点系统。这样"分阶段 + 可观测 + 主/子进程隔离 + 页面出现后补初始化"形成组合拳，而不是只做异步初始化。

任务注册也可以由模块提供，最后在宿主侧聚合。为了避免任务泛滥，我们要求每个任务声明预算原因：

```kotlin
@StartupBudget(maxCostMs = 20, reason = "路由表需要在首个页面交互前完成安装")
class RouteInstallTask : StartupTask { ... }
```

预算不是为了制造形式感，而是让新增启动任务必须说明价值和成本。后续性能回归时，团队也可以按预算快速定位异常任务。

## 落地中要注意的几点

不要把 `background` 理解为"随便放后台线程"。后台任务同样会占用 CPU、IO 和锁资源，过多并发可能影响首屏渲染。启动阶段的后台线程池需要限制并发数。

`activity` 任务要注意幂等。横竖屏切换、多窗口、深链启动、任务栈恢复都可能导致 Activity 生命周期多次触发。框架应该提供 `startOnce` 语义，任务自身也要能承受重复调用。

多进程场景要提前设计。任务可以声明适用进程，例如主进程、推送进程、独立 Web 进程。默认所有进程都执行完整启动任务，通常是性能和稳定性隐患。

---

分阶段初始化的本质，是把启动任务从"调用顺序"升级为"可调度模型"。它需要任务模型、依赖表达、线程调度、异常降级、耗时监控和评审纪律共同配合。只有这样，启动优化才不会停留在一次性清理，而能成为长期可维护的工程能力。