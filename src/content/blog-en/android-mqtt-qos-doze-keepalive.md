---
title: 'Android MQTT Communication End to End: From Paho QoS Semantics to Doze-Mode Keepalive Engineering'
lang: en
translationKey: android-mqtt-qos-doze-keepalive
slug: android-mqtt-qos-doze-keepalive
excerpt: From MQTT QoS semantics and Paho acknowledgment retransmission to Doze-mode long-connection keepalive, a complete reliability chain and engineering practice for Android IoT communication.
publishDate: '2026-09-02'
tags:
- Android
- MQTT
- Kotlin
- IoT
- Long-Connection Keepalive
- Doze Mode
seo:
  title: 'Android MQTT: QoS Semantics, Paho Retry, and Doze Keepalive'
  description: How QoS 1 semantics, Paho persistence and retry, and Doze-mode mitigations work together for reliable Android MQTT delivery.
  pageType: article
---

While building a smart-hardware app, I ran into a strange issue: the device was online and the network was fine, but after the phone was locked for about ten minutes, commands pushed from the cloud took more than ten minutes to reach the app. Tracing the path, I first suspected the broker, then suspected Paho of dropping messages, and finally located the cause in Android's Doze mode cutting the long-lived connection. That investigation made me re-examine the full MQTT chain on Android: QoS guarantees message semantics, Paho handles acknowledgments and retransmission, and keepalive determines whether the connection survives.

## QoS Semantics Decide Whether a Message Gets Lost

MQTT QoS is not a network-speed metric; it is an acknowledgment protocol between sender and receiver, divided into three levels:

- **QoS 0 (At most once)**: fire and forget, waits for no ACK, and may lose messages.
- **QoS 1 (At least once)**: the receiver replies with PUBACK; if it is not received, the message is resent, so duplicates are possible.
- **QoS 2 (Exactly once)**: the PUBLISH/PUBREC/PUBREL/PUBCOMP four-step handshake guarantees delivery exactly once.

For mobile downlink commands, I recommend consistently using QoS 1. QoS 0 dropping commands on weak networks is unacceptable; QoS 2 requires a four-step handshake, whose round-trip cost is high when the mobile network jitters, and "exactly once" provides limited value for most control commands—deduplicating repeated commands at the business layer with idempotency is cheaper.

## Paho Client Acknowledgments and Retransmission

The Paho Android client maps QoS semantics to two configurations: cleanSession and persistence.

```kotlin
val options = MqttConnectOptions().apply {
    isCleanSession = false          // 断线后 broker 保留会话
    keepAliveInterval = 30          // PINGREQ 间隔，单位秒
    isAutomaticReconnect = true
    setWill("device/offline", "0".toByteArray(), 1, true)
}
```

`isCleanSession = false` makes the broker remember subscriptions and buffer QoS 1/2 messages while the client is disconnected. After the client reconnects, Paho first completes unacknowledged inflight messages before processing new ones.

Here I hit a pitfall: Paho uses `MemoryPersistence` by default, so inflight messages are kept only in memory. If the process is killed, that state disappears and reconnection cannot recover it. To survive system process kills, switch to `MqttDefaultFilePersistence`.

```kotlin
MqttAndroidClient(context, uri, clientId, MqttDefaultFilePersistence())
```

## How Doze Mode Kills Long-Lived Connections

Android 6.0 introduced Doze: after the screen is off, the device is stationary, and it has been unplugged for a while, the system enters deep sleep, suspends network access, ignores WakeLocks, and defers AlarmManager. **A foreground service does not equal Doze exemption**—it can only protect process priority and avoid App Standby's process freezing, while Doze is a device-level power policy that still cuts the network.

I have seen many teams assume that a foreground service plus a heartbeat is enough, only to find that after the screen locks the MQTT PINGREQ cannot be sent at all, and the TCP connection is judged timed out and dropped by intermediate devices or the broker. The ten-plus-minute delay at the start came from exactly this: Doze only restores the network during maintenance windows, and Paho reconnects only then, after which the backlogged commands arrive.

## Keepalive Strategy: Foreground Service, WakeLock, and Whitelist

My engineering solution has three layers:

First, the foreground service withstands background execution limits. After Android 8.0 ordinary background services are killed, so use a foreground service with a persistent notification to keep the process alive:

```kotlin
class MqttService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification())
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mqtt:keepalive")
            .apply { acquire() }
        connect()
    }
}
```

Second, guide users to add the app to the battery optimization whitelist; this is the key step that truly bypasses Doze:

```kotlin
val pm = getSystemService(PowerManager::class.java)
if (!pm.isIgnoringBatteryOptimizations(packageName)) {
    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:$packageName")
    })
}
```

Third, set keepAliveInterval to 30 seconds in MqttConnectOptions, combined with automatic reconnect. The heartbeat lets the broker promptly detect half-open connections; it cannot fight Doze alone, but it is the backstop in the whole chain.

If the product can accept second-to-minute-level latency, I recommend FCM high-priority push to wake the app and rebuild MQTT instead of keeping the long-lived connection hard alive all the time. Battery saving and low latency are a trade-off; don't try to have both.

## Three Engineering Decisions

In practice I stick to three choices:

- **Use QoS 1 for downlink commands, combined with business idempotency.** It neither silently drops messages nor pays the weak-network cost of QoS 2's four-step handshake.
- **Use LWT with retained messages for device online status.** The `device/offline` will message is published automatically by the broker on abnormal disconnect, which is far more reliable than the app reporting its own status.
- **Use exponential backoff with random jitter for reconnection.** On weak networks, fixed-interval reconnects amplify broker pressure; I usually increase 1s, 2s, 4s, capping at 60s.

Back to the original question: the reliability of an MQTT communication chain is never guaranteed by any single point. QoS manages semantics, Paho manages retransmission, and keepalive manages the connection. If any one of the three is missing, a cloud command can be silently swallowed at some link.
