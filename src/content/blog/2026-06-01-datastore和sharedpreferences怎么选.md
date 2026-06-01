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

新项目里，本地配置优先考虑 DataStore；已有项目中，SharedPreferences 不一定立刻重写，但高频读写和主线程访问需要治理。

少量旧配置可以继续 SharedPreferences；新增简单 key-value 用 Preferences DataStore；有结构的数据模型用 Proto DataStore；需要事务型关系数据用 Room。

## 深入阅读

- [返回专题页](/kotlin-coroutines/)
- [2026-04-23-Android_SharedPreferences_到_DataStore_深度演进_从同步_ANR](/blog/2026-04-23-Android_SharedPreferences_%E5%88%B0_DataStore_%E6%B7%B1%E5%BA%A6%E6%BC%94%E8%BF%9B_%E4%BB%8E%E5%90%8C%E6%AD%A5_ANR/)
