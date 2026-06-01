---
title: "Android Gradle 构建慢怎么分析？"
slug: android-gradle-build-slow
excerpt: "整理 Android Gradle 构建慢的分析路径，包括 Build Scan、Configuration Cache、KSP、任务依赖和缓存命中。"
publishDate: '2026-06-01'
tags:
- "Android"
- "Gradle"
- "工程化"
seo:
  title: "Android Gradle 构建慢怎么分析？Configuration Cache 与任务治理"
  description: "介绍 Android Gradle 构建慢的分析方法，覆盖 Build Scan、Configuration Cache、KSP、任务依赖、缓存命中和 CI 优化。"
---

Android 构建慢不要先改插件，先把耗时拆成配置阶段、执行阶段、缓存命中和 CI 环境差异。

优先用 Build Scan 或 profile 看配置阶段和执行阶段耗时，再检查 Configuration Cache、KAPT/KSP、资源处理、Dex、R8 和自定义 task 输入输出声明。

## 深入阅读

- [返回专题页](/android-engineering/)
- [Android Gradle 构建提速：Configuration Cache、KSP 与任务治理](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
