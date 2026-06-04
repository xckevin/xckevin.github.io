---
title: "Android On-device AI System Health: Dynamic Inference Degradation by Thermal, Battery, and Memory Pressure"
lang: en
translationKey: android-on-device-ai-system-health
slug: android-on-device-ai-system-health
excerpt: "A practical three-dimensional degradation strategy for Android on-device AI inference, coordinating thermal status, battery state, and memory pressure with normalized scoring, model preloading, and state migration."
publishDate: '2026-04-27'
tags:
- "Android"
- "On-device AI Inference"
- "Performance Optimization"
- "Memory Management"
- "Degradation Strategy"
seo:
  title: "Android On-device AI Degradation by Thermal, Battery, and Memory Pressure"
  description: "Coordinate Android on-device AI inference across thermal, battery, and memory pressure with adaptive degradation, model preloading, and state migration."
  pageType: article
---

When landing on-device AI inference in production, I ran into a classic failure mode: the model looked smooth in the lab, then collapsed after a few minutes on real phones. Logcat showed `OOM` and `thermal throttle`, and users simply killed the app.

The core difference between on-device inference and cloud inference is this: **the device is not an unlimited resource pool**. CPU thermal throttling, memory pressure and process kills, and low-battery background restrictions are often treated as deployment details. In production, they become the traps.

## Three-dimensional modeling

### Thermal state: the earliest warning, and the easiest one to ignore

Android's thermal mechanism has several levels, from `STATUS_NONE` to `STATUS_CRITICAL`. Many apps only react at `STATUS_CRITICAL`, but by `STATUS_MODERATE` the SoC has usually started reducing frequency. If you wait for the severe warning, you are already late.

Use `PowerManager.addThermalStatusListener` for real-time callbacks instead of polling:

```kotlin
powerManager.addThermalStatusListener { status ->
    when (status) {
        PowerManager.THERMAL_STATUS_MODERATE -> adjustFps(8)
        PowerManager.THERMAL_STATUS_SEVERE -> adjustFps(3)
        PowerManager.THERMAL_STATUS_CRITICAL -> suspendInference()
    }
}
```

Start degrading at `MODERATE`. Reducing inference frame rate, for example from 15 fps to 8 fps and then 3 fps, is much better than freezing or crashing. Users may interpret the lower frame rate as "slightly less smooth." A crash makes them give up.

### Battery: hidden constraints in power-save mode

After power-save mode turns on, the system does more than lower CPU frequency. It can delay `JobScheduler` work and constrain foreground service execution windows. Many inference engines also have their thread priority silently adjusted by the system, with no obvious signal to your code.

```kotlin
val batteryPct = batteryManager.getIntProperty(
    BatteryManager.BATTERY_PROPERTY_CAPACITY)
val isSaverOn = powerManager.isPowerSaveMode

if (isSaverOn || batteryPct < 15) {
    switchToLiteModel()
}
```

One trap I hit: `isPowerSaveMode` is inaccurate on some customized ROMs. In production, combine it with the `ACTION_POWER_SAVE_MODE_CHANGED` broadcast as a second check. Otherwise, on some Xiaomi, OPPO, or vivo devices, power-save mode may be enabled while your code still thinks it is off.

The degradation order for battery pressure matters: **turn off nonessential post-processing first** such as beautification or super-resolution, **then switch to a smaller model**, and **only then lower frame rate**. Remove low-value compute before touching the core inference experience. Reverse that order and users feel the quality drop immediately.

### Memory: the hardest silent killer

Model loading can consume hundreds of megabytes, and intermediate tensors during inference can allocate hundreds more. On a 6 GB RAM device, that is enough to trigger LMK. Android's Low Memory Killer does not distinguish between an "important inference task" and "a reclaimable background page." To LMK, both are killable.

For memory pressure, I do not rely on the system-level `lowMemory` signal because it arrives too late:

```kotlin
val runtime = Runtime.getRuntime()
val usedMem = runtime.totalMemory() - runtime.freeMemory()
val availMem = runtime.maxMemory() - usedMem

if (availMem < 200 * 1024 * 1024L) {
    triggerMemoryDegradation()
}
```

Use runtime available heap memory as the signal, with the threshold set to about 1.5x the model's peak memory requirement. By the time `lowMemory` arrives, you may already be at OOM. Active monitoring lets you degrade before memory reaches the danger line. That gap may only be tens of seconds, but it is enough to save the session.

## Strategy engine: arbitration across dimensions

Each dimension is straightforward in isolation. The harder question is what to do when thermal and memory pressure fire at the same time. You need an arbitration layer.

```kotlin
data class InferenceConfig(
    val modelType: ModelType,     // FULL / LITE / TINY
    val targetFps: Int,
    val postEffects: Set<String>  // Post-processing switches
)

fun evaluate(dims: Map<String, Float>): InferenceConfig {
    val minScore = dims.values.minOrNull() ?: 1.0f
    return when {
        minScore >= 0.8f -> fullConfig()
        minScore >= 0.5f -> balancedConfig()
        minScore >= 0.2f -> lowPowerConfig()
        else -> minimalConfig()
    }
}
```

Each dimension outputs a normalized score from 0 to 1, and **the global strategy is decided by the minimum score**. The barrel principle applies directly here: if any dimension becomes the bottleneck, the whole inference pipeline should degrade. Otherwise, you get the awkward situation where memory is already near the danger line, thermal state looks normal, and the app keeps running the large model anyway.

Measured result: on Snapdragon 7-series devices with 6 GB RAM, the app hit OOM after 8-12 minutes without this strategy. With three-level degradation, it ran steadily for more than 30 minutes while keeping temperature below 42°C.

## Engineering details of model switching

The degradation path needs multiple models ready: full precision or FP16, quantized INT8, and a distilled model. Two details are easy to miss during switching.

**Preload models. Do not load from disk at the moment of degradation.** Loading a model after a thermal warning consumes CPU and can make heat worse:

```kotlin
val models = mapOf(
    ModelType.FULL  to Interpreter(loadBuffer("full.tflite")),
    ModelType.LITE  to Interpreter(loadBuffer("lite.tflite")),
    ModelType.TINY to Interpreter(loadBuffer("tiny.tflite"))
)
```

The cost is an extra 50-80 MB of resident memory. On devices with 6 GB or more, that is acceptable. On 4 GB devices, use `mmap` as a compromise: the system can reclaim clean physical pages under memory pressure and fault them back in when accessed.

**Do not lose temporal state.** In video-stream inference, when switching models, you cannot simply discard the previous frame's detection box history, tracking IDs, or other temporal state. I smooth the transition frame by interpolating from the previous result. It is only a few lines of code, but without it users see obvious flicker. That feels worse than a lower frame rate.

## Judgments after shipping

1. **Three degradation levels are enough.** Five or six levels usually do not help. Maintenance cost rises, and frequent switching can introduce instability. Full, balanced, and minimal cover roughly 95% of real cases.

2. **Production telemetry matters more than threshold tuning.** I spent a lot of time tuning thresholds, then found that the bigger missing piece was knowing which strategy production devices actually used. Report the trigger reason and current device state on every degradation event. Without that loop, you do not know whether a user really ran in minimal mode or crashed before degradation fired.

3. **Give users a manual switch.** In some situations, such as recording an important video or livestreaming, users would rather accept heat than degradation. A "performance first / battery first" switch is more accurate than asking the strategy engine to guess. The machine can make the default choice; the user should keep the final say.

The bottleneck for Android on-device AI inference is often not model accuracy. It is whether the model can keep running. Three-dimensional coordinated degradation is essentially **availability engineering**: avoid collapse first, then optimize for quality.
