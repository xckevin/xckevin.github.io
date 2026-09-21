---
title: 深入 Android MQTT 物联网通信全链路：从 Paho 客户端 QoS 语义到 Doze 模式长连接保活的工程实践
excerpt: 从 MQTT QoS 语义、Paho 确认重传到 Doze 模式长连接保活，梳理 Android 端物联网通信的完整可靠性链路与工程实践。
publishDate: '2026-09-02'
tags:
- Android
- MQTT
- Kotlin
- 物联网
- 长连接保活
seo:
  title: 深入 Android MQTT 物联网通信全链路：从 Paho 客户端 QoS 语义到 Doze 模式长连接保活的工程实践
  description: 解析 Android MQTT 通信全链路：QoS 1 消息语义、Paho 持久化重传、Doze 模式断连根因，以及前台服务、WakeLock 与电池白名单的长连接保活方案。
---

做智能硬件 App 时，我遇到过一个诡异现象：设备在线、网络正常，手机锁屏十分钟后，云端下发指令要等十几分钟才到 App。排查链路时我先怀疑 broker，又怀疑 Paho 丢消息，最后定位到 Android 的 Doze 模式把长连接掐了。这轮排查让我重新梳理了 MQTT 在 Android 端的完整链路：QoS 保证消息语义，Paho 负责确认与重传，保活决定连接能不能活下来。

## QoS 语义决定"消息到底丢不丢"

MQTT 的 QoS 不是网速指标，而是发送方与接收方之间的确认协议，分三个等级：

- **QoS 0（At most once）**：发完即忘，不等 ACK，可能丢消息。
- **QoS 1（At least once）**：接收方回 PUBACK，没收到就重发，可能重复。
- **QoS 2（Exactly once）**：PUBLISH/PUBREC/PUBREL/PUBCOMP 四步交互，保证只到达一次。

移动端下行指令我建议统一用 QoS 1。QoS 0 在弱网下丢指令不可接受；QoS 2 要四步交互，移动网络抖动时往返成本高，而且"恰好一次"对大多数控制指令收益有限，重复指令靠业务幂等去重更划算。

## Paho 客户端的确认与重传

Paho Android 客户端把 QoS 语义落到两个配置上：cleanSession 和持久化。

```kotlin
val options = MqttConnectOptions().apply {
    isCleanSession = false          // 断线后 broker 保留会话
    keepAliveInterval = 30          // PINGREQ 间隔，单位秒
    isAutomaticReconnect = true
    setWill("device/offline", "0".toByteArray(), 1, true)
}
```

`isCleanSession = false` 让 broker 记住订阅关系，并把断线期间 QoS 1/2 的消息暂存。客户端重连后，Paho 会先完成未确认的 inflight 消息，再处理新消息。

这里我踩过一个坑：Paho 默认用 `MemoryPersistence`，inflight 消息只放内存。进程被杀后这些状态直接消失，重连也补不回来。要扛住系统杀进程，得换成 `MqttDefaultFilePersistence`。

```kotlin
MqttAndroidClient(context, uri, clientId, MqttDefaultFilePersistence())
```

## Doze 模式如何掐断长连接

Android 6.0 引入 Doze：屏幕关闭、设备静止、未充电一段时间后，系统进入深度休眠，暂停网络访问、忽略 WakeLock、延迟 AlarmManager。**前台服务不等于 Doze 豁免**——它只能保住进程优先级，躲过 App Standby 的进程冻结，而 Doze 是设备级电源策略，照样断网。

我见过不少团队以为开了前台服务、加了心跳就稳了，结果锁屏后 MQTT 的 PINGREQ 根本发不出去，TCP 连接被中间设备或 broker 判超时断开。开头那十几分钟延迟就是这么来的：Doze 只在维护窗口恢复网络，Paho 重连后才收到积压指令。

## 保活方案：前台服务、WakeLock 与白名单

我的工程方案分三层：

第一层，前台服务扛后台执行限制。Android 8.0 后普通后台服务会被杀，用前台服务加常驻通知保住进程：

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

第二层，引导用户加入电池优化白名单，这是真正绕开 Doze 的关键一步：

```kotlin
val pm = getSystemService(PowerManager::class.java)
if (!pm.isIgnoringBatteryOptimizations(packageName)) {
    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:$packageName")
    })
}
```

第三层，MqttConnectOptions 里 keepAliveInterval 设为 30 秒，配合自动重连。心跳让 broker 及时发现半开连接，不能单独对抗 Doze，但它是整条链路里兜底的那一环。

如果产品能接受秒级到分钟级延迟，我更推荐 FCM 高优先级推送唤醒 App 再重建 MQTT，而不是让长连接一直硬扛。省电和低延迟是一组取舍，别两头都想要。

## 三个工程判断

实际落地时我坚持三个选择：

- **下行指令用 QoS 1，配合业务幂等**。既不会静默丢消息，又不用为 QoS 2 的四步交互付弱网成本。
- **用 LWT 加 retained 消息做设备在线状态**。`device/offline` 的遗嘱消息在异常断线时由 broker 自动发布，比 App 自己上报可靠得多。
- **重连用指数退避加随机抖动**。弱网下固定间隔重连会放大 broker 压力，我一般 1s、2s、4s 递增，封顶 60s。

回到开头那个问题：MQTT 通信链路的可靠性，从来不是单点能保证的。QoS 管语义，Paho 管重传，保活管连接，三件事缺一条，云端指令就可能在某个环节被悄悄吞掉。
