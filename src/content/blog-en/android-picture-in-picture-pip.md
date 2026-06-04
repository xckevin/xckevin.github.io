---
title: "Android Picture-in-Picture: Lifecycle, SurfaceView, and MediaSession"
lang: en
translationKey: android-picture-in-picture-pip
slug: android-picture-in-picture-pip
excerpt: "A deep dive into Android Picture-in-Picture, covering Activity lifecycle sequencing, SurfaceView continuity, aspect-ratio constraints, RemoteAction, and MediaSession."
publishDate: '2025-11-06'
tags:
- "Android"
- "Picture-in-Picture"
- "Window Management"
- "MediaSession"
- "Video Playback"
seo:
  title: "Android Picture-in-Picture: Lifecycle, SurfaceView, and MediaSession"
  description: "Understand Android PiP from lifecycle sequencing and SurfaceView continuity to aspect-ratio constraints, RemoteAction callbacks, and MediaSession state."
  pageType: article
---

I once hit a nasty issue while building a video app. The user pressed Home to enter PiP, the video moved into the small window, audio kept playing, and three seconds later the app ANRed. The logs showed a long-running operation in `onStop()` blocking the main thread, while the PiP transition was stuck after `onPause()` waiting for `onStop()` to complete.

At its core, this was a problem in the entire PiP window-management pipeline.

## Entering PiP: lifecycle is serial

After `enterPictureInPictureMode()` is called, the system does not simply shrink the Activity. The actual window transition is coordinated by **SystemUI** and **WindowManagerService, or WMS**:

```java
// 1. App initiates the request
enterPictureInPictureMode(params);  // Async; does not wait for callbacks

// 2. AMS takes over
// -> onPause() runs first
// -> PiP transition animation starts, controlled by SystemUI's PipTaskOrganizer
// -> onStop() runs, and the Activity is no longer visible
// -> onPictureInPictureModeChanged(true) is triggered
```

There is **no asynchronous window between `onPause()` and `onStop()`**. If `onStop()` does expensive work, the PiP animation can stall because WMS is waiting for that lifecycle step to finish before switching the window from fullscreen to PiP. In my case, moving MediaSession state updates to a background thread and keeping `onStop()` lightweight fixed the issue.

## SurfaceView continuity during transition

When entering PiP, the video frame should shrink smoothly instead of flickering and recreating. This relies on SurfaceView **continuity**.

Ordinary Views must be redrawn during a window-mode switch. SurfaceView is different because its Surface is managed as an independent SurfaceFlinger layer. During PiP entry:

```java
// SurfaceView handling during PiP entry
// WMS calls relayoutWindow -> adjusts the Surface size
// SurfaceFlinger directly scales the original Surface content without recreating BufferQueue
```

The video rendering path, MediaCodec -> Surface -> SurfaceFlinger, is not interrupted by Activity lifecycle changes. Two things have to be true:

1. Do not call `mediaPlayer.pause()` from `onStop()`
2. Do not recreate MediaCodec from `SurfaceHolder.Callback.surfaceChanged()`

In real projects, if extreme smoothness is not required, I often use `TextureView` with hardware acceleration for custom transition animations because it is more flexible. But for performance-sensitive scenarios such as 4K video, SurfaceView's seamless transition is hard to replace. Avoiding one GPU copy is enough to stabilize frame rate.

## Adaptive ratio: three layers of constraints

`PictureInPictureParams.Builder.setAspectRatio()` looks like a simple aspect-ratio setting, but it has three layers of constraints behind it:

```kotlin
val params = PictureInPictureParams.Builder()
    .setAspectRatio(Rational(16, 9))  // Desired ratio
    .build()
```

**Layer one**: the system-allowed range is between `Rational(1, 2)` and `Rational(2, 1)`. Values outside that range throw immediately.

**Layer two**: the actual window ratio is dynamically adjusted by SystemUI's `PipResizeGestureHandler`. When the user drags to resize, the system snaps based on the ratio you set, but snap behavior varies by OEM. It is smooth on Pixel devices and can jump on some Xiaomi devices. During debugging, watch the PiP window bounds in `adb shell dumpsys activity`.

**Layer three**: on foldables, the PiP window adjusts as the physical screen ratio changes. I once saw the PiP window get cropped on a Flip device because `Rational` was not updated when the fold state changed.

```kotlin
// Correct approach: listen for layout changes and update dynamically
override fun onLayoutChange(...) {
    val newRatio = if (isInMultiWindowMode) Rational(3, 4) else Rational(16, 9)
    setPictureInPictureParams(
        PictureInPictureParams.Builder().setAspectRatio(newRatio).build()
    )
}
```

## RemoteAction: cross-process callback, not a local call

The PiP window supports three `RemoteAction` entries, usually for play/pause, previous, and next:

```kotlin
val action = RemoteAction(
    Icon.createWithResource(context, R.drawable.ic_pause),
    "Pause", "Pause playback",
    PendingIntent.getBroadcast(
        context, 0, Intent("ACTION_PAUSE"), 
        PendingIntent.FLAG_IMMUTABLE
    )
)
```

`RemoteAction` uses `PendingIntent` and calls back into the app through a BroadcastReceiver. It **does not directly call an Activity method**. This has several consequences:

1. If the app process has been killed, the `PendingIntent` wakes the BroadcastReceiver, and playback state must be rebuilt there
2. `BroadcastReceiver.onReceive()` must return within 10 seconds or it can trigger an ANR
3. Do not run network requests inside `onReceive()`; hand work off to a Service

One pitfall I hit: calling `mediaPlayer.pause()` directly from the BroadcastReceiver caused an `IllegalStateException` due to player state-machine timing. The correct approach is to bridge through MediaSession callbacks:

```kotlin
class PiPActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Dispatch through MediaSession and let MediaSession.Callback handle it
        val session = getMediaSession()
        session?.controller?.transportControls?.pause()
    }
}
```

## MediaSession integration: the single source of state

PiP `RemoteAction` controls and lock-screen notification controls share the same playback state. The bridge is MediaSession.

```kotlin
// Bind PiP-related behavior when building MediaSession
val session = MediaSession.Builder(context, player)
    .setCallback(object : MediaSession.Callback {
        override fun onPlay() {
            player.play()
            // Synchronize PiP RemoteAction state
            updatePiPActions(isPlaying = true)
        }
        override fun onPause() {
            player.pause()
            updatePiPActions(isPlaying = false)
        }
    })
    .build()
```

**MediaSession is the single source of state**. PiP RemoteActions, lock-screen notifications, Bluetooth controls, and car systems all read playback state from MediaSession. Maintaining separate state in multiple places is asking for trouble. I once debugged a case where PiP showed a "Pause" icon while the phone was still playing; the root cause was a stale `isPlaying` flag.

```kotlin
private fun updatePiPActions(isPlaying: Boolean) {
    val actions = if (isPlaying) {
        listOf(buildPauseAction(), buildNextAction(), buildPrevAction())
    } else {
        listOf(buildPlayAction(), buildNextAction(), buildPrevAction())
    }
    setPictureInPictureParams(
        PictureInPictureParams.Builder().setActions(actions).build()
    )
}
```

## PiP exit pitfalls

Manual PiP exit can use `moveTaskToBack(true)`, but in real development the window is more often closed automatically by the system:

- Android 12+ high-power restrictions may close the PiP window after the app spends some time in the background
- Under memory pressure, LMK can kill the process, and the PiP window disappears with it
- Some ROMs restrict non-video PiP usage, including customized systems that close it automatically after more than three minutes

Several practices have worked well:

1. Use a foreground Service plus persistent notification to reduce the chance of being killed by LMK
2. Save state in `onTaskRemoved()` and restore playback position when the app is relaunched
3. Do not put transition animations inside the PiP window. SystemUI's `PipOverlayController` is very strict about custom windows, and even alpha changes can be clipped.

PiP development is ultimately about respecting a few boundaries: lifecycle is serial, SurfaceView has continuity, RemoteAction uses cross-process broadcasts, and MediaSession is the single source of state. Once those boundaries are respected, most issues become configuration problems rather than architecture problems.
