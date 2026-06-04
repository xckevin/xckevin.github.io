---
title: "Android Dumpsys Deep Dive: System Service dump() to adb Debugging"
lang: en
translationKey: android-dumpsys-system-service-debugging
slug: android-dumpsys-system-service-debugging
excerpt: "A practical deep dive into Android dumpsys internals, covering Binder IPC, dump permission gates, buffer behavior, and scripts for memory leaks, ANR snapshots, and Binder storms."
publishDate: '2025-07-28'
tags:
- "Android"
- "dumpsys"
- "Performance Optimization"
- "Binder"
- "System Debugging"
seo:
  title: "Android Dumpsys: System Service dump(), Binder IPC, and adb Debugging"
  description: "Trace dumpsys from Binder calls to AMS internals, with scripts for memory leak tracking, ANR snapshots, and Binder storm diagnosis."
  pageType: article
---

When troubleshooting production issues, the command I use most often is not `top` or `logcat`. It is `dumpsys`. It can immediately expose the system's internals: memory distribution, Activity stacks, Binder call statistics. The information density is much higher than most other tools. But after using it long enough, you notice something uncomfortable: the same `dumpsys meminfo` command has completely different output structures across Android versions, and behavior after adding `--local` can be counterintuitive.

This article uses `ActivityManagerService.dump()` as the anchor and follows the Binder call chain downward. It explains dumpsys cross-process communication, permission gates, and buffer behavior. After that, you are not just someone who "knows how to use dumpsys"; you can build your own diagnostic scripts around it.

## The dumpsys entry point: underrated native code

It is natural to assume `adb shell dumpsys` directly calls the Java-layer ServiceManager. In reality, it first goes through a native path. The entry point is `frameworks/native/cmds/dumpsys/dumpsys.cpp`:

```cpp
int main(int argc, char* const argv[]) {
    sp<IServiceManager> sm = defaultServiceManager();
    Vector<String16> services = sm->listServices();
    // Match service names. By default, all services are listed.
    for (size_t i = 0; i < N; i++) {
        sp<IBinder> service = sm->checkService(services[i]);
        int err = service->dump(STDOUT_FILENO, args);
    }
}
```

dumpsys obtains a proxy to ServiceManager through `defaultServiceManager()`, then gets the target service's Binder reference with `checkService()` rather than `getService()`. The difference is that `checkService` does not block while waiting for a service to start. If the service is not registered, it returns null immediately. **This explains why dumpsys sometimes fails silently for certain services.**

After obtaining the IBinder reference, the `fd` argument of `dump(fd, args)` is passed directly as `STDOUT_FILENO`. Output travels through the file descriptor throughout the flow and does not go through Java String conversion. This detail matters later when discussing buffers.

## Binder-layer dump: how data crosses process boundaries

The `service->dump()` line triggers a full Binder cross-process call. The call chain looks like this:

```text
dumpsys (native)
  -> BpBinder::dump(fd, args)        // Proxy side, packages the request
    -> IPCThreadState::transact()    // Writes to /dev/binder
      -> BBinder::onTransact()       // Kernel wakes the target process
        -> BnInterface::dump(fd, args) // Stub side, unpacks the request
          -> Service::dump(fd, args)   // Final business logic
```

There are two pitfalls here. I have hit both.

First, dump is a synchronous Binder call. If the target service's `dump()` method holds a lock or performs heavy IO, the caller blocks the whole time. Before Android 10, I once saw `dumpsys activity` hang for 30 seconds in production. AMS held the AMS Lock during dump, then tried to acquire the WMS Lock, while WMS was busy handling a SurfaceFlinger callback. The result was a lock-chain stall.

Second, Binder transactions have a 1 MB transfer limit, but dump output does not use Binder's `data` buffer. It passes a file descriptor through the `fd` argument, and the target process writes directly to that fd. If you trace `sys_write` with strace, you can see this:

```bash
# dumpsys side
write(1, "...", 8192)  = 8192   # STDOUT_FILENO

# system_server side, where AMS lives
write(7, "...", 4096)  = 4096   # Same fd, shared kernel file table
```

So dump output has no 1 MB limit. In theory, it can output any amount of data. But when the output is huge, such as `dumpsys meminfo -a`, buffer behavior becomes a performance bottleneck.

## Inside AMS.dump(): priority queues and conditional output

Take ActivityManagerService as an example and look at how its dump method organizes output. AMS does not put all logic into one giant method. It uses a **priority dispatch** design:

```java
// ActivityManagerService.java, simplified
@Override
protected void dump(FileDescriptor fd, PrintWriter pw, String[] args) {
    // Permission check runs first
    if (!DumpUtils.checkDumpPermission(mContext, TAG, pw)) return;

    int opti = 0;
    while (opti < args.length) {
        String opt = args[opti];
        if ("-a".equals(opt)) {
            // Full dump, overrides all later priority filtering
            dumpAll = true;
        } else if ("--local".equals(opt)) {
            // Only dump local process information and skip cross-process queries
            localOnly = true;
        }
        opti++;
    }

    // PriorityDumper mechanism: decide output scope by priority
    synchronized (this) {
        dumpPriority(pw, PRIORITY_HIGH, "ACTIVITY MANAGER", args);
        if (dumpAll) {
            dumpPriority(pw, PRIORITY_NORMAL, "", args);
        }
    }
}
```

The `PriorityDumper` interface defines five priorities: `PRIORITY_CRITICAL`, `PRIORITY_HIGH`, `PRIORITY_NORMAL`, `PRIORITY_LOW`, and `PRIORITY_TRIVIAL`. A normal `dumpsys activity` only outputs CRITICAL and HIGH content. Adding `-a` outputs everything. This design directly affects output efficiency.

The `--local` option deserves separate attention. It does not merely mean "output less." It **skips every child dump that requires a cross-process Binder call**. For example, when AMS dumps the process list, it normally queries related information from WMS and PKMS. With `--local`, it only outputs cached data inside its own process. When production services are frequently inspected with dumpsys, `--local` can significantly reduce system_server load.

## Permission checks: two easy-to-miss gates

dump permission is checked at two levels.

**Shell level**: `adb shell dumpsys` runs as the shell user, which has the `DUMP` permission. In AndroidManifest this permission is `protectionLevel=signature|privileged`. But if your app wants to call it from code:

```java
// Correct way to call dumpsys from app-layer code
IBinder service = ServiceManager.getService("activity");
if (service != null) {
    // Requires android.permission.DUMP
    service.dump(yourFd, new String[]{"-a"});
}
```

The app must declare `android.permission.DUMP`, and it **must be a system-signed app** to actually hold it. Third-party apps cannot get this permission. The alternative is invoking `bugreport` through `adb shell`, but that captures a full system snapshot rather than a targeted dump.

**Service level**: AMS `checkDumpPermission()` also checks the caller UID. Non-shell and non-root callers receive a `Permission Denial` line in the output instead of an exception. This silent failure is often mistaken for the service not existing:

```text
Permission Denial: can't dump ActivityManager from pid=12345, uid=10123
```

## Output buffering: the C library trap

dump output is written to a FileDescriptor through `PrintWriter`, but `PrintWriter` itself is not buffered. The real performance factor is the C stdio buffer associated with the underlying fd.

There is an easy-to-miss detail in `dumpsys.cpp`: the dumpsys process does not call `setvbuf` proactively, so the default behavior of `STDOUT_FILENO` depends on the output target. In pipe mode, such as `adb shell dumpsys | grep`, it is **fully buffered**. Redirection to a file is also **fully buffered**. Only direct terminal output is **line buffered**.

This difference causes a concrete issue in troubleshooting:

```bash
# Output order may be delayed or appear out of order
adb shell dumpsys meminfo | grep "Used RAM"

# This is real-time
adb shell dumpsys meminfo
```

Fully buffered pipe mode means `grep` may not receive data until the buffer is full, usually 4096 bytes. For large dump output this does not matter much, but for streaming monitoring scripts it creates visible latency. The fix is to force line buffering on the dumpsys side:

```bash
adb shell "stdbuf -oL dumpsys meminfo" | tee meminfo.log
```

## Building a production diagnostic toolchain

Once you understand the internals, dumpsys stops being just a query command and becomes a programmable diagnostic primitive. These are three script snippets I maintain for daily use.

**Fast memory leak detection**: capture PSS deltas every five seconds:

```bash
#!/bin/bash
PID=$1
echo "TIME,PSS(KB),RSS(KB)"
while true; do
    pss=$(adb shell dumpsys meminfo $PID | grep "TOTAL PSS" | awk '{print $3}')
    rss=$(adb shell dumpsys meminfo $PID | grep "TOTAL RSS" | awk '{print $3}')
    echo "$(date +%H:%M:%S),$pss,$rss"
    sleep 5
done
```

You can judge the trend from the PSS slope alone. There is no need to compare MAT hprof files first.

**Snapshot right before ANR**: preserve system state from the last moment before ANR:

```bash
adb shell "while true; do dumpsys activity --local > /sdcard/ams_prev.txt; mv /sdcard/ams_prev.txt /sdcard/ams_curr.txt; sleep 2; done"
```

`--local` is crucial here. High-frequency dumpsys with the full version can overload system_server. When an ANR occurs, `ams_prev.txt` is the latest complete snapshot, preserving the InputDispatcher focus window and Activity stack state.

**Binder storm root-cause tracing**: find high-frequency Binder callers:

```bash
adb shell dumpsys binder_proxies | \
  grep -A5 "Outgoing" | \
  awk '/Node/{node=$3} /calls/{print node, $3, $5}' | \
  sort -k3 -rn | head -10
```

This script walks outgoing call counts for all Binder nodes, sorts by call frequency in descending order, and takes the top 10. During one system jank investigation, this command found the culprit in three minutes: a background service had accidentally put `getSystemService()` inside `onDraw()`.

## Boundaries and tradeoffs

dumpsys is not a silver bullet. It has clear boundaries.

**Performance cost**: AMS dump holds the AMS Lock, a global lock. Frequent calls can block Activity launch flow. For production inspection scripts, add `--local` and keep the dumping interval above five seconds.

**Version differences**: After Android 12, AMS dump output changed substantially. Some fields were removed or replaced. When writing cross-version diagnostic scripts, first use `dumpsys -l` to list available services, then adapt for the target Android version.

**Alternative options**: If you are building automated monitoring rather than doing immediate troubleshooting, `Perfetto` trace data is more structured and has a lower system impact. dumpsys is better suited to "I need to see the answer right now" situations.

In the end, `dumpsys` is a transient snapshot tool for system state. Its value is not in the output of a single command. Its value is in understanding where each field comes from, so when you see an abnormal value, you can follow the call chain back to the root cause.
