---
title: 'Android Gradle 与 AGP 9 迁移'
seo:
  title: 'Android Gradle 与 AGP 9 迁移：构建提速、Built-in Kotlin、KSP 与 CI 门禁'
  description: '面向 Android Gradle、AGP 9 和构建提速搜索需求，整理 Built-in Kotlin、KSP、Configuration Cache、Version Catalog、CI/CD 与质量门禁。'
---

Android Gradle 的搜索需求通常不是“看一篇概念介绍”，而是要解决构建慢、升级 AGP 失败、KSP/Kotlin 版本冲突、CI 不稳定和模块依赖混乱。这个页面把本站工程化内容按 AGP 9 迁移和构建治理重新组织。

## 迁移前先做清单

1. 固定 Gradle、AGP、Kotlin、KSP、JDK 和 Android Studio 版本矩阵。
2. 打开 Build Scan 或构建日志，先确认慢在配置阶段、任务执行、KSP/KAPT、资源处理还是 R8。
3. 逐模块启用 Configuration Cache 兼容性检查，不要一次性改完整个仓库。
4. 把依赖版本迁到 Version Catalog，把重复脚本沉到 Convention Plugins。
5. 在 CI 里增加构建耗时、缓存命中率、Lint、单测和产物校验门禁。

## AGP 9 关注点

- Built-in Kotlin：AGP 9 默认启用内置 Kotlin 支持，升级时要处理 Kotlin Gradle Plugin 与 KSP 版本关系。
- 默认行为变化：部分 buildFeatures、R8、NDK、compileSdk 消费约束会影响老项目。
- 测试夹具与 IDE 支持：升级不只是命令行构建，也要验证 Android Studio 体验。
- 插件兼容性：自研 Gradle 插件、字节码插桩、资源处理和发布插件都要单独验证。

## 核心阅读

- [移动端工程化专题](/android-engineering/)
- [Android Gradle 构建慢怎么分析？从配置阶段到任务执行](/blog/2026-06-01-android-gradle构建慢怎么分析/)
- [Android Gradle 构建提速：Configuration Cache、KSP 与任务治理](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android Gradle Version Catalog 与 Convention Plugins](/blog/2026-03-10-深入_android_gradle_version_catalog_与_convention_plu/)
- [Android APK 构建全链路：aapt2、V4 签名与 AGP 内部机制](/blog/2026-05-16-深入_android_apk_构建全链路_从_aapt2_资源编译到_v4_签名验证的_agp_内部/)
- [Android CI/CD 质量门禁应该包含什么？](/blog/2026-06-01-android-ci-cd质量门禁/)

## 排查路径

- 构建整体慢：先看配置阶段和远程缓存，再看任务热点。
- Kotlin/KSP 慢：看符号处理器数量、增量能力、模块边界和生成代码体积。
- R8 慢：看 keep 规则、资源 shrink、混淆输入规模和多变体构建。
- CI 慢：看缓存目录、依赖下载、并发策略、测试分层和产物复用。
- 升级失败：先缩小到最小模块，再逐个恢复插件和自定义任务。

## 官方参考

- [Android Gradle plugin release notes](https://developer.android.com/build/releases/gradle-plugin)
- [AGP 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes)
- [Migrate to built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin)

## 相关专题

- [Kotlin 与协程工程实践](/kotlin-coroutines/)：Kotlin、KSP、K2 和编译器变化会直接影响 Android 构建链路。
- [Android 性能优化](/android-performance/)：性能门禁需要把 Macrobenchmark、启动耗时和线上指标接入 CI。
