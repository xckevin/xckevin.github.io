---
title: "Android Zygote Process Deep Dive: From init fork to App Incubation"
lang: en
translationKey: android-zygote-init-fork-process
slug: android-zygote-init-fork-process
excerpt: "A deep dive into Android Zygote startup, preloading, socket communication, fork specialization, and how COW makes app process creation fast."
publishDate: '2025-10-03'
tags:
- "Android"
- "Zygote"
- "Performance Optimization"
- "Process Management"
- "Framework"
seo:
  title: "Android Zygote: init Startup, Preloading, Fork, and App Processes"
  description: "Trace Android Zygote from init startup to app process incubation, covering preloaded classes, sockets, COW, fork specialization, and pitfalls."
  pageType: article
---

While working on Android performance optimization, I once read through the Zygote source in AOSP with one question in mind: why does cold-starting an app take hundreds of milliseconds, while forking a new process can take only a few milliseconds? The answer is in Zygote's design. It turns the heavy operation of "process creation" into "process copying."

## What Zygote is

Zygote is one of the earliest daemon processes started after Android boots. Its name comes from biology: every Android app process is forked from it.

Its value is **preloading**. At startup, Zygote loads a large set of Framework Java classes and native libraries into memory once. Child processes forked from it share those read-only memory pages through Linux **COW**, or Copy-on-Write. This avoids repeated loading work for every app. It means two things: apps do not need to initialize the ART runtime from scratch, and multiple apps can share one copy of Framework memory, reducing total memory usage.

## Startup path: init to Zygote

Zygote is started by the init process and defined in `init.rc`:

```text
# system/core/rootdir/init.rc
service zygote /system/bin/app_process64 -Xzygote /system/bin --zygote --start-system-server
    class main
    priority -20
    user root
    group root readproc reserved_disk
    socket zygote stream 660 root system
```

There is a useful detail here: `app_process64` is not a dedicated Zygote executable. It is `app_process`, and the `-Xzygote` and `--zygote` arguments switch it into the Zygote path. `--start-system-server` tells Zygote to fork the SystemServer process immediately after startup.

Before init starts Zygote, it creates a Unix Domain Socket named `zygote`. AMS later uses this Socket to send fork requests to Zygote.

Zygote's entry point is in `app_main.cpp`:

```cpp
// frameworks/base/cmds/app_process/app_main.cpp
if (zygote) {
    runtime.start("com.android.internal.os.ZygoteInit", args, zygote);
} else if (className) {
    runtime.start("com.android.internal.os.RuntimeInit", args, zygote);
}
```

When `zygote` is true, execution enters the ZygoteInit path. Otherwise it uses RuntimeInit. A normal `app_process` invocation, such as directly executing a Java class, uses the latter path.

## Preloading: what Zygote actually loads

After entering Java code, `ZygoteInit.main()` performs four key steps:

```java
// frameworks/base/core/java/com/android/internal/os/ZygoteInit.java
public static void main(String[] argv) {
    zygoteServer = new ZygoteServer(isPrimaryZygote);
    preload(bootTimingsTraceLog);                     // Preload.
    if (startSystemServer) {
        forkSystemServer(abiList, zygoteSocketName, zygoteServer);
    }
    zygoteServer.runSelectLoop(abiList);              // Enter the wait loop.
}
```

`preload()` does five things, and each one directly affects app startup latency.

**preloadClasses()** reads `/system/etc/preloaded-classes` and loads classes one by one through `Class.forName()`. This file usually contains 3,000 to 6,000 classes and covers common Framework classes such as Activity, View, and Fragment.

**preloadResources()** loads system themes, color values, Drawables, and related resources to avoid reparsing them during every app startup.

**preloadOpenGL()** initializes an EGL context inside the Zygote process. After fork, child processes can reuse GPU driver state, which removes part of the first-frame graphics initialization delay.

**preloadSharedLibraries()** loads commonly used native shared libraries, including `libandroid_runtime.so` and `libicu.so`.

**preloadTextResources()** loads internationalized text resources.

At this point, Zygote has a complete ART runtime and Framework environment in memory and is ready to respond to fork requests.

## Socket communication and process incubation

Zygote listens on its Socket through select-style multiplexing:

```java
// frameworks/base/core/java/com/android/internal/os/ZygoteServer.java
void runSelectLoop(String abiList) {
    while (true) {
        Os.poll(pollFDs, -1);
        for (int i = pollFDs.length - 1; i >= 0; --i) {
            if (i == 0) {
                ZygoteConnection newPeer = acceptCommandPeer(abiList);
                peers.add(newPeer);
            } else {
                connection.processOneCommand(this);  // Handle fork request.
            }
        }
    }
}
```

When AMS decides to start an Activity, Service, or BroadcastReceiver, it sends a request to the Zygote Socket through `ProcessList`. The arguments include process uid, gid, nice name, and other specialization parameters.

After receiving the request, Zygote calls `Zygote.forkAndSpecialize()`:

```java
// frameworks/base/core/java/com/android/internal/os/Zygote.java
public static int forkAndSpecialize(int uid, int gid, int[] gids, 
        int runtimeFlags, int[][] rlimits, int mountExternal, 
        String seInfo, String niceName, ...) {
    ZygoteHooks.preFork();
    int pid = nativeForkAndSpecialize(...);
    ZygoteHooks.postForkCommon();
    return pid;
}
```

`nativeForkAndSpecialize()` is a JNI call. Under the hood, it executes the `fork()` system call. After fork returns, execution splits into two paths:

- **Parent process, Zygote**: receives the child PID, closes unused file descriptors, and continues the select loop
- **Child process, the new app**: receives 0, applies permission settings and seccomp filters, then eventually calls `RuntimeInit.applicationInit()` to start the app's main thread

"Specialize" refers to the child-process customization after fork: process-group setup, scheduling policy changes, and SELinux context switching.

## Why fork is faster than creating a process

Linux `fork()` uses COW semantics:

- During fork, the kernel does not copy the parent's physical memory. It only copies page tables and marks all pages read-only.
- When the parent or child tries to write to a page, the kernel triggers a page fault and copies that page.
- Preloaded classes and resources are mostly read-only, so child processes share them directly with zero copy.

The essence of Zygote is to move "start the ART VM and load the Framework" from **every app startup** to **one system startup operation**. In practice, preloading saves roughly one to three seconds, depending on the device and the size of the preload list.

## Practical pitfalls

**Bloated preloaded-classes lists**. OEMs sometimes add many classes to this file to speed up their own apps. Loading more than 10,000 classes can improve specific app startup paths, but it slows Zygote startup and raises the baseline memory footprint. AOSP is usually around 4,000 classes. Keeping the list under roughly 6,000 is a safer target.

**64-bit and 32-bit Zygote coexistence**. Android 5.0 introduced separate Zygote64 and Zygote32 processes, each preloading its own runtime environment. Apps choose through the `ro.zygote` property. On mixed-architecture devices, the two Zygotes each occupy memory, which matters on low-memory devices.

**ANR caused by a full Socket queue**. Zygote handles Socket requests on a single thread. If many process-start requests arrive at once, such as when a multi-process app starts several Providers in parallel, requests queue up. In extreme cases this can contribute to ANR. The fix is to reduce unnecessary processes or enable the USAP, Unspecialized App Process, pool to pre-fork processes.

**Fork time versus app startup time**. In several systrace captures I have taken, the fork itself usually costs only 5 to 50 ms. The real cost comes after fork, especially `Application.onCreate()` and ContentProvider initialization. Optimization work should focus there instead of obsessing over Zygote itself.

Zygote has been part of Android since Android 1.0, and its core idea has remained stable: shared memory and centralized preloading. Understanding that mechanism is far more useful than blindly adding classes to `preloaded-classes`.
