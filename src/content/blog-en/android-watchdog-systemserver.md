---
title: "Android Watchdog Internals: SystemServer Lock Monitoring and System Restart"
lang: en
translationKey: android-watchdog-systemserver
slug: android-watchdog-systemserver
excerpt: "A deep dive into Android Watchdog monitoring, deadlock detection, system_server restart flow, common triggers, and stack-based root cause analysis."
publishDate: '2025-09-30'
tags:
- "Android"
- "Watchdog"
- "system_server"
- "Deadlock Detection"
- "System Stability"
seo:
  title: "Android Watchdog: SystemServer Lock Monitoring and Restart Flow"
  description: "Understand Android Watchdog deadlock detection, HandlerChecker scheduling, 60-second timeout handling, system_server restart, and stack analysis."
  pageType: article
---

Most Android developers have seen ANRs: the main thread blocks for five seconds and the system shows a dialog. Watchdog failures are harsher. There is no dialog. The phone goes black, restarts, and logcat leaves one telling line: `WATCHDOG KILLING SYSTEM PROCESS`.

That log comes from Watchdog, Android's last line of defense at the system layer. The monitoring idea is similar to ANR detection because both are timeout-driven, but the target is different. Watchdog is not watching an app main thread. It watches key service locks inside the `system_server` process. Once it confirms a deadlock, it kills `system_server` directly and triggers a soft reboot of the device.

## Watchdog's core monitoring model

Watchdog is a singleton thread inside `system_server`. It is initialized early during `SystemServer.java` startup:

```java
// SystemServer.java
// Watchdog is initialized during startBootstrapServices().
final Watchdog watchdog = Watchdog.getInstance();
watchdog.start();
```

It does not poll lock state directly. That would be too expensive. The actual detection mechanism is **HandlerChecker**: Watchdog posts an empty message to the target thread's Handler queue. If it receives the acknowledgment before timeout, that thread's Looper is still turning normally, which means any locks it holds still have a chance to be released.

Internally, Watchdog maintains multiple HandlerCheckers, each bound to a critical service thread:

```java
// Watchdog.java - register a monitoring target
public void addMonitor(Monitor monitor) {
    // Register with the HandlerChecker for the foreground thread.
    mMonitorChecker.addMonitor(monitor);
}
```

The `Monitor` interface has a single method:

```java
public interface Monitor {
    void monitor();
}
```

During deadlock detection, Watchdog calls this method and deliberately tries to acquire service locks. If it cannot acquire them, the deadlock is effectively confirmed.

## MonitorChecker scheduling and detection flow

Watchdog's `run()` method is an infinite loop. Each iteration performs one full detection pass:

```java
@Override
public void run() {
    boolean waitedHalf = false;
    while (true) {
        // 1. Post monitoring messages to every HandlerChecker.
        for (HandlerChecker hc : mHandlerCheckers) {
            hc.scheduleCheckLocked();
        }
        
        // 2. Wait 30 seconds, half of the default timeout.
        long timeout = DEFAULT_TIMEOUT;  // 60 seconds
        long start = SystemClock.uptimeMillis();
        while (timeout > 0) {
            try { wait(timeout); } catch (InterruptedException e) {}
            timeout = DEFAULT_TIMEOUT - (SystemClock.uptimeMillis() - start);
        }
        
        // 3. Evaluate the result.
        boolean fdLimitTriggered = false;
        if (fdOverLimit()) fdLimitTriggered = true;
        
        final int waitState = evaluateCheckerCompletionLocked();
        if (waitState == COMPLETED) {
            waitedHalf = false;
            continue;
        } else if (waitState == WAITING) {
            continue;
        } else if (waitState == WAITED_HALF) {
            // First timeout: dump stacks.
            if (!waitedHalf) {
                // Dump AMS stacks, kernel stacks, and related state.
                waitedHalf = true;
            }
            continue;
        }
        
        // OVERDUE: confirmed deadlock, trigger restart.
        // ...
    }
}
```

The flow breaks down into three steps.

### Step 1: wait 30 seconds

MonitorChecker sends ping messages to each monitored thread and waits for acknowledgments. If no response arrives within 30 seconds, Watchdog moves to the next step.

### Step 2: wait another 30 seconds

Watchdog does not kill the process on the first timeout. It triggers a full stack dump first: AMS stacks, native stacks, and kernel stacks are written to logcat. Then it continues waiting.

### Step 3: confirm the deadlock

After the full 60-second timeout, Watchdog performs final confirmation by calling `Monitor.monitor()` again. If that method returns normally, the earlier timeout was a false positive and Watchdog lets it go. If it blocks, Watchdog kills `system_server`.

## The system restart path

After a deadlock is confirmed, the handling path is heavier than a simple `Process.killProcess()`:

```java
// Watchdog.java - handling after deadlock confirmation
if (!SFHang) {  // SurfaceFlinger is not the hung process.
    // 1. Dump final state.
    ProcessCpuTracker processCpu = new ProcessCpuTracker(true);
    doSysRq('w');   // Dump blocked tasks.
    doSysRq('l');   // Dump backtraces for all active CPUs.
    
    // 2. Write a DropBox entry.
    mActivity.addErrorToDropBox(
        "watchdog", null, "system_server", null, null,
        name, null, stackTrace, null);
    
    // 3. Kill system_server.
    Process.killProcess(Process.myPid());
    System.exit(10);
}
```

After `System.exit(10)`, the `system_server` process exits. The init process notices because `system_server` is declared as `critical` in `init.rc`. init then restarts the Android runtime, including Zygote. The kernel does not reboot, but all user-space services are reinitialized. In practice, it is a warm restart.

From the user's point of view, the screen goes black, the boot animation appears after a few seconds, and the device returns to the lock screen. The whole sequence usually takes 20 to 30 seconds.

## Common trigger scenarios

These are the categories I have seen most often in real projects.

**Binder call-chain deadlocks**. The common pattern is AMS holding its lock while waiting for a WMS callback, while WMS holds its own lock and waits for an AMS callback. Both sides make synchronous calls on each other's threads. Almost every service inside `system_server` uses Binder even though it is in the same process, so cross-service lock dependencies can easily form cycles.

**IO blocked inside a lock**. A service holds a lock while doing synchronous disk writes. If eMMC garbage collection kicks in, write latency can jump to seconds. A 60-second timeout is not generous under extreme IO jitter.

**Severe Binder congestion**. When the Binder thread pool is exhausted, any logic that depends on Binder communication to release a lock can sit in a queue. No single call has to be permanently deadlocked. If overall throughput drops to zero, Watchdog can still classify the situation as overdue.

## Finding the root cause from stacks

After a Watchdog restart, the key debugging material is under `data/anr/`. File names often look like `trace_01`. These traces are usually more detailed than a regular ANR `traces.txt`.

The investigation path is:

1. Start with the **Watchdog thread itself**: which `Monitor.monitor()` call is blocked?
2. Find the corresponding **Binder thread**: who owns that lock, and what is it waiting for?
3. **Trace the cross-process call chain**: if the Binder call leaves `system_server`, inspect the callee process stacks as well, usually SurfaceFlinger or mediaserver.

I once hit a case where Watchdog restarted the system and the stack showed AMS waiting for the `ActivityStackSupervisor` lock. The thread holding that lock was running `WindowManager.removeWindow()`. At first glance it looked like an AMS-WMS deadlock. After following the chain, the real issue turned out to be a lost vsync signal on the SurfaceFlinger side, which caused WMS `relayoutWindow` to block indefinitely. The root cause was not inside `system_server` at all.

For Watchdog issues, the stack tells you where the system blocked. The actual deadlock cycle often has to be reconstructed across processes.

## How Watchdog and ANR cooperate

One easy detail to miss: Watchdog and ANR are not fully separate mechanisms. When Watchdog enters the WAITED_HALF state, the first 30-second timeout, it actively calls AMS `dumpStackTraces()` and reuses the ANR path to collect process stacks.

That is why dumps triggered by Watchdog are more complete than normal ANR dumps. They include native processes and kernel threads, not just app processes. The cost is that, when the system is already badly congested, the dump operation itself can make the freeze worse and create a feedback loop where the device gets stuck dumping.

Android 12 introduced an optimization: before Watchdog triggers heavy dumps, it checks the IO wait ratio through `ProcessCpuTracker`. If the ratio exceeds a threshold, it skips some expensive dumps and prioritizes restart. Production data shows that this strategy significantly shortens the failure duration where the whole device appears frozen during dumping.
