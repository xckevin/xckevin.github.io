---
title: "Glance 和 RemoteViews 有什么区别？"
slug: glance-vs-remoteviews
excerpt: "解释 Android Glance AppWidget 与 RemoteViews 的关系、差异、适用场景和迁移判断。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Jetpack Glance"
- "AppWidget"
- "Compose"
seo:
  title: "Glance 和 RemoteViews 有什么区别？Android AppWidget 方案对比"
  description: "对比 Android Glance 与 RemoteViews，解释声明式小组件、RemoteViews 翻译层、更新机制、限制和适用场景。"
---

Glance 不是替代 Android AppWidget 底层机制的新渲染引擎，它更像是 RemoteViews 之上的声明式封装。理解这一点很重要，否则很容易把 Glance 当成“能在桌面小组件里跑完整 Compose”的方案。

Android 桌面小组件真正渲染在 Launcher 进程里，应用进程不能直接把自己的 View 树塞过去。跨进程传递的不是 View 对象，而是一组受限的 RemoteViews 操作指令。

## RemoteViews 是底层协议

RemoteViews 的核心思想是：应用构建一份描述，告诉 Launcher “创建这个布局、设置这个文本、设置这张图片、绑定这个点击事件”。Launcher 收到后在自己的进程里 inflate 和渲染。

这套机制带来两个结果。

第一，能力受限。RemoteViews 只支持一部分 View 和操作，不能随便自定义 View，也不能执行任意 UI 逻辑。它服务的是跨进程安全和稳定，不是完整 UI 框架能力。

第二，更新是批量提交。应用调用 `AppWidgetManager.updateAppWidget()` 后，系统把 RemoteViews 发送给宿主。小组件不是像 Activity 那样每帧响应式重绘，而是通过一次次更新刷新状态。

所以传统 RemoteViews 代码通常会比较命令式：创建 RemoteViews，setTextViewText，setImageViewResource，setOnClickPendingIntent，然后提交。

## Glance 做了什么

Glance 提供的是 Compose 风格 API：`Column`、`Row`、`Text`、`Image`、`Button`、`GlanceModifier`。开发者写起来像 Compose，但最终会被翻译成 RemoteViews。

这意味着 Glance 的优势主要在开发体验和状态组织：

- UI 结构更接近声明式写法。
- 与 Kotlin、协程、DataStore 等现代组件配合更自然。
- 组件组合比手写 RemoteViews 更清晰。
- 迁移 Compose 思维成本低。

但 Glance 的边界仍然是 RemoteViews。不能因为 API 长得像 Compose，就期待它支持完整 Compose 的布局、动画、手势、Canvas、自定义绘制和复杂状态管理。

## 两者的关键差异

RemoteViews 更底层、更直接，适合简单、稳定、对产物可控要求高的小组件。你能清楚知道每次更新设置了哪些 View 属性，也更容易处理一些老版本兼容问题。

Glance 更适合新项目或需要维护复杂小组件结构的项目。它能减少模板代码，让 UI 层更容易拆组件，也更容易和现代状态流结合。

但如果小组件需要非常细的 RemoteViews 控制、依赖某些 Glance 尚未覆盖的 API，或者历史代码已经稳定，继续 RemoteViews 并不丢人。Glance 不是必须迁移项。

## 更新机制不要误解

很多 Compose 开发者刚用 Glance 时会误以为状态变化后小组件会像 Compose 页面一样自动重组。实际不是这样。AppWidget 更新仍然受系统调度、频率限制、电量策略和 Launcher 行为影响。

Glance 可以帮你根据状态生成新的 RemoteViews，但你仍然要设计更新触发：定时更新、用户点击触发、数据变化后主动更新、WorkManager 后台同步。更新太频繁会耗电，也可能被系统限制；更新太少，用户看到的数据就不新鲜。

## 什么时候选 Glance

新建小组件，UI 结构中等复杂，需要更清晰的声明式代码，可以选 Glance。已有 Compose 团队也更容易接受它的写法。

已有 RemoteViews 小组件稳定运行，需求只是小修小补，可以先不迁移。涉及复杂兼容、深度定制或 Glance 不支持的布局能力时，RemoteViews 仍然是更可靠的选择。

对于技术选型，最稳的结论是：Glance 改善的是 AppWidget 开发体验，不改变 AppWidget 的跨进程本质。能接受 RemoteViews 的限制，才适合用 Glance。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Jetpack Compose](/jetpack-compose/)
- [Android Glance AppWidget 原理：RemoteViews、更新机制与 Compose 小组件](/blog/2026-05-28-深入_android_glance_appwidget_全链路_从_remoteviews_渲染桥接/)
- [Jetpack Compose 原理与高级应用：状态、布局、重组与性能实践](/blog/jetpack-compose-高级应用与原理/)
<!-- /seo-internal-links -->
