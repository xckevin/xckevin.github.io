---
title: "Android Process and Thread Model Deep Dive (3): Thread Safety"
lang: en
translationKey: android-process-thread-model-deep-dive-part3
slug: android-process-thread-model-deep-dive-part3
excerpt: "Part 3 of the Android process and thread model series, covering advanced synchronization, thread safety, ANR triggers, trace analysis, and Perfetto workflows."
publishDate: 2025-07-04
displayInBlog: false
tags:
- "Android"
- "Process"
- "Thread"
- "Handler"
series:
  name: "Android Process and Thread Model Deep Dive"
  part: 3
  total: 3
seo:
  title: "Android Process and Thread Model Deep Dive: Thread Safety and ANR"
  description: "Learn Android synchronization primitives, thread-safety practices, ANR triggers, trace reading, Binder analysis, lock diagnostics, and Perfetto workflows."
  pageType: article
---
> This is part 3 of the three-part "Android Process and Thread Model Deep Dive" series. The previous article covered "The Android Main Thread (UI Thread): Heart and Bottleneck."

## 7. Advanced Synchronization and Thread Safety

When multiple threads access shared mutable data, synchronization is required to guarantee **atomicity**, **visibility**, and **ordering**, preventing data races and inconsistent state.

### Core Concepts

- **Atomicity**: one operation, or a set of operations, either completes entirely without interruption by any external factor, or does not execute at all
- **Visibility**: when one thread changes the value of a shared variable, other threads can observe that change immediately
- **Ordering**: program execution follows the source-code order. Compilers and processors may reorder instructions for optimization, and synchronization mechanisms are needed to preserve ordering in specific cases

### Choosing and Applying Synchronization Primitives

#### synchronized (Built-in Lock)

- **Pros**: simple to use and hard to misuse because the lock is released automatically
- **Cons**: relatively limited. The lock is not interruptible, does not support fairness, and each lock has only one associated condition wait queue. It is suitable for simple, low-contention scenarios

#### volatile

- **Purpose**: guarantees **visibility** for the decorated variable and prevents some instruction reordering, partially guaranteeing ordering
- **Limitation**: does **not** guarantee atomicity. For example, `volatile int i; i++;` is not atomic
- **Use cases**: mainly state flags, such as `volatile boolean flag = false;`, or visibility for a single read/write operation. It cannot replace locks for compound operations

#### java.util.concurrent.locks.Lock, such as ReentrantLock

- **Pros**: more powerful. It supports interruptible locking (`lockInterruptibly`), timed locking (`tryLock`), fair and non-fair locks, and multiple Condition objects for more complex wait/notify patterns
- **Cons**: must be released manually in a `finally` block with `unlock()`, otherwise deadlocks may occur
- **Use cases**: scenarios that require more flexible lock control, interruptibility, fairness, or multiple wait conditions. Performance is similar to `synchronized` under low contention and is often better under high contention, depending on implementation and platform

#### ReadWriteLock, such as ReentrantReadWriteLock

- **Scenario**: shared data with many reads and few writes. Multiple reader threads may access the data at the same time, while writes are exclusive
- **Pros**: significantly improves read concurrency
- **Note**: the implementation is more complex than `ReentrantLock`; read locks (`readLock()`) and write locks (`writeLock()`) must be used correctly

#### java.util.concurrent.atomic.*

- **Scenario**: atomic updates to a single variable, such as a counter or state flag
- **Principle**: uses CPU-provided CAS (Compare-and-Swap) atomic instructions. It is lock-free and efficient
- **Pros**: lighter and faster than locks
- **Limitation**: only guarantees atomicity for a single variable. It cannot guarantee atomicity for compound operations

#### CountDownLatch

- **Scenario**: one thread needs to wait until one or more other threads finish some work before continuing. For example, the main thread waits for several initialization subtasks to complete

#### CyclicBarrier

- **Scenario**: multiple threads wait for each other until all of them reach a barrier point, and then they continue to the next step together. It can be reused. For example, each phase of a parallel computation may need to wait until all worker threads finish

#### Semaphore

- **Scenario**: limit how many threads can access a specific resource at the same time, such as a database connection pool or network connection limit

#### BlockingQueue

- **Scenario**: producer-consumer patterns. It decouples producer and consumer threads and provides built-in synchronization and blocking behavior

### Thread-Safety Best Practices

- **Prefer immutability**: if shared data is immutable, meaning its state does not change after creation, it is naturally thread-safe and needs no synchronization
- **Narrow synchronization scope**: keep the locked region as small as possible and protect only the required critical section to improve concurrency
- **Lock ordering**: if multiple locks must be acquired, make sure every thread acquires them in the **same** fixed order to avoid deadlocks
- **Use concurrent collections**: the `java.util.concurrent` package provides thread-safe collections such as `ConcurrentHashMap` and `CopyOnWriteArrayList`, which are often more efficient and safer than manually synchronizing `HashMap` or `ArrayList`
- **Avoid long-running work or external calls while holding a lock**: otherwise, a lock may be held for too long

## 8. Deep ANR Analysis

ANR is Android's signal that an app is seriously unresponsive. It is a problem every Android engineer must be able to diagnose and fix confidently.

### Trigger Conditions Recap

- **Input event timeout**: an input event, such as touch or key input, is not handled within 5 seconds
- **Broadcast receiver timeout**: `onReceive()` takes too long. Foreground broadcasts are usually limited to 10 seconds, while background broadcasts may allow around 60 seconds
- **Service timeout**: key methods such as `onCreate()`, `onStartCommand()`, and `onBind()` take too long. Foreground services are usually limited to 20 seconds, while background services may allow around 200 seconds

### Systematic Analysis Steps

**1. Get the ANR trace file**

This is the most important evidence. It can be obtained from `/data/anr/traces.txt`, which requires root or an adb bugreport, or from Google Play Console.

**2. Identify the ANR type and time**

Read the summary at the beginning of the trace file and confirm the ANR type, such as input timeout, broadcast timeout, or service timeout, and the time it happened.

**3. Analyze the state of the main thread ("main")**

**This is the core of ANR analysis.** Inspect the stack of the "main" thread carefully:

- **Blocking point**: where did it finally stop?
- **I/O work?** Is it doing file I/O, network I/O, or database work? Look for stack frames such as `nativePollOnce`, `socketRead`, `FileInputStream.read`, or SQLiteDatabase-related calls
- **CPU-heavy computation?** Does the stack show complex computation logic?
- **Lock waiting?** Is it stuck in monitor wait, `LockSupport.park`, or `Object.wait`? The trace usually shows lines such as `waiting to lock <0x...>(a ...)` and `held by threadid=<tid>`
- **Binder call?** Is it stuck in `BinderProxy.transactNative` or `binder_thread_read`? If so, determine which service is being called, usually from the stack or Binder-related information. If the target is a system service, suspect a slow or deadlocked `SystemServer`
- **GC?** Does the stack show GC-related work? GC itself causes ANR less often, but a long GC pause can worsen other timeout conditions

**4. Analyze the thread holding the lock**

If the main thread is waiting for a lock, use the owner thread ID (`tid`) from the trace to find that thread's stack. Then analyze **why it held the lock for so long**. Is it doing I/O, computation, waiting for another lock that creates a deadlock chain, or making a Binder call?

**5. Analyze Binder threads**

Inspect all threads named `Binder:<pid>_<n>`. Are any Binder threads stuck in a long-running `onTransact` implementation? Are they also waiting for locks?

**6. Inspect other threads**

Review other background thread stacks for abnormal activity, such as participation in a deadlock, excessive CPU usage that starves the main thread, and similar issues.

**7. Analyze CPU load**

Check the CPU load information at the end of the trace file, usually split into User, Kernel, IOwait, IRQ, and SoftIRQ. High User% may indicate CPU-heavy computation. High IOwait% indicates disk or network I/O bottlenecks. High Kernel% may be related to drivers or system calls. Also check whether the CPU core running the main thread was busy when the ANR happened.

**8. Analyze lock information**

Read the Locks section in the trace file carefully. It lists contended locks and the corresponding waiting and owning threads, which is critical for deadlock analysis.

**9. Combine with Systrace/Perfetto**

**Strongly recommended.** If you can capture a trace while reproducing the ANR scenario, analysis becomes much easier. Perfetto and Systrace can:

- **Visualize thread state**: clearly show whether the main thread stayed Runnable, waiting for CPU scheduling, Running, executing code, or Sleeping/Blocked before the ANR
- **Locate slow code**: combined with CPU time profiling, directly identify the slowest methods on the main thread or on the thread holding a lock
- **Analyze lock contention**: visualize lock ownership and wait relationships
- **Analyze Binder calls**: show Binder transaction duration and target
- **Correlate system events**: check whether GC or system service activity is related to the ANR

## 9. Conclusion: Control Concurrency, Control Responsiveness

Android's process and thread model is the foundation of its concurrency architecture, and it directly affects resource usage, stability, and user experience. From Linux fundamentals, to Android's fine-grained process lifecycle management through AMS and `oom_adj`, to the responsibilities and coordination of the main thread, Binder threads, and background threads inside an app, plus Handler/Looper and synchronization primitives, all of these pieces form a complex but critical system.

Android specialists must go beyond basic thread usage. They need to understand how process priority interacts with LMK, know the main thread's performance red lines, understand the Binder thread pool, choose the best background concurrency strategy for the scenario, such as ExecutorService or coroutines, master Handler internals, and apply advanced synchronization tools to solve complex thread-safety problems. More importantly, when facing ANR, they need a systematic method that combines ANR traces, Perfetto, and related tools to isolate performance bottlenecks and deadlocks across both application code and system service interactions.

Deep control of the process and thread model is not only a technical safeguard against ANR. It is also a core capability for building high-performance, highly concurrent, highly stable applications that deliver an excellent user experience.

---

**"Android Process and Thread Model Deep Dive" Series**

1. Introduction: The Foundation and Challenge of Concurrent Execution
2. The Android Main Thread (UI Thread): Heart and Bottleneck
3. **Advanced Synchronization and Thread Safety** (this article)
