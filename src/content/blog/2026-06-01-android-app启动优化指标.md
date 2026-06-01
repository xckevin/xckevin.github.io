---
title: "Android App 启动优化应该先看哪些指标？"
slug: android-startup-metrics
excerpt: "整理 Android 启动优化的关键指标、阶段拆分、Perfetto trace 观察点和线上治理优先级。"
publishDate: '2026-06-01'
tags:
- "Android"
- "启动优化"
- "Perfetto"
seo:
  title: "Android App 启动优化指标：冷启动、首帧、TTID 与 Perfetto 分析"
  description: "介绍 Android App 启动优化应关注的冷启动、首帧、TTID、主线程阻塞、Binder 调用和 Perfetto trace 指标。"
---

启动优化不要先改代码，先确定指标。否则很容易把耗时从一个阶段挪到另一个阶段，线上体验没有真正变好。

## 优先看四类指标

冷启动总耗时、首帧时间、主线程阻塞、线上分位值。Perfetto 中重点观察 Zygote fork、bindApplication、ActivityThread、Choreographer#doFrame、Binder transaction 和 disk I/O。

## 深入阅读

- [返回专题页](/android-performance/)
- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/2026-04-19-Android_%E5%86%B7%E5%90%AF%E5%8A%A8%E5%85%A8%E9%93%BE%E8%B7%AF%E4%BC%98%E5%8C%96%E5%B7%A5%E7%A8%8B%E5%AE%9E%E8%B7%B5_%E4%BB%8E_Zygote_fork_%E5%88%B0%E9%A6%96%E5%B8%A7%E4%B8%8A%E5%B1%8F%E7%9A%84_Systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/App%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96%E4%B8%93%E9%A1%B9/)
