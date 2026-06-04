---
title: "Android App Battery Optimization with Battery Historian"
lang: en
translationKey: android-battery-optimization-battery-historian
slug: android-battery-optimization-battery-historian
excerpt: "A practical Android battery optimization guide using Battery Historian and Perfetto to reduce Wakelock, Alarm, and Network drain through staged background policies and CI checks."
publishDate: '2025-06-04'
tags:
- "Android"
- "Battery Optimization"
- "Wakelock"
- "Battery Historian"
- "Performance Optimization"
seo:
  title: "Android Battery Optimization: Battery Historian, Perfetto, and Background Work"
  description: "Use Battery Historian and Perfetto to diagnose Wakelock, Alarm, and Network drain, then reduce Android background power with policy tiers and CI checks."
  pageType: article
---

```bash
adb shell dumpsys batterystats --reset
# Use the app for 30 minutes...
adb bugreport bugreport.zip
```

Import the report into Battery Historian. Docker is the fastest setup:

```bash
docker run -p 9999:9999 gcr.io/android-battery-historian/stable:3.1 \
  --port 9999
```

Open `http://localhost:9999` and upload the zip file. You will get a very dense timeline. The first time you see it, it can be overwhelming. I recommend focusing on only three rows: **Wakelock**, **JobScheduler / Alarm**, and **Network**. Those three cover roughly 80% of background battery-drain cases.

A typical pattern looks like this: after the user turns the screen off, the Wakelock row shows long red bars, and the Network row shows intermittent blue blocks. That usually means some periodic background network request is running while holding a Wakelock. One request may consume only a few milliamps, but if it runs 60 times per hour, the battery will not last until the afternoon.

## Use Perfetto for millisecond-level attribution

Battery Historian tells you **when** the problem happened. Perfetto tells you **who** triggered it. Since Android 12, Perfetto tracing is built into the system, and the System Tracing app is the easiest capture path:

```bash
# Command-line capture: 30 seconds, including wakelock and work categories
adb shell perfetto \
  -c - --txt \
  -o /data/misc/perfetto-traces/trace.perfetto-trace <<EOF
buffers: { size_kb: 65536 }
data_sources: {
  config {
    name: "android.power"
  }
}
data_sources: {
  config {
    name: "android.network_packets"
  }
}
duration_ms: 30000
EOF
```

Open [ui.perfetto.dev](https://ui.perfetto.dev), jump to the problematic time range, and focus on two tracks:

- **Alarm wakeups**: shows the source package name and `Intent` behind the `PendingIntent`, which often points straight to the calling code. A common case is a third-party SDK registering high-frequency alarms, even though you never noticed when it was initialized.
- **Wakelock owners**: shows paired `acquire` and `release` events. The gap between them is the lock hold time. If `release` never appears, some code forgot to release the lock. This is harder to spot than a memory leak because it does not crash.

## Governance strategies for the three biggest battery drains

### Wakelock: releasing it is not the only concern

Most Android developers know Wakelocks must be released in pairs. Real projects have more subtle problems.

**The lock is held too long.** A WakeLock may be held for three seconds even though the protected work only needs 200 ms. The usual cause is code structure: a network request and lock release are bound to the same `try-finally`, so a network timeout keeps the CPU awake unnecessarily. Split the scopes.

```kotlin
// Bad example: network request is inside the lock-protected scope
wakeLock.acquire()
try {
    api.fetchData() // May take 5-10 seconds
    processData()
} finally {
    wakeLock.release()
}

// Better: protect only the work that truly needs the CPU awake
wakeLock.acquire()
val data = try {
    api.fetchData()
} finally {
    wakeLock.release()
}
processData() // This part does not need to hold the lock
```

**Nested locks.** Module A acquires a lock, calls module B, and B acquires another lock. If B exits through an exception, A's outer `release` still runs, but B's lock leaks. A reference-counted WakeLock or a wrapper class that centralizes acquisition and release can eliminate this class of bug.

### Alarm: from periodic polling to demand-driven wakeups

The battery model for alarms is simple: every wakeup keeps the CPU out of suspend for at least 3-5 seconds, even if your code runs for only 10 ms. An alarm that fires 3,600 times per hour, once per second, keeps the device from entering deep sleep.

I usually reduce alarms in three levels:

**Level 1: merge intervals.** If multiple modules set their own alarms at nearby times, merge them into one scheduling window. For example, module A fetches messages every five minutes and module B syncs config every six minutes. You may not be able to make the periods identical through a greatest common divisor, but both can run inside a five-minute window.

**Level 2: tolerate delay.** Very few cases truly need `setExactAndAllowWhileIdle`. Most background tasks are fine with `setWindow` or even `setInexactRepeating`, letting the system merge adjacent alarms into one wakeup window:

```kotlin
alarmManager.setWindow(
    AlarmManager.ELAPSED_REALTIME_WAKEUP,
    triggerTime - tolerance,
    tolerance,
    pendingIntent
)
```

**Level 3: migrate to WorkManager.** WorkManager uses JobScheduler underneath and lets the system flexibly delay non-urgent work based on battery and network state. After I moved 80% of alarm-based tasks to WorkManager in one project, background wakeups dropped to one fifth of the original count.

### Network: it is not only about fewer bytes

Mobile network power has an easy-to-miss property: establishing the connection costs more than transmitting the data. On cellular networks, moving from idle to active and then to DCH, the dedicated channel state, takes about two seconds. During that time, power consumption is more than 10 times idle. That is why reducing request count matters more for battery than reducing payload size.

Three tactics help:

- **Request merging**: send queued analytics events together during the Doze exit window, or Maintenance Window, instead of uploading every event in real time. Firebase Performance itself follows this pattern.
- **Frequency reduction**: adjust request frequency based on battery level. Below 20%, queue non-critical requests until the device is charging.
- **Protocol Buffers instead of JSON**: not primarily for bandwidth, but because serialization and deserialization are faster, shortening CPU active time. Parsing a 50 KB JSON payload may consume 30 ms of CPU time; an equivalent protobuf can take less than 5 ms.

## Build continuous monitoring, not a one-time cleanup

After the code is fixed, how do you keep it from regressing? A trap I have hit is manually running Battery Historian before every release. Two releases later, nobody remembers to do it.

A better approach is to put battery checks into CI:

```bash
# Automated batterystats analysis script
adb shell dumpsys batterystats --checkin com.yourapp > stats.txt
# Parse key metrics
grep "wake_lock" stats.txt | awk -F',' '{sum+=$4} END {print "Total wakelock time:", sum/1000, "s"}'
grep "alarm_trigger" stats.txt | awk -F',' '{total+=$3} END {print "Total alarms:", total}'
```

I set two threshold lines: compare each version's alarm wakeup count with the previous version and alert if it grows by more than 15%; also alert if total Wakelock hold time exceeds 300 seconds per hour. Absolute precision is not the goal. The trend matters more than the exact number.

For production monitoring, Firebase Performance's Network metrics plus custom traces are enough to see the distribution of main-thread blocking caused by network requests, without adding another SDK. If a network request's P99 grows from 200 ms to 500 ms, the first thing to investigate is not raw performance. It is why that request is being made frequently in the background.

## From local optimization to architecture decisions

Looking back, the hardest part of battery optimization is not finding the problem. It is making tradeoffs between product requirements and power cost. Product wants real-time presence, but Doze restricts background network access. Operations wants frequent event uploads, but every upload wakes the device.

My principle is: **do not compromise foreground experience; tier background power use by priority**. When the user is actively using the app, sync what needs syncing and render what needs rendering. There is no point saving power there. After screen-off, only time-sensitive features such as IM messages and incoming calls should use real-time paths. Everything else should wait for system maintenance windows.

After this tiered strategy landed, the social app's background battery usage dropped from 23% per day to 6%, and battery-related app store complaints disappeared within two months. The gain was not only battery life. With fewer WakeLocks, System Server Binder traffic also dropped, and the whole device felt smoother. That is the extra payoff of battery optimization, and why it is more system-level than many other performance projects.
