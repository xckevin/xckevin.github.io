---
title: "Android 进程与线程模型深度剖析（3）：高级同步与线程安全"
excerpt: "「Android 进程与线程模型深度剖析」系列第 3/3 篇：高级同步与线程安全"
publishDate: 2025-07-04
displayInBlog: false
tags:
  - Android
  - 进程
  - 线程
  - Handler
series:
  name: "Android 进程与线程模型深度剖析"
  part: 3
  total: 3
seo:
  title: "Android 进程与线程模型深度剖析（3）：高级同步与线程安全"
  description: "「Android 进程与线程模型深度剖析」系列第 3/3 篇：高级同步与线程安全"
---
> 本文是「Android 进程与线程模型深度剖析」系列的第 3 篇，共 3 篇。在上一篇中，我们探讨了「Android 主线程（UI 线程）：心脏与瓶颈」的相关内容。

## 七、高级同步与线程安全

当多个线程访问共享的可变数据时，必须使用同步机制来保证数据的**原子性（Atomicity）**、**可见性（Visibility）** 和**有序性（Ordering）**，防止出现数据竞争和不一致状态。

### 核心概念

- **原子性**：一个操作或者多个操作要么全部执行并且执行的过程不会被任何因素打断，要么就都不执行
- **可见性**：当一个线程修改了共享变量的值，其他线程能够立即得知这个修改
- **有序性**：程序执行的顺序按照代码的先后顺序执行（编译器和处理器可能会进行指令重排优化，需要同步机制来保证特定情况下的有序性）

### 同步原语（Primitives）选择与应用

#### synchronized（内置锁）

- **优点**：使用简单，不易出错（自动释放锁）
- **缺点**：功能相对有限——锁是不可中断的；不支持公平性；一个锁只能关联一个条件等待队列。适用于简单、低竞争的场景

#### volatile

- **作用**：保证被修饰变量的**可见性**；禁止指令重排序优化（部分保证有序性）
- **局限**：**不保证原子性**。例如 `volatile int i; i++;` 不是原子操作
- **适用**：主要用于状态标志位（如 `volatile boolean flag = false;`）或确保单次读写操作的可见性。不能替代锁用于保护复合操作

#### java.util.concurrent.locks.Lock（如 ReentrantLock）

- **优点**：功能更强——可中断锁（`lockInterruptibly`）；可超时锁（`tryLock`）；可实现公平/非公平锁；可关联多个 Condition 对象（用于实现更复杂的等待/通知模式）
- **缺点**：必须手动在 finally 块中释放锁（`unlock()`），否则可能导致死锁
- **适用**：需要更灵活的锁控制、可中断性、公平性或多个等待条件的场景。性能在低竞争下与 synchronized 类似，高竞争下通常更好（但具体取决于实现和平台）

#### ReadWriteLock（如 ReentrantReadWriteLock）

- **场景**：读多写少的共享数据。允许多个读线程同时访问，但写操作是互斥的
- **优点**：显著提高读操作的并发性
- **注意**：实现比 ReentrantLock 更复杂，需要正确使用读锁（`readLock()`）和写锁（`writeLock()`）

#### java.util.concurrent.atomic.*

- **场景**：对单个变量（计数器、状态标志）进行原子更新
- **原理**：利用 CPU 提供的 CAS（Compare-and-Swap）原子指令实现，无锁（Lock-Free），效率高
- **优点**：比使用锁更轻量、性能更好
- **局限**：只能保证单个变量的原子性，不能保证复合操作的原子性

#### CountDownLatch

- **场景**：一个线程需要等待一个或多个其他线程完成某些操作后才能继续执行。例如，主线程等待多个初始化子任务完成

#### CyclicBarrier

- **场景**：多个线程需要相互等待，直到所有线程都到达一个「屏障点」，然后才能一起继续执行下一步。可以重用。例如，并行计算中，各阶段需要等待所有线程完成

#### Semaphore（信号量）

- **场景**：控制同时访问某个特定资源（如数据库连接池、网络连接数）的线程数量

#### BlockingQueue

- **场景**：生产者-消费者模式。解耦生产者线程和消费者线程，自带同步和阻塞功能

### 线程安全最佳实践

- **优先考虑不可变性（Immutability）**：如果共享数据是不可变的（创建后状态不再改变），则天生线程安全，无需同步
- **缩小同步范围**：尽量减小锁保护的代码块范围，只保护必要的临界区，以提高并发性
- **锁顺序**：如果需要获取多个锁，确保所有线程都以**相同**的固定顺序获取锁，以避免死锁
- **使用并发容器**：`java.util.concurrent` 包提供了线程安全的集合类（如 `ConcurrentHashMap`、`CopyOnWriteArrayList`），通常比手动同步 HashMap/ArrayList 更高效、更安全
- **避免持有锁时执行耗时操作或调用外部方法**：防止长时间占用锁

## 八、ANR（Application Not Responding）深度分析

ANR 是 Android 中指示应用严重无响应的信号，是必须能够熟练诊断和解决的问题。

### 触发条件回顾

- **输入事件超时**：5 秒内未处理完输入事件（触摸、按键）
- **广播接收器超时**：`onReceive()` 执行时间过长（前台广播通常 10 秒，后台广播可能 60 秒）
- **Service 超时**：`onCreate()`、`onStartCommand()`、`onBind()` 等关键方法执行时间过长（前台服务 20 秒，后台服务可能 200 秒）

### 系统性分析步骤

**1. 获取 ANR Trace 文件**

这是最重要的依据。可以从 `/data/anr/traces.txt`（需要 root 或通过 adb bugreport），或 Google Play Console 后台获取。

**2. 识别 ANR 类型与时间**

查看 Trace 文件开头的摘要信息，确认是哪种类型的 ANR（Input timeout、Broadcast timeout、Service timeout）以及发生时间。

**3. 主线程（"main"）状态分析**

**这是分析的核心！** 仔细检查「main」线程的堆栈信息：

- **阻塞点**：它最终停在了哪个方法调用上？
- **IO 操作？** 是否在进行文件读写、网络请求、数据库操作（看堆栈中是否有nativePollOnce、socketRead、FileInputStream.read、SQLiteDatabase 相关调用）？
- **CPU 密集计算？** 堆栈是否显示正在执行复杂的计算逻辑？
- **锁等待？** 是否卡在 monitor wait 或 LockSupport.park / Object.wait 等待锁？Trace 中通常会显示「waiting to lock <0x...>(a ...)」以及「held by threadid=<tid>」
- **Binder 调用？** 是否卡在 BinderProxy.transactNative 或 binder_thread_read？如果是，看调用的是哪个服务（通常能从堆栈或 Binder 相关信息看出）。如果目标是系统服务，需要怀疑 SystemServer 是否缓慢或死锁
- **GC？** 堆栈是否显示正在进行 GC 相关操作？（虽然 GC 本身引起的 ANR 相对少见，但长 GC 暂停可能加剧其他超时）

**4. 分析锁持有者线程**

如果主线程在等待锁，根据 Trace 中提供的持有者线程 ID（tid），找到该线程的堆栈。分析该线程**为什么长时间持有锁**？它是否也在进行 IO、计算、等待其他锁（形成死锁链）、或进行 Binder 调用？

**5. 分析 Binder 线程**

检查所有名为「Binder:\<pid>_\<n>」的线程堆栈。是否有 Binder 线程卡在耗时的 onTransact 实现中？或者它们是否也在等待锁？

**6. 检查其他线程**

浏览其他后台线程的堆栈，看是否有异常活动，如参与死锁、消耗过多 CPU 资源导致主线程饥饿等。

**7. CPU 负载分析**

查看 Trace 文件末尾的 CPU 负载信息（分 User/Kernel/IOwait/IRQ/SoftIRQ）。高 User% 可能意味 CPU 密集计算。高 IOwait% 意味磁盘或网络 IO 瓶颈。高 Kernel% 可能与驱动或系统调用有关。检查 ANR 发生时主线程所在 CPU 核心是否繁忙。

**8. 锁信息分析**

仔细阅读 Trace 文件中的 Locks 部分，它会列出所有发生争用的锁以及等待和持有线程的信息，是分析死锁的关键。

**9. 结合 Systrace/Perfetto**

**强烈推荐！** 如果能在复现 ANR 场景时抓取 Trace，将极大简化分析。Perfetto/Systrace 可以：

- **可视化线程状态**：清晰看到主线程在 ANR 发生前长时间处于 Runnable（等待 CPU 调度）还是 Running（执行代码）还是 Sleeping/Blocked 状态
- **定位耗时代码**：结合 CPU Time Profiling，直接定位到主线程或锁持有者线程中耗时最长的方法
- **分析锁竞争**：直观展示锁的持有和等待关系
- **分析 Binder 调用**：显示 Binder 事务的耗时和目标
- **关联系统事件**：查看 GC、系统服务活动是否与 ANR 相关

## 九、结论：掌控并发，驾驭响应

Android 的进程和线程模型是其并发架构的基础，直接关系到应用的资源消耗、稳定性与用户体验。从 Linux 的底层机制，到 Android 系统通过 AMS 和 oom_adj 对进程生命周期的精细管理，再到应用内部主线程、Binder 线程、后台线程的职责划分与协同，以及 Handler/Looper 机制和各种同步原语的应用，共同构成了这个复杂而重要的体系。

Android 专家必须超越基础的线程使用，深刻理解进程优先级与 LMK 的交互，掌握主线程的性能红线，熟悉 Binder 线程池的运作，能够根据场景选择最优的后台并发策略（如 ExecutorService、Coroutines），精通 Handler 机制的内部原理与应用，并能够熟练运用各种高级同步工具解决复杂的线程安全问题。更重要的是，面对 ANR 这一顽疾，能够运用系统性的方法，结合 ANR Trace 和 Perfetto 等工具，抽丝剥茧，定位并解决从应用代码到系统服务交互中可能存在的各种性能瓶颈和死锁问题。

对进程与线程模型的深度掌控，不仅是避免 ANR 的技术保障，更是实现高性能、高并发、高稳定性应用，从而提供卓越用户体验的核心能力。

---

**「Android 进程与线程模型深度剖析」系列目录**

1. 引言：并发执行的基石与挑战
2. Android 主线程（UI 线程）：心脏与瓶颈
3. **高级同步与线程安全**（本文）
