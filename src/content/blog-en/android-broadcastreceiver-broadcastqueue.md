---
title: "Android BroadcastReceiver End to End: Registration to BroadcastQueue"
lang: en
translationKey: android-broadcastreceiver-broadcastqueue
slug: android-broadcastreceiver-broadcastqueue
excerpt: "A deep dive into Android BroadcastReceiver dispatch, covering dynamic and static registration, BroadcastQueue scheduling, ordered broadcasts, sticky broadcast deprecation, background limits, and async timeout handling."
publishDate: '2025-06-20'
tags:
- "Android"
- "BroadcastReceiver"
- "AMS"
- "Performance Optimization"
- "Architecture"
seo:
  title: "Android BroadcastReceiver: Registration to BroadcastQueue"
  description: "A full-chain guide to BroadcastReceiver dispatch, covering registration, BroadcastQueue scheduling, ordered broadcasts, and background limits."
  pageType: article
---

While building performance monitoring, I once hit a strange issue: after the app stayed in the background for a while, several `BroadcastReceiver` callbacks stopped firing. There were no exceptions in logs and no ANR. The broadcasts looked as if they had disappeared.

After a full investigation, the cause was Android 8.0 and later background broadcast limits. But the complete dispatch chain behind that symptom is much more complex than the official documentation suggests. This article follows the path of registration -> enqueue -> scheduling -> dispatch -> timeout handling, and breaks down the broadcast architecture layer by layer.

## The real difference between the two registration modes

### Dynamic registration: a live Binder-backed channel

`Context.registerReceiver()` does two things internally: it creates a `ReceiverDispatcher`, then registers it with AMS.

```java
// frameworks/base/core/java/android/app/ContextImpl.java
public Intent registerReceiver(BroadcastReceiver receiver, IntentFilter filter) {
    // 1. Create IIntentReceiver.Stub as the Binder server endpoint.
    IIntentReceiver rd = new LoadedApk.ReceiverDispatcher(
            receiver, context, scheduler, null, true)
            .getIIntentReceiver();
    // 2. Register with AMS.
    ActivityManager.getService().registerReceiver(
            mMainThread.getApplicationThread(), ... , rd, filter, ...);
}
```

`LoadedApk.ReceiverDispatcher` wraps an `InnerReceiver`, which implements `IIntentReceiver.Stub`. In essence, it is a Binder object. When AMS calls back through this Binder, `ReceiverDispatcher` uses the main-thread Handler to ensure `onReceive()` executes on the UI thread.

On the AMS side, a `BroadcastFilter` object is inserted into `mReceiverResolver`, an `IntentResolver` structure that records the mapping between Receivers and Filters. When a broadcast arrives, AMS walks the matching filters to find its targets.

A dynamically registered Receiver is bound to the lifecycle of its host component, such as an Activity or Service. When the host is destroyed, the `BroadcastFilter` on the AMS side is removed automatically. One pitfall I have hit: registering a Receiver from `Application` code while accidentally passing an Activity Context. After the Activity was recreated, broadcasts were lost because the old Binder was invalid, but the app code had no obvious signal.

### Static registration: deferred activation from the manifest

Static registration takes a different path. During app installation or boot-time package scanning, `PackageManagerService` parses `AndroidManifest.xml`, extracts `<receiver>` tags as `ResolveInfo`, and stores them in `mReceivers`.

A static Receiver has no active Binder connection inside AMS. When a broadcast needs to be delivered to it, AMS temporarily starts the app process if needed, instantiates the Receiver, calls `onReceive()`, and then destroys it.

This temporary nature has two consequences:

- `onReceive()` must return within **10 seconds**, or it can trigger an ANR.
- After Android 8.0, most implicit broadcasts no longer wake static Receivers.

## BroadcastQueue: the AMS scheduling engine

Broadcast dispatch is not a simple loop over callbacks. AMS uses a full queue mechanism to control concurrency, ordering, and timeouts.

### Dual-queue design

AMS maintains two `BroadcastQueue` instances internally:

```text
mFgBroadcastQueue   -> foreground broadcast queue, 10s timeout
mBgBroadcastQueue   -> background broadcast queue, 60s timeout
```

The goal is straightforward: foreground broadcasts move faster, time out sooner, and are not blocked by background broadcasts. When an app is in the foreground, even normal broadcasts usually go through the foreground queue.

```java
// frameworks/base/services/core/java/com/android/server/am/BroadcastQueue.java
BroadcastQueue(ActivityManagerService service, Handler handler,
        String name, long timeoutPeriod, boolean allowDelayBehindServices) {
    mService = service;
    mHandler = new BroadcastHandler(handler.getLooper());
    mQueueName = name;
    mTimeoutPeriod = timeoutPeriod;  // 10s foreground, 60s background.
}
```

### Serial scheduling and parallel dispatch

First, clarify a few key concepts:

- `BroadcastRecord`: one broadcast send operation, including the Intent, sender permissions, target list, and related metadata.
- `BroadcastFilter`: the descriptor for a dynamically registered receiver.
- `ResolveInfo`: the descriptor for a statically registered receiver.

Multiple dynamic receivers for the same broadcast are **dispatched in parallel**. AMS calls back all matching `BroadcastFilter` targets through Binder in one pass. When a broadcast has both dynamic and static receivers, AMS handles all dynamic receivers first, then processes static receivers one by one. Each static Receiver must finish and acknowledge the result before the next one runs. This is the lower-level mechanism behind ordered broadcast semantics.

### Ordered broadcasts advance one receiver at a time

The core of ordered broadcasts is not just "sort by priority." It is **process receivers one by one, and if an earlier receiver cancels the broadcast, later receivers never see it**.

```java
// BroadcastQueue.java - process the next receiver.
final void processNextBroadcast(boolean fromMsg) {
    synchronized (mService) {
        BroadcastRecord r;
        // Find the broadcast record currently being processed.
        do {
            r = mOrderedBroadcasts.get(0);
            // If a receiver has already timed out, force progress to the next one.
            if (mService.mProcessesReady && r.dispatchTime > 0) {
                if ((now - r.dispatchTime) > (2 * mTimeoutPeriod * ...)) {
                    broadcastTimeoutLocked(false);
                }
            }
            // Handle timeout or find the next target.
            ...
        } while (r == null);
    }
}
```

Ordered broadcast progress depends on `processCurBroadcastLocked()`. After the current receiver calls `setResultCode()` or finishes processing, AMS receives confirmation through `finishReceiverLocked()`. Only then does the scheduler call `scheduleBroadcastsLocked()` and continue to the next receiver.

If a receiver does not finish within 10 seconds in the foreground queue, `broadcastTimeoutLocked()` forcibly skips it and reports an ANR.

## Sticky broadcasts: from convenience to deprecation

Sticky Broadcasts were designed for convenience: once sent, the broadcast remains cached in AMS, so later registered Receivers can receive it immediately.

```java
// Send a sticky broadcast. AMS caches the Intent.
sendStickyBroadcast(new Intent(Intent.ACTION_BATTERY_CHANGED));
```

But sticky broadcasts have two fatal problems:

- **Security**: any app can register and read the sticky Intent, creating a high risk of information leakage.
- **Consistency**: the cached data may already be stale, so new receivers get dirty state.

Starting with Android 5.0, `sendStickyBroadcast()` was marked deprecated. Android 9.0 tightened the rules further. Only a few system sticky broadcasts remain, such as `ACTION_BATTERY_CHANGED`.

I once saw a small project use sticky broadcasts to carry login state. It silently failed on Android 9 devices, and it took two days to discover that the API had been restricted. The replacement is simple: use `LiveData`, `Flow`, or local storage. Do not use broadcasts for state management anymore.

## Background limits and dispatch timeouts

The Android 8.0 rule can be summarized in one sentence: **when an app is in the background, static Receivers do not receive implicit broadcasts except for explicit broadcasts and a small set of exemptions.** Android 9.0 further limits how often background apps can receive implicit broadcasts.

These limits directly affect `BroadcastQueue` behavior. `processNextBroadcast()` skips static receivers that no longer satisfy delivery conditions and dispatches only to eligible dynamic receivers.

One easy-to-miss detail: dynamically registered Receivers are not subject to the Android 8.0 static-receiver restriction, but the 60-second timeout rule still applies. Even though the background queue timeout is longer than the foreground queue timeout, doing I/O or heavy computation inside `onReceive()` can still cause an ANR.

```kotlin
// Common pitfall: synchronous network request inside onReceive.
class NetworkReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Dangerous: get() is blocking and may exceed the 60s background timeout.
        val result = httpClient.newCall(request).execute()
        // Correct approach: hand it off to JobIntentService or WorkManager.
    }
}
```

The fix is `goAsync()`:

```java
public class SafeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pendingResult = goAsync();  // Extend timeout to about 10 minutes.
        new Thread(() -> {
            // Do expensive work.
            doHeavyWork();
            pendingResult.finish();  // Must be called, otherwise this leaks.
        }).start();
    }
}
```

`goAsync()` tells AMS that this receiver needs asynchronous work and extends the timeout window from 10 or 60 seconds to roughly 10 minutes. The child thread must call `finish()` manually. Otherwise AMS keeps holding the `BroadcastRecord`, causing a leak.

## Timeline of the broadcast dispatch chain

Putting the full chain together:

1. The **sender** calls `sendBroadcast(intent)`, entering AMS through Binder.
2. AMS `broadcastIntentLocked()` matches all receivers, dynamic and static, and creates a `BroadcastRecord`.
3. The `BroadcastRecord` is pushed into the corresponding `BroadcastQueue`, foreground or background.
4. `processNextBroadcast()` takes the record, dispatches to dynamic receivers in parallel through Binder, and processes static receivers one by one.
5. After a receiver finishes `onReceive()`, it notifies AMS through `finishReceiverLocked()`.
6. When all receivers finish, or when a timeout occurs, the broadcast record is removed from the queue.

In this chain, only the first step is synchronous. Everything afterward advances asynchronously inside AMS. By the time `sendBroadcast()` returns, the Receiver often has not even started running. Many developers miss this timing detail.

For core business flows, I prefer explicit broadcasts combined with dynamic registration. It sacrifices a little flexibility, but it is much more controllable. Static Receivers are now better suited for power-aware or system-level event listening. Business state should usually flow through EventBus or `Flow`. Broadcasts are no longer a universal communication tool. They are a system-level mechanism for passing a small number of important signals. Once you understand the scheduler, you can decide when to use them and when to avoid them.
