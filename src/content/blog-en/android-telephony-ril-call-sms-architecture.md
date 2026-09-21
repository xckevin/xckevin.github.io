---
title: 'Android Telephony End-to-End: Call State Machine and SMS Flow from TelephonyManager to RIL'
lang: en
translationKey: android-telephony-ril-call-sms-architecture
slug: android-telephony-ril-call-sms-architecture
excerpt: 'A full walkthrough of Android Telephony architecture: the TelephonyManager facade, the Phone process call state machine, the RIL sequence protocol, and the two separate SMS send/receive paths—plus how to localize issues by layer.'
publishDate: '2026-08-17'
tags:
- Android
- Telephony
- RIL
- Architecture
- Source Code Analysis
- SMS
pageType: article
seo:
  title: 'Android Telephony: Call State Machine and SMS from TelephonyManager to RIL'
  description: How Android Telephony spans the app layer, Phone process call state machine, RIL sequence protocol, and the two separate SMS send/receive paths.
---

I once debugged an online "incoming call doesn't ring" issue. Tracing the logs from the application layer all the way down to the RIL socket output, I discovered that the same call state was maintained separately in four different processes. Telephony is the most typical cross-process + HAL layered system in Android: the application-layer API is only the entry point, while the real state machine, protocol handling, and Modem interaction are hidden in the Phone process and the RIL layer. Only by understanding this path can you localize call, SMS, and data network anomalies to the correct layer.

## The Application Layer Is Just a Facade

`TelephonyManager` has no business logic of its own; it is a **Facade**. All proactive operations go through the `ITelephony` AIDL interface, and all state callbacks go through the `TelephonyRegistry` system service. These two paths are kept separate within the application process:

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

The binder service that `getITelephony()` obtains is `PhoneInterfaceManager` in the Phone process. State subscription is completely different: the application registers a `TelephonyCallback` into `TelephonyRegistry`, and the Phone process proactively pushes updates to `system_server` via `notifyCallStateChanged`, which then dispatches them to all registered clients. One is a synchronous call, the other an asynchronous broadcast—when a problem occurs, the troubleshooting entry points are completely different.

## The Phone Process and the Call State Machine

The real logic lives in the `com.android.phone` process. At startup, `PhoneFactory.makeDefaultPhones()` creates a `GSMPhone` or `CDMAPhone` based on device configuration, and each Phone holds its own CallTracker. For GSM, `GsmCallTracker` is the core of the entire call state machine.

It does not rely on event-driven design; instead, it actively polls. `handlePollCalls` periodically calls `mCi.getCurrentCalls()` to query the current call list from RIL and, after getting back the `DriverCall` list, performs state mapping:

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

`DriverCall.State` has six values—ACTIVE, HOLDING, DIALING, ALERTING, INCOMING, WAITING—much more fine-grained than the three seen at the application layer. GsmCallTracker aggregates these six into the three `Phone.State` values IDLE / RINGING / OFFHOOK, then notifies `TelephonyRegistry` through `DefaultPhoneNotifier`.

With multiple SIM cards, `CallManager` aggregates the CallTrackers of multiple Phones. Dual-SIM call switching is the easiest place to trip up here: one card is in a call while another receives an incoming call, and the two state machines run in parallel—the "single phone number" the application layer sees may actually correspond to different subIds. The pitfall I hit was: in a dual-SIM scenario, don't rush to inspect the state machine itself; first confirm which subId's Phone the upper layer actually obtained.

## The RIL Layer: A Protocol on Top of Sockets

RIL (Radio Interface Layer) translates upper-layer requests into the protocol used to communicate with the Modem. In the traditional implementation, `RIL.java` uses a local socket to connect to the rild daemon, with two threads responsible for sending and receiving respectively:

```java
// RIL.java 的线程模型
RILSender   mSender;    // 写 /dev/socket/rild
RILReceiver mReceiver;  // 读 rild 的响应
```

Each request is wrapped in a `RILRequest` with an incrementing `mSerial` sequence number. When sent, it is written to a Parcel; the receiving side dispatches responses back to the corresponding request by sequence number:

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

The sequence number mechanism is the key to RIL reliability: the socket is asynchronous, the Modem's response order is not guaranteed to match the request order, and the sequence number is what allows responses to be matched correctly.

After Android 8.0 introduced Treble, the `IRadio` HAL (HIDL, later migrated to AIDL) gradually replaced rild's socket channel, and the underlying layer of `RIL.java` switched to `RadioProxy`. But the skeleton—the RILSender/RILReceiver thread model, sequence number matching, and `RILRequest` lifecycle management—was preserved. When reading logs, `RILJ` is the Java layer and `RILC` is the HAL/C++ layer. For logs, I generally first look for `mSerial` on the RILJ side, then use that number to align with the RILC side—much more efficient than looking at the two sides separately.

## SMS Sending and Receiving Are Two Separate Paths

SMS sending and receiving are completely asymmetric in architecture, and many people get confused here.

The sending path is a top-down proactive call: `SmsManager.sendTextMessage` → `ISms` binder → `IccSmsInterfaceManager` in the Phone process → `GsmSmsDispatcher`. The Dispatcher is responsible for encoding text into a PDU, calling RIL's `RIL_REQUEST_SEND_SMS`, and handling retries, the SMSC address, and delivery reports (SMS-DELIVER-REPORT).

The receiving path is a bottom-up passive notification: after the Modem receives an SMS, it proactively reports it via `UNSOL_RESPONSE_NEW_SMS`; after RILReceiver reads it, it calls back `BaseCommands`, and then enters `InboundSmsHandler`:

```java
// 接收方向的关键路径
RIL.processUnsolicited -> mNewSmsRegistrant.notifyRegistrant
-> InboundSmsHandler.handleMessage
-> SmsMessage.createFromPdu(pdu, format)
-> 写入 SmsProvider 数据库 -> 发送 SMS_RECEIVED 广播
```

In the receiving path, `InboundSmsHandler` performs carrier policy filtering, writes to the `SmsProvider` database, and filters duplicate SMS. VoLTE SMS (IMS) is a third path, going through `ImsSmsDispatcher`, with the protocol stack in ImsService rather than traditional RIL—before troubleshooting, first confirm which channel the SMS is using.

## The Troubleshooting Toolbox

When actually locating Telephony problems, the three entry points I commonly use:

1. **`adb shell dumpsys telephony.registry`** lets you directly see the call state, SIM state, and all processes with registered callbacks recorded on the system service side. First confirm whether the state is already wrong at the `system_server` layer.
2. **radio buffer logs**: `adb logcat -b radio` captures the complete record of interactions between RILJ and the Modem side. `RIL_REQUEST_*` and `UNSOL_*` appear in pairs by sequence number, much clearer than the main buffer.
3. **Binary search by layer**: if the state is wrong, first look at TelephonyRegistry; if the state is correct but the UI is wrong, look at the application-layer registration; if protocol interaction is abnormal, go straight to the radio buffer—no need to guess your way down from the API.

The complexity of Telephony lies in the fact that the same state is maintained separately across four layers: the application, system_server, the Phone process, and RIL/Modem. When something goes wrong, determining which layer is already wrong is far more efficient than guessing the code location directly.
