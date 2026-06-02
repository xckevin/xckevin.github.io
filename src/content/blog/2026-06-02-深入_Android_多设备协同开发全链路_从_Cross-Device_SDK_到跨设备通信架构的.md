---
title: 深入 Android 多设备协同开发全链路：从 Cross-Device SDK 到跨设备通信架构的生态工程实践
excerpt: 从 Nearby Connections 到 Cross-Device SDK 的实战踩坑记录：通过 Session 抽象和 Resource 模型解决多设备协同中的连接稳定性、消息可靠性和状态管理问题。
publishDate: '2026-06-02'
tags:
- Android
- Cross-Device SDK
- 多设备协同
- Nearby Connections
- 架构设计
seo:
  title: 深入 Android 多设备协同开发全链路：从 Cross-Device SDK 到跨设备通信架构的生态工程实践
  description: 本文记录从 Nearby Connections 到 Cross-Device SDK 的多设备协同开发实践，涵盖 Session 会话管理、Resource 消息模型、断线重连策略与设备发现调优等工程要点。
---

去年接手一个车载娱乐项目，需求是让后排平板实时控制前排中控的导航和音乐。厂商 Demo 用 Nearby Connections 跑通了，但压力测试一上就崩了——连接断开不自动恢复、多设备并发时数据包乱序、设备休眠心跳超时。

下面是我从 Nearby Connections 一路踩坑到 Cross-Device SDK 的实战记录。

## 技术选型：Nearby Connections 的边界在哪

Nearby Connections 是 Google Play Services 的一套 P2P 近场通信 API，支持三种拓扑：

- **P2P_STAR**：1 个中心节点 + N 个外围节点，中心负责转发
- **P2P_POINT_TO_POINT**：两两直连
- **P2P_CLUSTER**：节点间自动建立网状连接

底层走 WiFi、蓝牙和 WiFi Direct 混合传输，物理链路切换对开发者透明。上手很顺畅：

```kotlin
// 发起连接
val strategy = Strategy.P2P_STAR
Nearby.getConnectionsClient(context)
    .startAdvertising(deviceName, SERVICE_ID, connectionLifecycleCallback, advertisingOptions)
    .addOnSuccessListener { /* 等待对方请求连接 */ }
```

跑了两个星期，问题开始冒出来：

**连接稳定性差**。WiFi 和蓝牙切换有 3-5 秒真空期，上层拿到 `onDisconnected()` 回调，但没有内置重连。我加了一层重试逻辑，但每次重连都要重新走蓝牙扫描和 WiFi Direct 协商，延迟不可控。

**消息投递不保证可靠**。`Payload` 分 `BYTE`、`FILE`、`STREAM` 三种，命名让人觉得可靠，实际 `STREAM` 类型在高吞吐场景下会丢包且不重发。文件传输必须切回 `FILE` 类型。

**多设备并发逻辑全靠自己写**。P2P_STAR 模式下，中心节点要维护当前连接设备数，外围节点要感知自己角色——这些状态管理 Nearby Connections 一概不管。

更棘手的是，不同厂商对 WiFi Direct 的实现差异很大。三星设备建连稳定性远好于某些国产机型。在业务层做兼容性判断，成本太高。

## Cross-Device SDK 解决了什么

2024 年 Google 推出 Cross-Device SDK（当时还是 Developer Preview），定位就是补齐 Nearby Connections 缺失的「会话管理」和「设备能力协商」层。

核心思路：**把多设备协同抽象为 Session，SDK 管连接生命周期和传输策略，业务只管 Session 内的消息收发。**

架构上分三层：

```
┌─────────────────────────────────────┐
│          Application Layer          │
│  (Session 创建/加入, 消息收发)       │
├─────────────────────────────────────┤
│       Cross-Device SDK Core         │
│  Session 管理, Device 发现,          │
│  能力协商, 传输策略选择               │
├─────────────────────────────────────┤
│   Transport Layer (Nearby / BLE)    │
│   WiFi, BLE, WiFi Direct            │
└─────────────────────────────────────┘
```

Session 是整个 SDK 的核心抽象。创建时需要描述设备的 **能力（Capability）** 和 **资源类型**：

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

这段代码表达了三件事：我是谁（导航 + 播放能力）、我要什么资源（导航状态 + 播放控制）、打包成一个 Session。对方设备通过 `onSessionAvailable()` 发现 Session 后，调用 `joinSession()`，SDK 自动完成连接建立和能力协商。

对比 Nearby Connections，SDK 接管了「找谁连、怎么连、断了怎么办」，业务代码从状态机变成了消息驱动。

## 消息模型：从 Payload 到 Resource

Nearby Connections 的消息模型围绕 `Payload`：数据打包成 Payload 对象，`sendPayload()` 发出，远端收到 `onPayloadReceived()` 回调。

Payload 是无状态的一次性数据块。发 10 个 Payload，接收顺序由底层传输决定——遥控导航这种场景里是致命的。

Cross-Device SDK 引入 **Resource** 概念。Resource 是有状态的、可共享的数据对象：

```kotlin
// 发送导航状态变更
session.setResource(
    ResourceId.NAVIGATION_STATE,
    navState.toByteArray()
)

// 远端自动收到 Resource 更新回调
override fun onResourceUpdated(session: Session, resourceId: ResourceId, data: ByteArray) {
    when (resourceId) {
        ResourceId.NAVIGATION_STATE -> updateMap(NavigationState.fromByteArray(data))
    }
}
```

Resource 模型的语义很清晰：不关心怎么传、传了多少次，只关心「当前状态是什么」。SDK 内部做增量同步和冲突合并，业务层拿到最终一致的状态。

一个文档没写的细节：Resource 更新频率不要超过 30Hz。超过这个阈值，SDK 内部的合并策略会导致延迟累积。高频数据（如触摸坐标）建议自己走 UDP 旁路。

## 断线重连与设备发现：工程上要处理的几件事

Cross-Device SDK 的断线重连是自动的，但业务侧有不少边界情况。

**设备发现延迟**。默认扫描间隔 60 秒，两设备擦肩而过（后排乘客上车马上要用）大概率扫不到。调整扫描参数：

```kotlin
val discoveryConfig = DiscoveryConfig.Builder()
    .setScanMode(ScanMode.LOW_LATENCY)  // 牺牲电量换速度
    .setScanIntervalSeconds(15)
    .build()
```

`LOW_LATENCY` 模式在测试设备上把发现时间从 8-12 秒压到 2-3 秒，但待机功耗涨了约 15%。不需要持续发现时及时 `stopDiscovery()`。

**Session 重建后的状态恢复**。重连成功后 Session 是新实例，之前持有的 Resource 不会自动同步回来，需要业务侧调用 `session.requestResource()` 重新拉取。我包了一层 Repository：

```kotlin
class MultiDeviceRepository(private val sessionManager: SessionManager) {
    
    private val stateBackup = mutableMapOf<ResourceId, ByteArray>()
    
    suspend fun onSessionRestored(session: Session) {
        stateBackup.forEach { (id, data) ->
            session.setResource(id, data) // 恢复本地已知状态
        }
        remoteResources.forEach { id ->
            session.requestResource(id)    // 从远端拉取缺失的状态
        }
    }
}
```

**多设备角色分配**。Cross-Device SDK 不预设服务端/客户端角色，需要自己约定。我的做法：设备协商时带上 `priority` 参数，续航最强的设备（插着电的中控屏）自动成为「协调者」，承担转发和状态合并。

## 踩坑记录

1. **混淆规则**。Cross-Device SDK 大量依赖 Protobuf 和反射，混淆没配好直接 crash：

```
-keep class com.google.android.gms.crossdevice.** { *; }
-keep class com.google.crossdevice.proto.** { *; }
```

2. **测试困难**。多设备集成测试必须用真机，模拟器不支持底层 WiFi/BLE 协议栈。我在 CI 上架了 4 台 Pixel 搭设备池，用 ADB 远程调度。

3. **国产手机的「省电优化」**。华米 OV 的省电策略会直接 kill 后台 Service，Nearby Connections 连接瞬间断开。Cross-Device SDK 用前台 Service 保活，但系统级省电模式下仍可能被杀。没有一劳永逸的方案，只能引导用户加白名单。

4. **不要混用 Nearby 和 Cross-Device SDK**。两个 SDK 共享底层 Transport 但互不兼容，同时运行会导致端口冲突，连接成功率暴跌。选一个，全量迁移。

Cross-Device SDK 把多设备协同从「手写状态机」简化成了「声明能力 + 收发 Resource」，但会话恢复策略、设备发现调优、厂商兼容这些脏活还是得自己扛。它适合以数据同步为核心的中低频场景（文档协作、媒体控制、IoT 配置），低延迟音视频流还是老老实实走 WebRTC。
