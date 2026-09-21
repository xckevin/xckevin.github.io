---
slug: android-adpf-thermal-performance-hints
translationKey: android-adpf-thermal-performance-hints
title: 深入 Android 动态性能框架 ADPF 全链路：从 Thermal API 到 Performance Hint 的自适应性能调度
excerpt: 本文解析 Android 动态性能框架 ADPF，结合 Thermal 热状态、Performance Hint 调频预算与 Game Mode 策略基线，演示如何在热降频前主动降载并拉平掉帧曲线。
publishDate: '2026-08-16'
tags:
- Android
- Kotlin
- ADPF
- 性能优化
- 帧率优化
seo:
  title: Android ADPF：Thermal API 与 Performance Hint 自适应调度
  description: 深入 Android ADPF 全链路实践：通过 Thermal API 感知热余量、Performance Hint 对齐帧预算、Game Mode 设定性能基线，实现过热降频前的自适应性能调度。
  pageType: article
---

我在一个 3D 游戏里把帧率锁在 60，渲染线程的帧间隔仍会从 16ms 突然拉到 30-40ms。查 Trace 看到 CPU 频率断崖式下跌，代码里没有任何逻辑变化。这就是热降频：芯片温度突破阈值后，调度器先降频再恢复，整个过程里应用层只能"挨打"。

ADPF（Android Dynamic Performance Framework）把三个能力串起来：Thermal API 报告热状态和余量、Performance Hint API 让系统按目标帧预算调频、Game Mode API 提供用户级的性能取向。三者配合后，应用可以在过热降频发生前主动降载，把掉帧曲线拉平。

## 先感知：热状态与热余量

Thermal API 有两层。第一层是状态监听，`PowerManager` 提供从 `THERMAL_STATUS_NONE` 到 `THERMAL_STATUS_SHUTDOWN` 的多级状态：

```kotlin
val pm = context.getSystemService(PowerManager::class.java)
val executor = Executors.newSingleThreadExecutor()

pm.addThermalStatusListener(executor) { status ->
    when (status) {
        PowerManager.THERMAL_STATUS_LIGHT -> renderer.qualityScale = 0.85f
        PowerManager.THERMAL_STATUS_MODERATE -> renderer.qualityScale = 0.65f
        PowerManager.THERMAL_STATUS_SEVERE -> renderer.qualityScale = 0.5f
        else -> renderer.qualityScale = 1.0f
    }
}
```

这个回调的缺点是**事件式**：只有跨过阈值才触发，而且不少机型的状态跳变很粗，LIGHT 之后可能直接跳到 SEVERE。用它做降载，动作往往已经慢了一拍。

第二层 `getThermalHeadroom` 回答"未来会不会热"：

```kotlin
val headroom = pm.getThermalHeadroom(forecastSeconds = 10)
if (!headroom.isNaN() && headroom >= 0.7f) {
    renderer.enableLowPowerPath()
}
```

`headroom` 是一个从 0 起步、可能超过 1.0 的余量估计值：越接近或超过 1.0，表示越接近严重热节流（throttling），是危险信号；越接近 0，表示散热余量越充足、越安全。`forecastSeconds` 传 0 获取当前值，传 10 获取 10 秒后的预测。预测靠厂商实现，返回 `NaN` 表示不支持。我在 Pixel 和几台国产旗舰上验证，10 秒预测基本能提前覆盖一次高负载场景的升温过程，比状态回调早 3-5 秒。

## 再执行：用 Performance Hint 对齐调频

感知到热之后，降载不能只改画面质量。如果调度器继续误判渲染线程的真实耗时，系统可能还在按 60 帧的高负载目标给 CPU 提频，降载效果会打折。

`PerformanceHintManager` 提供会话机制，让应用告诉系统"我下一帧的预算是多少、实际花了多少"：

```kotlin
val hintManager = context.getSystemService(PerformanceHintManager::class.java)
val session = hintManager.createHintSession(
    intArrayOf(renderThread.id, gameThread.id),
    16L * 1_000_000L
)

// 每帧渲染结束后上报实际耗时
session.reportActualWorkDuration(actualFrameCostMillis * 1_000_000L)
```

创建会话时传入的线程必须是长期存活的渲染或逻辑线程，系统会观察这些线程的负载模式。API 的时间单位是纳秒，所以毫秒值要乘 1_000_000。目标时长是核心输入：16ms 对应 60 帧，22ms 对应 45 帧，33ms 对应 30 帧。热状态变化时动态调整目标：

```kotlin
fun adaptToThermal(headroom: Float, status: Int) {
    val target = when {
        status >= PowerManager.THERMAL_STATUS_SEVERE -> 33L
        headroom >= 0.7f -> 22L
        else -> 16L
    }
    hintSession.updateTargetWorkDuration(target * 1_000_000L)
}
```

有一个容易忽略的点：`updateTargetWorkDuration` 不是改渲染线程的等待时间，它改的是系统对这批线程的频率与核心选择预期。真正的降载还是要渲染器同步把帧预算降下来，两边对齐才有效。

## 定基线：Game Mode 是策略入口

Game Mode API 是 ADPF 里偏向用户策略的一层。玩家在系统界面选"性能模式"或"省电模式"后，应用通过 `GameManager` 读取：

```kotlin
val gameManager = context.getSystemService(GameManager::class.java)
val baseBudget = when (gameManager.gameMode) {
    GameManager.GAME_MODE_PERFORMANCE -> 16L
    GameManager.GAME_MODE_BATTERY -> 33L
    else -> 22L
}
```

我倾向于把 Game Mode 作为基线，而不是热状态下的自动开关。性能模式给 16ms 的目标，省电模式直接给 33ms；热状态在这个基线上做收紧。不要反过来在过热时调用 `setGameMode` 切换系统模式，部分厂商会弹确认框，而且用户明确选的模式不该被应用偷偷改写。

## 串起来后的三个落地点

把三套 API 串起来后，我项目里的调度逻辑收敛成一条：

```kotlin
fun onFrameStart() {
    val modeBudget = gameModeBudget(gameManager.gameMode)
    val headroom = pm.getThermalHeadroom(0)
    val status = pm.currentThermalStatus

    val budget = when {
        status >= PowerManager.THERMAL_STATUS_SEVERE -> 33L
        headroom >= 0.7f -> 22L
        else -> modeBudget
    }

    if (budget != lastBudget) {
        hintSession.updateTargetWorkDuration(budget * 1_000_000L)
        renderer.applyQualityByBudget(budget)
        lastBudget = budget
    }
}
```

实际落地有 3 条经验。第一，**headroom 要采样，不要只在回调里读**：状态回调在部分设备上过慢，按 1 秒周期采样 headroom 反而更稳。第二，**预算和画质必须同时降**：只改 `updateTargetWorkDuration` 不改渲染负载，等于让系统追着一个不存在的帧预算跑。第三，**用 22ms 做中间档**：直接 60 跳 30 会带来肉眼可见的顿挫，45 帧的中间态让玩家更不容易察觉性能回收。
