---
title: "Android Push Delivery: FCM, Vendor Channels, and Doze"
lang: en
translationKey: android-push-service-fcm-vendor-channels
slug: android-push-service-fcm-vendor-channels
excerpt: "A practical look at Android push delivery across FCM and OEM vendor channels, including keepalive behavior, Doze impact, routing, TTL, and fallback design."
publishDate: '2025-10-27'
tags:
- "Android"
- "FCM"
- "Push Services"
- "Performance Optimization"
- "Architecture Design"
seo:
  title: "Android Push Delivery: FCM, Vendor Channels, Doze, and Fallbacks"
  description: "Analyze Android push delivery across FCM and OEM channels, including keepalive strategies, Doze delays, TTL semantics, priority routing, and fallbacks."
  pageType: article
---

Last year, while adapting an overseas social app for the China market, I ran into a hard delivery problem. The Google Play build had a stable push arrival rate above 95%, while the domestic build fell to 70%. After users locked the screen for more than 15 minutes, delivery was almost wiped out. What exactly happens between a server sending a push and the user's phone lighting up? I took apart both FCM and several domestic OEM push channels to find out.

## FCM's built-in advantage: platform privilege from Google services

FCM, Firebase Cloud Messaging, has strong delivery not because its protocol is magical, but because it runs inside the Google Play services process. That is the central tension in push delivery: **the process with the higher priority gets the message through first.**

FCM keeps its long connection inside Google Play services. That process has two key advantages.

First, it benefits from the **persistent process exemption**. After Android 6.0, the framework ignores `android:persistent` for ordinary apps, but it still applies to Google Play services as a system-level app. Even if the user swipes your app away from recent tasks, the FCM connection remains alive.

Second, it is on the **Doze whitelist**. Since Android 6.0 introduced Doze, non-whitelisted apps have faced strict limits on network access, WakeLocks, and Alarms. In AOSP's `DeviceIdleController.java`, the Google Play services package is hardcoded into `mPowerSaveWhitelistExceptIdleApps`:

```java
// frameworks/base/services/core/java/com/android/server/DeviceIdleController.java
private void addPowerSaveWhitelistApps() {
    mPowerSaveWhitelistExceptIdleApps.add("com.google.android.gms");
    mPowerSaveWhitelistExceptIdleApps.add("com.android.vending");
    // ...
}
```

FCM's heartbeat connection can survive even during deep Doze. In my measurements, FCM messages in Doze usually arrived with a 3-5 second delay, which is nearly invisible to users.

## Vendor channels: keeping a heartbeat alive inside system constraints

Domestic Android phones usually do not ship with Google Play services. MiPush, HMS Push, OPPO Push, and VIVO Push each maintain their own delivery channel. Their keepalive strategies are essentially a negotiation with the system's power-saving policy.

### Two different architecture paths

Huawei and OPPO follow the **built-in system service path**. The push SDK does not maintain its own long connection. Instead, it calls a push component in the system service layer through Binder. In HMS Push, for example, the app-side SDK is only a lightweight proxy:

```java
// App-side call
HmsMessageService service = new HmsMessageService();
TokenResult token = service.getToken();

// Actual execution happens in the com.huawei.hwid process.
// That process has system-level resident permissions and is not fully restricted by Doze.
```

The upside is that the push channel is maintained by a system process, so survivability is close to FCM. The cost is startup latency. If the system push service is not ready when the app starts, the SDK must wait for asynchronous initialization, and the first token fetch can take 3-8 seconds.

Xiaomi and VIVO use a **system whitelist plus independent process path**. The push SDK registers a separate `:push` process to keep the long connection alive, relying on OEM-level ROM privileges for the vendor's own push process: raising its OOM Adj score, adding it to battery optimization whitelists, and bypassing Doze network limits.

The problem is that there is no unified vendor standard. Whitelist behavior depends entirely on each OEM. In early versions, some vendors even managed to have their own battery-saving features kill their own push process.

### Heartbeat strategy differences

The heartbeat interval of a long connection directly controls the tradeoff between delivery latency and battery drain. The channels differ as follows:

| Channel | Foreground heartbeat | Doze heartbeat | Notes |
|------|------------|--------------|------|
| FCM | ~60s | ~300s | Adaptive through Activity Detection |
| MiPush | ~45s | ~180s | Strongest keepalive, higher battery cost |
| HMS Push | ~120s | ~300s | System service has no direct heartbeat; wakes through Alarm |
| OPPO Push | ~120s | ~300s | Close to the HMS strategy |

Xiaomi's 45-second heartbeat is aggressive by industry standards. It appears to reduce latency, but when the user is idle, the battery cost from frequent heartbeats can cause the power-saving module to mark the app as high consumption. That can increase the chance of being killed.

## The real impact of Doze: more complex than it looks

Many developers summarize Doze as "background apps lose network access." The actual mechanism is much more granular.

Doze has multiple phases. Light Idle starts a few minutes after the screen turns off. Network access is throttled but not fully blocked. Deep Idle starts after the device has been stationary for about 30 minutes and enters the **Maintenance Window** mechanism. The system briefly restores network access at intervals, apps send heartbeats and receive messages during that window, and then the device goes back to sleep.

One easily missed detail: Maintenance Window timing is **not fixed**. Before Android 9, it was roughly every 15 minutes. Later versions gradually extended it. Since Android 12, after a device has been stationary for more than two hours, the window can stretch to one or two hours. For time-sensitive push messages, that is almost fatal.

In one measurement on an idle Android 13 test device after three hours, push delay for a non-whitelisted app fluctuated between 30 minutes and one hour.

## Priority-based delivery: not every message needs to arrive immediately

Once you understand channel differences and Doze limits, the engineering strategy becomes clearer. A practical priority model looks like this:

- **P0 instant messages** such as call invitations and verification codes: send through the vendor channel's high-priority API and allow a system wakeup. The server should have timeout fallback. If arrival is not acknowledged within five seconds, downgrade to P1 and retry through the long connection.

- **P1 important messages** such as direct messages and transaction notifications: use the standard push channel. The server maintains message ID deduplication and ordering. The message can be displayed in the notification shade after arrival, but it should not wake the screen.

- **P2 silent messages** such as data sync and config updates: use FCM Data Messages or vendor pass-through messages without displaying a notification. Process immediately when the app is foregrounded; when it is backgrounded, write to a local queue and batch-process on the next active session.

A simplified version of a message routing module I used in production looks like this:

```python
def route_push(user_id, message):
    channel = get_active_channel(user_id)  # "fcm" / "hms" / "mipush" ...
    priority = message.get("priority", 1)
    
    if priority == 0:
        # P0: mark urgent and use system-level wakeup
        channel.push(message, wakeup=True, ttl=300)
        # Check ACK after 5 seconds; downgrade and retry as P1 if missing
        schedule_ack_check(message.id, delay=5, fallback_p1=True)
    elif priority == 1:
        channel.push(message, wakeup=False, ttl=3600)
    else:
        # P2: pass-through message, not shown in notifications
        channel.data_message(message, ttl=7200)
```

There is a subtle trap here: **Huawei and Xiaomi do not interpret TTL exactly the same way**. Huawei's TTL means the maximum server-side storage time before the message is discarded. Xiaomi's TTL also affects delivery strategy, so an overly short TTL can expire outside the Doze maintenance window. I recommend standardizing TTL at 3600 seconds or more, and letting the server enforce freshness instead of relying on channel TTL behavior.

## A real production pitfall

After multi-channel support went live, the staged rollout showed abnormally low arrival rates on OPPO devices in a specific scenario. The cause was OPPO's push SDK requirement that users manually enable the app's "auto start" permission; otherwise, the background push service would not establish its connection.

That differs from Huawei and Xiaomi. Their system push service is not controlled by the app-level auto-start permission; once the app is installed, delivery can work. OPPO's review team classified push-channel establishment as auto-start behavior and required explicit user authorization.

The fix had two layers. First, during registration and login, the app detected that permission and guided users to enable it. Second, the server added an SMS fallback path for OPPO users, sending P0 messages by SMS 30 seconds after push failure.

That incident made the real risk clear: **multi-channel adaptation is not finished after SDK integration. Each vendor's interpretation of permission boundaries is the real business risk.**

## Principles worth keeping

When optimizing a push system, I would not obsess over whether one channel is a few milliseconds faster than another. These principles matter more.

**Prefer system-level channels over self-built long connections.** For overseas users, FCM is the obvious choice. For domestic users, route by device brand to the corresponding vendor channel. A self-built long connection should only be supplemental and should carry P2 silent sync data.

**Do not gamble against Doze.** Do not assume your heartbeat strategy can beat the system power-saving mechanism. Good message prioritization and sufficiently long TTL values are more practical than clever heartbeat algorithms.

**Build a closed-loop server-side message trace.** Record the timeline from send to terminal ACK for every message, and distinguish channel delay, device sleep delay, and client processing delay. During incident response, that separation makes the problem obvious. In one project I used `message_id + event_type + timestamp` telemetry with ELK for real-time monitoring, and it caught four channel-side anomalies within six months.
