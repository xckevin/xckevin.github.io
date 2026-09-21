---
title: 深入 Android 屏幕刷新率动态切换与 LTPO 适配全链路：从 DisplayManager 帧率策略到 Choreographer VSYNC 自适应调度
excerpt: 深入剖析 Android 刷新率动态切换的底层机制，详解 DisplayModeDirector 投票仲裁规则、LTPO 面板 DDIC 影子调度及 Choreographer VSYNC 自适应策略，提供实战验证的三级帧率管理方案。
publishDate: '2026-07-23'
tags:
- Android
- LTPO
- 性能优化
- 帧率管理
- Choreographer
seo:
  title: 深入 Android 屏幕刷新率动态切换与 LTPO 适配全链路：从 DisplayManager 帧率策略到 Choreographer VSYNC 自适应调度
  description: 深入剖析 Android 屏幕刷新率动态切换全链路机制，从 DisplayModeDirector 投票仲裁到 LTPO 面板 DDIC 影子调度，详解 Choreographer VSYNC 自适应策略及实战帧率管理方案。
---

在做视频播放器的性能优化时，遇到了一个诡异的现象：同一台 120Hz LTPO 设备上，我们的播放器始终锁在 60Hz，但 YouTube 在滑动列表时能流畅跑到 120Hz。当时的第一反应是漏掉了某个 API 调用——结果发现，问题远比想象中复杂。

## 为什么设置了 preferredRefreshRate 还是掉回 60Hz

第一版代码很直接：

```kotlin
window.attributes.preferredDisplayModeId = display.supportedModes
    .find { it.refreshRate == 120f }?.modeId ?: 0
```

这个设置只在"没有其他约束"时生效。一旦页面中存在 Camera2 预览或 MediaCodec 输出的 SurfaceView，帧率立刻跌回 60Hz。不是 SurfaceView 有问题，而是系统内部的帧率仲裁机制把你的偏好投票压过了。

Android 的帧率决策是一个多方博弈的结果：

- **应用层** 通过 `preferredDisplayModeId` 声明偏好，属于优先级较低的投票源
- **SurfaceFlinger** 扫描所有可见 Layer 的实际帧提交速率，推算出"内容帧率"
- **DisplayModeDirector** 汇总各路投票源，按优先级从高到低求交集来仲裁最终刷新率范围
- **LTPO 面板的 DDIC** 在系统给定的刷新率范围内，可以在硬件层做进一步的精细调节

你设了 120Hz，但如果 Camera2 的 BufferQueue 稳定在 30fps，SurfaceFlinger 就会投给低帧率区间，最终结果可能是 60Hz。

## DisplayModeDirector 的投票架构与仲裁规则

Android 11 重构了帧率管理，核心是把各个影响因素抽象为"投票（Vote）"，由 `DisplayModeDirector` 汇总计算。每个投票都带有一个预定义的固定优先级（例如触摸/UDFPS 优先级高于普通的 App 请求，App 请求又高于默认渲染帧率），并产出一个可接受的刷新率区间。仲裁规则不是简单的"取下限最大值"，而是**按优先级从高到低依次收窄区间**：从最高优先级开始，把各优先级的区间依次求交集；一旦交出的区间变成空集，就丢弃当前参与仲裁的最低优先级投票，从下一档优先级重新求交集，直到得到一个非空的可用区间为止。换句话说，高优先级的投票（如指纹解锁场景的 UDFPS 请求）几乎总能覆盖低优先级的投票（如应用的 `preferredDisplayModeId`），而不是单纯比较数值大小。

**内容帧率投票**——SurfaceFlinger 持续追踪每个 Layer 的 dequeueBuffer 间隔。如果某 Layer 连续 500ms 没提交新帧，帧率估算为 0（表示"无所谓"）；如果间隔稳定在 16ms，估算为 60fps。这个投票源在视频播放场景下杀伤力最大。

**亮度与温度投票**——低亮度下，OLED 面板在 120Hz 驱动时 MURA（显示不均）问题更明显，系统会降级到 60Hz。温度过高同理，高温加速面板老化，系统会主动限频。

**触摸升频投票**——手指按下瞬间，InputManager 通过 `IDisplayManager.aidl` 发出临时升频请求，覆盖内容帧率的低帧率投票，直到手指抬起后一段时间才释放（具体延迟时长因设备厂商定制而异，并非固定值）。这就是为什么即使视频播着 24fps，滑动进度条时屏幕依然能飙到 120Hz。

**应用偏好投票**——也就是你调用的 `preferredDisplayModeId`。它的优先级最低，只在其他投票源没有约束时被采纳。

实际项目中踩过的一个坑：CameraX 的 PreviewView 在 PERFORMANCE 模式下内部用的是 SurfaceView，它有独立的 BufferQueue，帧率投票会被 SurfaceFlinger 单独统计。解决方案不是去关掉 Camera 的帧率投票（你也关不掉），而是在不需要高帧率的场景下主动降级，让系统信任你的 AUTO 模式选择。

## Choreographer 的 VSYNC 自适应

帧率切换后，Choreographer 会根据新的 VSYNC 周期自动调整 `doFrame` 的调用节奏。这个过程在 Framework 层完全透明，但应用层有一个容易忽略的陷阱。

在 LTPO 面板从 120Hz 降到 10Hz 做静态显示时，VSYNC 周期从 8.3ms 拉长到 100ms。如果你的动画计算用了固定步长：

```kotlin
// ❌ 错误：假设帧间隔固定
fun doFrame(frameTimeNanos: Long) {
    x += velocityX * 16f  // 写死的 16ms
}
```

在 10Hz 模式下，每次 `doFrame` 间隔实际是 100ms，画面会严重跳帧。正确做法是用 `frameTimeNanos` 计算真实 delta：

```kotlin
// ✅ 正确：取真实时间增量
private var lastFrameTime = 0L

override fun doFrame(frameTimeNanos: Long) {
    val deltaMs = if (lastFrameTime == 0L) 16f
        else (frameTimeNanos - lastFrameTime) / 1_000_000f
    lastFrameTime = frameTimeNanos
    updateAnimation(deltaMs)
    Choreographer.getInstance().postFrameCallback(this)
}
```

另一个容易误用的点是 `Choreographer.getVsyncId()`。它的返回值是 VSYNC 的序列号，在 LTPO 面板自主降频期间，这个序列号可能长时间不增长——不要用它来做时间戳推算。

## LTPO 面板的硬件层"影子调度"

LTPO（Low-Temperature Polycrystalline Oxide）与传统 LTPS 的本质区别：LTPS 只能在几个固定档位间切换（60/90/120Hz），LTPO 支持 1Hz～120Hz 的连续调节，代价是栅极驱动电路更复杂，漏电流控制要求更高。

Android 对 LTPO 的适配分软硬件两层：

**软件层：IdleTimer 降频**

AOSP 在 `DisplayModeDirector` 中维护一个 idle timer。当一段时间内没有新帧提交，系统判断进入静态内容期，主动将刷新率降到面板支持的最低值（具体的静止判定时长可由设备厂商配置，并没有统一的固定数值）。

**硬件层：DDIC 的自适应刷新**

LTPO 面板的显示驱动芯片（DDIC）支持在系统给定的刷新率范围内做更细粒度的调节，但这个过程通常仍是由系统（DisplayModeDirector / SurfaceFlinger / HWC）主导触发的，而不是 DDIC 完全脱离系统调度、自行决定的"静默降频"。当系统判断内容静止、下调目标刷新率后，会通过显示通路通知面板切换到对应的低刷新率或自刷新（self-refresh）模式，Choreographer 的 VSYNC 回调节奏也会随之调整——不是"Choreographer 仍按 120Hz 调度、面板却背着系统偷偷降到 1Hz"这种完全脱节的状态。真正容易踩坑的地方在于：如果应用在低刷新率区间内还坚持按固定步长（如 16ms）估算帧间隔，而不是读取真实的 VSYNC 周期，动画就会出现跳帧。

不同厂商、不同面板对 LTPO 自适应刷新的实现细节和响应速度存在差异，App 层不应假设某个具体的切换延迟或阈值，而应始终以 `frameTimeNanos` 计算真实的帧间隔，避免对刷新率切换时机做过强的假设。

## 一个实际可用的自适应策略

我落地了一套三级帧率策略：

```kotlin
class RefreshRatePolicy(private val activity: Activity) {

    fun setMode(mode: Mode) {
        val dm = activity.getSystemService(DisplayManager::class.java)
        val display = dm.getDisplay(Display.DEFAULT_DISPLAY)
        val window = activity.window

        val targetId = when (mode) {
            Mode.AUTO -> 0 // 完全交由系统投票
            Mode.HIGH -> display.supportedModes
                .maxByOrNull { it.refreshRate }?.modeId ?: 0
            Mode.LOW -> display.supportedModes
                .firstOrNull { it.refreshRate == 60f }
                ?: display.supportedModes.minByOrNull { it.refreshRate }
                ?.modeId ?: 0
        }
        window.attributes.preferredDisplayModeId = targetId
        window.attributes = window.attributes
    }

    enum class Mode { AUTO, HIGH, LOW }
}
```

默认使用 AUTO，只在必要时覆盖。游戏或视频场景设置 HIGH，静态阅读设 LOW。AUTO 模式下，LTPO 面板在阅读场景的功耗比锁定 120Hz 低约 40%（一加 11 实测），滚动列表时自动升到 120Hz，体验无感知。

## 排障清单

遇到帧率问题时按这个顺序排查：

1. `adb shell dumpsys display`——看投票源的投票区间，找到压低帧率的源头
2. 检查是否有 Camera2、MediaCodec 持续输出固定帧率的 Surface——这是最高频的隐形杀手
3. LTPO 设备上，用高速摄像头验证实际刷新率——dumpsys 返回的值不代表面板实际状态
4. 动画引擎统一用 `frameTimeNanos` 算 delta——别假设帧间隔是固定的
