---
slug: android-telephony-ril-call-sms-architecture
translationKey: android-telephony-ril-call-sms-architecture
title: 深入 Android Telephony 全链路：从 TelephonyManager 到 RIL 层的通话状态机与短信收发架构解析
excerpt: 从应用层 TelephonyManager 门面到 Phone 进程通话状态机，再到 RIL 层序列号协议与短信双链路，梳理 Telephony 四层状态同步与问题定位方法。
publishDate: '2026-08-17'
tags:
- Android
- Telephony
- RIL
- 架构设计
- 源码分析
seo:
  title: Android Telephony：TelephonyManager、RIL 通话状态机与短信收发
  description: 解析 Android Telephony 全链路架构：TelephonyManager 门面、Phone 进程通话状态机、RIL 层序列号协议，以及短信收发双路径与问题排查方法。
  pageType: article
---

排查过一次"来电不响铃"的线上问题，日志从应用层一路翻到 RIL 的 socket 输出，才发现同一个通话状态在四个进程里各维护了一份。Telephony 是 Android 里最典型的跨进程 + HAL 分层系统：应用层 API 只是入口，真正的状态机、协议处理和 Modem 交互都藏在 Phone 进程和 RIL 层。理解这条链路，才能把通话、短信、数据网络的异常问题定位到正确的层。

## 应用层只是门面

`TelephonyManager` 本身没有业务逻辑，它是一个**门面（Facade）**。所有主动操作走 `ITelephony` 这个 AIDL 接口，所有状态回调走 `TelephonyRegistry` 这个系统服务，两条路径在应用进程里是分开的：

```kotlin
val tm = getSystemService(TelephonyManager::class.java)
// 主动操作：拿 ITelephony 的 binder，最终落到 Phone 进程
val iTelephony = tm.getITelephony() // 隐藏 API，系统应用可用
iTelephony.dial("10086")
// 状态订阅：注册到 system_server 里的 TelephonyRegistry
tm.registerTelephonyCallback(mainExecutor,
    object : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) {
            // IDLE / RINGING / OFFHOOK
        }
    })
```

`getITelephony()` 拿到的 binder 服务端是 Phone 进程里的 `PhoneInterfaceManager`。状态订阅则完全不同：应用把 `TelephonyCallback` 注册进 `TelephonyRegistry`，Phone 进程通过 `notifyCallStateChanged` 主动推送到 `system_server`，再分发给所有注册的客户端。一条是同步调用，一条是异步广播，出问题时排查入口完全不同。

## Phone 进程与通话状态机

真正的逻辑在 `com.android.phone` 进程。启动时 `PhoneFactory.makeDefaultPhones()` 根据设备配置创建 `GSMPhone` 或 `CDMAPhone`，每个 Phone 持有独立的 CallTracker。以 GSM 为例，`GsmCallTracker` 是整个通话状态机的核心。

它不依赖事件驱动，而是主动轮询。`handlePollCalls` 周期性调用 `mCi.getCurrentCalls()` 向 RIL 查询当前呼叫列表，拿回 `DriverCall` 列表后做状态映射：

```java
// GsmCallTracker.updatePhoneState 的核心映射逻辑
if (ringingCall.isIdle() && foregroundCall.isIdle() && backgroundCall.isIdle()) {
    oldState = mState;
    mState = Phone.State.IDLE;
} else if (ringingCall.isIdle()) {
    mState = Phone.State.OFFHOOK;
} else {
    mState = Phone.State.RINGING;
}
```

`DriverCall.State` 有 ACTIVE、HOLDING、DIALING、ALERTING、INCOMING、WAITING 六种，比应用层看到的三种细腻得多。GsmCallTracker 把这六种聚合到 `Phone.State` 的 IDLE / RINGING / OFFHOOK 三态，再通过 `DefaultPhoneNotifier` 通知 `TelephonyRegistry`。

多 SIM 卡时，`CallManager` 会汇聚多个 Phone 的 CallTracker。双卡通话切换最容易在这里踩坑：一张卡通话中，另一张卡来电，两个状态机并行维护，应用层看到的"一个电话号码"背后可能对应不同 subId。我踩过的坑是：双卡场景下先别急着看状态机本身，先确认上层拿到的是哪个 subId 的 Phone。

## RIL 层：socket 之上的协议

RIL（Radio Interface Layer）把上层请求翻译成与 Modem 通信的协议。传统实现里，`RIL.java` 用本地 socket 连接 rild 守护进程，两个线程分别负责收发：

```java
// RIL.java 的线程模型
RILSender   mSender;    // 写 /dev/socket/rild
RILReceiver mReceiver;  // 读 rild 的响应
```

每个请求封装成 `RILRequest`，带一个递增的 `mSerial` 序列号。发送时写入 Parcel，接收端按序列号把响应派发回对应请求：

```java
// processSolicited 根据序列号找到原始请求
RILRequest rr = findAndRemoveRequestFromList(serial);
switch (rr.mRequest) {
    case RIL_REQUEST_GET_CURRENT_CALLS:
        rr.mResult = responseCallList(p);
        break;
    case RIL_REQUEST_SEND_SMS:
        rr.mResult = responseString(p);
        break;
}
```

序列号机制是 RIL 可靠性的关键：socket 是异步的，Modem 响应顺序不保证与请求一致，序列号让响应能正确匹配。

Android 8.0 引入 Treble 后，`IRadio` HAL（HIDL，后续转 AIDL）逐步取代了 rild 的 socket 通道，`RIL.java` 底层改走 `RadioProxy`。但 RILSender/RILReceiver 的线程模型、序列号匹配、`RILRequest` 生命周期管理这套骨架保留了下来。看日志时 `RILJ` 是 Java 层，`RILC` 是 HAL/C++ 层，对日志我一般先在 RILJ 侧找 `mSerial`，再拿这个编号去 RILC 侧对齐，比两边各看各的高效。

## 短信收发是两条独立路径

短信的发送和接收在架构上完全不对称，很多人在这里搞混。

发送链路是自上而下的主动调用：`SmsManager.sendTextMessage` → `ISms` binder → Phone 进程的 `IccSmsInterfaceManager` → `GsmSmsDispatcher`。Dispatcher 负责把文本编码成 PDU，调用 RIL 的 `RIL_REQUEST_SEND_SMS`，并处理重试、短信中心地址和 delivery report（SMS-DELIVER-REPORT）。

接收链路是自下而上的被动通知：Modem 收到短信后通过 `UNSOL_RESPONSE_NEW_SMS` 主动上报，RILReceiver 读到后回调 `BaseCommands`，再进入 `InboundSmsHandler`：

```java
// 接收方向的关键路径
RIL.processUnsolicited -> mNewSmsRegistrant.notifyRegistrant
-> InboundSmsHandler.handleMessage
-> SmsMessage.createFromPdu(pdu, format)
-> 写入 SmsProvider 数据库 -> 发送 SMS_RECEIVED 广播
```

接收路径里 `InboundSmsHandler` 会做运营商策略过滤、写入 `SmsProvider` 数据库、重复短信过滤。VoLTE 短信（IMS）是第三条路，走 `ImsSmsDispatcher`，协议栈在 ImsService 而非传统 RIL，排查前先确认短信走的是哪条通道。

## 排查工具箱

实际定位 Telephony 问题时，我常用的三个入口：

1. **`adb shell dumpsys telephony.registry`** 能直接看到系统服务侧记录的通话状态、SIM 卡状态和所有已注册回调的进程。先确认状态在 `system_server` 这一层是否已经错了。
2. **radio buffer 日志**：`adb logcat -b radio` 抓到的就是 RILJ 和 Modem 侧交互的完整记录，`RIL_REQUEST_*` 和 `UNSOL_*` 会按序列号成对出现，比 main buffer 清晰得多。
3. **按层二分**：状态不对先看 TelephonyRegistry，状态对但 UI 不对看应用层注册；协议交互异常直接看 radio buffer，不必从 API 一路猜。

Telephony 的复杂性在于同一份状态在应用、system_server、Phone 进程、RIL/Modem 四层各自维护。出问题时先确定哪一层已经错了，比直接猜代码位置高效得多。
