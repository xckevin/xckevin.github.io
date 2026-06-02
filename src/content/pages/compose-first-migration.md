---
title: 'Jetpack Compose 迁移与性能优化'
seo:
  title: 'Jetpack Compose 迁移与性能优化：Compose First、重组、LazyColumn 与 View 互操作'
  description: '面向 Android 团队的 Jetpack Compose 专题页，整理 Compose First、XML 到 Compose 迁移、重组性能、LazyColumn、Modifier、测试和 View 互操作。'
---

Jetpack Compose 已经从“新 UI 框架”变成 Android 新功能开发的默认路径。这个页面面向正在处理“Jetpack Compose 怎么迁移”“Compose 为什么卡顿”“Compose First 意味着什么”的读者，把本站相关深度文章整理成一条工程化路线。

## 适合谁读

- 已经有 View/XML 页面，准备按模块迁移到 Compose。
- 遇到频繁重组、LazyColumn 掉帧、状态读取位置不合理等性能问题。
- 需要同时维护 Compose 与 View，处理 AndroidView、ComposeView、生命周期和滚动冲突。
- 想把 Compose 用到 Wear OS、Glance AppWidget 或多端 UI 架构里。

## 迁移路线

1. 先从低风险页面开始迁移，不要直接重写核心交易链路。
2. 用 View/Compose 互操作连接存量页面，把生命周期、状态提升和事件边界先定清楚。
3. 对高频列表和复杂状态页做重组追踪，重点检查 Stability、derivedStateOf 和状态读取位置。
4. 补齐 Compose UI 测试、截图测试和 CI 回归，避免迁移后靠手工验收。
5. 对 AppWidget、Wear OS、大屏和折叠屏等场景单独做适配策略。

## 核心阅读

- [Jetpack Compose 深度解析专题](/jetpack-compose/)
- [Compose 为什么会频繁重组？从 Stability 到状态读取位置](/blog/2026-06-01-compose为什么频繁重组/)
- [Jetpack Compose 重组性能全链路调优：Stability、derivedStateOf 与跳过重组](/blog/2026-05-07-jetpack_compose_重组性能全链路调优_从_stability_推断到_deriveds/)
- [Android Compose LazyColumn 滑动性能调优：从重组追踪到帧率稳定](/blog/2026-02-26-深入_android_compose_lazycolumn_滑动性能调优全链路_从重组追踪到帧率稳定/)
- [Compose 与 View 桥接实战：AndroidView 与 ComposeView 的双向通信](/blog/2026-05-19-jetpack_compose_与_view_互操作性深度解析_从_androidview_嵌入到_/)
- [Android Compose 渐进式迁移：从 View/Compose 混用到全量声明式 UI](/blog/2025-07-04-深入_android_compose_渐进式迁移全链路_从_view_compose_混用架构到全量/)

## 性能排查重点

- 重组次数：看参数稳定性、remember 作用域和状态读取位置。
- 列表滚动：看 key、contentType、item 组合粒度和图片加载。
- 布局与绘制：看 Modifier 顺序、自定义 Layout、Canvas 绘制和无效测量。
- 输入与手势：看 PointerInput、NestedScroll 和点击区域。
- 测试稳定性：看 Compose 测试调度、异步状态和截图测试基线。

## 相关专题

- [Kotlin 与协程工程实践](/kotlin-coroutines/)：Compose 状态流和副作用经常依赖 Flow、StateFlow 与结构化并发。
- [Android 性能优化](/android-performance/)：如果问题已经落到启动、渲染、内存或 trace，需要进入系统性能排查。
- [移动端工程化](/android-engineering/)：迁移需要测试、CI、质量门禁和模块边界配合。
