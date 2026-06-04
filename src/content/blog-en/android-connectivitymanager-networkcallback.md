---
title: "Android ConnectivityManager Deep Dive: From NetworkCallback to Adaptive Network Switching"
lang: en
translationKey: android-connectivitymanager-networkcallback
slug: android-connectivitymanager-networkcallback
excerpt: "From NetworkInfo's limits to the NetworkCapabilities model, this article explains real-time network monitoring and adaptive switching with ConnectivityManager."
publishDate: '2026-03-05'
tags:
- "Android"
- "ConnectivityManager"
- "Networking"
- "Performance"
- "Kotlin"
seo:
  title: "Android ConnectivityManager: NetworkCallback and Adaptive Network Switching"
  description: "Understand Android ConnectivityManager, NetworkCapabilities, NetworkCallback, socket binding, and ConnectivityDiagnostics for poor-network handling."
  pageType: article
---

While building a video calling SDK, we hit a painful issue: at the instant Wi-Fi switched to 4G, every in-flight packet timed out, and the remote video froze for three to five seconds before recovering. Logs showed that by the time the business layer received the network-disconnected callback, the underlying TCP connection was already dead.

The root cause was simple: our mental model of Android networking was still stuck in the `NetworkInfo.isConnected()` era.

## NetworkInfo's fatal flaw: why Google deprecated it

Before Android 5.0, network-state checks usually looked like this:

```java
ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
NetworkInfo info = cm.getActiveNetworkInfo();
if (info != null && info.isConnected()) {
    // Start the request
}
```

This code has two major problems.

First, **"connected" does not mean "usable."** A phone can be connected to a Wi-Fi router while that router has no Internet access, and `isConnected()` still returns `true`. Your request then times out with no early signal.

Second, **Android 5.0+ devices may be connected to Wi-Fi and cellular at the same time.** `getActiveNetworkInfo()` returns only one "default" network, so you do not know which network the system chose underneath. If the system moves the default route from Wi-Fi to cellular, the old network bound to your Socket may already be invalid while new requests remain unaware.

Google introduced `NetworkCapabilities` in API 21 and fully deprecated `NetworkInfo` in API 29. This was not a simple class-name swap. It was a redesign of the network model.

## NetworkCapabilities: from "is it connected?" to "what can it do?"

The core idea of `NetworkCapabilities` is: **do not ask what type of network it is; ask what capabilities it provides.**

```kotlin
val cm = getSystemService(ConnectivityManager::class.java)
val network = cm.activeNetwork
val caps = cm.getNetworkCapabilities(network)

caps?.let {
    // Capability checks, not type checks
    val hasInternet = it.hasCapability(NET_CAPABILITY_INTERNET)
    val isValidated = it.hasCapability(NET_CAPABILITY_VALIDATED)
    val notMetered = !it.hasCapability(NET_CAPABILITY_NOT_METERED)
    val bandwidth = it.linkDownstreamBandwidthKbps
}
```

Key fields:

- **`NET_CAPABILITY_INTERNET`**: this network can reach the public Internet, which is much more precise than `isConnected()`
- **`NET_CAPABILITY_VALIDATED`**: the system has performed connectivity validation, such as probing `connectivitycheck.gstatic.com`, and confirmed the network really works. This became my primary signal for poor-network optimization
- **`NET_CAPABILITY_NOT_METERED`**: whether the network is unmetered; Wi-Fi is usually `true`, cellular is usually `false`
- **`linkDownstreamBandwidthKbps`**: estimated bandwidth, which is more reliable for adaptive bitrate decisions than hard-coding Wi-Fi versus 4G

A common misconception: many developers still use `NetworkCapabilities.hasTransport(TRANSPORT_WIFI)` to decide whether the device is on Wi-Fi. That is unreliable on dual-network devices. Wi-Fi and cellular may both exist, but only one of them may currently provide Internet capability.

## NetworkCallback: stop polling network state

The old approach was to periodically call `getActiveNetworkInfo()`. It wastes power and reacts late. The correct model is to register a `NetworkCallback`:

```kotlin
val request = NetworkRequest.Builder()
    .addCapability(NET_CAPABILITY_INTERNET)
    .addCapability(NET_CAPABILITY_VALIDATED)
    .build()

val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
        // The network is available; a Socket can be bound to it
        Log.d("Net", "available: $network")
    }

    override fun onCapabilitiesChanged(
        network: Network, caps: NetworkCapabilities
    ) {
        // Capabilities changed, such as Wi-Fi validation or bandwidth updates
        val bw = caps.linkDownstreamBandwidthKbps
    }

    override fun onLost(network: Network) {
        // The network is truly gone
    }
}

cm.registerNetworkCallback(request, callback)
```

Pay attention to the difference between `onLost` and `onUnavailable`: `onUnavailable` fires when the requested conditions are not met within the specified time, while the network itself may still exist. `onLost` means the network is actually gone. For connection migration, trigger the switch from `onLost`, not `onUnavailable`.

Another trap: **`onAvailable` may arrive before `NET_CAPABILITY_VALIDATED`.** If you immediately send a request in `onAvailable`, it may fail because the network has not finished validation. Prefer checking the `VALIDATED` flag in `onCapabilitiesChanged` before sending traffic.

## NetworkRequest binding: make the connection follow the network

Once you know when a network is usable, the next step is binding business connections to a specific network. Android's networking APIs support this natively:

```kotlin
// Bind OkHttp to a specific network
val client = OkHttpClient.Builder()
    .socketFactory(network.socketFactory)
    .build()

// Native HttpURLConnection
val conn = network.openConnection(url) as HttpURLConnection

// Cronet
val engine = CronetEngine.Builder(context)
    .setDefaultNetwork(network)
    .build()
```

**Binding matters because** all traffic for that Socket goes only through the specified network. When the system switches the default network, your bound Socket is not affected. But if the bound network is lost, you must actively migrate.

In a real project, migration logic usually looks like this:

```kotlin
override fun onLost(network: Network) {
    // Mark the current connection as needing migration
    pendingMigration = true
}

override fun onAvailable(network: Network) {
    if (pendingMigration) {
        // A new network is available; bind again
        rebindSocket(network)
        pendingMigration = false
    }
}
```

There is one detail here: a window exists between `onLost` and `onAvailable`. During that window, if the Socket has not yet noticed that the old network is gone because TCP retransmission is still in progress, data may pile up in the kernel buffer. A practical fix is to set a shorter Socket timeout or actively `close()` the old connection after `onLost`.

## Three engineering points that matter

### 1. Bind monitoring to a foreground service to avoid being killed

If the process is in the background and the system freezes it during a network switch, `NetworkCallback` will not fire. In practice, **any module that depends on real-time network state should run inside a foreground service.**

```kotlin
// In the Service that registers NetworkCallback
startForeground(NET_MONITOR_ID, notification)
```

This is not just a best-practice preference. It follows from Android's background execution limits. Android 8.0+ places strict limits on network callbacks for background services. Without a foreground service, callback delays during network switches can reach minutes.

### 2. Use ConnectivityDiagnostics for active probing

API 29 added `ConnectivityDiagnosticsManager`, which can actively detect network quality issues:

```kotlin
val diagManager = getSystemService(ConnectivityDiagnosticsManager::class.java)
diagManager.registerConnectivityDiagnosticsCallback(
    NetworkRequest.Builder()
        .addCapability(NET_CAPABILITY_INTERNET)
        .build(),
    executor,
    object : ConnectivityDiagnosticsCallback() {
        override fun onDataStallSuspected(report: DataStallReport) {
            // Suspected data stall; actively trigger migration
            triggerNetworkMigration()
        }
    }
)
```

`onDataStallSuspected` is system-level stall detection. When the lower layers keep sending data but no ACKs come back, the system invokes this callback. Compared with app-level timeout and retry logic, this signal often arrives two to three seconds earlier, which noticeably improves poor-network experience.

### 3. Choose a strategy when multiple networks are available

Android 12+ supports simultaneous Wi-Fi and cellular use. If your app needs low latency, such as a game or video call, you can explicitly request cellular as a hot standby:

```kotlin
val cellularRequest = NetworkRequest.Builder()
    .addCapability(NET_CAPABILITY_INTERNET)
    .addTransportType(TRANSPORT_CELLULAR)
    .build()

cm.requestNetwork(cellularRequest, callback)
```

Do not blindly enable dual channels, though. In my tests on several mid-range devices, concurrent Wi-Fi and cellular increased cellular modem power consumption by about 15% to 20%. For short-video or news apps, one `VALIDATED` network is enough. Dual channels are worth the power cost only in latency-sensitive scenarios.

## Closing thoughts

Three conclusions are directly usable:

**Model network state as "capability," not "type."** Stop writing code like `if (wifi) { highQuality() }`. Use `linkDownstreamBandwidthKbps` and `VALIDATED` instead; that code will age better.

**Bind connections to a `Network` object instead of relying on the system default route.** OkHttp, Cronet, and native Sockets all support binding. Put migration logic in `NetworkCallback` so connections follow the network.

**`onDataStallSuspected` is one of the most valuable APIs for poor-network optimization.** App-level timeout retries usually wait five to ten seconds. System-level stall detection can shorten that to two or three seconds. For real-time transmission apps, those three seconds can decide whether users stay or close the app.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Binder internals: from driver communication to the AIDL call chain](/en/blog/android-binder/)
- [Getting started with Android Perfetto: capture traces, read tracks, and diagnose performance](/en/blog/android-perfetto/)
- [Android ANR trace governance: from input dispatch timeouts to thread stack diagnosis](/en/blog/android-anr-trace-governance/)
<!-- /seo-internal-links -->
