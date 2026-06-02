---
title: 深入 Android ConnectivityManager 全链路：从 NetworkCallback 实时监听到网络切换自适应架构
excerpt: 从 NetworkInfo 缺陷到 NetworkCapabilities 能力模型，解析 ConnectivityManager 实时网络监控与自适应切换架构。
publishDate: '2026-06-02'
tags:
- Android
- ConnectivityManager
- 网络优化
- 性能优化
- Kotlin
seo:
  title: 深入 Android ConnectivityManager 全链路：从 NetworkCallback 实时监听到网络切换自适应架构
  description: 深入解析 Android ConnectivityManager 网络状态管理，涵盖 NetworkCapabilities 能力模型、NetworkCallback 实时监听、Socket 网络绑定及 ConnectivityDiagnostics 弱网优化等完整工程实践。
---

做视频通话 SDK 的时候碰到一个棘手问题：WiFi 切换到 4G 的一瞬间，所有正在传输的数据包全部超时，用户那边画面卡住 3-5 秒才能恢复。排查日志发现，业务层拿到网络断开的回调时，底层 TCP 连接早就死了。

根因很简单——我们对 Android 网络状态的理解还停留在 `NetworkInfo.isConnected()` 时代。

## NetworkInfo 的死穴：为什么 Google 标记它过时

Android 5.0 之前，判断网络状态的写法长这样：

```java
ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
NetworkInfo info = cm.getActiveNetworkInfo();
if (info != null && info.isConnected()) {
    // 发起请求
}
```

这段代码有两个致命缺陷。

第一，**「已连接」不等于「可用」**。WiFi 连着路由器但路由器没通外网，`isConnected()` 依然返回 `true`。你的请求会直接超时，没有任何提前感知的机会。

第二，**Android 5.0+ 设备可能同时连接 WiFi 和蜂窝网络**。`getActiveNetworkInfo()` 只返回一个「默认」网络，你根本不知道系统背后选了哪个。如果系统把默认网络从 WiFi 切到蜂窝，你的 Socket 绑定的旧网络早已失效，新请求却毫无感知。

Google 在 API 21 引入 `NetworkCapabilities`，在 API 29 彻底废弃 `NetworkInfo`。这个替换不是换个类名那么简单，背后是一次网络架构的重新建模。

## NetworkCapabilities：从「是否连接」到「能干什么」

`NetworkCapabilities` 的核心思路：**不问你是什么网络，问你能提供什么能力**。

```kotlin
val cm = getSystemService(ConnectivityManager::class.java)
val network = cm.activeNetwork
val caps = cm.getNetworkCapabilities(network)

caps?.let {
    // 能力判断，而非类型判断
    val hasInternet = it.hasCapability(NET_CAPABILITY_INTERNET)
    val isValidated = it.hasCapability(NET_CAPABILITY_VALIDATED)
    val notMetered = !it.hasCapability(NET_CAPABILITY_NOT_METERED)
    val bandwidth = it.linkDownstreamBandwidthKbps
}
```

关键字段：

- **`NET_CAPABILITY_INTERNET`**：这个网络能访问公网，比 `isConnected()` 语义精确得多
- **`NET_CAPABILITY_VALIDATED`**：系统已经做过连通性探测（比如请求 `connectivitycheck.gstatic.com`），确认网络真的通。这个字段是我做弱网优化的核心依据
- **`NET_CAPABILITY_NOT_METERED`**：是否计费流量，WiFi 通常是 `true`，蜂窝通常是 `false`
- **`linkDownstreamBandwidthKbps`**：估算带宽，做自适应码率时比硬编码 WiFi/4G 判断靠谱

一个常见误区：很多人还在用 `NetworkCapabilities.hasTransport(TRANSPORT_WIFI)` 判断 WiFi。这在双网并发设备上不可靠——WiFi 和蜂窝可能同时存在，但互联网能力只走其中一条。

## NetworkCallback：别再轮询网络状态了

早期做法是定时调用 `getActiveNetworkInfo()` 轮询，耗电且延迟大。正确做法是注册 `NetworkCallback`：

```kotlin
val request = NetworkRequest.Builder()
    .addCapability(NET_CAPABILITY_INTERNET)
    .addCapability(NET_CAPABILITY_VALIDATED)
    .build()

val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
        // 网络可用，可以绑定 Socket
        Log.d("Net", "available: $network")
    }

    override fun onCapabilitiesChanged(
        network: Network, caps: NetworkCapabilities
    ) {
        // 能力变化（比如 WiFi 验证通过、带宽估算更新）
        val bw = caps.linkDownstreamBandwidthKbps
    }

    override fun onLost(network: Network) {
        // 网络真正丢失
    }
}

cm.registerNetworkCallback(request, callback)
```

注意 `onLost` 和 `onUnavailable` 的区别：`onUnavailable` 在指定时间内未满足请求条件时触发，网络可能还在；`onLost` 是网络真的丢了。做连接迁移时，需要在 `onLost` 里触发切换逻辑，而不是 `onUnavailable`。

还有一个坑：**`onAvailable` 回调时机早于 `NET_CAPABILITY_VALIDATED`**。如果在 `onAvailable` 里立刻发请求，可能因为网络还没完成验证而失败。建议在 `onCapabilitiesChanged` 里检查 `VALIDATED` 标记后再发请求。

## NetworkRequest 绑定：让连接跟着网络走

知道了网络什么时候可用，下一步是把业务连接绑定到指定网络。Android 的网络 API 原生支持绑定：

```kotlin
// OkHttp 绑定到指定网络
val client = OkHttpClient.Builder()
    .socketFactory(network.socketFactory)
    .build()

// 原生 HttpURLConnection
val conn = network.openConnection(url) as HttpURLConnection

// Cronet
val engine = CronetEngine.Builder(context)
    .setDefaultNetwork(network)
    .build()
```

**绑定的意义在于**：这个 Socket 的所有流量只走指定网络。系统切换默认网络时，你绑定的 Socket 不受影响。但绑定网络丢失了，你需要主动做迁移。

实际项目里的迁移逻辑大致是这样：

```kotlin
override fun onLost(network: Network) {
    // 标记当前连接为待迁移
    pendingMigration = true
}

override fun onAvailable(network: Network) {
    if (pendingMigration) {
        // 新网络来了，重新绑定
        rebindSocket(network)
        pendingMigration = false
    }
}
```

这里有个细节：`onLost` 到 `onAvailable` 之间有个窗口期。这期间如果 Socket 还没感知到旧网络断开（TCP 重传仍在进行），数据会堆积在内核缓冲区。合理的做法是给 Socket 设置一个较短的超时，或者在 `onLost` 后主动 `close()` 旧连接。

## 工程化的三个关键点

### 1. 前台服务绑定，防止被系统 kill

网络切换期间，如果进程在后台且被系统冻结，`NetworkCallback` 是不会触发的。实践下来发现：**凡是依赖实时网络状态的模块，必须挂前台服务**。

```kotlin
// 在注册 NetworkCallback 的 Service 里
startForeground(NET_MONITOR_ID, notification)
```

这不由最佳实践决定，是 Android 的后台限制机制决定的。Android 8.0+ 对后台服务的网络回调有严格限制，不挂前台服务的话，网络切换时回调延迟可能达到分钟级。

### 2. 用 ConnectivityDiagnostics 做主动探测

API 29 新增的 `ConnectivityDiagnosticsManager` 可以主动探测网络质量：

```kotlin
val diagManager = getSystemService(ConnectivityDiagnosticsManager::class.java)
diagManager.registerConnectivityDiagnosticsCallback(
    NetworkRequest.Builder()
        .addCapability(NET_CAPABILITY_INTERNET)
        .build(),
    executor,
    object : ConnectivityDiagnosticsCallback() {
        override fun onDataStallSuspected(report: DataStallReport) {
            // 疑似网络卡死，主动触发切换
            triggerNetworkMigration()
        }
    }
)
```

`onDataStallSuspected` 是系统级别的卡死检测——当底层持续发送数据但收不到 ACK 时，系统会回调这个方法。相比应用层自己做超时重试，这个回调的时机通常早 2-3 秒，对弱网体验提升明显。

### 3. 多网络并发时的策略选择

Android 12+ 支持同时使用 WiFi 和蜂窝网络。如果你的应用需要低延迟（比如游戏、视频通话），可以显式请求蜂窝网络作为热备：

```kotlin
val cellularRequest = NetworkRequest.Builder()
    .addCapability(NET_CAPABILITY_INTERNET)
    .addTransportType(TRANSPORT_CELLULAR)
    .build()

cm.requestNetwork(cellularRequest, callback)
```

但不建议盲目开双通道。我测过几款中端机，WiFi + 蜂窝并发时，蜂窝模块的功耗增加约 15%-20%。对于短视频或资讯类应用，一个 `VALIDATED` 网络就够了，双通道只在延迟敏感场景才值这个功耗。

## 收尾

三个可以直接用的结论：

**把网络状态建模为「能力」而非「类型」**。不要再写 `if (wifi) { highQuality() }` 这种代码了。用 `linkDownstreamBandwidthKbps` 和 `VALIDATED` 做判断，代码的生命周期更长。

**连接绑定到 Network 对象，而不是依赖系统默认路由**。OkHttp、Cronet、原生 Socket 都支持绑定，迁移逻辑写在 `NetworkCallback` 里，让连接跟着网络走。

**`onDataStallSuspected` 是弱网优化最值得用的 API**。应用层超时重试通常要等 5-10 秒，系统级卡死检测能把这个时间缩短到 2-3 秒。对实时传输应用来说，这 3 秒的差距足以决定用户是继续用还是关掉 App。
