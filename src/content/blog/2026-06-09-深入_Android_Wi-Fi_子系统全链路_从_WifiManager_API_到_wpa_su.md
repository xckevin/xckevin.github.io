---
title: Android Wi-Fi 连接管理全链路深度解析：从 WifiManager 到驱动层
slug: android-wifi-connection-wifimanager-wpa-supplicant
translationKey: android-wifi-connection-wifimanager-wpa-supplicant
excerpt: 深入剖析 Android Wi-Fi 连接从应用层 WifiManager 到驱动层 nl80211 的完整链路，涵盖 WifiService 状态机、wpa_supplicant 四次握手、BSSID 黑名单机制及分层排查实践。
publishDate: '2026-06-09'
tags:
- Android
- Wi-Fi
- 系统架构
- wpa_supplicant
- 调试
seo:
  title: Android Wi-Fi 连接管理全链路深度解析：从 WifiManager 到驱动层
  description: 从 WifiManager API 到底层驱动，逐层拆解 Android Wi-Fi 连接全链路。深入 wpa_supplicant 状态机、BSSID 黑名单机制及 nl80211 通信原理，提供实用分层排查方法。
---

去年在一个 IoT 项目里，我遇到一个诡异问题：`WifiManager.connect()` 返回成功，但设备一直没连上目标 AP。logcat 里 Wi-Fi 状态在 CONNECTING 和 DISCONNECTED 之间反复横跳，没有任何异常堆栈。排查到一半才发现，问题出在 wpa_supplicant 的 BSSID 黑名单逻辑——上层 API 完全感知不到这个行为。

这条链路比大多数人想象的深。下面从 API 到驱动，串一遍 Android Wi-Fi 连接管理的全链路。

## 应用层入口：WifiManager 的异步本质

开发者最熟悉的入口是 `WifiManager`：

```java
WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
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

这是 Android 10 引入的推荐方式，通过 `ConnectivityManager` 发起连接请求。老 API `wifiManager.enableNetwork()` + `reconnect()` 虽然还能用，但在多网络场景下行为不可预测——系统可能同时维持蜂窝网络，而不是切换到 Wi-Fi。

这个 API 有个容易被忽略的特性：**它是异步的，且不保证结果**。`requestNetwork()` 只是向系统提交了一个"网络偏好"，Wi-Fi 模块是否采纳、何时采纳，上层无法控制。我踩过的坑是：在高密度 AP 环境下，设备可能因为 BSSID 层面的原因拒绝连接，但 `onAvailable()` 回调永远不会触发，也不会报错。

## 系统服务层：WifiService 的调度模型

应用层的请求经过 Binder IPC 进入 `system_server` 进程中的 `WifiService`。核心实现类 `WifiServiceImpl` 承担了权限校验、状态管理和并发控制：

```java
// frameworks/opt/net/wifi/service/java/com/android/server/wifi/WifiServiceImpl.java
@Override
public void connect(String packageName, String featureId, WifiConfiguration config,
        int netId, IActionListenerWrapper listener) {
    mWifiPermissionsUtil.enforceCanAccessScanResults(packageName, ...);
    mWifiThreadRunner.post(() -> {
        mClientModeImpl.connectNetwork(config, netId);
        listener.onSuccess();
    });
}
```

两个设计要点：

**一是 `WifiThreadRunner`（即 `WifiHandlerThread`）**。Wi-Fi 相关的所有状态变更都在这个单线程上串行执行，避免了锁竞争。代价是——如果某个操作在 HAL 层阻塞（比如驱动无响应），整个 Wi-Fi 模块都会卡住。我在系统稳定性专项里见过这类问题，表现为 Wi-Fi 开关按钮点击后无任何反应，最终靠 `WifiWatchdog` 超时重启机制恢复。

**二是 `ClientModeImpl`（旧称 `WifiStateMachine`）**。这是整个 Wi-Fi 模块的心脏，一个标准的层次状态机（Hierarchical State Machine）。关键状态包括：

- `DefaultState`：处理全局消息，如驱动加载、接口销毁
- `SupplicantStartedState`：wpa_supplicant 进程已启动，等待连接指令
- `ConnectModeState`：扫描和连接的主状态
- `L2ConnectedState`：二层链路已建立，等待 DHCP
- `ObtainingIpState`：正在获取 IP

状态机用 `StateMachine` 框架实现，消息传递依赖 `sendMessage()`。每个状态只处理自己关心的 `what`，其他消息交给父状态，靠父子继承关系自然形成职责链。

## WifiNative 与 SupplicantStaIfaceHal：HIDL 边界

从 Java 层到 native 层的跨越由 `WifiNative` 完成。通过 JNI 调用 `com_android_server_wifi_WifiNative.cpp`，进入 HIDL（Hardware Interface Definition Language）定义的 HAL 接口。

Android 10 之后，Wi-Fi HAL 拆分为多个独立接口：

```
IWifiChip.hal      → 芯片管理（模式切换、能力查询）
IWifiStaIface.hal  → STA 模式接口（扫描、连接、漫游）
ISupplicant.hal    → wpa_supplicant 代理接口
ISupplicantStaIface.hal → supplicant STA 操作
```

`SupplicantStaIfaceHal` 封装了与 `ISupplicantStaIface.hal` 的通信。以发起连接为例：

```cpp
// frameworks/opt/net/wifi/libwifi_system/supplicant_sta_iface_hal.cpp
SupplicantStatus SupplicantStaIfaceHal::connectToNetwork(
    const NetworkConfig& config) {
    sp<ISupplicantStaNetwork> network;
    // 在 wpa_supplicant 中创建或更新网络配置
    auto status = addNetwork(config, &network);
    if (!status.isOk()) return status;
    // 发起连接
    return network->select();
}
```

HIDL 调用最终通过 `hwservicemanager` 路由到 vendor 分区的 HAL 实现。这条路径上有一个常见的稳定性问题：**HAL 服务进程崩溃会导致上层抛出 `TransactionFailed` 异常**。Google 的做法是引入 `ISupplicantCallback`——当 HAL 异常退出时，通过回调通知上层状态机触发恢复流程。

## wpa_supplicant：连接状态机的灵魂

wpa_supplicant 是 Wi-Fi 连接的核心守护进程，实现了 IEEE 802.11 的 supplicant 协议栈。它通过 **control interface**（Unix domain socket，默认路径 `/data/vendor/misc/wifi/sockets/wpa_ctrl_*`）接收上层指令。

wpa_supplicant 内部维护了一个分层状态机：

```
DISCONNECTED → SCANNING → ASSOCIATING → ASSOCIATED
                                  ↓
                          4-WAY HANDSHAKE
                                  ↓
                            COMPLETED
```

每个状态转换都对应一组 802.11 管理帧的交互。以 WPA2 连接为例，完整流程是：

1. **扫描**：probe request → probe response（或被动接收 beacon）
2. **认证**：auth request → auth response（802.11 开放系统认证）
3. **关联**：association request → association response
4. **四次握手**：ANonce/SNonce 交换，推导 PTK（Pairwise Transient Key）
5. **组密钥握手**：GTK 分发

BSSID 黑名单机制是这里最容易踩的坑。如果驱动层连续多次关联失败（`max_assoc_failures`，默认值通常是 3），wpa_supplicant 会将该 BSSID 加入黑名单，在一定时间内（`bssid_ignore_timeout`，默认 60 秒）跳过这个 AP。这就是我开头遇到问题的根因——上层 API 只知道"没连上"，看不到黑名单逻辑。

查看黑名单状态：

```bash
adb shell wpa_cli -i wlan0 blacklist
```

清空黑名单：

```bash
adb shell wpa_cli -i wlan0 blacklist clear
```

## 驱动层：nl80211 与内核交互

wpa_supplicant 通过 **nl80211**（Netlink 协议族）与内核中的 cfg80211/mac80211 框架通信。这是一条基于 Netlink socket 的消息通道，每条 nl80211 命令对应一个 802.11 操作：

```c
// 发起扫描：wpa_supplicant 构造 NL80211_CMD_TRIGGER_SCAN
struct nl_msg *msg = nl80211_drv_msg(drv, 0, NL80211_CMD_TRIGGER_SCAN);
nla_put(msg, NL80211_ATTR_IFINDEX, drv->ifindex);
// ... 填充扫描参数
nl80211_send(drv, msg);  // 通过 netlink socket 发送到内核
```

内核收到命令后，调用无线网卡驱动的 `ieee80211_ops` 回调，最终操作硬件寄存器完成射频操作。从应用层 `requestNetwork()` 到驱动层寄存器写入，这条链路经过了 **7 个进程边界**（App → system_server → HAL daemon → wpa_supplicant → Kernel → Driver），任何一个环节的异常都会导致连接失败。

## 排查工具箱

在实际问题排查中，我通常会按以下层次定位：

**第一层：确认状态机卡在哪里**

```bash
adb shell dumpsys wifi | grep -A 10 "ClientModeImpl"
```

这条命令输出当前状态、最近的消息历史和 supplicant 连接状态。如果发现状态机长期停在 `SupplicantStartedState` 不往下走，大概率是 wpa_supplicant 本身有问题。

**第二层：直接跟 wpa_supplicant 对话**

```bash
adb shell wpa_cli -i wlan0 status       # 查看当前连接状态
adb shell wpa_cli -i wlan0 list_networks # 查看已保存网络
adb shell wpa_cli -i wlan0 scan_results  # 查看扫描结果
```

`wpa_cli` 绕过 Java 层和 HAL 层，直接操作 wpa_supplicant。如果 `wpa_cli` 能正常发起连接而应用层不行，问题锁定在上层；反之则是 native 层或驱动的问题。

**第三层：抓取 supplicant 日志**

开启调试日志后，wpa_supplicant 会输出每次状态转换、每帧的交互细节和控制命令的响应：

```bash
adb shell wpa_cli -i wlan0 log_level DEBUG
adb logcat -s wpa_supplicant
```

四次握手过程中任何一个步骤失败，日志里都会有明确的 `WPA: 4-Way Handshake failed` 和对应的 reason code。

## 实践建议

Wi-Fi 连接问题排查，不要从 logcat 乱翻。先确认状态机位置，再用 `wpa_cli` 排除 native 层问题，最后才看驱动日志。这条分层排查路径帮我节省了大量时间。

做 Wi-Fi 相关的 SDK 开发时，用 `ConnectivityManager` 的 `NetworkCallback` 而不是轮询 `WifiManager.getConnectionInfo()`。后者返回的是缓存状态，在快速漫游或多网络切换场景下会滞后 500ms 以上，不够可靠。

如果需要在连接前预筛选 AP，直接在 `WifiNetworkSpecifier` 里指定 BSSID 比连接后再做漫游调整更稳定——少一次重关联，就少一次被黑名单机制拦截的风险。
