---
title: 深入 Android Watchdog 机制：从 SystemServer 锁监控到系统自动重启的全链路解析
excerpt: 深入解析 Android Watchdog 机制的监控模型、死锁检测流程与 system_server 重启链路，并结合常见触发场景和堆栈定位方法。
publishDate: '2025-09-30'
tags:
- Android
- Watchdog
- system_server
- 死锁检测
- 系统稳定性
seo:
  title: 深入 Android Watchdog 机制：从 SystemServer 锁监控到系统自动重启的全链路解析
  description: 深入解析 Android Watchdog 死锁检测机制，涵盖 HandlerChecker 调度模型、60 秒超时判定流程、system_server 重启链路，以及 Binder 死锁、IO 阻塞等常见触发场景的堆栈定位方法。
---

ANR 谁都见过——主线程卡 5 秒，弹个框。但有一种情况更狠：没有弹框，手机直接黑屏重启，logcat 只剩一行 `WATCHDOG KILLING SYSTEM PROCESS`。

这条日志来自 Watchdog，Android 系统层的最后防线。监控思路和 ANR 一样靠超时触发，但盯的不是应用主线程，而是 system_server 进程里关键服务的锁状态。一旦确认死锁，直接杀掉 system_server，触发整机软重启。

## Watchdog 的核心监控模型

Watchdog 是 system_server 里的一个单例线程，在 `SystemServer.java` 启动早期完成初始化：

```java
// SystemServer.java
// Watchdog 在 startBootstrapServices() 阶段初始化
final Watchdog watchdog = Watchdog.getInstance();
watchdog.start();
```

它不直接轮询锁状态——那种做法开销太大。实际的检测手段是 **HandlerChecker**：往目标线程的 Handler 队列塞一条空消息，超时内收到回执，说明该线程 Looper 还在正常轮转，持有的锁也就有机会释放。

Watchdog 内部维护了多个 HandlerChecker，每个绑定到一个关键服务线程：

```java
// Watchdog.java - 注册监控目标
public void addMonitor(Monitor monitor) {
    // 注册到 foreground 线程的 HandlerChecker
    mMonitorChecker.addMonitor(monitor);
}
```

`Monitor` 接口只有一个方法：

```java
public interface Monitor {
    void monitor();
}
```

死锁检测时调用这个方法，主动去拿服务锁——拿不到，坐实了死锁。

## MonitorChecker 的调度与检测流程

Watchdog 的 `run()` 是一个无限循环，每轮执行一次完整检测：

```java
@Override
public void run() {
    boolean waitedHalf = false;
    while (true) {
        // 1. 给所有 HandlerChecker 投递监控消息
        for (HandlerChecker hc : mHandlerCheckers) {
            hc.scheduleCheckLocked();
        }
        
        // 2. 等待 30 秒（默认超时的一半）
        long timeout = DEFAULT_TIMEOUT;  // 60 秒
        long start = SystemClock.uptimeMillis();
        while (timeout > 0) {
            try { wait(timeout); } catch (InterruptedException e) {}
            timeout = DEFAULT_TIMEOUT - (SystemClock.uptimeMillis() - start);
        }
        
        // 3. 评估结果
        boolean fdLimitTriggered = false;
        if (fdOverLimit()) fdLimitTriggered = true;
        
        final int waitState = evaluateCheckerCompletionLocked();
        if (waitState == COMPLETED) {
            waitedHalf = false;
            continue;
        } else if (waitState == WAITING) {
            continue;
        } else if (waitState == WAITED_HALF) {
            // 第一次超时：dump 堆栈
            if (!waitedHalf) {
                // dump AMS stacks, kernel stacks...
                waitedHalf = true;
            }
            continue;
        }
        
        // OVERDUE：确认死锁，触发重启
        // ...
    }
}
```

整个流程拆成三步：

### 第一步：等待 30 秒

MonitorChecker 往各线程发 ping 消息，等回执。30 秒收不到就进入下一步。

### 第二步：再等 30 秒

第一次超时不杀进程。Watchdog 触发一次全量堆栈 dump——AMS 堆栈、native 堆栈、内核栈全输出到 logcat。然后继续等。

### 第三步：确认死锁

60 秒总超时后，Watchdog 做最终确认：再调一次 `Monitor.monitor()`。这个方法能正常返回，说明之前误判，放过；阻塞住，直接杀 system_server。

## 系统重启的触发链路

确认死锁后，处理流程比 `Process.killProcess()` 重得多：

```java
// Watchdog.java - 死锁确认后的处理
if (!SFHang) {  // 不是 SurfaceFlinger 挂死
    // 1. dump 最终现场
    ProcessCpuTracker processCpu = new ProcessCpuTracker(true);
    doSysRq('w');   // dump blocked tasks
    doSysRq('l');   // dump all active CPUs backtrace
    
    // 2. 触发 dropbox 记录
    mActivity.addErrorToDropBox(
        "watchdog", null, "system_server", null, null,
        name, null, stackTrace, null);
    
    // 3. 杀掉 system_server
    Process.killProcess(Process.myPid());
    System.exit(10);
}
```

`System.exit(10)` 执行后，system_server 进程退出。init 进程检测到它挂了——system_server 在 `init.rc` 中声明了 `critical` 属性——于是重启整个 Android runtime，包括 zygote。内核不重启，但所有用户态服务全部重新初始化，等于一次热重启。

用户侧的表现：屏幕黑掉，几秒后出开机动画，再回到锁屏。全程 20-30 秒。

## 常见触发场景

实际项目里遇过这几类：

**Binder 调用链死锁**。最常见的模式：AMS 持锁等 WMS 回调，WMS 持锁等 AMS 回调，两边都在对方线程上做同步调用。system_server 里几乎所有服务都在同一进程内走 Binder，跨服务锁依赖很容易形成环。

**IO 阻塞在锁内**。某服务持锁执行同步磁盘写入，赶上 eMMC 做 GC，写入延迟飙到秒级。60 秒超时在极端 IO 抖动面前不算宽裕。

**Binder 调用大量拥塞**。Binder 线程池耗尽时，所有依赖 Binder 通信释放锁的逻辑都在排队。单个调用可能没死锁，但整体吞吐量归零，Watchdog 一样判定超时。

## 从堆栈定位根因

Watchdog 重启后，关键排查资料在 `data/anr/` 目录，文件名类似 `trace_01`，比普通 ANR 的 `traces.txt` 详细不少。

定位思路：

1. 先看 **Watchdog 线程本身**：卡在哪个 `Monitor.monitor()` 上
2. 找到对应的 **Binder 线程**：谁持着那个锁？在等什么？
3. **追踪跨进程调用链**：如果 Binder 调用出了 system_server，要查被调用进程（通常是 SurfaceFlinger 或 mediaserver）的堆栈

之前踩过一个坑：Watchdog 重启，堆栈显示 AMS 在等 `ActivityStackSupervisor` 锁，持锁线程在执行 `WindowManager.removeWindow()`。乍看是 AMS-WMS 死锁，跟到最后发现是 SurfaceFlinger 侧的 vsync 信号丢了，导致 WMS 的 `relayoutWindow` 一直阻塞。根因根本不在 system_server 里。

处理 Watchdog 问题，堆栈只告诉你阻塞点，真正的死锁环往往要跨进程才能拼出来。

## Watchdog 与 ANR 的协作

容易被忽略的一点：Watchdog 和 ANR 不是两套独立机制。Watchdog 进入 WAITED_HALF 阶段（第一次 30s 超时）时，会主动调用 AMS 的 `dumpStackTraces()`，沿 ANR 的代码路径收集所有进程堆栈。

所以 Watchdog 触发的 dump 比普通 ANR dump 更全——包含 native 进程和内核线程的堆栈，不只是应用进程。代价是：如果系统已经极度拥塞，dump 操作本身可能加剧卡顿，形成"dump 死"的恶性循环。

Android 12 引入了优化：Watchdog 触发 dump 前先通过 `ProcessCpuTracker` 检查 IO wait 比例，超过阈值就跳过部分重量级 dump，优先执行重启。线上数据表明，这个策略明显缩短了"dump 过程中整机冻屏"的故障时长。
