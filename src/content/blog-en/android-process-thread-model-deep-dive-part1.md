---
title: "Android Process and Thread Model Deep Dive (1): Foundations and Challenges"
lang: en
translationKey: android-process-thread-model-deep-dive-part1
slug: android-process-thread-model-deep-dive-part1
excerpt: "Part 1 of a three-part Android process and thread model series, covering Linux foundations, Android process priority, Zygote, LMK, and multiprocess tradeoffs."
publishDate: 2025-07-04
displayInBlog: false
tags:
- "Android"
- "Process"
- "Thread"
- "Handler"
series:
  name: "Android Process and Thread Model Deep Dive"
  part: 1
  total: 3
seo:
  title: "Android Process and Thread Model Deep Dive: Foundations and Challenges"
  description: "Explore Linux process and thread basics, Android Zygote startup, process lifecycle, oom_adj priority, LMK behavior, and multiprocess architecture tradeoffs."
  pageType: article
---
> This is part 1 of the three-part "Android Process and Thread Model Deep Dive" series.

## Introduction: The Foundation and Challenge of Concurrent Execution

In Android, all application code runs inside a specific process and thread context. A process provides resource isolation and an independent runtime environment, while a thread is the basic unit scheduled by the CPU and is responsible for executing concrete instructions. Understanding how Android creates, manages, and schedules processes, including their lifecycle, priority, and termination model, and how threads are organized inside a process, including the main thread, Binder threads, background threads, synchronization, and communication, is essential for building stable, smooth, responsive applications.

For Android specialists, knowing the basics of `Thread` or remembering that UI operations must run on the main thread is not enough. You need a deeper understanding of the Linux process and thread model, Android's process lifecycle and OOM priority adjustment mechanism (`oom_adj`), the central role and performance limits of the main thread, how the Binder thread pool works, modern background execution strategies, the internals of Handler and Looper, advanced synchronization techniques, and systematic ANR (Application Not Responding) analysis. That depth is the foundation for solving concurrency bugs, improving responsiveness, and diagnosing system-level abnormal behavior.

This series walks through Android's process and thread model, including:

- **Low-level foundations**: a review of Linux process and thread concepts
- **Android processes**: Zygote forking, lifecycle, priority, and the OOM Killer (`oom_adj`)
- **Main thread deep dive**: key responsibilities and performance constraints of the UI thread
- **Binder threads**: the core thread pool that handles IPC
- **Background execution strategy**: modern concurrency options such as `ExecutorService` and coroutines
- **Handler internals**: how Looper, MessageQueue, and ThreadLocal work
- **Advanced synchronization**: principles and use cases for locks, atomics, and concurrency utilities such as `CountDownLatch` and `Semaphore`
- **ANR deep analysis**: a systematic way to diagnose and fix application-not-responding issues

## 1. Low-Level Foundations: Linux Processes and Threads

Android is built on top of the Linux kernel, so its process and thread model is inherited directly from Linux.

### Process

- An instance of a running program
- Owns an independent **virtual address space**, memory, data stack, file descriptors, and other system resources
- Is isolated from other processes; interprocess communication requires IPC mechanisms such as Binder, sockets, or pipes
- Linux creates child processes through the `fork()` system call, which copies the parent process address space. The child usually then calls one of the `exec()` system calls to load and run a new program image

### Thread

- An execution unit inside a process and the basic unit scheduled by the CPU
- Threads in the same process **share** the process virtual address space, memory resources such as code, data, and heap segments, and file descriptors
- Each thread has its own **independent** program counter, registers, and thread stack, which stores local variables and function call information
- Thread switching, or context switching, is usually much cheaper than process switching
- In the Linux kernel, a thread, or Lightweight Process (LWP), is created with the `clone()` system call and specific flags. `clone()` provides more flexible resource-sharing options than `fork()`. User space typically creates and manages threads through the POSIX threads library (`pthread`)

### Android Application Context

By default, every Android app runs in its own Linux process with a unique UID (user ID) and GID (group ID), which gives Android its application sandbox. All code inside the app, whether Java/Kotlin or native code, runs on some thread that belongs to that process.

## 2. Android Process Model: Managed Lifecycle and Priority

Android manages application processes far more aggressively than standard Linux. Its primary goal is to preserve system smoothness and user experience.

### Zygote-Forked Processes

As discussed earlier, all application processes, as well as `SystemServer`, are created by the Zygote process through `fork()`. This lets new processes start quickly and share memory through Copy-on-Write.

### Process Lifecycle and State, Managed by AMS

Android classifies processes into broad priority categories based on application component state and user interaction. This priority directly determines how likely a process is to be killed when memory is low.

#### Foreground Process

- The app the user is currently interacting with, where the top Activity is in the Resumed state
- Hosts a Service bound to an Activity the user is interacting with
- Hosts a Service that called `startForeground()` and shows a persistent notification
- Hosts a Service currently executing a lifecycle callback such as `onCreate`, `onStart`, or `onDestroy`
- Hosts a BroadcastReceiver currently executing `onReceive()`

**This has the highest priority. The system kills it only as a last resort, when memory is critically low.**

#### Visible Process

- Has an Activity visible to the user but not in the foreground, for example when the Activity is partially covered by a non-full-screen dialog or Activity and is in the Paused state
- Hosts a Service bound to a visible Activity

**This also has very high priority and is not killed unless doing so is necessary to keep foreground processes running.**

#### Service Process

- Hosts a Service started with `startService()` that is still running, where the Service does not belong to the foreground or visible process categories

**This has higher priority than background processes but lower priority than visible processes. Long-running, unimportant service processes may still be reclaimed.**

#### Cached Process

- Contains no foreground, visible, or service components. It usually contains an app the user has left, with Activities in the Stopped state, kept in memory for faster relaunch

**This has the lowest priority and is the first target when the system runs out of memory.** Cached processes are further ranked internally with policies such as LRU (least recently used), including empty processes, previous app processes, launcher processes, and so on.

**Diagram: Android process priority**

```plain
Most Important (Least likely to be killed)
          ^
          |
+-------------------------+
|  Foreground Process     |  (Activity Resumed, Foreground Service)  <- oom_adj ~ 0
+-------------------------+
          |
+-------------------------+
|  Visible Process        |  (Activity Paused but Visible)           <- oom_adj ~ 100-200
+-------------------------+
          |
+-------------------------+
|  Service Process        |  (Started Service running)               <- oom_adj ~ 500+
+-------------------------+
          |
+-------------------------+
|  Cached Process (LRU)   |  (Activity Stopped/Destroyed, Empty)     <- oom_adj ~ 900+
+-------------------------+
          |
          V
      Least Important (Most likely to be killed)
```

### OOM Killer and the oom_adj Score

**LMK (Low Memory Killer)**: a driver or mechanism in the Android kernel that kills processes according to priority when system memory drops below specific thresholds, reclaiming memory for the rest of the system.

**`oom_adj` (Out-of-Memory Adjustment) score**: a key kernel parameter calculated and assigned by `ActivityManagerService` (AMS) for each process. It is exposed at `/proc/<pid>/oom_score_adj`. Its value roughly ranges from -1000, meaning never kill, such as system processes, to +1000, meaning easiest to kill, such as empty cached processes. The lower the `oom_adj` value, the more important the process is and the less likely LMK is to kill it.

**Dynamic adjustment**: AMS **dynamically adjusts** a process's `oom_adj` score based on the state of components running in that process, such as whether an Activity is visible, whether a Service is foreground, or whether the process has bound connections. For example, when an Activity goes into the background, the `oom_adj` of its process rises. When a Service calls `startForeground()`, the process's `oom_adj` drops.

Understanding how `oom_adj` is calculated and how it affects the process is critical in these scenarios:

- **Background task design**: choose the right background mechanism, such as a foreground Service or WorkManager, so important work is more likely to survive under memory pressure
- **Process death analysis**: when an app process disappears unexpectedly, its last `oom_adj` score and the system memory state are key clues
- **Memory optimization**: reducing app memory usage lowers system-wide memory pressure and indirectly improves the survival odds of the app process

### Multiprocess Applications

**Scenario**: using the `android:process` attribute in `AndroidManifest.xml` allows different app components such as Activities, Services, Receivers, and Providers to run in separate processes.

**Benefits**: isolation, where one process crash does not affect other processes; possible avoidance of a single-process memory ceiling, although total memory usage is usually higher; and security, such as putting sensitive operations in a separate process.

**Challenges**:

- **IPC cost**: communication between processes must go through Binder (AIDL), Messenger, ContentProvider, sockets, or similar mechanisms, adding runtime overhead and implementation complexity
- **Higher memory usage**: each process has its own VM instance and runtime overhead, so total memory use is higher than in a single-process app
- **Management complexity**: interprocess dependencies, lifecycle synchronization, and data sharing need careful design

Multiprocess architecture is an architectural choice. Its benefits and costs must be weighed carefully, and it is usually adopted only when there is a clear need, such as stability isolation or special memory requirements.

---

> In the next article, we will discuss "The Android Main Thread (UI Thread): Heart and Bottleneck."

**"Android Process and Thread Model Deep Dive" Series**

1. **Introduction: The Foundation and Challenge of Concurrent Execution** (this article)
2. The Android Main Thread (UI Thread): Heart and Bottleneck
3. Advanced Synchronization and Thread Safety
