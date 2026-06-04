---
title: "Android ANR Governance: From Main-Thread Stalls to ANR Trace Analysis"
lang: en
translationKey: android-anr-trace-governance
slug: android-anr-trace-governance
excerpt: "A practical ANR analysis workflow covering signal-triggered traces, MessageQueue backlog, Binder timeouts, lock contention, Perfetto alignment, and production monitoring."
publishDate: '2026-04-19'
tags:
- "Android"
- "ANR"
- "Performance Optimization"
- "Perfetto"
- "Binder"
seo:
  title: "Android ANR Governance: Main-Thread Stalls, traces.txt, Binder, and Perfetto"
  description: "Analyze Android ANRs with traces.txt, MessageQueue backlog, Binder waits, lock contention, Perfetto timelines, and production monitoring."
  pageType: article
---

You receive an ANR report from production, open `traces.txt`, and see the main thread parked in `nativePollOnce`. It looks idle, so it is tempting to assume the app was not doing anything. That is one of the easiest ANR traps to fall into. ANR attribution is not just "what was the main thread doing?" It requires correlating the signal trigger time, MessageQueue backlog, Binder call chains, and lock contention.

This article starts with the ANR signal mechanism, walks through the three most common root-cause categories, and ends with a practical `traces.txt` + Perfetto alignment workflow.

## How ANR is triggered: not just a timeout, but a signal

Many developers describe ANR as "the main thread did not respond for 5 seconds, so Android showed a dialog." That is close, but not precise enough.

Android uses a **Watchdog + Signal** mechanism. For input events, `InputDispatcher` starts a timer when it dispatches a touch or key event. If it does not receive the app's `finished` callback within 5 seconds, it sends `SIGQUIT` (signal 3) to the target process. After receiving that signal, ART's signal handler dumps all thread stacks into `/data/anr/traces.txt`.

Common timeout thresholds:

| ANR type | Timeout |
|---|---|
| Input event (touch/key) | 5s |
| Foreground Service | 20s |
| Background Service | 200s |
| BroadcastReceiver (foreground) | 10s |
| BroadcastReceiver (background) | 60s |

The key detail is that the moment `SIGQUIT` is sent is not the same as the moment the main thread first stalled. The stack in `traces.txt` is a snapshot at signal time, not at stall start time. This timing gap is the root of many wrong conclusions.

## Reading traces.txt: a three-part check

After opening `traces.txt`, find the target process and its `main` thread. Then inspect three dimensions.

**Thread state**

```text
"main" prio=5 tid=1 Sleeping
  | group="main" sched=0/0 handle=0x...
  | sysTid=12345 nice=-10 cgrp=default
  | held mutexes=
```

`Sleeping` means the thread is waiting, `Blocked` means it is waiting for a lock, and `Native` means it is executing native code. If `held mutexes` is not empty, the main thread is holding a lock. In that case, look for the other threads waiting for the same lock.

**Java stack**

```text
at android.os.MessageQueue.nativePollOnce(Native method)
at android.os.MessageQueue.next(MessageQueue.java:335)
at android.os.Looper.loop(Looper.java:183)
```

Do not immediately conclude "the main thread was idle" when you see `nativePollOnce`. It only means the main thread was waiting in `epoll` when the signal was handled. The real problem may have already finished, leaving the main thread waiting for the next message, or a long-running message may have ended just before the dump.

**Binder thread correlation**

If the Java stack contains `BinderProxy.transact`, inspect the Binder thread pool in the same process or in the remote process:

```text
"Binder:12345_3" prio=5 tid=15 Blocked
  at com.example.SomeService.heavyQuery(...)
  - waiting to lock <0x0a1b2c3d> (SomeService.class)
    held by thread 8 ("AsyncTask #1")
```

In this case, the chain is: main thread -> Binder call -> remote Binder thread waiting for a lock. The actual root cause is the other thread holding that lock.

## Three root-cause categories

### Root cause 1: MessageQueue backlog

This usually appears when message handling time is uneven. A single 2-second message may not trigger an ANR, but 50 messages at 100 ms each can exceed the timeout cumulatively.

Instrumentation inside `Looper.loop()` is not enough. Use `Looper.getMainLooper().setMessageLogging()` to monitor the execution time of each message:

```kotlin
Looper.getMainLooper().setMessageLogging { log ->
    if (log.startsWith(">>>>> Dispatching")) {
        // Record the start time.
        startTime = SystemClock.uptimeMillis()
    } else if (log.startsWith("<<<<< Finished")) {
        val cost = SystemClock.uptimeMillis() - startTime
        if (cost > 100) { // Report messages taking more than 100 ms.
            reportSlowMessage(log, cost)
        }
    }
}
```

One pitfall: this logging callback adds string-formatting overhead in production. Enable it in debug or staged builds, not across the full production population.

For production, I prefer using `Choreographer` `FrameCallback` intervals to infer long main-thread blocking indirectly.

### Root cause 2: Binder call timeout

A synchronous Binder call blocks the main thread until the remote side returns. The source usually falls into two buckets.

**The remote process is busy**: system services such as AMS, WMS, and PackageManager can respond slowly under load. Any `getSystemService`-related call can become a delayed failure point.

```java
// This looks harmless, but it is a synchronous Binder call.
ActivityManager am = (ActivityManager) context.getSystemService(ACTIVITY_SERVICE);
am.getRunningAppProcesses(); // Do not call this on the main thread.
```

**The Binder thread pool is exhausted**: the default pool size is 15 threads. When many concurrent Binder requests saturate the pool, new calls queue up. In `traces.txt`, you may see multiple Binder threads in the `Blocked` state.

Diagnostic commands:

```bash
# Check the process thread count.
cat /proc/<pid>/status | grep Threads
# Count threads whose names start with "Binder:" in traces.txt.
grep -c "Binder:" traces.txt
```

### Root cause 3: lock contention

This is the hardest category to diagnose because the thread holding the lock often looks like it is doing normal work. It is just holding the lock for too long.

The important `traces.txt` markers are `waiting to lock` and `held by thread`. Build the wait graph manually:

```text
main -> waiting for lock A (SharedPreferences$EditorImpl.this)
    <- held by thread-12
thread-12 -> waiting for lock B (SQLiteDatabase.this)
    <- held by thread-8
thread-8 -> running a DB query in native code
```

If the graph has a cycle, it is a deadlock. If it is a chain, inspect the tail thread that is still doing work. That is usually the real root cause.

In real projects, I have repeatedly seen `SharedPreferences.apply()` cause lock contention. `apply()` writes to disk asynchronously, but when `Activity.onStop()` or `Service.onStop()` runs, the system waits for all pending `apply()` operations to finish. That wait happens synchronously on the main thread.

```kotlin
// Risky: frequent apply() calls can block the main thread during onStop.
prefs.edit().putString("key", value).apply()

// For onStop paths, consider flushing earlier or moving to DataStore.
```

## Perfetto alignment: from static snapshot to dynamic timeline

`traces.txt` is a snapshot at the moment of the incident. Perfetto shows the timeline before and after it. You need both to reconstruct what actually happened.

The ideal production setup captures a Perfetto trace when an ANR is reported, but the operational cost is high. For reproduction, use a command like this:

```bash
adb shell perfetto \
  -c - --txt \
  -o /data/misc/perfetto-traces/trace.pftrace \
<<EOF
buffers: { size_kb: 63488 fill_policy: RING_BUFFER }
data_sources: { config { name: "linux.process_stats" } }
data_sources: { config { name: "linux.ftrace"
  ftrace_config {
    ftrace_events: "sched/sched_switch"
    ftrace_events: "sched/sched_blocked_reason"
    ftrace_events: "binder/binder_transaction"
  }
}}
duration_ms: 10000
EOF
```

In the Perfetto UI, focus on three signals.

**`sched_blocked_reason`**: when a thread transitions from running to sleeping, this ftrace event records why it blocked. If the thread enters `D` state (uninterruptible sleep), it is waiting for I/O or a kernel lock. That is invisible in a Java-level `traces.txt` stack.

**`binder_transaction`**: this shows Binder transaction sender, receiver, and duration. Main-thread Binder calls longer than 1 second stand out clearly here.

**Main-thread Running ratio**: if the main thread spends a long time outside the Running state, it is not computing; it is waiting for something. Combine this with `traces.txt` lock information to identify the exact lock.

Alignment tip: find the `ANR in` logcat line, take its system timestamp, locate that time in the Perfetto timeline, then inspect thread scheduling for the 5 to 10 seconds before it.

## Production governance loop

Being able to analyze ANRs is not enough. You also need continuous production monitoring and attribution. A practical implementation has three layers.

**Layer 1: real-time monitoring**. A main-thread watchdog posts a heartbeat message to the main thread every second. If no response arrives within 3 seconds, it captures and reports the current stack. This often catches the signal before the real ANR dialog is triggered.

```kotlin
class MainThreadWatchdog(private val threshold: Long = 3000L) {
    private val handler = Handler(Looper.getMainLooper())
    private val monitorThread = HandlerThread("watchdog").also { it.start() }
    private val monitorHandler = Handler(monitorThread.looper)

    fun start() {
        scheduleHeartbeat()
    }

    private var lastBeat = SystemClock.uptimeMillis()

    private fun scheduleHeartbeat() {
        handler.post { lastBeat = SystemClock.uptimeMillis() }
        monitorHandler.postDelayed({
            val gap = SystemClock.uptimeMillis() - lastBeat
            if (gap > threshold) {
                // Capture and report the main-thread stack.
                reportStall(gap)
            }
            scheduleHeartbeat()
        }, 1000)
    }
}
```

**Layer 2: local ANR collection**. Capture `SIGQUIT`, take over the signal handler in native code, dump complete thread stacks, then send structured data back to Java through a socket. Matrix's open-source AnrCanary module implements this flow and can be integrated directly.

**Layer 3: attribution classification**. Automatically tag reported stacks by root cause: contains `nativePollOnce` and no pending messages, mark as possible false attribution; contains `waitForCondition`, classify as Binder wait; contains `waiting to lock`, classify as lock contention. After classification, route each type to the responsible team instead of dumping all ANRs into one unattended queue.

---

The hardest part of ANR governance is not the technology. It is the noise. A `traces.txt` snapshot may catch the recovery period instead of the stall period, and the stack often points to the symptom rather than the cause. Building the habit of analyzing both "snapshot + timeline" and attaching the previous 3 seconds of MessageQueue logs to reports can materially improve attribution accuracy. I prefer setting watchdog heartbeat thresholds around 2 seconds rather than 5 seconds. It is cheaper to catch the stall early than to reverse-engineer it after the ANR dialog.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Performance Optimization](/en/android-performance/)
- [Android Binder IPC model: cross-process calls, thread pools, and performance traps](/en/blog/android-binder/)
- [Android Perfetto: trace capture, track analysis, and performance debugging](/en/blog/android-perfetto/)
- [Android startup optimization: from Zygote fork to first frame with Perfetto](/en/blog/android-cold-start-zygote-systrace/)
- [DataStore vs SharedPreferences: choosing Android local configuration storage](/en/blog/datastore-vs-sharedpreferences/)
<!-- /seo-internal-links -->
