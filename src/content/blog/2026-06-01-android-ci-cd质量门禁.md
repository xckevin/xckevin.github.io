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
- [Android CI/CD 实践：Jenkins、GitLab CI、构建发布与质量门禁](/blog/Jenkins%E4%B8%8EGitLab%20CI%E5%AE%9E%E7%8E%B0Android%E6%8C%81%E7%BB%AD%E9%9B%86%E6%88%90%E4%B8%8E%E4%BA%A4%E4%BB%98%EF%BC%9A%E4%BB%8E%E6%9E%84%E5%BB%BA%E5%88%B0%E5%8F%91%E5%B8%83%E7%9A%84%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97/)
- [Android 测试工程实践：JUnit、集成测试、Compose 语义与 CI](/blog/2026-05-10-%E6%B7%B1%E5%85%A5_Android_%E6%B5%8B%E8%AF%95%E5%85%A8%E9%93%BE%E8%B7%AF%E5%B7%A5%E7%A8%8B%E5%AE%9E%E8%B7%B5_%E4%BB%8E_JUnit_%E5%8D%95%E5%85%83%E6%B5%8B%E8%AF%95%E5%88%B0_Compose_Semanti/)
