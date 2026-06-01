---
title: "Paging3 RemoteMediator 适合什么场景？"
slug: paging3-remotemediator
excerpt: "解释 Paging3 RemoteMediator 的定位、网络数据库分页协作、缓存优先列表和常见错误用法。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Paging3"
- "Room"
- "性能优化"
seo:
  title: "Paging3 RemoteMediator 适合什么场景？网络与数据库分页缓存解析"
  description: "讲解 Android Paging3 RemoteMediator 的适用场景，覆盖网络分页、Room 缓存、RemoteKeys、刷新策略和常见问题。"
---

RemoteMediator 适合“网络数据需要落库，并以数据库作为页面唯一数据源”的分页场景。它不是所有分页需求的必选项，也不是 Paging3 的入门必经步骤。

判断是否需要 RemoteMediator，先问一个问题：页面数据是否必须离线可用、可缓存、可恢复，并且数据库才是 UI 的最终数据源？如果答案是否定的，普通网络 PagingSource 可能更简单。

## RemoteMediator 的定位

Paging3 里，`PagingSource` 负责提供分页数据，`Pager` 负责把分页过程暴露成 Flow，UI 通过 `PagingData` 渲染列表。最简单的场景是直接从网络分页：滑到底部，请求下一页，展示结果。

RemoteMediator 多做了一层协调：当本地数据库没有足够数据时，它请求网络，把结果写入数据库；UI 不直接消费网络结果，而是始终从 Room 的 PagingSource 读取。

这套架构的核心是“单一数据源”。网络只是补充数据库，数据库才是页面真相。

## 适合 RemoteMediator 的场景

第一类是信息流、商品列表、文章列表这类需要缓存的页面。用户退出再进来，应该先看到本地数据，再逐步刷新网络数据。RemoteMediator 能把本地缓存和远程分页组织到同一个 Paging 流程里。

第二类是弱网体验要求高的页面。网络失败时，数据库里仍然有旧数据，UI 可以继续展示；网络恢复后再补齐和刷新。

第三类是多个页面共享同一份列表数据。比如收藏列表、搜索历史、频道内容都需要统一缓存和查询，落库后可以避免多个页面各自维护网络状态。

第四类是需要本地二次加工的数据。服务端返回列表后，客户端还要合并本地状态、阅读进度、置顶、屏蔽、实验分组，这些都更适合通过数据库统一建模。

## 不适合的场景

如果页面只是一次性搜索结果，退出后不需要保留，RemoteMediator 可能过重。直接网络 PagingSource 更清晰。

如果分页数据强实时，例如股票盘口、实时弹幕、在线成员列表，数据库缓存可能带来滞后，RemoteMediator 也不一定合适。

如果服务端分页协议不稳定，排序经常变化，又没有可靠的 cursor 或 remote key，RemoteMediator 会很难维护一致性。列表重复、缺页、刷新错乱通常都来自这里。

## RemoteKeys 是关键

RemoteMediator 里最容易写错的是 RemoteKeys。它记录每个 item 或每个 query 对应的上一页、下一页、刷新位置。没有可靠 key，分页就不知道下一次应该从哪里加载。

常见错误包括：

- 只按 itemId 存 key，没有区分 query、频道、排序条件。
- refresh 时没有清理旧 key，导致新旧列表混在一起。
- 服务端返回空页时没有正确标记 endOfPaginationReached。
- 数据库写入和 key 写入不在同一个事务里，崩溃后状态不一致。

RemoteMediator 的写入应该尽量放在数据库事务里：清理旧数据、写入新数据、更新 remote key 要么一起成功，要么一起失败。

## 刷新策略怎么设计

`REFRESH`、`APPEND`、`PREPEND` 三种 LoadType 不应该写成同一套逻辑。Refresh 关注重新建立列表基准；Append 关注加载下一页；Prepend 只有在支持向上分页的场景才需要实现。

刷新时还要考虑缓存过期策略。每次进入页面都强制 refresh，会浪费流量并破坏离线体验；永远不 refresh，又会展示过期数据。比较稳的方式是给缓存加时间戳，进入页面先展示本地数据，再根据过期策略决定是否后台刷新。

## 选型结论

需要“网络 + 数据库 + 离线缓存 + 分页协作”的列表，用 RemoteMediator。只需要“网络分页 + 即时展示”的列表，用普通 PagingSource。需要复杂查询、筛选和本地状态合并时，RemoteMediator 的价值会明显增加。

RemoteMediator 本质上不是分页工具，而是缓存一致性工具。把这个定位想清楚，代码会少很多绕路。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android Paging3 深度解析：PagingSource、RemoteMediator 与分页缓存](/blog/2026-04-24-android_paging3_深度解析_从_pagingsource_分页引擎到_remoteme/)
- [Room Flow 为什么能自动更新？](/blog/room-flow-auto-update/)
<!-- /seo-internal-links -->
