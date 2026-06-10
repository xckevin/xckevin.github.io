---
title: 深入 Android 16 Live Updates 实时通知全链路
slug: android-16-live-updates
translationKey: android-16-live-updates
excerpt: Android 16 的 Live Updates API 将通知定义与状态更新解耦，通过 ProgressSegment 分段描述和增量同步机制，大幅降低跨进程开销，并支持状态栏胶囊持久化展示。
publishDate: '2026-06-06'
tags:
- Android
- LiveUpdates
- 前台服务
- 通知优化
- 性能优化
seo:
  title: 深入 Android 16 Live Updates 实时通知全链路
  description: 详解 Android 16 Live Updates API 的设计架构：从 ProgressSegment 分段进度到增量同步机制，再到状态栏胶囊持久化，附落地实践与厂商兼容性建议。
---

## 传统 ForegroundService 通知的局限

Android 前台服务（ForegroundService）从 8.0 起要求绑定常驻通知。这条通知的内容是静态快照——进度变了，只能调 `NotificationManager.notify()` 重发一条。

```kotlin
// 传统做法：每次进度变化都要重建通知
val notification = NotificationCompat.Builder(context, CHANNEL_ID)
    .setContentTitle("上传中")
    .setProgress(100, currentProgress, false)
    .build()
notificationManager.notify(NOTIFICATION_ID, notification)
```

频繁 notify 有两个代价：Binder 跨进程通信每次都重建完整通知对象，CPU 和内存消耗不小；通知栏刷新时会有视觉闪烁。更麻烦的是，用户划掉通知后 ForegroundService 随时可能被系统回收——后台任务能不能活着，你说了不算。

Android 16 的 Live Updates API 从架构层重新设计了这套机制。

## Live Updates 的核心抽象

Live Updates 把「定义通知内容」和「更新通知状态」拆成两件事。`LiveUpdateNotification` 样式类在底层引入了一套分段进度描述结构，不再依赖 `setProgress()` 的单次设值。

```kotlin
class UploadLiveUpdate : LiveUpdateNotification(context, CHANNEL_ID) {
    override fun onBindStyle(): LiveUpdateStyle {
        return LiveUpdateStyle.Progress(
            segments = listOf(
                ProgressSegment("压缩", 0, 30, ProgressStatus.ACTIVE),
                ProgressSegment("加密", 30, 60, ProgressStatus.PENDING),
                ProgressSegment("上传", 60, 100, ProgressStatus.PENDING)
            ),
            icon = R.drawable.ic_upload
        )
    }
}
```

`ProgressSegment` 把任务拆成分段状态机，每个段有自己的名称、起止范围和状态（ACTIVE / PENDING / COMPLETED）。系统拿到这个结构后，状态栏渲染完全交给 SystemUI 进程，应用进程只管推送状态变更。

和传统方案比，核心变化很明确：**通知结构只定义一次，后续只传差异数据**。

## 状态变更的增量同步机制

应用端通过 `LiveUpdateManager` 更新进度，不再直接操作 Notification：

```kotlin
val manager = context.getSystemService(LiveUpdateManager::class.java)
manager.updateProgress("upload_task_001") {
    segments[0].status = ProgressStatus.COMPLETED
    segments[1].status = ProgressStatus.ACTIVE
    segments[1].progress = 45
}
```

`updateProgress` 的 lambda 闭包通过 Binder 将变更增量同步到 SystemUI。相比传统 `notify()` 每次重建完整通知对象再跨进程传输，数据量减少 90% 以上。

`updateProgress` 的调用频率上限大约是每秒 15 次——超出的调用会被合并或丢弃。做毫秒级帧率动画不够，但常规进度刷新绰绰有余。这是系统层的节流保护，避免应用刷屏耗尽渲染资源。

## 状态栏胶囊的持久化细节

条件满足时，Live Update 会自动收缩为状态栏胶囊，显示在时间旁边：

1. 使用 `LiveUpdateStyle.Progress` 且 segments 不为空
2. 绑定了有效的 ForegroundService
3. 用户在通知栏折叠了该通知，或触发超时自动折叠

收缩后的胶囊由 SystemUI 的 `LiveUpdateCapsuleView` 渲染，跑在系统进程内。应用被 LMK 杀掉，胶囊也不会消失，会按配置的时长继续保留。

```kotlin
val config = LiveUpdateConfig.Builder()
    .setPersistDuration(Duration.ofMinutes(30)) // 最长驻留
    .setCollapseBehavior(CollapseBehavior.COLLAPSE_TO_CAPSULE)
    .setPriority(Priority.HIGH) // 锁屏也显示
    .build()
manager.startLiveUpdate("upload_task_001", liveUpdateNotification, config)
```

`CollapseBehavior` 三种模式：`COLLAPSE_TO_CAPSULE`（收缩为胶囊）、`COLLAPSE_TO_ICON`（收缩为图标）、`KEEP_EXPANDED`（保持展开）。文件上传、导航这类需要持续关注进度的场景，胶囊模式信息展示最直接。

## 落地建议

`LiveUpdateManager` 是系统服务，可以跨 Activity / Fragment 使用。我习惯把它封装在 Repository 层，用 `StateFlow` 暴露：

```kotlin
class UploadRepository {
    private val manager = context.getSystemService(LiveUpdateManager::class.java)
    private val _state = MutableStateFlow<UploadProgress>(UploadProgress.Idle)

    suspend fun upload(file: File): Flow<UploadProgress> {
        startLiveUpdate(file.name)
        return _state.onEach { progress ->
            manager.updateProgress(file.name) {
                segments.forEachIndexed { i, seg ->
                    seg.status = progress.toProgressStatus(i)
                }
            }
        }
    }
}
```

踩过的几个坑：

**胶囊数量硬限制**：同一应用最多 2 个活跃胶囊。超了不会崩，但新的 Live Update 会静默降级为普通通知。多任务场景需要主动管理优先级，确保重要的任务占住胶囊位。

**厂商 ROM 兼容性**：小米 HyperOS 和部分 ColorOS 版本上胶囊可能不显示，厂商对 SystemUI 做了深度定制。海外市场放心用，国内市场建议预留降级为普通通知的开关。做过国内 ROM 适配的人都懂这个道理——SystemUI 相关的 API 永远要给厂商定制留一手。

**Service 声明不需要改**：ForegroundService 的 `startForeground()` 调用保持不变，Manifest 不用加新权限。这次 API 设计很务实，迁移成本压到了最低。

Android 16 以下的设备直接退化为普通 ForegroundService 通知，用 `Build.VERSION.SDK_INT` 判断即可，不需要额外兼容库。已有前台服务的项目，核心改动三步：替换通知构建方式、接入 `LiveUpdateManager`、配置 `LiveUpdateConfig`，半小时能搞定。
