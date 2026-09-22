---
title: "Android Wi-Fi Connections: Use Modern APIs and Debug Layers"
lang: en
translationKey: android-wifi-connection-wifimanager-wpa-supplicant
slug: android-wifi-connection-wifimanager-wpa-supplicant
excerpt: "Choose the correct Android Wi-Fi API, handle permissions and callbacks, and isolate failures from app policy through the Wi-Fi stack."
publishDate: '2026-06-09'
updatedDate: '2026-09-22'
tags:
- "Android"
- "Wi-Fi"
- "System Architecture"
- "wpa_supplicant"
- "Debugging"
seo:
  title: "Android Wi-Fi Connections: Modern APIs and Debugging"
  description: "Connect Android devices with WifiNetworkSpecifier or suggestions, handle Android 13 permissions, and debug Wi-Fi failures by layer."
  pageType: article
---

For ordinary apps on Android 10+ (API 29+), `WifiManager` is no longer a general-purpose saved-network controller. Use `WifiNetworkSpecifier` for a user-approved, local connection for the current app, and `WifiNetworkSuggestion` when the system may auto-connect later. `WifiManager.setWifiEnabled()` always returns `false` for apps targeting Android 10+, and direct configured-network management is restricted to privileged apps or device-policy controllers.

That distinction fixes many misleading “Wi-Fi connected but my app has no network” reports: an accepted API request is not a completed association, an IP lease, internet validation, or the default network changing for the process.

## Pick the API by the user outcome

| Need | API | Important boundary |
| --- | --- | --- |
| Set up a camera or accessory on its local AP now | `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork()` | Android 10+; user approval is part of the flow; it is scoped to the request |
| Offer credentials for future internet auto-connect | `WifiNetworkSuggestion` | Android 10+; the platform chooses whether to connect |
| Let a user save a network | `Settings.ACTION_WIFI_ADD_NETWORKS` | Android 11+; system UI asks the user to approve |
| Toggle Wi-Fi or edit arbitrary saved networks | Not available to a normal app | Android 10+ restriction |

Do not use a `WifiNetworkSpecifier` for a background “connect whenever possible” feature. It is designed for a specific request, often an IoT onboarding flow. Suggestions are also not a success guarantee: the framework scores candidates and the user can revoke the app's suggestions.

## Permissions change with the API level

For an app targeting Android 13+ (API 33+), declare and request `NEARBY_WIFI_DEVICES` for connection-management APIs. It belongs to the Nearby devices runtime group. Scanning still has a location implication: `WifiManager.startScan()` and `getScanResults()` require `ACCESS_FINE_LOCATION`, even on Android 13+.

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
<!-- Retain location for pre-33 Wi-Fi behavior; omit maxSdkVersion if scanning needs it on 33+. -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="32" />
```

If the app scans on Android 13+, remove `maxSdkVersion` and request precise location at runtime for that feature. Calling a protected API without its required permission can throw `SecurityException`; test the denied path rather than assuming a null result means denial.

## A complete request-scoped connection example

The callback is the result contract. `onAvailable()` means Android made a matching network available; use the supplied `Network` for sockets, or explicitly bind the process for a short, user-visible flow. Always unregister the callback.

```kotlin
class DeviceSetupController(private val connectivityManager: ConnectivityManager) {
    private var activeCallback: ConnectivityManager.NetworkCallback? = null

    fun connect(ssid: String, wpa2Passphrase: String) {
        val isValidWpa2Passphrase = wpa2Passphrase.length in 8..63 &&
            wpa2Passphrase.all { it.code in 0x20..0x7e }
        require(isValidWpa2Passphrase) {
            "WPA2 passphrase must be 8–63 printable ASCII characters"
        }
        disconnect() // Keep only one request for this setup screen.
        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(ssid).setWpa2Passphrase(wpa2Passphrase).build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .setNetworkSpecifier(specifier).build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Use network.socketFactory / network.openConnection for this local session.
            }
            override fun onUnavailable() { /* Show a retry path. */ }
            override fun onLost(network: Network) { /* Stop device work and update the UI. */ }
        }
        activeCallback = callback
        connectivityManager.requestNetwork(request, callback)
    }

    fun disconnect() {
        activeCallback?.let(connectivityManager::unregisterNetworkCallback)
        activeCallback = null
    }
}
```

Call `disconnect()` from the setup screen's `onStop()`, a ViewModel's `onCleared()`, or the explicit “leave setup” action. Do not unregister immediately after `requestNetwork()`, or the request can be cancelled before `onAvailable()`. `WifiManager.getConnectionInfo()` is deprecated from API 31; the precise replacement is to observe the requested `Network` and its capabilities, then validate the application's own protocol—for example, an HTTPS health request to the accessory—because Wi-Fi association alone says nothing about DHCP, captive portals, or the target service.

## Debug from framework intent to radio state

For a normal production app, start with your `NetworkCallback` timeline and exception logs. On a debuggable device or platform build, then move down the stack:

```bash
# Framework state, recent events, configured interfaces and suggestions.
adb shell dumpsys wifi

# Connectivity's view of active and requested networks.
adb shell dumpsys connectivity

# Captured framework/service logs; use a narrow filter while reproducing.
adb logcat -b all | grep -iE 'Wifi|wpa_supplicant|ConnectivityService'
```

Interpret the observations in order:

1. `onUnavailable()` with no framework error usually points to request constraints, denied permission, user rejection, or no matching AP—not a driver conclusion.
2. A network that becomes available but cannot reach the local service points to IP/DNS/routing or the device protocol. Test with `network.socketFactory`, so a different default network cannot hide the fault.
3. Repeated association or authentication failures in `dumpsys wifi`/platform logs warrant OEM or system-image investigation. The framework, HAL, `wpa_supplicant`, kernel `cfg80211`/`nl80211`, and vendor driver participate, but their exact state-machine names and shell tools vary by Android release and OEM.

Avoid instructing end users to run `wpa_cli`: it is generally unavailable or permission-restricted on production builds. It is a platform-engineering tool, not an app-level confirmation method. Likewise, a BSSID avoidance/blacklist decision is implementation and version dependent; capture system logs before assigning it as the cause.

## Official references and related reading

- [Request permission to access nearby Wi-Fi devices](https://developer.android.com/develop/connectivity/wifi/wifi-permissions) lists API 33 permission boundaries and scan exceptions.
- [Wi-Fi suggestion API](https://developer.android.com/develop/connectivity/wifi/wifi-suggest) explains the system-selected, future-connect use case.
- [Android 10 privacy changes](https://developer.android.com/about/versions/10/privacy/changes) documents the `setWifiEnabled()` and configured-network restrictions.
- [Advanced Android network programming](/en/blog/android-advanced-network-programming-optimization-part3/) covers transport-level retries and observability once connectivity is established.
- [Android BLE GATT scanning and long connections](/en/blog/android-ble-gatt-scanning-long-connection/) is useful when an accessory offers both Wi-Fi and Bluetooth setup paths.
