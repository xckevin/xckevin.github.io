---
title: 深入 Android 触觉反馈系统全链路：从 VibrationEffect 波形合成到 Vibrator HAL 的触感设计工程实践
excerpt: 从 VibrationEffect 波形合成、VibratorManager 调度到 HAL 驱动，拆解 Android 触觉反馈全链路，并总结省电模式下的触感设计工程实践。
publishDate: '2026-08-20'
tags:
- Android
- Kotlin
- 触觉反馈
- HAL
- 架构设计
seo:
  title: 深入 Android 触觉反馈系统全链路：从 VibrationEffect 波形合成到 Vibrator HAL 的触感设计工程实践
  description: 深入 Android 触觉反馈全链路：解析 VibrationEffect 波形合成、VibratorManager 调度、HAL 驱动与省电约束，分享触感设计工程实践。
---

做输入法震动反馈时遇到过一个问题：同一个 `VibrationEffect`，普通模式下震动清脆，开了省电模式却直接静默。顺着调用栈一路追到 HAL，才发现触觉反馈不是"调个 API 就震"，中间隔着波形合成、震动调度、权限校验、省电策略四层。

## VibrationEffect：波形不是一段音频

第一次接触震动，多数人会写这样的代码：

```kotlin
val vibrator = context.getSystemService(Vibrator::class.java)
vibrator.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE))
```

`createOneShot` 生成一段持续 80 ms、固定强度的震动。它够用，但表达不了"轻-重-轻"这类复合触感。Android 8.0 引入的「震动效果（VibrationEffect）」本质上是一套**波形描述协议**，把触感拆成三种可组合的原子结构：

- **Waveform（波形）**：一组时间戳加振幅的数组，描述振幅随时间变化
- **Predefined（预定义）**：系统内置效果，如 `EFFECT_CLICK`、`EFFECT_DOUBLE_CLICK`
- **Composed（组合）**：用 `Primitive` 原语编排的复杂效果，支持延迟和重复

Waveform 的合成最直观：

```kotlin
val timings = longArrayOf(0, 60, 100)   // 第 0ms 起步，第 60ms 到下一档，第 100ms 结束
val amplitudes = intArrayOf(0, 255, 0) // 0 -> 满幅 -> 0
VibrationEffect.createWaveform(timings, amplitudes, -1) // -1 表示不循环
```

这里有个容易出错的地方：`timings` 和 `amplitudes` 长度必须一致，振幅范围 1 到 255，**0 代表马达在那一时刻停止，不是"静音档"**。想表达"停一下再震"，要让振幅在暂停区间内保持 0，也就是连续两个控制点都写 0，不能靠插入时长为 0 的片段。

`Composed` 适合设计有节奏的触感。Android 12 引入的 `Composition` API 用「原语（Primitive）」描述基础触感单元：`PRIMITIVE_CLICK` 是短促的点击感，`PRIMITIVE_TICK` 更轻，`PRIMITIVE_LOW_TICK` 是更弱的轻触，接近实体按键的微震。

```kotlin
val effect = VibrationEffect.startComposition()
    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 1.0f, 0)
    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, 1.0f, 80)
    .compose()
```

我现在的项目里，确认键用 `CLICK`，滚动吸附用 `TICK`，错误提示用 `DOUBLE_CLICK` 加一段 40 ms 的波形。原语在不同设备上由厂商调校，手感一致性比纯波形好得多。

## 从 Vibrator 到 VibratorManager 的调度层

如果写过 Android 12 之前的版本，会发现 `Vibrator` 被拆了一层。直接 `getSystemService(Vibrator::class.java)` 拿到的，其实是 `VibratorManager` 返回的默认 Vibrator。

这个拆分不是单纯的重构。Android 12 起支持**多马达设备**，一个 `VibratorManager` 管理多个 `Vibrator`，每个 `Vibrator` 对应一个物理马达。调度层要处理三件事：

第一，解析震动属性（VibrationAttributes）。震动不只要描述波形，还要告诉系统"这个震动属于什么场景"：

```kotlin
val attrs = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM)
vibrator.vibrate(effect, attrs)
```

`USAGE_ALARM`、`USAGE_NOTIFICATION`、`USAGE_TOUCH` 这些 usage 值直接影响省电模式和勿扰模式下的拦截策略。不传这个参数时默认是 `USAGE_UNKNOWN`，被系统丢弃的概率很高。

第二，合并与抢占。系统维护一个震动请求队列，会合并短震动，新请求会打断正在进行的震动。在触觉密集型场景（比如输入法连续按键）里，频繁调用 `vibrate` 会让马达反复启停，产生"嗡嗡"的拖尾感。

第三，权限与后台限制。`VIBRATE` 权限只是第一道门，省电模式下系统会直接丢弃后台应用的震动，前台服务也要通过 `VibrationAttributes` 声明合理 usage 才能保留。

实际项目里我就踩过这个坑：推送通知在锁屏后不震动，排查发现通知渠道的 `VibrationAttributes` 用了 `USAGE_UNKNOWN`，系统进入省电模式后直接把它过滤了。改成 `USAGE_NOTIFICATION` 后恢复正常。

## HAL 层：波形如何变成马达运动

离开 framework 之后，震动请求通过 `IVibratorManagerService` 下发到 HAL。Android 11 之前是 `IVibrator` HIDL 接口，Android 12 迁移到 AIDL，核心能力变化不大，主要多了对 `Composition` 的支持。

HAL 侧最关键的抽象，是把波形转换成马达驱动信号。以 `createWaveform` 为例，framework 传下来的是"时间戳 + 振幅"数组，HAL 要负责：

- 把振幅数组插值成连续的 PWM（脉冲宽度调制）占空比序列
- 根据马达类型（ERM 偏心旋转马达或 LRA 线性谐振马达）选择驱动策略
- 处理刹车（braking）逻辑，让马达在波形结束后快速停住

这里有个容易被忽略的细节：**LRA 马达有谐振频率**。ERM 靠转速控制强度，转速线性对应振幅；LRA 靠共振，驱动频率接近谐振频率（通常 150-250 Hz）时效率最高。所以 HAL 拿到振幅数组后，不是简单缩放 PWM 占空比，而是保持频率不变，调节驱动电压。

```cpp
// HAL 侧典型处理：把 amplitude 映射为 LRA 驱动电压
float drive_voltage = amplitude_to_voltage(amplitude, lra_config);
// 频率固定在谐振点附近，只调幅度
set_lra_drive(lra_config.resonant_freq_hz, drive_voltage);
```

这也是为什么同一个波形在不同设备上触感差异巨大。**HAL 由 SoC 厂商和 ODM 各自实现**，插值算法、刹车策略、LRA 调校参数都不统一。做触感设计时如果追求跨设备一致性，优先用 `Predefined` 效果或 `Primitive`，把波形细节交给厂商调校。

## 省电约束与触感设计的工程实践

回到开头的静默问题。省电模式对震动的拦截发生在两个位置：

- framework 层：`VibratorManagerService` 根据 `PowerManager` 的省电状态，过滤低优先级 usage 的震动请求
- HAL 层：部分设备在 HAL 里做二次拦截，直接忽略省电状态下的震动

所以省电模式不是"降低震动强度"，而是**选择性丢弃**。框架层的拦截逻辑大致是：

```java
// VibratorManagerService 中的简化逻辑
if (powerSaveMode && !isHighPriorityUsage(attrs.getUsage())) {
    return; // 直接丢弃，不进入 HAL
}
```

高优先级 usage 通常包括 `USAGE_ALARM`、`USAGE_RINGTONE` 和 `USAGE_NOTIFICATION` 的一部分场景，系统基本会过滤掉 `USAGE_TOUCH` 和 `USAGE_UNKNOWN`。

基于这条链路，我在项目里沉淀了几条实践：

1. **每个震动请求都显式声明 usage**，不要依赖默认值。触感反馈用 `USAGE_TOUCH`，但要接受它在省电模式下可能被系统丢弃；通知用 `USAGE_NOTIFICATION`，闹钟用 `USAGE_ALARM`。
2. **优先使用 `VibrationEffect.Composition` 组合原语**，而不是手写波形数组。厂商对原语的调校通常比波形插值更稳定，跨设备一致性好。
3. **用 `hasVibrator()` 和 `arePrimitivesSupported()` 做能力检测**，不要假设所有设备都支持组合原语。低版本设备回退到 `createOneShot` 或波形。

触觉反馈这条链路容易被低估，从波形描述、调度管理到 HAL 驱动，每一层都在做取舍：framework 管策略，HAL 管物理，中间隔着的是厂商实现差异。设计触感时，把"这个震动属于什么场景"想清楚，比纠结波形参数更有效。
