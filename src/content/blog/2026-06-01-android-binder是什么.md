---
title: "Android Binder 是什么？一篇看懂 Binder 通信模型"
slug: android-binder
excerpt: "用问题驱动的方式解释 Android Binder 是什么、为什么系统服务依赖 Binder、一次跨进程调用会经过哪些角色。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Binder"
- "Framework"
- "IPC"
seo:
  title: "Android Binder 是什么？Binder IPC 通信模型入门解析"
  description: "面向 Android 开发者解释 Binder 是什么，覆盖 Client、Server、ServiceManager、Binder Driver、AIDL 与系统服务调用链路。"
---

Android Binder 是 Android 系统里最核心的跨进程通信机制。应用调用系统服务、系统服务之间协作、AIDL 接口调用，底层大多都离不开 Binder。

如果只用一句话解释：Binder 让一个进程可以像调用本地对象一样调用另一个进程里的对象，同时由内核负责转发、身份传递、引用管理和死亡通知。

## Binder 解决的到底是什么问题

Android 应用运行在独立进程里。进程隔离能保护安全性，但也带来一个问题：应用想请求 ActivityManagerService 启动页面、请求 WindowManagerService 创建窗口、请求 PackageManagerService 查询包信息时，不能直接访问系统服务进程里的对象。

Binder 做的事情就是把一次方法调用拆成三段：

1. Client 把方法编号和参数写入 `Parcel`。
2. Binder Driver 在内核中把事务转交给目标进程。
3. Server 端读取 `Parcel`，执行真正的方法，再把返回值写回。

从调用方看，它像是在调用一个普通接口；从系统看，它是一套有权限校验和生命周期管理的 IPC 协议。

## 一次 Binder 调用会经过哪些角色

最典型的链路包含四个角色：Client、Proxy、Binder Driver、Stub。

Client 拿到的是一个远程对象代理，也就是 Proxy。Proxy 的职责是把方法调用序列化成 `Parcel`，然后调用 `transact()`。Binder Driver 收到事务后，根据目标 Binder 引用找到 Server 进程，把事务放进目标线程的队列。Server 端的 Stub 收到请求后，调用本地实现方法，并把结果写回。

ServiceManager 是另一个关键角色。系统服务启动后会把自己的 Binder 对象注册到 ServiceManager；应用需要服务时，先通过名字查询 Binder 引用，再通过这个引用发起后续调用。`Context.getSystemService()` 背后很多路径最终都会落到这套模型上。

## AIDL 和 Binder 的关系

AIDL 不是 Binder 本身，而是帮你生成 Binder 模板代码的工具。你写一个 `.aidl` 接口，编译器生成 `Stub` 和 `Proxy`。Client 调 Proxy，Proxy 写 Parcel；Server 继承 Stub，Stub 解 Parcel 并分发到真实实现。

手写 Binder 代码当然可以，但容易出错：方法编号、参数顺序、异常处理、接口版本都需要自己维护。AIDL 的价值在于把这些样板代码收敛起来，让开发者只关注接口定义。

理解 AIDL 时要记住两点。第一，AIDL 调用默认是同步阻塞的，Client 线程会等待 Server 返回；如果 Server 端慢，调用方也会慢。第二，跨进程传输不是“传对象”，而是序列化数据，复杂对象需要 `Parcelable`，大对象会增加拷贝和内存压力。

## 为什么系统服务更适合 Binder

Socket 也能跨进程通信，但 Binder 更贴近 Android 系统服务的需求。

Binder 支持调用方身份传递，Server 可以通过调用 UID/PID 做权限判断；支持死亡通知，远程进程死掉后可以收到 `binderDied`；支持对象引用，远程对象可以作为参数继续传递；还天然接入系统服务注册和查询机制。

这些能力让 Binder 不只是通信通道，而是 Android Framework 的对象模型。AMS、WMS、PMS、InputManager、Media 服务都可以围绕 Binder 组织接口边界。

## 性能排查时怎么看 Binder

Binder 调用并不一定慢，真正危险的是在主线程做同步 Binder 调用，或者调用的系统服务本身排队很久。Perfetto 里可以看 `binder transaction`、主线程阻塞片段和目标服务线程状态。如果主线程停在 Binder 上，不要只优化应用代码，应该继续追 Server 端到底在等锁、等 I/O，还是被其他请求占满。

日常开发里有几个经验规则：避免在首帧前密集查询系统服务；批量接口不要拆成大量小 Binder 调用；跨进程回调要考虑死亡通知；AIDL 大对象传输要控制大小；主线程调用系统服务前先确认是否可能阻塞。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android Framework](/android-framework/)
- [Android Binder 原理：从驱动通信到 AIDL 调用链路](/blog/binder-ipc机制深度解析-beyond-aidl/)
- [Android Framework 系统服务：AMS、WMS 与应用进程交互模型](/blog/android系统服务与framework层交互模型/)
- [Android Perfetto 入门：Trace 抓取、轨道分析与性能定位](/blog/android-perfetto/)
<!-- /seo-internal-links -->
