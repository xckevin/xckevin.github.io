---
title: Android Wi-Fi 连接：选择现代 API 与分层排查
slug: android-wifi-connection-wifimanager-wpa-supplicant
translationKey: android-wifi-connection-wifimanager-wpa-supplicant
excerpt: 选择正确的 Android Wi-Fi API，处理权限和回调，并从应用策略到系统 Wi-Fi 栈定位连接失败。
publishDate: '2026-06-09'
updatedDate: '2026-09-22'
tags:
- Android
- Wi-Fi
- 系统架构
- wpa_supplicant
- 调试
seo:
  title: "Android Wi-Fi 连接：现代 API 与分层排查"
  description: "使用 WifiNetworkSpecifier 或 Wi-Fi 建议 API 完成连接，处理 Android 13 权限，并按层定位 Wi-Fi 故障。"
  pageType: article
---

对 Android 10+（API 29+）的普通应用，`WifiManager` 已不是任意保存网络的管理器。当前应用需要用户确认、立即连入本地设备热点时，用 `WifiNetworkSpecifier`；希望系统今后自动连接互联网热点时，用 `WifiNetworkSuggestion`。面向 Android 10+ 的应用调用 `WifiManager.setWifiEnabled()` 恒返回 `false`，直接编辑已配置网络也仅限特权应用或设备策略控制器。

这一区分解释了很多“请求成功但应用不能联网”的问题：请求被系统接受，不等于已完成关联、DHCP、网络验证，更不等于默认网络已经切换给当前进程。

## 按用户目标选 API

| 目标 | API | 关键边界 |
| --- | --- | --- |
| 现在配置摄像头/配件的本地热点 | `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork()` | Android 10+；用户确认是流程的一部分；请求有作用域 |
| 提供凭据供未来自动联网 | `WifiNetworkSuggestion` | Android 10+；是否连接由平台选择 |
| 让用户保存一个网络 | `Settings.ACTION_WIFI_ADD_NETWORKS` | Android 11+；系统界面让用户确认 |
| 开关 Wi-Fi 或编辑任意已保存网络 | 普通应用不可用 | Android 10+ 的限制 |

不要拿 `WifiNetworkSpecifier` 实现后台“随时自动连接”。它是一次具体请求，常用于 IoT 配网；Suggestion 同样不保证成功，系统会对候选网络评分，用户也能撤销该应用的建议。

## 权限取决于 API 与系统版本

target Android 13+（API 33+）并管理 Wi-Fi 连接时，应声明并动态申请 `NEARBY_WIFI_DEVICES`，它属于“附近设备”运行时权限组。扫描仍与位置有关：即使在 Android 13+，`WifiManager.startScan()`、`getScanResults()` 仍需要 `ACCESS_FINE_LOCATION`。

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
<!-- 仅为向后兼容且 Android 13+ 不扫描时使用 maxSdkVersion。 -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="32" />
```

若 Android 13+ 也需要扫描，移除 `maxSdkVersion` 并在使用该功能时申请精确位置。缺少受保护 API 所需权限可能抛出 `SecurityException`；要覆盖拒绝分支，不能把 `null` 当作唯一的拒绝信号。

## 一段完整的请求作用域连接代码

`NetworkCallback` 才是结果契约。`onAvailable()` 表示系统提供了满足请求的网络；应使用回调给出的 `Network` 建立 socket，或仅在短暂且用户可见的流程中显式绑定进程。结束时必须注销回调。

```kotlin
class DeviceSetupController(private val connectivityManager: ConnectivityManager) {
    private var activeCallback: ConnectivityManager.NetworkCallback? = null

    fun connect(ssid: String, wpa2Passphrase: String) {
        val isValidWpa2Passphrase = wpa2Passphrase.length in 8..63 &&
            wpa2Passphrase.all { it.code in 0x20..0x7e }
        require(isValidWpa2Passphrase) {
            "WPA2 passphrase must be 8–63 printable ASCII characters"
        }
        disconnect() // 一个设置页只保留一个 request。
        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(ssid).setWpa2Passphrase(wpa2Passphrase).build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .setNetworkSpecifier(specifier).build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // 使用 network.socketFactory / network.openConnection 建立本次本地连接。
            }
            override fun onUnavailable() { /* 展示重试路径。 */ }
            override fun onLost(network: Network) { /* 停止设备操作并更新 UI。 */ }
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

把 `disconnect()` 放在设置页的 `onStop()`、ViewModel 的 `onCleared()` 或用户明确离开流程的位置；不要紧跟 `requestNetwork()` 立即注销，否则请求会在 `onAvailable()` 前被取消。`WifiManager.getConnectionInfo()` 自 API 31 起已废弃，准确的替代是观察请求回调给出的 `Network`/capabilities，并验证应用自身协议，例如向配件发起 HTTPS 健康检查；Wi-Fi 关联本身无法说明 DHCP、门户认证或目标服务可用。

## 从应用意图排查到无线栈

线上应用先记录 `NetworkCallback` 时间线和异常。可调试设备或平台构建环境中，再逐层向下查看：

```bash
adb shell dumpsys wifi
adb shell dumpsys connectivity
adb logcat -b all | grep -iE 'Wifi|wpa_supplicant|ConnectivityService'
```

结果可这样解释：

1. `onUnavailable()` 通常先指向请求约束、权限拒绝、用户拒绝或找不到匹配 AP，不能直接归因于驱动。
2. 网络已 `onAvailable()` 但连不上本地服务，优先查 IP/DNS/路由或设备协议；用 `network.socketFactory` 测试，避免默认网络掩盖问题。
3. `dumpsys wifi`/平台日志反复出现关联或认证失败，再交给 OEM 或系统镜像侧检查。Framework、HAL、`wpa_supplicant`、`cfg80211`/`nl80211` 与厂商驱动都参与其中，但具体状态机和 shell 工具会随版本、OEM 而变。

不要让终端用户运行 `wpa_cli`：它在量产设备上通常不可用或受权限限制，是平台工程工具而非应用层成功判据。同样，BSSID 避让/黑名单是实现与版本相关的行为，必须先留存系统日志再判断原因。

## 官方资料与延伸阅读

- [申请访问附近 Wi-Fi 设备的权限](https://developer.android.com/develop/connectivity/wifi/wifi-permissions?hl=zh-CN)：API 33 权限边界与扫描例外。
- [Wi-Fi Suggestion API](https://developer.android.com/develop/connectivity/wifi/wifi-suggest)：系统选择、未来连接的使用场景。
- [Android 10 隐私权变更](https://developer.android.com/about/versions/10/privacy/changes?hl=zh-CN)：`setWifiEnabled()` 与已配置网络限制。
- [Android 高级网络编程与优化](/blog/android-advanced-network-programming-optimization-part3/)：建立连接后的重试与可观测性。
- [Android BLE GATT 扫描与长连接](/blog/android-ble-gatt-scanning-long-connection/)：配件同时提供 Wi-Fi/Bluetooth 配网时的相关方案。
