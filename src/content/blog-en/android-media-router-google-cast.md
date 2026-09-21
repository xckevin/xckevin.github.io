---
title: 'Android Casting End to End: From MediaRouter Discovery to Google Cast Session Management'
lang: en
translationKey: android-media-router-google-cast
slug: android-media-router-google-cast
excerpt: 'A breakdown of Android casting end to end: MediaRouter device discovery, the Cast Session state machine, and the pitfalls of background resume, so you avoid mixing Route and Session lifecycles.'
publishDate: '2026-08-21'
tags:
- Android
- MediaRouter
- Google Cast
- State Machine
- Casting
seo:
  title: 'Android Casting: MediaRouter Discovery to Google Cast Session Management'
  description: 'Android casting end to end: MediaRouter device discovery and the Google Cast Session state machine, plus background resume pitfalls.'
  pageType: article
---

When I took over the casting feature for a video app, the PM had two requirements: the cast button should only light up when a device is available, and the app should be able to resume casting progress after being backgrounded and brought back. My first instinct was to check the MediaRouter docs, but the docs blur the boundary between "discovering a device" and "actually casting to it." This article breaks the chain apart, following it from MediaRouter route discovery all the way to the Cast Session state machine.

## MediaRouter only handles routing, not playback

Let's start with a point that's easy to confuse: MediaRouter is a route-selection framework provided by the framework. It maintains a set of `MediaRouter.RouteInfo` objects (the concrete information about a route), letting users pick an output device through `MediaRouteButton` or custom UI. It doesn't care about the casting protocol, and it doesn't handle playback.

The real work is done by `MediaRouteProvider`. Each provider corresponds to a device category: Bluetooth, the system's built-in remote display, Google Cast. When the Cast SDK initializes, it registers its own provider, and only then do Cast devices appear as `MediaRouter.RouteInfo`.

The key is the ControlCategory. An app declares the capabilities it needs through `MediaRouteSelector`; `CATEGORY_REMOTE_PLAYBACK` means "push media to a remote device for playback." The router only exposes routes matching the selector to the app; routes that don't match don't even factor into the button state.

## Discovery: how a Cast device becomes a route

The Cast SDK discovers devices via mDNS, using the service type `_googlecast._tcp.local`. The concrete implementation details of this layer are encapsulated inside the Cast SDK (after sniffing devices on the local network, it builds an internal `CastDevice` representation and then bridges it to the MediaRouteProvider); they are not a stable public API. Developers don't need to, and shouldn't, depend directly on the internal provider implementation—just interact with Cast through public APIs such as `CastContext` and `SessionManager`. The app usually doesn't have to handle this step directly: initialize CastContext and hand it off to CastButtonFactory, and devices end up presented to the app as `MediaRouter.RouteInfo`.

```kotlin
val castContext = CastContext.getSharedInstance(context)
CastButtonFactory.setUpMediaRouteButton(context, mediaRouteButton)

val selector = MediaRouteSelector.Builder()
    .addControlCategory(CastMediaControlIntent.categoryForCast("APP_ID"))
    .build()
mediaRouteButton.routeSelector = selector
```

`categoryForCast("APP_ID")` narrows the selector to "devices that can run my receiver app." This both filters out incompatible devices and determines when the button should light up. Discovery is asynchronous, so in the first few seconds after a cold start the button may hide and then reappear. If the product requires "gray out instead of hide when no device is available," you have to maintain the discovery state yourself.

## From onRouteSelected to the CastSession state machine

After the user taps the button and selects a device, the framework invokes `MediaRouter.Callback.onRouteSelected`, and MediaRouter then calls the provider's `RouteController.onSelect`. Cast's RouteController triggers the `CastSession` startup flow there. In this bridge chain, MediaRouter's RouteInfo and Cast's Session are two separate lifecycles and must not be mixed up.

One key design of the Cast SDK is that the Session is an explicit state machine, not a simple connection callback. `SessionManagerListener` exposes the full state:

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

The state flow is roughly `STARTING → STARTED → SUSPENDED → RESUMING → RESUMED`, and any state can transition to `ENDED`. `STARTED` only means the receiver app has started, not that media has loaded successfully. A pitfall I hit: someone read the remoteMediaClient playback state directly inside `onSessionStarted` and got null—`load` is asynchronous, so you have to wait for `RemoteMediaClient.Listener`'s `onStatusUpdated`.

## Disconnects and resume: use the state machine instead of manual checks

Background resume is the part of casting features most likely to go wrong. On the Android side, driving things from the Session state is more reliable than manual checks. When the app goes to the background, don't proactively disconnect the `CastSession`; let the SDK handle network fluctuations itself. What you need to listen for is `SUSPENDED` and `ENDED`.

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

My take: don't implement your own reconnection timer. When the Session is suspended, the SDK automatically tries to recover; layering your own retry logic on top just fights the SDK over state and causes duplicate `load` calls during the `RESUMING` phase. Scenarios like the user disconnecting or the receiver exiting should all be funneled into `onSessionEnded`.

## Two real-world pitfalls

The first pitfall is that the Route and Session lifecycles don't overlap. A MediaRouter `RouteInfo` can keep existing while the `CastSession` may already have `ENDED`. To determine "am I currently casting," look at `sessionManager.currentCastSession`, not `MediaRouter.getSelectedRoute()`. Mixing the two APIs gives your state checks two sources of truth, which is hard to debug later.

The second pitfall is that the ordering of `onRouteSelected` and `onSessionStarted` is not guaranteed. When the user switches devices quickly in succession, the old Session may not have ended before the new select comes in. My habit is to add idempotency protection in `onRouteSelected` first: if a Session already exists and the route is different, wait for `onSessionEnded` before starting a new session.

Once you understand this chain, most remaining casting-feature problems reduce to a state-machine judgment call: "which callback do I do this in?"
