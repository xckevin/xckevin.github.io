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

Android Binder 是 Android 系统里最核心的跨进程通信机制。应用进程调用系统服务、系统服务之间协作、AIDL 接口调用，底层大多都离不开 Binder。

## 先给结论

Binder 解决的是一个问题：不同进程不能直接访问彼此内存，但 Android 又需要让应用像调用本地对象一样调用系统服务。Binder 把这个调用包装成一次事务，由 Binder 驱动在内核中负责转发。

## AIDL 和 Binder 的关系

AIDL 不是 Binder 本身，而是帮你生成 Binder 接口代码的工具。你写 AIDL，编译器生成 Stub 和 Proxy；Client 调 Proxy，Proxy 把参数写入 Parcel，再通过 Binder 驱动发给 Server 端 Stub。

## 为什么 Android 不直接用 Socket

Socket 可以跨进程，但 Binder 更适合 Android 系统服务场景：它支持对象引用、死亡通知、调用方身份传递和权限校验，也能和系统服务管理机制自然结合。

## 深入阅读

- [返回专题页](/android-framework/)
- [Android Binder 原理：从驱动通信到 AIDL 调用链路](/blog/Binder%20IPC%E6%9C%BA%E5%88%B6%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90%20(Beyond%20AIDL)/)
- [Android Framework 系统服务：AMS、WMS 与应用进程交互模型](/blog/Android%E7%B3%BB%E7%BB%9F%E6%9C%8D%E5%8A%A1%E4%B8%8EFramework%E5%B1%82%E4%BA%A4%E4%BA%92%E6%A8%A1%E5%9E%8B/)
