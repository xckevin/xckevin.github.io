---
title: "Android Adaptive Refresh Rate, LTPO, and Choreographer: From preferredDisplayModeId to Hardware Shadow Scheduling"
lang: en
translationKey: android-adaptive-refresh-rate-ltpo-choreographer
slug: android-adaptive-refresh-rate-ltpo-choreographer
excerpt: "Why a 120Hz LTPO device holds video playback at 60Hz, how DisplayModeDirector arbitrates refresh rate votes, and how to adapt Choreographer timing when VSYNC changes."
publishDate: '2026-07-23'
tags:
- "Android"
- "Display"
- "LTPO"
- "Choreographer"
- "Performance"
seo:
  title: "Android Adaptive Refresh Rate, LTPO, and Choreographer"
  description: "How Android arbitrates refresh rate on LTPO panels, why preferredDisplayModeId gets overridden, and how to adapt Choreographer timing."
  pageType: article
---

While optimizing a video player, I ran into a puzzling phenomenon: on the same 120Hz LTPO device, our player remained locked at 60Hz, but YouTube could smoothly reach 120Hz while scrolling a list. My first instinct was that we had missed an API call—but it turned out the problem was far more complicated than expected.

## Why It Still Drops Back to 60Hz After Setting preferredRefreshRate

The first version of the code was straightforward:

```kotlin
window.attributes.preferredDisplayModeId = display.supportedModes
    .find { it.refreshRate == 120f }?.modeId ?: 0
```

This setting only takes effect when "there are no other constraints." As soon as the page contains a Camera2 preview or a SurfaceView fed by MediaCodec output, the frame rate immediately falls back to 60Hz. The issue is not SurfaceView itself; rather, the system's internal frame-rate arbitration mechanism outvotes your preference.

Android's frame-rate decision is the result of a multi-party negotiation:

- **The application layer** declares a preference through `preferredDisplayModeId`; this is a relatively low-priority vote source.
- **SurfaceFlinger** scans the actual frame submission rate of every visible Layer and infers the "content frame rate."
- **DisplayModeDirector** aggregates all vote sources and arbitrates the final refresh-rate range by taking intersections from highest priority to lowest priority.
- **The LTPO panel's DDIC** can perform finer hardware-level adjustment within the refresh-rate range given by the system.

You set 120Hz, but if Camera2's BufferQueue stays steady at 30fps, SurfaceFlinger votes for a low frame-rate range, and the final result may be 60Hz.

## DisplayModeDirector's Voting Architecture and Arbitration Rules

Android 11 refactored frame-rate management. The core idea is to abstract each influencing factor into a "Vote" that is aggregated by `DisplayModeDirector`. Each vote carries a predefined fixed priority—for example, touch/UDFPS votes have higher priority than ordinary app requests, and app requests have higher priority than the default rendering frame rate—and each vote produces an acceptable refresh-rate range. The arbitration rule is not simply "take the maximum lower bound." Instead, it **narrows the range by priority from high to low**: starting from the highest priority, the ranges for each priority level are intersected successively. Once an intersection becomes empty, the currently participating lowest-priority vote is discarded, and intersection resumes from the next priority level until a non-empty usable range is obtained. In other words, high-priority votes—such as the UDFPS request in a fingerprint-unlock scenario—can almost always override low-priority votes such as an app's `preferredDisplayModeId`, rather than the outcome being decided merely by comparing numeric values.

**Content frame rate vote** — SurfaceFlinger continuously tracks every Layer's dequeueBuffer interval. If a Layer submits no new frame for 500ms, its frame rate estimate is 0, meaning "no preference"; if the interval is stable at 16ms, the estimate is 60fps. This vote source is the most damaging in video playback scenarios.

**Brightness and temperature vote** — At low brightness, MURA, or display non-uniformity, is more obvious when an OLED panel is driven at 120Hz, so the system downgrades to 60Hz. The same applies when temperature is too high: high temperature accelerates panel aging, so the system proactively limits the frame rate.

**Touch boost vote** — The moment a finger goes down, InputManager sends a temporary frame-rate boost request through `IDisplayManager.aidl`, overriding the low-frame-rate content vote until some time after the finger lifts. The exact delay varies by device vendor customization and is not a fixed value. That is why the screen can still spike to 120Hz when you scroll a progress bar even though the video is playing at 24fps.

**App preference vote** — This is your `preferredDisplayModeId` call. It has the lowest priority and is adopted only when no other vote source imposes a constraint.

One pitfall I ran into in a real project: CameraX's PreviewView in PERFORMANCE mode uses a SurfaceView internally, which has an independent BufferQueue, so its frame-rate vote is counted separately by SurfaceFlinger. The solution is not to turn off the camera's frame-rate vote—you cannot turn it off anyway—but to proactively downgrade in scenarios where a high frame rate is not needed and let the system trust your AUTO mode selection.

## Choreographer's VSYNC Adaptation

After a refresh-rate switch, Choreographer automatically adjusts the cadence of `doFrame` calls according to the new VSYNC period. This process is completely transparent at the framework layer, but the application layer has one easy-to-overlook trap.

When an LTPO panel drops from 120Hz to 10Hz for static display, the VSYNC period stretches from 8.3ms to 100ms. If your animation calculation uses a fixed step:

```kotlin
// ❌ 错误：假设帧间隔固定
fun doFrame(frameTimeNanos: Long) {
    x += velocityX * 16f  // 写死的 16ms
}
```

In 10Hz mode, the actual interval between `doFrame` calls is 100ms, so the animation will visibly skip frames. The correct approach is to compute the real delta from `frameTimeNanos`:

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

Another point that is easy to misuse is `Choreographer.getVsyncId()`. Its return value is the VSYNC sequence number. While an LTPO panel is autonomously reducing its refresh rate, this sequence number may not increase for a long time—do not use it to derive timestamps.

## LTPO Panel's Hardware-Layer "Shadow Scheduling"

The essential difference between LTPO (Low-Temperature Polycrystalline Oxide) and traditional LTPS is that LTPS can only switch among a few fixed levels such as 60/90/120Hz, while LTPO supports continuous adjustment from 1Hz to 120Hz. The trade-off is a more complex gate-driver circuit and stricter leakage-current control requirements.

Android's LTPO adaptation is split into software and hardware layers:

**Software layer: IdleTimer frequency reduction**

AOSP maintains an idle timer inside `DisplayModeDirector`. When no new frame is submitted for a period of time, the system decides that the content has entered a static phase and proactively lowers the refresh rate to the minimum supported by the panel. The specific idle-detection duration can be configured by the device vendor; there is no unified fixed value.

**Hardware layer: DDIC adaptive refresh**

The LTPO panel's display driver chip (DDIC) supports finer-grained adjustment within the refresh-rate range provided by the system, but this process is still normally triggered and led by the system—DisplayModeDirector / SurfaceFlinger / HWC—rather than being a "silent frequency reduction" decided entirely by the DDIC on its own, detached from system scheduling. When the system decides the content is static and lowers the target refresh rate, it notifies the panel through the display pipeline to switch to the corresponding low refresh rate or self-refresh mode, and Choreographer's VSYNC callback cadence adjusts accordingly. It is not the fully disconnected state in which "Choreographer still schedules at 120Hz while the panel secretly drops to 1Hz behind the system's back." The real pitfall is this: if the application still insists on estimating frame intervals with a fixed step such as 16ms inside a low-refresh-rate range, instead of reading the real VSYNC period, the animation will drop frames.

Different vendors and panels differ in the implementation details and responsiveness of LTPO adaptive refresh. The application layer should not assume any specific switching latency or threshold. Always compute the real frame interval from `frameTimeNanos`, and avoid making overly strong assumptions about when a refresh-rate switch occurs.

## A Practical Adaptive Strategy That Works

I shipped a three-tier frame-rate policy:

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

It defaults to AUTO and overrides only when necessary. Games or video scenarios use HIGH, while static reading uses LOW. In AUTO mode, an LTPO panel consumed about 40% less power in reading scenarios than when locked to 120Hz, measured on a OnePlus 11, and it automatically rises to 120Hz when scrolling a list, with no perceptible impact on the experience.

## Troubleshooting Checklist

When you encounter a frame-rate problem, investigate in this order:

1. `adb shell dumpsys display` — look at the vote ranges from each vote source and find the source that is pulling the frame rate down.
2. Check whether there is a Camera2 or MediaCodec surface that continuously outputs at a fixed frame rate — this is the most frequent invisible killer.
3. On an LTPO device, use a high-speed camera to verify the actual refresh rate — the value returned by dumpsys does not represent the panel's actual state.
4. Have the animation engine consistently compute delta from `frameTimeNanos` — do not assume the frame interval is fixed.
