---
title: "Android CI/CD 质量门禁应该包含什么？"
slug: android-ci-cd-quality-gates
excerpt: "整理 Android CI/CD 中构建、测试、Lint、签名、性能基准、发布和回滚的质量门禁设计。"
publishDate: '2026-06-01'
tags:
- "Android"
- "CI/CD"
- "工程化"
seo:
  title: "Android CI/CD 质量门禁：构建、测试、Lint、性能与发布检查"
  description: "介绍 Android CI/CD 质量门禁设计，覆盖 Jenkins、GitLab CI、单元测试、Lint、签名、性能基准、发布和回滚。"
---

Android CI/CD 的目标不是“自动打包”，而是把质量风险挡在合并、发布和灰度之前。

基础门禁包括 Debug/Release 构建、单元测试、Lint、签名和版本配置。进阶门禁包括集成测试、UI 冒烟、Macrobenchmark 性能回归、包体积阈值和灰度指标观察。

## 深入阅读

- [返回专题页](/android-engineering/)
- [Android CI/CD 实践：Jenkins、GitLab CI、构建发布与质量门禁](/blog/jenkins与gitlab-ci实现android持续集成与交付从构建到发布的完整指南/)
- [Android 测试工程实践：JUnit、集成测试、Compose 语义与 CI](/blog/2026-05-10-深入_android_测试全链路工程实践_从_junit_单元测试到_compose_semanti/)
