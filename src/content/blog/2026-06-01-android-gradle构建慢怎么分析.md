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

Android 构建慢不要先改插件，也不要先升级机器。构建耗时是配置阶段、任务执行、编译器、缓存命中、CI 环境共同叠加的结果。如果没有拆开看，优化动作大概率会打在错误的位置。

这篇不重复完整提速方案，只讲分析路径：怎么判断慢在哪里，哪些数据值得看，看到问题后应该往哪个方向继续挖。

## 第一步：先拿到可比较的基线

构建性能排查最怕凭感觉。先固定一个命令，例如：

```bash
./gradlew :app:assembleDebug --profile
./gradlew :app:assembleDebug --scan
```

然后至少跑三次：第一次冷构建，第二次不改代码的重复构建，第三次改一行业务代码后的增量构建。三次数据代表不同问题：冷构建看全量成本，重复构建看缓存，增量构建看日常开发体验。

记录时不要只写总耗时，至少拆这些字段：

- Configuration time
- Task execution time
- 执行 task 数量和 up-to-date task 数量
- KAPT/KSP/Kotlin 编译耗时
- Dex、R8、资源处理耗时
- 本地与 CI 的差异

没有这张表，后面的优化讨论都会变成“我觉得”。

## 配置阶段慢：看 Configuration Cache

如果 Build Scan 里 Configuration time 很高，说明 Gradle 花了很多时间解析脚本、创建 task、配置插件。多模块项目里这部分经常超过 10 秒，业务代码只改一行也要重新配置所有模块。

先检查是否启用 Configuration Cache：

```properties
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=warn
```

如果启用后没有命中，不要只看控制台最后一行。Build Scan 会列出具体不兼容点：某个插件访问了 Project，某个 task action 里读取了 Gradle model，或者用了不安全的 `afterEvaluate`。这些问题要逐个修，不是换一个参数能解决。

配置阶段优化的判断标准很简单：第二次相同构建时，Configuration time 应该明显下降。如果没有下降，先别看 KSP、R8、Dex，瓶颈还在配置层。

## 执行阶段慢：先找 Top Task

任务执行慢时，先按耗时排序，而不是从 `build.gradle` 里猜。常见大户包括：

- `kaptDebugKotlin`：KAPT 生成 stub 和注解处理。
- `compileDebugKotlin`：Kotlin 编译，受模块边界和 ABI 变化影响。
- `mergeDebugResources` / `processDebugResources`：资源规模、AAPT2、重复资源。
- `dexBuilderDebug` / `mergeDexDebug`：方法数、依赖体积、增量命中。
- `minifyReleaseWithR8`：Release 包混淆和优化。

如果 KAPT 排在前面，优先评估 Room、Hilt、Moshi 等依赖是否能迁到 KSP。如果资源处理慢，先看资源数量、变体数量、是否每次都触发全量处理。如果 Kotlin 编译慢，重点看模块拆分、公共 API 变化和是否有大而全的基础模块。

## 缓存不命中：比任务慢更危险

很多构建慢不是某个 task 天生慢，而是它每次都重新执行。排查方式是看 Gradle 为什么认为 task 不是 up-to-date：

```bash
./gradlew :app:assembleDebug --info
```

常见原因包括：自定义 task 没有声明输入输出、输出文件写入时间戳、读取环境变量但没有声明为 input、生成文件路径不稳定、依赖远程资源、构建脚本里做了随机逻辑。

自定义 task 是重灾区。一个永远 out-of-date 的生成代码 task，会导致下游 Kotlin 编译、资源处理甚至 Dex 都跟着重跑。修这类问题的收益通常比换硬件更直接。

## CI 慢要单独看

本地快不代表 CI 快。CI 上常见问题是没有持久化 Gradle 缓存、每次重新下载依赖、没有固定 JDK/NDK/AGP 版本、并发任务抢 CPU、模拟器测试和构建任务互相干扰。

CI 里至少缓存三类目录：Gradle wrapper、Gradle dependency cache、Build Cache。远程 Build Cache 如果配置得当，不同分支和不同机器可以复用中间产物。但远程缓存也要有准入策略，不能让不可靠 task 污染缓存。

## 一个实用的排查顺序

我一般按这个顺序处理 Android Gradle 构建慢：

1. 用 `--scan` 和 `--profile` 建基线。
2. 看配置阶段是否过高，先处理 Configuration Cache。
3. 看 Top Task，区分 KAPT、Kotlin、资源、Dex、R8。
4. 看 up-to-date 和 build cache 命中率。
5. 单独对比本地与 CI，补缓存和环境固定。
6. 最后再考虑模块化拆分、依赖治理和 AGP 升级。

这个顺序的好处是每一步都有数据闭环。构建优化不是玄学，慢在哪里，报告里通常已经写出来了。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：移动端工程化](/android-engineering/)
- [Android Gradle 构建提速：Configuration Cache、KSP 与任务治理](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android CI/CD 质量门禁：构建、测试、Lint、性能与发布检查](/blog/android-ci-cd-quality-gates/)
<!-- /seo-internal-links -->
