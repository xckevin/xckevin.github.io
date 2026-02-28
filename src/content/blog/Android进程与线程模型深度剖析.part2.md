---
title: "Android 进程与线程模型深度剖析（2）：Android 主线程（UI 线程）：心脏与瓶颈"
excerpt: "「Android 进程与线程模型深度剖析」系列第 2/3 篇：Android 主线程（UI 线程）：心脏与瓶颈"
publishDate: 2025-07-04
displayInBlog: false
tags:
  - Android
  - 进程
  - 线程
  - Handler
series:
  name: "Android 进程与线程模型深度剖析"
  part: 2
  total: 3
seo:
  title: "Android 进程与线程模型深度剖析（2）：Android 主线程（UI 线程）：心脏与瓶颈"
  description: "「Android 进程与线程模型深度剖析」系列第 2/3 篇：Android 主线程（UI 线程）：心脏与瓶颈"
---
> 本文是「Android 进程与线程模型深度剖析」系列的第 2 篇，共 3 篇。在上一篇中，我们探讨了「引言：并发执行的基石与挑战」的相关内容。

## 三、Android 主线程（UI 线程）：心脏与瓶颈

应用进程启动时创建的第一个线程，通常被称为主线程或 UI 线程。

### 核心职责

- **UI 交互处理**：分发和处理用户输入事件（触摸、按键）
- **UI 绘制**：执行 Choreographer 回调，进行 Measure、Layout、Draw
- **组件生命周期**：执行 Activity、Service、BroadcastReceiver 等组件的生命周期回调方法（onCreate、onStart、onResume、onReceive 等）
- **主 Looper 任务**：执行通过与主线程 Looper 关联的 Handler post 过来的 Runnable 或 Message

### 黄金法则：永不阻塞主线程

**原因**：主线程负责处理所有与用户交互和界面更新的任务。任何耗时操作（网络请求、数据库读写、复杂计算、文件 IO，甚至某些有争议的锁等待）如果发生在主线程，都会阻止其处理新的 UI 事件或绘制请求。

**后果**：

- **轻微**：掉帧（Jank）、动画卡顿、界面失去响应
- **严重**：触发 ANR（Application Not Responding）对话框，用户可能选择强制关闭应用

## 四、Binder 线程：跨进程通信的执行者

如 Binder 章节所述，当其他进程（包括系统服务）通过 Binder 调用当前进程提供的服务时，请求是在专门的 Binder 线程上执行的。

**Binder 线程池**：每个提供 Binder 服务的进程维护一个线程池（由 libbinder 和内核驱动管理），用于并发处理传入的 IPC 调用。默认上限通常是 15 个线程（主线程除外）。

**执行上下文**：AIDL 接口方法的实现代码（或 `Binder.onTransact`）运行在 Binder 线程上。

### 核心规则

- **禁止耗时操作**：同样地，不能在 Binder 线程中执行可能阻塞的操作，否则会耗尽线程池资源，导致后续的 IPC 请求（包括来自系统的重要调用）无法被及时处理，引发死锁或 ANR。必须将耗时任务异步化
- **禁止直接 UI 更新**：Binder 线程不能直接操作 UI 组件。需要通过 Handler 将 UI 更新任务切换回主线程执行
- **线程安全**：如果 Binder 方法访问了可能被主线程或其他后台线程并发访问的共享数据，必须采取正确的同步措施

## 五、后台线程策略：将耗时任务请出主线程

为了遵守「不阻塞主线程/Binder 线程」的规则，必须将耗时任务放到后台线程执行。

### 基本 Thread + Runnable

最基础的方式，灵活但管理复杂。需要手动处理线程生命周期、中断、错误、与主线程通信等，容易出错。

### ExecutorService / ThreadPoolExecutor

**推荐方式**：提供线程池管理，复用线程，避免频繁创建销毁线程的开销。

**灵活性**：可以配置核心线程数、最大线程数、线程存活时间、任务队列类型（有界/无界）、拒绝策略。

**使用**：通过 `Executors` 工厂类创建常用类型线程池（`newFixedThreadPool`、`newCachedThreadPool`、`newSingleThreadExecutor`），或直接构造 `ThreadPoolExecutor` 进行精细控制。使用 `submit()` 或 `execute()` 提交 Runnable 或 Callable 任务。

根据任务类型（CPU 密集型 vs IO 密集型）合理配置线程池大小（CPU 密集型通常接近 CPU 核心数，IO 密集型可以更大）；选择合适的任务队列和拒绝策略；注意线程池的生命周期管理（适时 `shutdown()`）。

### AsyncTask（已弃用）

已弃用，不再推荐使用。

### IntentService（已弃用）/ JobIntentService

已弃用，建议使用 WorkManager 等替代方案。

### Kotlin Coroutines（协程）——现代首选

- **轻量级**：协程是运行在线程之上的、可挂起和恢复的计算单元，比线程更轻量。可以创建大量协程而不会耗尽系统资源
- **简化异步**：使用 `suspend` 关键字使得异步代码写起来像同步代码一样直观
- **结构化并发**：提供了 CoroutineScope（如 `viewModelScope`、`lifecycleScope`）来管理协程的生命周期，与组件生命周期绑定，自动取消，极大减少泄漏风险
- **调度器（Dispatchers）**：方便地在不同线程（`Dispatchers.Main`、`Dispatchers.IO`、`Dispatchers.Default`）之间切换协程执行上下文
- **生态**：与 Jetpack 库（LiveData、ViewModel、Room 等）深度集成。是目前 Kotlin 开发 Android 应用进行并发编程的首选方案

### RxJava / RxAndroid

- **响应式编程**：基于观察者模式，使用强大的操作符链式组合、转换、过滤异步事件流
- **优点**：处理复杂异步逻辑、多数据源合并、背压等场景非常强大
- **缺点**：学习曲线较陡峭，概念较多（Observable、Operator、Scheduler 等），代码可能不易理解

## 六、Handler、Looper、MessageQueue 详解：Android 线程通信的基石

这是 Android 框架内部广泛使用的线程通信和任务调度机制，尤其用于在不同线程间安全地传递消息和执行任务（特别是切换回主线程）。

### 核心组件

**Message**：携带少量数据（what、arg1、arg2、obj——避免用 obj 传递大对象，考虑 `setData(Bundle)`）或一个 Runnable 任务。包含一个 target 字段指向处理它的 Handler。

**MessageQueue**：每个拥有 Looper 的线程都有一个 MessageQueue。它按执行时间顺序存储待处理的 Message。当队列为空时，它会通过底层的 Linux epoll 机制高效地阻塞等待，直到新消息到来或超时。这是 `Looper.loop()` 不会空耗 CPU 的原因。

**Looper**：每个线程最多只能有一个 Looper（通过 ThreadLocal 存储）。它的核心是 `loop()` 方法，该方法进入一个死循环，不断地从其 MessageQueue 中取出下一条消息（`queue.next()`），如果消息不为空，则将其分发给消息的目标 Handler（`msg.target.dispatchMessage(msg)`）。

**Handler**：

- **创建**：在哪个线程创建 Handler 实例，它默认就与该线程的 Looper 关联（除非显式指定 Looper）
- **发送/发布**：提供 `post(Runnable)`、`postDelayed()`、`sendMessage()`、`sendMessageDelayed()`、`obtainMessage().sendToTarget()` 等方法，将 Runnable 包装成 Message 或直接将 Message 放入目标 Looper 的 MessageQueue 中
- **处理**：`dispatchMessage(Message msg)` 方法负责执行。如果 Message 有关联的 Runnable，则执行 Runnable；否则，如果 Handler 创建时传入了 Callback 接口，则调用 `callback.handleMessage()`；最后，如果前两者都没有，则调用 Handler 子类覆写的 `handleMessage(Message msg)` 方法。执行发生在与 Handler 关联的 Looper 所在的线程上

**ThreadLocal 的作用**：Looper 使用 `ThreadLocal<Looper>`（sThreadLocal）来确保每个线程拥有自己独立的 Looper 实例。`Looper.prepare()` 就是向当前线程的 ThreadLocalMap 中存入一个新的 Looper 对象。

### 经典用途

**子线程 → 主线程更新 UI**：在子线程创建 `new Handler(Looper.getMainLooper())`，然后通过此 Handler post 一个更新 UI 的 Runnable。

**创建自定义工作线程**：

```java
class WorkerThread extends Thread {
    public Handler mHandler; // Handler for this worker thread

    @Override
    public void run() {
        Looper.prepare(); // Associate a Looper with this thread
        // Handler created here is associated with the new Looper
        mHandler = new Handler(Looper.myLooper()) {
            @Override
            public void handleMessage(@NonNull Message msg) {
                // Process messages received on this worker thread
                Log.d("WorkerThread", "Processing message: " + msg.what);
            }
        };
        Looper.loop(); // Start the message loop, blocks until Looper.quit()
        Log.d("WorkerThread", "Looper finished.");
    }
}

// Usage:
WorkerThread worker = new WorkerThread();
worker.start();
// Wait until handler is created (use CountDownLatch or similar for safety)
// ...
// Send messages from other threads to the worker thread's handler
worker.mHandler.obtainMessage(MSG_DO_WORK, someData).sendToTarget();
// ...
// To stop the worker thread's looper:
// worker.mHandler.getLooper().quitSafely(); // Or quit()
```

**HandlerThread**：Android 提供的一个便利类，封装了上述创建带 Looper 的工作线程的逻辑。

### 常见陷阱

- **内存泄漏**：在 Activity/Fragment 中使用非静态内部类 Handler，会导致 Handler 隐式持有外部类引用。如果 Handler 发送了延迟消息，即使 Activity 销毁，消息仍在队列中，Handler 和 Activity 都无法被回收。**解决方案**：使用静态内部类 + `WeakReference<Activity>`，或者使用 Lifecycle aware 组件
- **主线程 Looper 阻塞**：在主线程 Handler 的 `handleMessage` 或 `Runnable.run` 中执行耗时操作
- **消息队列过载**：过度发送大量消息可能导致处理延迟

---

> 下一篇我们将探讨「高级同步与线程安全」，敬请关注本系列。

**「Android 进程与线程模型深度剖析」系列目录**

1. 引言：并发执行的基石与挑战
2. **Android 主线程（UI 线程）：心脏与瓶颈**（本文）
3. 高级同步与线程安全
