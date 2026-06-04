---
title: "Inside Android AlarmManager Scheduling"
lang: en
translationKey: android-alarmmanager-scheduling
slug: android-alarmmanager-scheduling
excerpt: "A full-path breakdown of Android AlarmManager scheduling, from AlarmManagerService Binder calls to RTC wakeups, Doze limits, batching, and dumpsys debugging."
publishDate: '2025-05-29'
tags:
- "Android"
- "AlarmManager"
- "Doze Mode"
- "Scheduled Work"
- "Performance Optimization"
seo:
  title: "Android AlarmManager Scheduling: Binder, RTC Wakeups, and Doze"
  description: "Follow Android AlarmManager from Binder calls to RTC wakeups, with Doze delays, batching, exact-alarm permissions, and dumpsys diagnostics."
  pageType: article
---

A project once had a message polling module that used `AlarmManager.setRepeating()` every five minutes to fetch server messages. QA reported that polling stopped after the device had been screen-off for half an hour, then immediately resumed when the screen turned on. There were no crashes in the logs, but the scheduled task clearly was not firing.

The root cause was **Doze Mode**, introduced in Android 6.0, which defers non-critical scheduled work. AlarmManager is much more than a single API call. From an app's `set()` call to a kernel **RTC_WAKEUP** hardware wakeup, the request passes through multiple layers of filtering, alignment, and policy control. Starting from `setExactAndAllowWhileIdle()`, let's walk through the whole path.

## How AlarmManagerService stores alarms

The client sends a request through `AlarmManager.set()`. Binder carries it across process boundaries into `AlarmManagerService`, which runs in `system_server`. The service keeps all pending alarms in time-sorted lists:

```java
// Simplified AOSP-style AlarmManagerService data structures
final ArrayList<AlarmBatch> mAlarmBatches = new ArrayList<>();

// Sorted by trigger time, separated by Doze-bypassing and non-bypassing alarms
private final ArrayList<Alarm> mPendingWhileIdleAlarms;
private final ArrayList<Alarm> mPendingNonIdleAlarms;
```

The core fields are `whenElapsed` (trigger time based on `SystemClock.elapsedRealtime()`), `windowLength` (allowed timing window), `PendingIntent` (callback carrier), and `type` (wakeup behavior).

**The type determines low-level alarm behavior**. Alarm types with the `_WAKEUP` suffix, such as `RTC_WAKEUP` and `ELAPSED_REALTIME_WAKEUP`, wake the CPU when the device is asleep. Types without `_WAKEUP` fire only when the device is already awake and are skipped during sleep.

Every alarm insertion triggers reordering. If the new alarm is earlier than the current earliest alarm, the system must update the kernel alarm time.

## The full journey of one Binder request

From `setExactAndAllowWhileIdle()` to the kernel RTC hardware, the call path has four stages.

### 1. App layer -> Binder -> AlarmManagerService

```java
// App-side call
alarmManager.setExactAndAllowWhileIdle(
    AlarmManager.ELAPSED_REALTIME_WAKEUP,
    SystemClock.elapsedRealtime() + 5 * 60 * 1000,
    pendingIntent);
```

After crossing Binder, the request enters `AlarmManagerService.setImpl()`:

```java
void setImpl(int type, long triggerAt, long windowLength,
             PendingIntent operation, ...) {
    // Calculate the actual trigger window
    final long maxElapsed = (windowLength > 0)
        ? triggerAt + windowLength : triggerAt;

    // Create the Alarm object and enqueue it
    Alarm a = new Alarm(type, triggerAt, maxElapsed, ...);
    int index = addAlarm(a);

    // Earlier than the current earliest alarm: update the kernel alarm
    if (index == 0) {
        rescheduleKernelAlarmsLocked();
    }
}
```

### 2. Updating the kernel alarm

`rescheduleKernelAlarmsLocked()` finds the earliest pending alarm and writes it to the kernel:

```java
void rescheduleKernelAlarmsLocked() {
    long nextWakeup = getNextWakeupTime();  // Aggregate all alarm types

    // Skip if the kernel alarm time has not changed
    if (nextWakeup == mLastWakeScheduleTime) return;

    mLastWakeScheduleTime = nextWakeup;
    setKernelTime(nextWakeup);
}
```

### 3. Kernel landing: RTC hardware wakeup

**The kernel implementation went through three iterations**:

| Era | Mechanism | Notes |
|------|------|------|
| Android 4.x | `/dev/alarm` character device | Custom alarmtimer driver with direct ioctl calls |
| Android 5.0+ | `timerfd_create(CLOCK_REALTIME_ALARM)` | Standard Linux interface through the alarmtimer subsystem |
| Final write | `/sys/class/rtc/rtc0/wakealarm` | Configures the hardware RTC chip, which wakes the SoC through an interrupt |

You can verify this hardware path directly while debugging. `adb shell cat /sys/class/rtc/rtc0/wakealarm` reads the next hardware wakeup time, letting you compare it with the alarm shown in `dumpsys`.

### 4. Callback dispatch when the alarm fires

When the RTC reaches the wakeup time, the kernel raises an interrupt, the SoC powers up, the `alarmtimer` driver notifies user space, the listener thread inside `AlarmManagerService` wakes, the service scans expired alarms in `mAlarmBatches`, and callbacks are dispatched to target apps through `PendingIntent.send()`.

## Doze Mode traffic control

Doze has two phases, and alarm behavior differs sharply between them.

**Phase 1: Light Idle** starts a few minutes after screen-off. The system disables network access and defers JobScheduler and sync tasks, but **alarms still fire normally**. AlarmManager impact is small in this phase.

**Phase 2: Deep Idle** starts when the device remains still and unplugged for a long time. The system switches to **Maintenance Windows**. Normal alarms are deferred and executed in batches during periodic windows. The interval between windows gradually grows from minutes to hours.

```java
// Deferred to a maintenance window in Deep Doze; timing is not predictable
alarmManager.set(AlarmManager.RTC_WAKEUP, triggerTime, pi);
alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, interval, pi);

// Bypasses Doze, but is still rate-limited by the system
alarmManager.setExactAndAllowWhileIdle(
    AlarmManager.RTC_WAKEUP, triggerTime, pi);
```

Even with `setExactAndAllowWhileIdle()`, a single app's minimum alarm interval during Doze is roughly **9 minutes**. More frequent calls are detected inside `AlarmManagerService.checkAllowWhileIdleFrequent()` and forcibly delayed. This value is not a documented API contract; it is a hardcoded limit in AOSP.

The key command for diagnosing Doze effects is `adb shell dumpsys deviceidle`. The `mState` field shows the current state, such as `ACTIVE`, `IDLE`, or `IDLE_MAINTENANCE`; `mLightState` shows the Light Idle state.

## Batching: the tradeoff between power and precision

`AlarmManagerService` is not a simple alarm passthrough. For inexact alarms scheduled with `set()`, the system performs **batching**:

```java
// Simplified alignment logic
long adjustRepeatingWindow(long triggerAt, long interval) {
    // Align the trigger time upward to an interval boundary
    return ((triggerAt + interval - 1) / interval) * interval;
}
```

The idea is straightforward: alarms from multiple apps that occur at nearby times are merged into one batch, reducing the number of device wakeups. With the `windowLength` parameter, you can give the system more freedom to align work. For example, `setWindow()` with a 30-second window lets the system choose the most power-efficient trigger point inside that window.

Android's power strategy is a tradeoff here: the more delay you can tolerate, the more power the system can save. If a task does not require second-level precision, `set()` with a reasonable window is more power-efficient than `setExact()`.

## Practical pitfalls

**Wakeup type and background behavior**: background polling, message push, and other tasks that must run after screen-off need an alarm type with the `_WAKEUP` suffix. I once saw a production incident where a background heartbeat used `ELAPSED_REALTIME` without `WAKEUP`. After the device slept, heartbeats stopped, the server considered devices offline, and a large reconnect storm followed.

**The misleading behavior of `setRepeating()`**: the API name implies repetition, but it is still deferred under Doze. Its repetition is reliable only while the device is active. If you need reliable scheduled wakeups, schedule the next alarm manually after each alarm fires. I have hit this in a real project: we assumed `setRepeating()` guaranteed periodic execution, but it was completely unreliable under Doze, so we replaced it with manual chained scheduling.

**Android 12+ permission requirements**: starting with API 31, `SCHEDULE_EXACT_ALARM` became a special permission that users can disable in Settings. If you call `setExactAndAllowWhileIdle()` without this permission, the system does not crash. It **silently degrades the alarm to an inexact alarm**, which is why many apps see scheduled work fail after upgrading. `adb shell dumpsys alarm` can show the app's actual exact-alarm permission state.

**Build your own debugging path**: when an alarm does not fire, check in this order: `dumpsys alarm | grep <package>` to confirm system-side registration, `dumpsys deviceidle` to confirm Doze state, `cat /sys/class/rtc/rtc0/wakealarm` to confirm kernel RTC configuration, and `dumpsys package <package> | grep SCHEDULE_EXACT` to check permission. These four commands cover the full app-to-hardware path and locate issues much faster than reading source code from scratch.
