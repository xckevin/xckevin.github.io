---
title: "Android Media3 Playback Architecture: From ExoPlayer to MediaSession"
lang: en
translationKey: android-media3-exoplayer-mediasession
slug: android-media3-exoplayer-mediasession
excerpt: "A deep dive into Android Media3 playback architecture, from the ExoPlayer core to the MediaSession control pipeline, buffering strategy, and migration practices."
publishDate: '2025-05-05'
tags:
- "Android"
- "Media3"
- "ExoPlayer"
- "Media Playback"
- "Architecture"
seo:
  title: "Android Media3 Playback: From ExoPlayer to MediaSession"
  description: "Explore Android Media3 architecture, including the ExoPlayer core, MediaSession control flow, TrackSelector, buffering strategy, and migration guidance."
  pageType: article
---

When I took over a video playback project last year, picture-in-picture, headset controls, and notification controls each had their own logic. Every playback policy change had to be synchronized in three places. The team was still using ExoPlayer 2.x at the time. After moving to Media3, those scattered control paths finally converged into one place. This article summarizes the architecture lessons from that migration.

## Why ExoPlayer evolved into Media3

From its 2014 release through the 2.x line, ExoPlayer was primarily positioned as a media player. It solved the limited protocol support and poor extensibility of Android's platform `MediaPlayer`, but its architecture had three bottlenecks.

The first bottleneck was the separation between playback and media control. ExoPlayer handled decoding and rendering, while MediaSession handled external controls such as headset buttons, car systems, and notification actions. The two had to be connected manually through `PlayerConnector`. That glue code was scattered across Activities and Services, and every integration had to reimplement state synchronization.

The second bottleneck was weak support for multi-Surface scenarios. For picture-in-picture transitions, secondary display casting, or audio-focus loss, callers had to manage the Surface lifecycle and player instance switching themselves. There was no unified abstraction to fall back on.

The third bottleneck was confusing module naming. Under `com.google.android.exoplayer2`, modules such as `core`, `ui`, and `extension` had opaque dependency relationships. For example, the `hls` module could indirectly pull in `dash`, adding unused binary size.

The central idea in Media3 is to **treat media playback and media control as one system**. It no longer separates "player APIs" from "session APIs." Instead, it uses the unified `Player` interface and `MediaSession` integration to route playback state and control commands through a single pipeline.

```kotlin
// Media3 unified entry point: Player and MediaSession together
val player = ExoPlayer.Builder(context).build()
val session = MediaSession.Builder(context, player).build()

// The playback source and controls both go through the same player instance.
player.setMediaItem(MediaItem.fromUri(videoUrl))
player.playWhenReady = true
```

Compared with the old approach of separately managing `SimpleExoPlayer` and `MediaSessionCompat` while manually syncing state, Media3 removes a large amount of glue code.

## Core changes in the player engine

Media3 refactors three important paths in the ExoPlayer-based playback core.

**TrackSelector is split by use case.** The old `DefaultTrackSelector` packed adaptive bitrate, screen-size matching, language preference, and other policies into one class, with more than 20 parameters. Media3 extracts the `TrackSelector` abstraction. The default implementation keeps the basic strategy, while complex scenarios can inject a custom implementation:

```kotlin
class AdaptiveTrackSelector : TrackSelector {
    override fun selectTracks(
        rendererCapabilities: Array<out RendererCapabilities>,
        trackGroupArray: TrackGroupArray,
        constraints: Constraints
    ): TrackSelection {
        // Dynamically choose bitrate based on network speed and device capability.
        val sortedGroups = trackGroupArray.sortedByDescending {
            it.getFormat(0).bitrate
        }
        return FixedTrackSelection(sortedGroups.first(), 0)
    }
}
```

**Renderers are decoupled into standalone components.** In the old architecture, `MediaCodecVideoRenderer` and `MediaCodecAudioRenderer` directly held decoder references and could not be replaced at runtime. Media3 turns Renderer creation into a stateless factory flow: each `prepare()` creates Renderer instances again. This matters for picture-in-picture. When switching to a smaller window, the app can switch to a lower-resolution Renderer without rebuilding the entire player.

**MediaSource creation is factory-based.** `ProgressiveMediaSource` and `HlsMediaSource` no longer directly depend on the player. They are created through `MediaSource.Factory`. During source switching, Media3 can warm up the next Source internally by calling `prepare()` in the background without interrupting current playback.

## Buffering strategy: from passive loading to active scheduling

ExoPlayer controls buffering through the `LoadControl` interface. The default `DefaultLoadControl` logic is simple: keep loading when the current buffer is below a threshold, 15 seconds by default, and stop when it is above the upper bound, 30 seconds by default. But this logic is not sensitive to network characteristics. After stalling, it cannot tell whether the problem was temporary jitter or a continuing decline.

Media3 keeps the `LoadControl` interface, but its default implementation adds **network bandwidth prediction**. By analyzing download speed and stall events over the previous 10 seconds, `DefaultLoadControl` can adjust the buffer target dynamically:

- When the network is stable, lower the target buffer to 10 seconds to reduce memory use
- When throughput drops, raise the target buffer early to 40 seconds, trading memory for time
- After more than three consecutive stalls, proactively switch to a lower-bitrate Track

The same prediction logic appears in `AdaptiveTrackSelection`. The older ABR algorithm looked only at average bandwidth over the last few seconds. Media3 adds a safety margin: multiply the bandwidth estimate by 0.75 before choosing a track, which reduces frequent track switches caused by sudden jitter.

```kotlin
// Custom LoadControl: cap prebuffering at the target values.
val loadControl = DefaultLoadControl.Builder()
    .setBufferDurationsMs(
        30000,  // Minimum buffer: 30 seconds
        60000,  // Maximum buffer: 60 seconds
        2000,   // Buffer before playback starts: 2 seconds
        5000    // Rebuffer after track switching: 5 seconds
    )
    .setPrioritizeTimeOverSizeThresholds(true) // Prefer duration thresholds.
    .build()
```

In production, I found `setPrioritizeTimeOverSizeThresholds(true)` especially useful for short-video feeds. With the default byte-first strategy, a 10-second 1080p video might preload an amount of data equivalent to five seconds of 4K video, wasting bandwidth for no user-visible benefit.

## MediaSession as the unified pipeline: control commands stop getting lost

In Media3, MediaSession is no longer just a bridge. It becomes **the only control channel between the player and the system**. Every command, whether it comes from app code, system buttons, Bluetooth devices, or Wear OS, follows the same path:

```text
External control source: headset, notification, car, Bluetooth
        |
MediaSession.Callback: unified entry point
        |
Player instance: state changes and callbacks
        |
MediaSession broadcasts state so system UI can update
```

This unified pipeline fixes two painful issues in the old architecture.

The first is automatic conflict resolution between commands. In the old approach, closing picture-in-picture could trigger `onStop()`, which paused playback, which then updated the notification. These chained side effects made state-machine bugs common. Media3's `MediaSession` maintains an internal command queue, so multiple commands arriving in a short period can be coalesced instead of making state jump back and forth.

The second is simpler authorization for background playback. You no longer need to manage `AudioFocus` and `MediaBrowserService` manually. When MediaSession registers with the system, it requests audio focus automatically. When audio focus is lost, playback is paused and resources are released.

```kotlin
// MediaSession callback: all control entry points converge here.
session.callback = object : MediaSession.Callback {
    override fun onPlay() {
        player.play()
    }

    override fun onPause() {
        player.pause()
    }

    override fun onSeekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }
}
```

This callback looks plain, but it hides an important behavior: `MediaSession.Callback` methods run on the main thread, while `player.play()` and `player.pause()` are safe to call from any thread. MediaSession already handles thread dispatching internally, so callers do not have to care.

## Practical advice

When migrating an old project, **change dependencies before changing code**. Media3 keeps most ExoPlayer 2.x API names. In many cases, replacing package names is enough. My migration order was: move `ExoPlayer` to the `androidx.media3` package first, verify playback, add `MediaSession`, and only then replace custom components. Getting a working baseline before replacing everything is much safer than a full rewrite in one pass.

Before writing a custom `LoadControl`, **stress-test under poor network conditions**. The default bandwidth prediction works well on Wi-Fi, but it can be too aggressive in subway or elevator-like weak-network scenarios. Raising the buffer target to 40 seconds can create ANR risk. For weak networks, keep `maxBufferMs` under 30 seconds unless you have data proving otherwise.

One more common trap: **do not bypass MediaSession and call Player directly**. Many projects keep both `player` and `mediaSession` references in an Activity, and some code paths call `player.play()` directly. That can make the notification state diverge from actual playback state. Route commands through `mediaSession.player` or send them through `MediaController` so there is only one trusted source of state.
