---
title: 'Deep Dive into Android''s Haptic Feedback System: From VibrationEffect Waveform Synthesis to Vibrator HAL Haptic Design Engineering Practice'
lang: en
translationKey: android-haptics-vibrationeffect-vibrator-hal
slug: android-haptics-vibrationeffect-vibrator-hal
excerpt: From VibrationEffect waveform synthesis and VibratorManager scheduling to HAL drivers, dissect Android's haptic feedback chain and summarize haptic design engineering practices under power-save mode.
publishDate: '2026-08-20'
tags:
- Android
- Kotlin
- Haptics
- HAL
- Architecture Design
seo:
  title: 'Android Haptics Full Chain: VibrationEffect to Vibrator HAL'
  description: 'A deep dive into Android''s haptic chain: VibrationEffect waveform synthesis, VibratorManager scheduling, HAL drivers, and power-save design practices.'
  pageType: article
---

While building haptic feedback for an input method, I ran into a problem: the same `VibrationEffect` produced a crisp vibration in normal mode, but went completely silent in power-save mode. Tracing the call stack all the way down to the HAL, I realized haptic feedback is not just "call an API and it vibrates" — it's layered across waveform synthesis, vibration scheduling, permission checks, and power-save policy.

## VibrationEffect: A Waveform Is Not an Audio Clip

When first working with vibration, most people write code like this:

```kotlin
val vibrator = context.getSystemService(Vibrator::class.java)
vibrator.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE))
```

`createOneShot` produces an 80 ms vibration at a fixed intensity. It gets the job done, but it can't express compound haptics like "light-strong-light." The VibrationEffect introduced in Android 8.0 is essentially a **waveform description protocol** that breaks haptics into three composable atomic structures:

- **Waveform**: an array of timestamps plus amplitudes, describing how amplitude changes over time
- **Predefined**: built-in system effects such as `EFFECT_CLICK` and `EFFECT_DOUBLE_CLICK`
- **Composed**: complex effects choreographed from `Primitive` primitives, supporting delays and repetition

Waveform composition is the most straightforward:

```kotlin
val timings = longArrayOf(0, 60, 100)   // 第 0ms 起步，第 60ms 到下一档，第 100ms 结束
val amplitudes = intArrayOf(0, 255, 0) // 0 -> 满幅 -> 0
VibrationEffect.createWaveform(timings, amplitudes, -1) // -1 表示不循环
```

There's an easy mistake here: `timings` and `amplitudes` must have the same length, the amplitude range is 1 to 255, and **0 means the motor stops at that moment — it is not a "mute level."** To express "pause then vibrate again," keep the amplitude at 0 across the pause interval, meaning two consecutive control points are both 0, rather than inserting a zero-duration segment.

`Composed` is suited to designing rhythmic haptics. The `Composition` API introduced in Android 12 uses primitives to describe basic haptic units: `PRIMITIVE_CLICK` is a short click feel, `PRIMITIVE_TICK` is lighter, and `PRIMITIVE_LOW_TICK` is an even weaker light tap, close to the micro-vibration of a physical key.

```kotlin
val effect = VibrationEffect.startComposition()
    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 1.0f, 0)
    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 1.0f, 80)
    .compose()
```

In my current project, the confirm key uses `CLICK`, scroll snapping uses `TICK`, and error prompts use `DOUBLE_CLICK` plus a 40 ms waveform. Primitives are tuned by vendors on different devices, so hand-feel consistency is much better than with raw waveforms.

## From Vibrator to the VibratorManager Scheduling Layer

If you've written code for versions before Android 12, you'll notice `Vibrator` was split into another layer. What you actually get from `getSystemService(Vibrator::class.java)` is the default Vibrator returned by `VibratorManager`.

This split is not just a refactor. Starting with Android 12, **multi-motor devices** are supported: one `VibratorManager` manages multiple `Vibrator` instances, each corresponding to a physical motor. The scheduling layer has three things to handle:

First, parse vibration attributes (VibrationAttributes). A vibration must not only describe its waveform but also tell the system "what scenario this vibration belongs to":

```kotlin
val attrs = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM)
vibrator.vibrate(effect, attrs)
```

Usage values like `USAGE_ALARM`, `USAGE_NOTIFICATION`, and `USAGE_TOUCH` directly affect interception policy in power-save mode and Do Not Disturb mode. When this parameter is omitted, the default is `USAGE_UNKNOWN`, which has a high chance of being dropped by the system.

Second, merging and preemption. The system maintains a vibration request queue that merges short vibrations, and new requests interrupt ongoing ones. In haptic-dense scenarios (like continuous keystrokes in an input method), calling `vibrate` frequently causes the motor to start and stop repeatedly, producing a "buzzing" trailing feel.

Third, permissions and background restrictions. The `VIBRATE` permission is only the first gate; in power-save mode the system directly drops vibrations from background apps, and foreground services must declare a reasonable usage via `VibrationAttributes` to be kept.

I actually stepped into this pit in a real project: push notifications stopped vibrating after the screen locked. Investigation revealed that the notification channel's `VibrationAttributes` used `USAGE_UNKNOWN`, and the system filtered it out once it entered power-save mode. Changing it to `USAGE_NOTIFICATION` restored normal behavior.

## The HAL Layer: How a Waveform Becomes Motor Motion

After leaving the framework, vibration requests are dispatched to the HAL via `IVibratorManagerService`. Before Android 11 this was the `IVibrator` HIDL interface; Android 12 migrated to AIDL. The core capabilities are largely unchanged, with the main addition being support for `Composition`.

The most critical abstraction on the HAL side is converting a waveform into motor drive signals. Taking `createWaveform` as an example, what the framework passes down is a "timestamp + amplitude" array, and the HAL is responsible for:

- Interpolating the amplitude array into a continuous PWM (pulse-width modulation) duty-cycle sequence
- Selecting a drive strategy based on motor type (ERM eccentric rotating mass motor or LRA linear resonant actuator)
- Handling braking logic so the motor stops quickly after the waveform ends

There's an easily overlooked detail here: **LRA motors have a resonant frequency.** ERM controls intensity through rotation speed, and speed maps linearly to amplitude; LRA relies on resonance, reaching peak efficiency when the drive frequency is near the resonant frequency (typically 150-250 Hz). So after receiving the amplitude array, the HAL doesn't simply scale the PWM duty cycle — it keeps the frequency constant and adjusts the drive voltage.

```cpp
// HAL 侧典型处理：把 amplitude 映射为 LRA 驱动电压
float drive_voltage = amplitude_to_voltage(amplitude, lra_config);
// 频率固定在谐振点附近，只调幅度
set_lra_drive(lra_config.resonant_freq_hz, drive_voltage);
```

This is also why the same waveform feels dramatically different across devices. **The HAL is implemented separately by each SoC vendor and ODM**, and the interpolation algorithms, braking strategies, and LRA tuning parameters are not unified. When designing haptics and pursuing cross-device consistency, prefer `Predefined` effects or `Primitive`, and leave waveform details to vendor tuning.

## Power-Save Constraints and Haptic Design Engineering Practice

Back to the silence problem from the beginning. Power-save mode intercepts vibrations at two places:

- Framework layer: `VibratorManagerService` filters vibration requests with low-priority usage based on `PowerManager`'s power-save state
- HAL layer: some devices perform a second interception in the HAL, directly ignoring vibrations in power-save state

So power-save mode doesn't "reduce vibration intensity" — it **selectively drops** requests. The framework-layer interception logic is roughly:

```java
// VibratorManagerService 中的简化逻辑
if (powerSaveMode && !isHighPriorityUsage(attrs.getUsage())) {
    return; // 直接丢弃，不进入 HAL
}
```

High-priority usage typically includes `USAGE_ALARM`, `USAGE_RINGTONE`, and some `USAGE_NOTIFICATION` scenarios. The system generally filters out `USAGE_TOUCH` and `USAGE_UNKNOWN`.

Based on this chain, I've distilled several practices in my projects:

1. **Explicitly declare usage for every vibration request** instead of relying on defaults. Use `USAGE_TOUCH` for haptic feedback, but accept that it may be dropped by the system in power-save mode; use `USAGE_NOTIFICATION` for notifications and `USAGE_ALARM` for alarms.
2. **Prefer composing primitives with `VibrationEffect.Composition`** rather than hand-writing waveform arrays. Vendor tuning for primitives is usually more stable than waveform interpolation, giving better cross-device consistency.
3. **Use `hasVibrator()` and `arePrimitivesSupported()` for capability detection** instead of assuming all devices support composite primitives. Fall back to `createOneShot` or waveforms on older devices.

The haptic feedback chain is easy to underestimate. From waveform description and scheduling management to HAL drivers, every layer makes trade-offs: the framework governs policy, the HAL governs physics, and between them lies the variance of vendor implementations. When designing haptics, thinking clearly about "what scenario this vibration belongs to" is more effective than obsessing over waveform parameters.
