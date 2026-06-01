---
title: "DataStore 和 SharedPreferences 应该怎么选？"
slug: datastore-vs-sharedpreferences
excerpt: "对比 SharedPreferences、Preferences DataStore 和 Proto DataStore 的适用场景、线程模型、类型安全和迁移策略。"
publishDate: '2026-06-01'
tags:
- "Android"
- "DataStore"
- "SharedPreferences"
seo:
  title: "DataStore 和 SharedPreferences 怎么选？Android 本地配置存储对比"
  description: "对比 Android SharedPreferences、Preferences DataStore 和 Proto DataStore，解释线程安全、ANR 风险、类型安全和迁移策略。"
---

新项目里，本地配置优先考虑 DataStore；已有项目中，SharedPreferences 不一定立刻重写，但主线程访问、高频读写和跨进程依赖需要治理。

这不是“新 API 一定替代旧 API”的问题，而是两者线程模型、数据一致性和类型能力不同。

## SharedPreferences 的问题在哪里

SharedPreferences 适合少量、简单、低频的 key-value 配置。它的使用成本低，老项目里大量存在。但它有几个工程风险。

第一，首次加载可能阻塞。SharedPreferences 背后是 XML 文件，首次读取需要从磁盘加载并解析。如果在启动主线程上访问多个文件，很容易放大冷启动耗时。

第二，`apply()` 虽然异步写磁盘，但内存状态会先更新，落盘时机不由调用方精确控制。极端情况下，进程被杀、并发写入、跨进程访问都可能带来一致性问题。

第三，类型能力弱。复杂结构往往被塞成 JSON 字符串，字段演进、默认值、兼容性都靠业务代码兜底，时间久了会变成隐形数据协议。

## Preferences DataStore 适合什么

Preferences DataStore 仍然是 key-value，但它基于协程和 Flow，读写异步，数据变化可以被观察。它适合替代新增的轻量配置，例如开关、排序方式、主题、用户偏好。

相比 SharedPreferences，它的优势在于：

- 不鼓励主线程阻塞式读取。
- 读操作以 Flow 暴露，天然适合 UI 响应式更新。
- 写操作通过事务式 `edit` 完成，避免部分并发问题。
- 支持从 SharedPreferences 迁移。

但 Preferences DataStore 不是强类型模型。key 名仍然是字符串，字段关系仍然靠业务约束。如果配置已经有明确结构，Proto DataStore 更合适。

## Proto DataStore 适合什么

Proto DataStore 用 Protocol Buffers 定义数据结构，适合有固定 schema 的本地配置或状态。例如用户设置、实验配置快照、复杂开关组合、离线策略参数。

它的优势是类型安全、默认值清晰、字段可演进。新增字段、废弃字段、兼容旧版本都可以通过 proto 规则管理，比手写 JSON 稳定。

缺点是接入成本更高：需要维护 `.proto` 文件、生成代码、处理迁移。对只有三五个布尔开关的场景，Proto DataStore 可能显得重。

## 什么时候应该用 Room

DataStore 不是数据库。只要出现列表、查询、排序、关联、分页、事务、多表关系，就应该考虑 Room。把一组业务记录塞进 DataStore，不仅查询痛苦，也会让写入粒度变大。

一个简单判断标准：如果你会问“怎么按条件查其中一部分数据”，那就不要用 DataStore。

## 迁移策略

老项目不建议一次性全量替换 SharedPreferences。更稳的方式是按风险治理。

启动链路上的同步读取优先迁移，尤其是 `Application.onCreate()`、ContentProvider、首屏 Activity 里的读取。高频写入的配置优先迁移，避免 XML 文件反复落盘。结构复杂且长期维护的数据优先考虑 Proto DataStore 或 Room。

低频、历史遗留、不会影响启动的少量配置，可以暂时保留 SharedPreferences。工程治理不是为了追求 API 统一，而是降低真实风险。

## 选择结论

少量旧配置继续 SharedPreferences；新增简单偏好用 Preferences DataStore；有结构的数据模型用 Proto DataStore；需要查询和关系的数据用 Room。

DataStore 的价值不只是“新”，而是把本地配置从同步读写模型迁到协程和 Flow 的响应式模型。对于现代 Android 应用，这是更容易长期维护的方向。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Kotlin 协程与 Flow](/kotlin-coroutines/)
- [Android SharedPreferences 到 DataStore 深度演进：从同步 ANR 到响应式存储](/blog/2026-04-23-android_sharedpreferences_到_datastore_深度演进_从同步_anr/)
- [Room Flow 为什么能自动更新？](/blog/room-flow-auto-update/)
<!-- /seo-internal-links -->
