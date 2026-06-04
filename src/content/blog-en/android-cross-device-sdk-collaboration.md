---
title: "Android Cross-Device Collaboration: From Cross-Device SDK to Communication Architecture"
lang: en
translationKey: android-cross-device-sdk-collaboration
slug: android-cross-device-sdk-collaboration
excerpt: "A practical account of moving from Nearby Connections to the Cross-Device SDK, using Session and Resource abstractions to improve connection stability, message reliability, and state management."
publishDate: '2026-03-26'
tags:
- "Android"
- "Cross-Device SDK"
- "Cross-Device Collaboration"
- "Nearby Connections"
- "Architecture"
seo:
  title: "Android Cross-Device Collaboration with the Cross-Device SDK"
  description: "A practical guide to Android cross-device collaboration, covering Sessions, Resources, reconnection, discovery tuning, and Nearby Connections tradeoffs."
  pageType: article
---

Last year I took over an in-car entertainment project. The requirement was straightforward: let tablets in the rear seats control navigation and music on the front center console in real time. The vendor demo worked with Nearby Connections, but it fell apart under stress testing. Connections did not recover automatically, packets arrived out of order when multiple devices were connected, and heartbeat timeouts appeared as soon as devices entered a low-power state.

This is the engineering record of how I moved from Nearby Connections to the Cross-Device SDK.

## Technology choice: where Nearby Connections reaches its limits

Nearby Connections is a Google Play services P2P proximity communication API. It supports three topologies:

- **P2P_STAR**: one central node plus N peripheral nodes, with the center responsible for forwarding
- **P2P_POINT_TO_POINT**: direct one-to-one connections
- **P2P_CLUSTER**: a mesh connection formed automatically among nodes

Under the hood it uses a mix of Wi-Fi, Bluetooth, and Wi-Fi Direct, and the physical link switching is transparent to developers. Getting started is smooth:

```kotlin
// Start advertising
val strategy = Strategy.P2P_STAR
Nearby.getConnectionsClient(context)
    .startAdvertising(deviceName, SERVICE_ID, connectionLifecycleCallback, advertisingOptions)
    .addOnSuccessListener { /* wait for the peer connection request */ }
```

After two weeks of testing, the problems started to show up.

**Connection stability was poor.** Switching between Wi-Fi and Bluetooth created a 3-5 second gap. The upper layer received `onDisconnected()`, but there was no built-in reconnection. I added retry logic, but every reconnect had to repeat Bluetooth scanning and Wi-Fi Direct negotiation, so latency was unpredictable.

**Message delivery was not reliably guaranteed.** `Payload` has three types: `BYTE`, `FILE`, and `STREAM`. The names make them sound reliable, but in high-throughput scenarios `STREAM` can drop packets without retransmission. File transfer has to fall back to the `FILE` type.

**Multi-device concurrency was entirely application-owned.** In `P2P_STAR` mode, the central node has to track the number of connected devices, and peripheral nodes need to understand their own role. Nearby Connections does not manage any of that state.

The harder issue was vendor variance. Wi-Fi Direct was much more stable on Samsung devices than on some domestic Android models. Handling those differences in business logic would have been too expensive.

## What the Cross-Device SDK solves

In 2024, Google introduced the Cross-Device SDK, then still in Developer Preview. Its purpose was to add the missing layers that Nearby Connections did not provide: **session management** and **device capability negotiation**.

The core idea is simple: **model cross-device collaboration as a Session. The SDK owns connection lifecycle and transport strategy, while the app only sends and receives messages inside the Session.**

Architecturally, it has three layers:

```text
+-------------------------------------+
|          Application Layer          |
|  Session create/join, messaging     |
+-------------------------------------+
|       Cross-Device SDK Core         |
|  Session management, discovery,     |
|  capability negotiation, transport  |
+-------------------------------------+
|   Transport Layer (Nearby / BLE)    |
|   Wi-Fi, BLE, Wi-Fi Direct          |
+-------------------------------------+
```

Session is the central abstraction. When creating one, you describe the device's **capabilities** and the **resource types** it wants to share:

```kotlin
val participant = Participant.Builder()
    .addCapability(DeviceCapability.VIDEO_PLAYBACK)
    .addCapability(DeviceCapability.NAVIGATION)
    .build()

val session = crossDeviceManager.createSession(
    SessionConfig.Builder()
        .setResources(listOf(ResourceType.NAVIGATION_STATE, ResourceType.PLAYBACK_CONTROL))
        .setMyParticipant(participant)
        .build()
)
```

This snippet says three things: who I am, with navigation and playback capabilities; what resources I need, navigation state and playback control; and that all of this belongs to one Session. After the peer device discovers the Session through `onSessionAvailable()`, it calls `joinSession()`, and the SDK handles connection setup and capability negotiation automatically.

Compared with Nearby Connections, the SDK takes over "who to connect to, how to connect, and what to do when the connection drops." Business code changes from a hand-written state machine into message-driven logic.

## Message model: from Payload to Resource

Nearby Connections centers its message model on `Payload`: data is wrapped in a Payload object, sent with `sendPayload()`, and received on the remote side through `onPayloadReceived()`.

A Payload is a stateless, one-shot data block. If you send 10 Payloads, receive order depends on the underlying transport. In a remote-navigation scenario, that is fatal.

The Cross-Device SDK introduces the idea of a **Resource**. A Resource is a stateful, shared data object:

```kotlin
// Send a navigation-state change
session.setResource(
    ResourceId.NAVIGATION_STATE,
    navState.toByteArray()
)

// The peer automatically receives Resource update callbacks
override fun onResourceUpdated(session: Session, resourceId: ResourceId, data: ByteArray) {
    when (resourceId) {
        ResourceId.NAVIGATION_STATE -> updateMap(NavigationState.fromByteArray(data))
    }
}
```

The Resource model has clear semantics: do not care how data is transmitted or how many times it is sent; care only about the current state. Internally, the SDK performs incremental synchronization and conflict merging, while the business layer receives an eventually consistent state.

One detail missing from the documentation: keep Resource update frequency below 30 Hz. Above that threshold, the SDK's internal merge strategy can accumulate latency. For high-frequency data such as touch coordinates, use your own UDP side channel.

## Reconnection and discovery: engineering details that still matter

The Cross-Device SDK handles reconnection automatically, but the app still has to deal with several edge cases.

**Device discovery latency.** The default scan interval is 60 seconds. If two devices are only briefly near each other, such as a rear-seat passenger who wants to use the tablet immediately after getting in the car, discovery often misses. Tune the scan parameters:

```kotlin
val discoveryConfig = DiscoveryConfig.Builder()
    .setScanMode(ScanMode.LOW_LATENCY)  // trade battery for speed
    .setScanIntervalSeconds(15)
    .build()
```

On my test devices, `LOW_LATENCY` reduced discovery time from 8-12 seconds to 2-3 seconds, but standby power consumption increased by about 15%. Call `stopDiscovery()` promptly when continuous discovery is no longer needed.

**State recovery after Session recreation.** After a successful reconnect, the Session is a new instance. Previously held Resources are not automatically synchronized back. The app needs to call `session.requestResource()` to fetch them again. I wrapped this in a Repository:

```kotlin
class MultiDeviceRepository(private val sessionManager: SessionManager) {
    
    private val stateBackup = mutableMapOf<ResourceId, ByteArray>()
    
    suspend fun onSessionRestored(session: Session) {
        stateBackup.forEach { (id, data) ->
            session.setResource(id, data) // restore the latest local state
        }
        remoteResources.forEach { id ->
            session.requestResource(id)   // fetch missing state from the peer
        }
    }
}
```

**Multi-device role assignment.** The Cross-Device SDK does not define server/client roles for you. You need your own convention. My approach was to include a `priority` parameter during device negotiation. The device with the strongest power profile, usually the plugged-in center console, automatically becomes the coordinator responsible for forwarding and state merging.

## Pitfalls

1. **ProGuard rules.** The Cross-Device SDK relies heavily on Protobuf and reflection. Incorrect obfuscation rules can crash the app:

```text
-keep class com.google.android.gms.crossdevice.** { *; }
-keep class com.google.crossdevice.proto.** { *; }
```

2. **Testing is hard.** Multi-device integration tests must run on real devices. Emulators do not support the lower-level Wi-Fi/BLE protocol stacks. I put four Pixel devices into a device pool in CI and scheduled them remotely through ADB.

3. **Aggressive battery optimization on domestic phones.** Some vendors' power-saving policies can kill the background Service directly, and the Nearby Connections link drops immediately. The Cross-Device SDK uses a foreground Service to stay alive, but it can still be killed under system-level battery-saving modes. There is no universal fix; you can only guide users to add the app to the allowlist.

4. **Do not mix Nearby Connections and the Cross-Device SDK.** The two SDKs share the underlying Transport layer but are not compatible. Running both at the same time can cause port conflicts and sharply reduce connection success rate. Pick one and migrate fully.

The Cross-Device SDK simplifies multi-device collaboration from a hand-written state machine into "declare capabilities and exchange Resources." But dirty work such as session restoration, discovery tuning, and vendor compatibility still belongs to the app. It fits medium- and low-frequency data synchronization scenarios, such as document collaboration, media control, and IoT configuration. For low-latency audio and video streams, use WebRTC.
