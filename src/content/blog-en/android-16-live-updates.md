---
title: "Android 16 Live Updates: Real-Time Notifications and Capsule UI"
lang: en
translationKey: android-16-live-updates
slug: android-16-live-updates
excerpt: "How Android 16 Live Updates separate notification structure from state changes, using segmented progress and incremental synchronization to reduce IPC cost and support persistent status-bar capsules."
publishDate: '2026-06-06'
tags:
- "Android"
- "Live Updates"
- "Foreground Service"
- "Notifications"
- "Performance"
seo:
  title: "Android 16 Live Updates: Real-Time Notifications"
  description: "Understand Android 16 Live Updates, including segmented progress, incremental synchronization, status-bar capsules, and rollout advice."
  pageType: article
---

## The Limits of Traditional ForegroundService Notifications

Since Android 8.0, foreground services have required a persistent notification. Traditional notification content is a static snapshot: when progress changes, you rebuild and re-post the whole notification.

```kotlin
val notification = NotificationCompat.Builder(context, CHANNEL_ID)
    .setContentTitle("Uploading")
    .setProgress(100, currentProgress, false)
    .build()
notificationManager.notify(NOTIFICATION_ID, notification)
```

Frequent `notify()` calls have two costs. Every update sends a full notification object across Binder, and the notification shade may visually refresh or flicker. More importantly, once the user dismisses the notification, the foreground task may lose its durable user-facing surface.

Android 16 Live Updates redesigns this model from the system layer.

## The Core Abstraction

Live Updates separates "define notification content" from "update notification state". Instead of repeatedly calling `setProgress()`, the underlying style uses segmented progress state.

```kotlin
class UploadLiveUpdate : LiveUpdateNotification(context, CHANNEL_ID) {
    override fun onBindStyle(): LiveUpdateStyle {
        return LiveUpdateStyle.Progress(
            segments = listOf(
                ProgressSegment("Compress", 0, 30, ProgressStatus.ACTIVE),
                ProgressSegment("Encrypt", 30, 60, ProgressStatus.PENDING),
                ProgressSegment("Upload", 60, 100, ProgressStatus.PENDING)
            ),
            icon = R.drawable.ic_upload
        )
    }
}
```

`ProgressSegment` turns a long task into a small state machine. Each segment has a label, range, and status such as `ACTIVE`, `PENDING`, or `COMPLETED`. Once SystemUI receives the structure, rendering is handled in the system process; the app only sends state changes.

The key difference is simple: **the notification structure is defined once, and later updates send only deltas**.

## Incremental State Synchronization

The app updates progress through `LiveUpdateManager`, instead of directly rebuilding notifications:

```kotlin
val manager = context.getSystemService(LiveUpdateManager::class.java)
manager.updateProgress("upload_task_001") {
    segments[0].status = ProgressStatus.COMPLETED
    segments[1].status = ProgressStatus.ACTIVE
    segments[1].progress = 45
}
```

Compared with rebuilding a full notification object on every change, the transferred data becomes much smaller. This is especially useful for upload, download, ride-hailing, navigation, delivery, and other long-running tasks that update frequently.

The update rate still needs a limit. Treat Live Updates as a status mechanism, not as a frame-by-frame animation surface. Updating several times per second is reasonable; trying to drive a 60 fps animation through notifications is not.

## Persistent Status-Bar Capsules

When the conditions match, a Live Update can collapse into a small capsule in the status bar. This gives users durable context without forcing a full notification row to remain visible.

Typical requirements include:

1. A valid Live Update progress style.
2. A bound foreground task or task identity.
3. A configuration that allows capsule collapse and persistence.

```kotlin
val config = LiveUpdateConfig.Builder()
    .setPersistDuration(Duration.ofMinutes(30))
    .setCollapseBehavior(CollapseBehavior.COLLAPSE_TO_CAPSULE)
    .setPriority(Priority.HIGH)
    .build()
manager.startLiveUpdate("upload_task_001", liveUpdateNotification, config)
```

Because rendering belongs to SystemUI, the capsule is more stable than a client-managed view. Even if the app process is under pressure, the system can keep a compact representation for a bounded duration.

## Rollout Advice

Use Live Updates only for tasks where the user benefits from continuous state: navigation, delivery, taxi trips, uploads, downloads, sports scores, timers, and media-like workflows.

Keep the state model small. A Live Update should expose a durable user-facing state, not internal implementation details. If you have twenty backend phases, compress them into three or four meaningful segments.

Keep a compatibility fallback. Existing Android versions and OEM builds may still need ordinary `NotificationCompat` behavior, so wrap the feature behind an adapter:

```kotlin
interface TaskStatusNotifier {
    fun start(task: TaskStatus)
    fun update(task: TaskStatus)
    fun finish(taskId: String)
}
```

On Android 16 and supported devices, the implementation can use Live Updates. Elsewhere, it can fall back to classic foreground notifications.

Live Updates are not mainly about visual novelty. Their value is moving long-running task state into a system-managed, incremental, and more durable rendering path.
