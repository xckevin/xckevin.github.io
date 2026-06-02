---
title: 深入 Android BroadcastReceiver 全链路：从注册机制到 BroadcastQueue 调度引擎的广播分发架构解析
excerpt: 本文深入剖析 Android BroadcastReceiver 的完整分发链路，涵盖动态/静态注册机制、BroadcastQueue 双队列调度、有序广播串行推进、粘性广播废弃及后台限制等核心原理，并给出异步超时处理实战方案。
publishDate: '2026-06-01'
tags:
- Android
- BroadcastReceiver
- AMS
- 性能优化
- 架构设计
seo:
  title: 深入 Android BroadcastReceiver 全链路：从注册机制到 BroadcastQueue 调度引擎的广播分发架构解析
  description: 从注册机制到 BroadcastQueue 调度引擎，深入解析 Android BroadcastReceiver 广播分发全链路架构，涵盖动态/静态注册、有序广播、粘性广播废弃及后台限制等核心原理与实战方案。
---

做性能监控时，我遇到了一个诡异的问题：App 切后台一段时间后，好几个 BroadcastReceiver 都不回调了。日志里没有异常，ANR 也没触发，广播就像被黑洞吞了一样。

排查一圈，问题出在 Android 8.0+ 的后台广播限制。但表面现象背后的全链路机制，远比官方文档描述的复杂。下面沿着「注册 → 入队 → 调度 → 分发 → 超时处理」这条线，把广播分发架构一层层拆开。

## 两种注册方式的本质差异

### 动态注册：绑定 Binder 的实时通道

`Context.registerReceiver()` 内部做了两件事：创建 ReceiverDispatcher，然后向 AMS 注册。

```java
// frameworks/base/core/java/android/app/ContextImpl.java
public Intent registerReceiver(BroadcastReceiver receiver, IntentFilter filter) {
    // 1. 创建 IIntentReceiver.Stub，作为 Binder 服务端
    IIntentReceiver rd = new LoadedApk.ReceiverDispatcher(
            receiver, context, scheduler, null, true)
            .getIIntentReceiver();
    // 2. 通过 AMS 注册
    ActivityManager.getService().registerReceiver(
            mMainThread.getApplicationThread(), ... , rd, filter, ...);
}
```

`LoadedApk.ReceiverDispatcher` 内部封装了一个 `InnerReceiver`，实现了 `IIntentReceiver.Stub`，本质是一个 Binder 对象。AMS 通过这个 Binder 回调过来时，`ReceiverDispatcher` 用主线程 Handler 把 `onReceive()` 切回 UI 线程执行。

AMS 侧把 `BroadcastFilter` 对象插入 `mReceiverResolver`（一个 IntentResolver 结构），记录 Receiver 和 Filter 的对应关系。广播到来时，遍历匹配即可找到目标。

动态注册的 Receiver 跟宿主组件（Activity/Service）的生命周期绑定。宿主销毁时，AMS 侧的 `BroadcastFilter` 自动移除。我踩过一个坑：在 Application 里注册 Receiver 时用了 Activity Context，Activity 重建后广播丢失——旧的 Binder 已经失效了，但代码里完全感知不到。

### 静态注册：Manifest 中的延迟激活

静态注册走的是另一条路径。PackageManagerService 在 App 安装或开机扫描时解析 `AndroidManifest.xml`，把 `<receiver>` 标签提取为 `ResolveInfo`，存入 `mReceivers`。

静态 Receiver 在 AMS 中没有活跃的 Binder 连接。广播需要分发到它时，AMS 临时拉起 App 进程（如果还没启动），实例化 Receiver，调用 `onReceive()`，然后销毁它。

这个"临时"特性带来了两个后果：
- `onReceive()` 必须在 **10 秒**内返回，否则 ANR
- Android 8.0 之后，大多数隐式广播不再唤醒静态 Receiver

## BroadcastQueue：AMS 的调度引擎

广播分发不是简单的遍历回调。AMS 用了一整套队列机制控制并发、有序性和超时。

### 双队列设计

AMS 内部维护两个 `BroadcastQueue` 实例：

```
mFgBroadcastQueue   → 前台广播队列，超时 10s
mBgBroadcastQueue   → 后台广播队列，超时 60s
```

这样设计的目的很简单：前台广播更快、超时更短，不与后台广播互相阻塞。App 在前台时，即使是普通广播也会走前台队列。

```java
// frameworks/base/services/core/java/com/android/server/am/BroadcastQueue.java
BroadcastQueue(ActivityManagerService service, Handler handler,
        String name, long timeoutPeriod, boolean allowDelayBehindServices) {
    mService = service;
    mHandler = new BroadcastHandler(handler.getLooper());
    mQueueName = name;
    mTimeoutPeriod = timeoutPeriod;  // 前台 10s，后台 60s
}
```

### 串行调度与并行分发

先厘清几个关键概念：

- `BroadcastRecord`：一次广播发送动作，包含 Intent、发送者权限、目标列表等
- `BroadcastFilter`：动态注册的接收器描述
- `ResolveInfo`：静态注册的接收器描述

同一个广播的多个动态接收器是**并行分发**的——AMS 一次性通过 Binder 回调所有匹配的 `BroadcastFilter`。当一个广播既有动态接收器又有静态接收器时，会先全部处理完动态的，再逐个串行处理静态的——每个静态 Receiver 处理完并确认结果后，才轮到下一个。这就是有序广播串行语义的底层实现。

### 有序广播的串行推进

有序广播的核心不是"按优先级排"，而是"**一个接一个处理，前面取消后面收不到**"。

```java
// BroadcastQueue.java - 处理下一个接收器
final void processNextBroadcast(boolean fromMsg) {
    synchronized (mService) {
        BroadcastRecord r;
        // 找到当前正在处理的广播记录
        do {
            r = mOrderedBroadcasts.get(0);
            // 如果已经有接收器超时，强制推进到下一个
            if (mService.mProcessesReady && r.dispatchTime > 0) {
                if ((now - r.dispatchTime) > (2 * mTimeoutPeriod * ...)) {
                    broadcastTimeoutLocked(false);
                }
            }
            // 处理超时或找到下一个目标
            ...
        } while (r == null);
    }
}
```

有序广播的推进依赖 `processCurBroadcastLocked()`。当前接收器调用 `setResultCode()` 或广播处理完成后，AMS 通过 `finishReceiverLocked()` 收到确认，调度引擎才触发 `scheduleBroadcastsLocked()` 继续处理下一个。

如果接收器在 10 秒（前台队列）内没有完成，`broadcastTimeoutLocked()` 强制跳过该接收器并上报 ANR。

## 粘性广播：从被滥用走向废弃

粘性广播（Sticky Broadcast）的设计初衷是方便：发送后一直保留在 AMS 中，后来注册的 Receiver 也能立刻收到。

```java
// 发送粘性广播——Intent 会被 AMS 缓存
sendStickyBroadcast(new Intent(Intent.ACTION_BATTERY_CHANGED));
```

但它有两个致命问题：
- **安全性**：任何 App 都可以注册并读到粘性 Intent，信息泄漏风险高
- **一致性**：缓存的数据可能早已过期，新注册者拿到的是脏状态

Android 5.0 起 `sendStickyBroadcast()` 被标记为 deprecated，Android 9.0 进一步收紧。系统保留的粘性广播只有少数几个，比如 `ACTION_BATTERY_CHANGED`。

我在一个小项目里遇到过：同事用粘性广播传递登录状态，在 Android 9 设备上静默失败，排查了两天才发现 API 已被限制。替代方案很直接——用 `LiveData`、`Flow` 或本地存储，别再用广播做状态管理。

## 后台限制与分发超时

Android 8.0 的限制规则一句话概括：**App 在后台时，除显式广播和少数豁免外，静态 Receiver 不接收隐式广播。** Android 9.0 进一步限制了后台 App 的隐式广播接收频次。

这些限制直接影响 `BroadcastQueue` 的行为：`processNextBroadcast()` 跳过不符合条件的静态接收器，只向仍然符合条件的动态接收器分发。

容易被忽略的一点：动态注册的 Receiver 不受 Android 8.0 限制，但"超时 60 秒"的规则仍然适用。后台广播队列的超时虽然比前台长，`onReceive()` 里做 IO 操作或复杂计算仍可能触发 ANR。

```kotlin
// 典型踩坑代码——onReceive 里同步请求网络
class NetworkReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // 危险：get() 是阻塞调用，可能超过 60s 后台超时
        val result = httpClient.newCall(request).execute()
        // 正确做法：交给 JobIntentService 或 WorkManager
    }
}
```

解决方案是 `goAsync()`：

```java
public class SafeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pendingResult = goAsync();  // 延长超时到 10 分钟
        new Thread(() -> {
            // 做耗时操作
            doHeavyWork();
            pendingResult.finish();  // 必须调用，否则泄漏
        }).start();
    }
}
```

`goAsync()` 通知 AMS 这个接收器需要异步处理，把超时窗口从 10/60 秒延长到约 10 分钟。子线程中必须手动调用 `finish()`，否则 AMS 一直持有 `BroadcastRecord` 导致内存泄漏。

## 广播分发链路的时间线

把整个链路从发送到结束串起来：

1. **发送端** 调用 `sendBroadcast(intent)` → Binder 进入 AMS
2. AMS 的 `broadcastIntentLocked()` 匹配所有接收器（动态+静态），生成 `BroadcastRecord`
3. `BroadcastRecord` 被推入对应 `BroadcastQueue`（前台/后台）
4. `processNextBroadcast()` 取出记录，对动态接收器并行 Binder 回调，对静态接收器串行逐个处理
5. 接收器 `onReceive()` 执行完成后，通过 `finishReceiverLocked()` 通知 AMS
6. 超时或全部接收器完成，广播记录从队列移除

这条链路里，除了第一步是同步的，后续全在 AMS 内异步推进。`sendBroadcast()` 返回时 Receiver 大概率还没开始执行——很多开发者会忽略这个时序细节。

在核心业务场景里，我更倾向用显式广播 + 动态注册的组合，牺牲一点灵活性换取可控性。静态 Receiver 现在更多用于省电和系统级事件的监听，业务逻辑尽量靠 EventBus 或 Flow 传递。广播不再是万能通讯工具，而是在系统层级上传递少量关键信号——理解调度机制之后，再决定什么场景该用、什么场景该绕开。
