---
slug: android-media-router-google-cast
translationKey: android-media-router-google-cast
title: 深入 Android 投屏全链路：从 MediaRouter 设备发现到 Google Cast Session 管理
excerpt: 拆解 Android 投屏全链路，讲清 MediaRouter 设备发现、Cast Session 状态机流转与后台续播的坑，避免 Route 与 Session 生命周期混用。
publishDate: '2026-08-21'
tags:
- Android
- MediaRouter
- Google Cast
- 状态机
- 投屏
seo:
  title: Android 投屏：MediaRouter 设备发现与 Google Cast Session
  description: 深入 Android 投屏全链路：从 MediaRouter 路由发现到 Google Cast Session 状态机管理，拆解设备发现、Session 状态流转与后台续播的关键实现与常见坑。
  pageType: article
---

接手视频 App 的投屏需求时，PM 提了两个要求：投屏按钮只在有可用设备时亮起；App 切后台再回来要能恢复投屏进度。第一反应是查 MediaRouter 文档，结果文档把「发现设备」和「真正投上去」两件事的边界讲得很含糊。这篇文章把链路拆开，从 MediaRouter 路由发现一路跟到 Cast Session 状态机。

## MediaRouter 只负责路由，不负责播放

先说一个容易混淆的点：MediaRouter 是 framework 提供的路由选择框架，维护一组 `MediaRouter.RouteInfo`（一条路由的具体信息），让用户通过 `MediaRouteButton` 或自定义 UI 选择输出设备。它不管投屏协议，也不负责播放。

真正干活的是 `MediaRouteProvider`。每个 Provider 对应一类设备：蓝牙、系统内置的 remote display、Google Cast。Cast SDK 初始化时注册自己的 Provider，Cast 设备才以 `MediaRouter.RouteInfo` 的形式出现。

关键在 ControlCategory。App 通过 `MediaRouteSelector` 声明自己需要什么能力，`CATEGORY_REMOTE_PLAYBACK` 表示「把媒体推到远端播放」。路由器只把匹配 selector 的 Route 暴露给 App，不匹配的连按钮状态都不参与。

## 发现：Cast 设备如何变成一条 Route

Cast SDK 的设备发现走 mDNS，服务类型是 `_googlecast._tcp.local`。这一层具体实现细节封装在 Cast SDK 内部（局域网嗅探到设备后生成内部的 `CastDevice` 表示，再桥接到 MediaRouteProvider），不是稳定的公开 API，开发者不需要也不应该直接依赖内部 Provider 实现，只需要通过 `CastContext`、`SessionManager` 等公开 API 与 Cast 交互。这一步通常不用 App 直接处理，初始化 CastContext 后交给 CastButtonFactory 即可，最终以 `MediaRouter.RouteInfo` 的形式呈现给 App。

```kotlin
val castContext = CastContext.getSharedInstance(context)
CastButtonFactory.setUpMediaRouteButton(context, mediaRouteButton)

val selector = MediaRouteSelector.Builder()
    .addControlCategory(CastMediaControlIntent.categoryForCast("APP_ID"))
    .build()
mediaRouteButton.routeSelector = selector
```

`categoryForCast("APP_ID")` 把 selector 限定为「能运行我这个接收端 App 的设备」，既过滤不兼容设备，也决定按钮什么时候该亮。发现是异步的，冷启动前几秒按钮可能先隐藏再出现；如果产品要求「无设备时置灰而不是隐藏」，就得自己维护发现状态。

## 从 onRouteSelected 到 CastSession 状态机

用户点按钮选中设备后，framework 回调 `MediaRouter.Callback.onRouteSelected`，MediaRouter 再去调用 Provider 的 `RouteController.onSelect`。Cast 的 RouteController 在这里触发 `CastSession` 启动流程。这条桥接链路里，MediaRouter 的 RouteInfo 和 Cast 的 Session 是两套生命周期，不能混用。

Cast SDK 的一个关键设计是：Session 是显式状态机，而不是简单的连接回调。`SessionManagerListener` 暴露完整状态：

```kotlin
castContext.sessionManager.addSessionManagerListener(object : SessionManagerListener<CastSession> {
    override fun onSessionStarted(session: CastSession, sessionId: String) {
        // 接收端 App 已启动，可以加载媒体
        session.remoteMediaClient?.load(mediaInfo)
    }
    override fun onSessionEnded(session: CastSession, error: Int) {
        playLocally()
    }
})
```

状态流转大致是 `STARTING → STARTED → SUSPENDED → RESUMING → RESUMED`，任意状态都能走到 `ENDED`。`STARTED` 只代表接收端 App 起来了，不代表媒体加载成功。我踩过的坑：有人在 `onSessionStarted` 里直接读 remoteMediaClient 的播放状态，拿到 null——`load` 是异步的，要等 `RemoteMediaClient.Listener` 的 `onStatusUpdated`。

## 断连与续播：用状态机而不是手动判断

后台续播是投屏需求里最容易翻车的部分。Android 侧靠 Session 状态驱动比手动判断可靠。App 切后台时不要主动断开 `CastSession`，让 SDK 自己处理网络波动；要监听的是 `SUSPENDED` 和 `ENDED`。

```kotlin
override fun onSessionSuspended(session: CastSession, reason: Int) {
    // 网络抖动，先挂起，等 SDK 自动恢复
}
override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
    // 恢复后重新同步播放进度
}
override fun onSessionEnded(session: CastSession, error: Int) {
    // 主动断开或接收端退出，切回本地续播
}
```

我的判断是：不要自己实现重连定时器。SDK 在 Session 挂起时会自动尝试恢复，再套一层重试逻辑只会和 SDK 抢状态，导致 `RESUMING` 阶段重复 load。用户主动断开、接收端退出这些场景，统一在 `onSessionEnded` 里收口。

## 两个实际的坑

第一个坑是 Route 和 Session 生命周期不重合。MediaRouter 的 `RouteInfo` 可以一直存在，但 `CastSession` 可能已经 `ENDED`。判断「当前是否在投屏」要看 `sessionManager.currentCastSession`，而不是 `MediaRouter.getSelectedRoute()`。两个 API 混用会让状态判断出现双源，后期很难排查。

第二个坑是 `onRouteSelected` 和 `onSessionStarted` 的时序不保证。用户连续快速切换设备时，旧的 Session 还没结束，新的 select 已经进来。我习惯在 `onRouteSelected` 里先做幂等保护：如果已有 Session 且 Route 不同，先等 `onSessionEnded` 再启动新会话。

这套链路理解之后，投屏需求里剩下的大部分问题会退化成状态机里「在哪个回调做什么事」的判断题。
