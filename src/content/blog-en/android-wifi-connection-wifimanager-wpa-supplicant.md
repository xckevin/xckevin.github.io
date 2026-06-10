---
title: "Android Wi-Fi Connection Management: From WifiManager to the Driver Layer"
lang: en
translationKey: android-wifi-connection-wifimanager-wpa-supplicant
slug: android-wifi-connection-wifimanager-wpa-supplicant
excerpt: "An end-to-end trace of Android Wi-Fi connection management, from WifiManager and WifiService state machines to wpa_supplicant, BSSID blacklists, nl80211, and layered debugging."
publishDate: '2026-06-09'
tags:
- "Android"
- "Wi-Fi"
- "System Architecture"
- "wpa_supplicant"
- "Debugging"
seo:
  title: "Android Wi-Fi: WifiManager, wpa_supplicant, and Driver Layer"
  description: "Trace Android Wi-Fi connection flow from WifiManager to wpa_supplicant and nl80211, with state-machine analysis and debugging tools."
  pageType: article
---

In an IoT project, I once hit a strange issue: `WifiManager.connect()` reported success, but the device never connected to the target AP. Logcat showed Wi-Fi bouncing between CONNECTING and DISCONNECTED with no useful exception. The root cause turned out to be wpa_supplicant's BSSID blacklist behavior, which the upper API did not expose clearly.

The Wi-Fi connection chain is deeper than many app developers expect. This article walks from API to driver layer.

## App Layer: WifiManager Is Asynchronous

The modern recommended entry on Android 10+ is a network request through ConnectivityManager:

```java
WifiNetworkSpecifier spec = new WifiNetworkSpecifier.Builder()
    .setSsid("MyWiFi")
    .setWpa2Passphrase("password")
    .build();

NetworkRequest request = new NetworkRequest.Builder()
    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
    .setNetworkSpecifier(spec)
    .build();

connectivityManager.requestNetwork(request, callback);
```

The key detail is that this is asynchronous and not a hard guarantee. The request expresses preference and constraints; the system decides whether and when to connect. In dense AP environments, BSSID-level failure can prevent connection without producing a clean app-layer error.

Older `enableNetwork()` and `reconnect()` flows still exist in legacy code, but their behavior is harder to reason about under modern multi-network policy.

## System Service: WifiService Scheduling

App requests enter `system_server` through Binder and reach `WifiServiceImpl`. This layer performs permission checks, state coordination, and message dispatch:

```java
public void connect(String packageName, String featureId, WifiConfiguration config,
        int netId, IActionListenerWrapper listener) {
    mWifiPermissionsUtil.enforceCanAccessScanResults(packageName, ...);
    mWifiThreadRunner.post(() -> {
        mClientModeImpl.connectNetwork(config, netId);
        listener.onSuccess();
    });
}
```

Two details matter.

First, Wi-Fi state changes are serialized on a Wi-Fi handler thread. This avoids lock-heavy concurrency, but if a HAL operation blocks, the entire module can appear stuck.

Second, `ClientModeImpl` is the heart of the Wi-Fi state machine. Important states include:

- `DefaultState`
- `SupplicantStartedState`
- `ConnectModeState`
- `L2ConnectedState`
- `ObtainingIpState`

When a connection gets stuck, the first question should be: which state is the machine in?

## WifiNative and Supplicant HAL

The Java-to-native boundary goes through `WifiNative` and HAL wrappers. Android's Wi-Fi HAL exposes chip, STA interface, and supplicant operations through separate layers.

Conceptually:

```text
WifiManager
  -> WifiServiceImpl
  -> ClientModeImpl
  -> WifiNative
  -> SupplicantStaIfaceHal
  -> wpa_supplicant
```

At this boundary, permission and policy decisions are already done. The remaining work is translating a connection request into supplicant configuration and native control commands.

## wpa_supplicant: The Connection State Machine

`wpa_supplicant` handles scan results, network selection, authentication, association, and WPA/WPA2 handshakes. It is the operational center of STA-mode Wi-Fi.

The connection process includes:

1. scan target SSIDs and BSSIDs.
2. select a candidate AP.
3. authenticate and associate.
4. run the 4-way handshake.
5. notify framework of link state.
6. wait for DHCP and network validation.

BSSID blacklist behavior is a common source of confusion. If a BSSID fails repeatedly, supplicant may temporarily avoid it. The framework might still think a connection attempt was submitted successfully, while the lower layer refuses the candidate.

This is why a purely app-layer interpretation of "connect succeeded" is misleading. It often means "the request was accepted", not "the link is established".

## Driver Layer: nl80211 and Kernel Interaction

Below supplicant, Linux Wi-Fi operations go through `nl80211` and cfg80211/mac80211 abstractions. Supplicant sends netlink messages to the kernel:

```c
struct nl_msg *msg = nl80211_drv_msg(drv, 0, NL80211_CMD_TRIGGER_SCAN);
nla_put(msg, NL80211_ATTR_IFINDEX, drv->ifindex);
nl80211_send(drv, msg);
```

The kernel then calls wireless driver callbacks and eventually controls hardware operations. From app request to radio behavior, the request crosses multiple process and privilege boundaries.

## Debugging Toolbox

Start with the state machine:

```bash
adb shell dumpsys wifi | grep -A 10 "ClientModeImpl"
```

This shows current state, recent messages, and supplicant status. If the machine stays in `SupplicantStartedState`, focus on supplicant or native layers.

Then talk directly to wpa_supplicant:

```bash
adb shell wpa_cli -i wlan0 status
adb shell wpa_cli -i wlan0 list_networks
adb shell wpa_cli -i wlan0 scan_results
```

If `wpa_cli` can connect while app-level APIs cannot, the issue is likely above native. If `wpa_cli` also fails, look at supplicant, HAL, or driver behavior.

Enable supplicant logs when needed:

```bash
adb shell wpa_cli -i wlan0 log_level DEBUG
adb logcat -s wpa_supplicant
```

Four-way handshake failures usually include reason codes in these logs.

## Practical Recommendations

Do not debug Wi-Fi by randomly searching logcat. First locate the state-machine position, then isolate the layer with `wpa_cli`, and only then inspect driver or kernel logs.

For SDK-level Wi-Fi features, prefer `ConnectivityManager.NetworkCallback` over polling `WifiManager.getConnectionInfo()`. The latter may return cached state and lag during roaming or rapid network switches.

If you must preselect an AP, specifying BSSID through `WifiNetworkSpecifier` can be more stable than connecting broadly and then relying on roaming. Fewer reassociations means fewer opportunities to hit blacklist behavior.
