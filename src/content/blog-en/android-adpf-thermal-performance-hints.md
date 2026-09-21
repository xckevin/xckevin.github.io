---
title: 'Adaptive Performance Scheduling with Android ADPF: From Thermal API to Performance Hints'
lang: en
translationKey: android-adpf-thermal-performance-hints
slug: android-adpf-thermal-performance-hints
excerpt: How Android's Dynamic Performance Framework connects Thermal API, Performance Hints, and Game Mode to shed load before thermal throttling and flatten the frame-drop curve.
publishDate: '2026-08-16'
tags:
- Android
- Kotlin
- ADPF
- Performance
- Frame Rate
seo:
  title: 'Android ADPF: Adaptive Performance Scheduling via Thermal & Hints'
  description: 'A practical Android ADPF walkthrough: Thermal API for headroom, Performance Hints for frame budget, Game Mode as baseline to shed load before throttling.'
  pageType: article
---

In a 3D game I locked the frame rate to 60, yet the render thread's frame interval still suddenly jumped from 16ms to 30–40ms. Checking the trace showed CPU frequency falling off a cliff, with no logic changes in the code. This is thermal throttling: once the chip temperature crosses a threshold, the scheduler drops the frequency first and recovers later — throughout the whole process the app layer can only take the hit.

ADPF (Android Dynamic Performance Framework) connects three capabilities: the Thermal API reports thermal state and headroom, the Performance Hint API lets the system tune frequency according to a target frame budget, and the Game Mode API provides a user-level performance orientation. Working together, these three let an app proactively shed load before thermal throttling kicks in, flattening the frame-drop curve.

## Sensing First: Thermal State and Thermal Headroom

The Thermal API has two layers. The first is state listening; `PowerManager` provides multiple levels from `THERMAL_STATUS_NONE` to `THERMAL_STATUS_SHUTDOWN`:

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

The downside of this callback is that it is **event-driven**: it only fires when a threshold is crossed, and on many devices the state transitions are coarse — after LIGHT it may jump straight to SEVERE. Using it for load shedding usually means the action is already one beat late.

The second layer, `getThermalHeadroom`, answers "will it get hot in the future":

```kotlin
val headroom = pm.getThermalHeadroom(forecastSeconds = 10)
if (!headroom.isNaN() && headroom >= 0.7f) {
    renderer.enableLowPowerPath()
}
```

`headroom` is a headroom estimate that starts from 0 and may exceed 1.0: the closer to or above 1.0, the closer to severe thermal throttling — a danger signal; the closer to 0, the more sufficient the cooling headroom and the safer the device. Passing 0 for `forecastSeconds` returns the current value, and passing 10 returns a 10-second forecast. The forecast depends on the vendor implementation; returning `NaN` means it is unsupported. I verified on a Pixel and several domestic flagship phones that the 10-second forecast can basically cover the temperature rise of a high-load scenario in advance, arriving 3–5 seconds earlier than the state callback.

## Then Execute: Aligning Frequency with Performance Hints

After sensing heat, load shedding can't just change visual quality. If the scheduler keeps misjudging the render thread's real cost, the system may still be boosting CPU frequency toward a 60-frame high-load target, diluting the effect of load shedding.

`PerformanceHintManager` provides a session mechanism that lets the app tell the system "what my budget is for the next frame and how much it actually cost":

```kotlin
val hintManager = context.getSystemService(PerformanceHintManager::class.java)
val session = hintManager.createHintSession(
    intArrayOf(renderThread.id, gameThread.id),
    16L * 1_000_000L
)

// 每帧渲染结束后上报实际耗时
session.reportActualWorkDuration(actualFrameCostMillis * 1_000_000L)
```

The threads passed when creating the session must be long-lived render or logic threads; the system observes the load patterns of these threads. The API's time unit is nanoseconds, so millisecond values must be multiplied by 1_000_000. The target duration is the core input: 16ms corresponds to 60 frames, 22ms to 45 frames, and 33ms to 30 frames. Adjust the target dynamically as thermal state changes:

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

One easy-to-miss point: `updateTargetWorkDuration` does not change the render thread's wait time; it changes the system's expectation for the frequency and core selection of these threads. Real load shedding still requires the renderer to lower the frame budget in sync; the two sides must be aligned to be effective.

## Setting the Baseline: Game Mode as the Policy Entry Point

The Game Mode API is the user-policy-leaning layer of ADPF. After the player selects "Performance mode" or "Battery saver mode" in system settings, the app reads it via `GameManager`:

```kotlin
val gameManager = context.getSystemService(GameManager::class.java)
val baseBudget = when (gameManager.gameMode) {
    GameManager.GAME_MODE_PERFORMANCE -> 16L
    GameManager.GAME_MODE_BATTERY -> 33L
    else -> 22L
}
```

I tend to treat Game Mode as a baseline rather than an automatic switch under thermal state. Performance mode gets a 16ms target, and battery saver mode gets 33ms directly; thermal state tightens on top of this baseline. Don't do the reverse — calling `setGameMode` to switch the system mode when overheating: some vendors pop up a confirmation dialog, and a mode the user explicitly chose should not be secretly rewritten by the app.

## Three Practical Landing Points After Wiring It Together

After wiring the three APIs together, the scheduling logic in my project converged into a single path:

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

In practice there are three lessons. First, **sample headroom instead of reading it only in the callback**: on some devices the state callback is too slow, and sampling headroom on a 1-second cadence is actually more stable. Second, **budget and quality must be lowered together**: changing only `updateTargetWorkDuration` without changing the render load is like making the system chase a frame budget that doesn't exist. Third, **use 22ms as the middle tier**: jumping straight from 60 to 30 causes visible stutter, while the 45-frame intermediate state makes it harder for players to notice the performance reclaim.
