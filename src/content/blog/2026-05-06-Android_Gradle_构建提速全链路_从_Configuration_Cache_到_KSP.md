---
title: Android Gradle 构建提速全链路：从 Configuration Cache 到 KSP 替换 KAPT 的工程化实践
excerpt: 系统拆解 Android Gradle 构建的三段耗时——配置阶段、注解处理与任务执行，通过启用 Configuration Cache、将 KAPT 迁移至 KSP、修复增量编译隐患等手段，实现增量构建时间大幅压缩的工程化实践。
publishDate: '2026-05-06'
tags:
- Android
- Gradle
- Kotlin
- KSP
- 构建优化
seo:
  title: "Android Gradle 构建提速：Configuration Cache、KSP 与任务治理"
  description: "系统整理 Android Gradle 构建提速方法，覆盖 Configuration Cache、KSP、任务配置、缓存命中和大型项目构建治理。"
---

一个中型项目，30 个模块，clean build 跑 4 分钟，增量构建也要 1 分 20 秒。这类数字在稍具规模的团队里并不少见，但多数人的应对方式是"加机器内存"或者"升级 Gradle 版本祈祷变快"。

构建耗时不是一个整体，而是三段叠加：**配置阶段（Configuration Phase）**、**注解处理（Annotation Processing）**、**任务执行（Task Execution）**。三段的瓶颈原因完全不同，混着优化等于同时修三台机器的不同故障——听起来很忙，实际上进展有限。

把这三段拆开，逐段定位，逐段解决。

---

## 第一步：摸清时间花在哪里

盲目优化是最贵的时间浪费。Gradle 自带了足够好的诊断工具，但很多人从没用过。

带 `--profile` 跑一次构建，Gradle 会在 `build/reports/profile/` 下生成 HTML 报告，包含配置阶段耗时和每个 task 的执行时间分布。更细粒度的分析用 `--scan`：

```bash
./gradlew assembleDebug --profile
./gradlew assembleDebug --scan  # 上传到 scans.gradle.com，获取交互式分析报告
```

从报告里找三个关键数字：

- **Configuration time**：超过 10s，配置阶段有问题
- **Task `:app:kaptDebugKotlin` 耗时**：KAPT 的重灾区，通常是单任务里耗时最长的
- **并行任务数量**：大量 task 串行排队，说明依赖图或并行配置有问题

没有 profile 数据就动手，大概率优化了一个根本不是瓶颈的地方。

---

## 配置阶段：Configuration Cache

配置阶段是 Gradle 解析所有 `build.gradle` 文件、构建 task 依赖图的过程。**每次构建都会重新执行**，哪怕只改了一行业务代码。

40 个模块的项目，配置阶段轻松吃掉 15–20 秒。Configuration Cache（CC）的思路是把这份 task 图序列化缓存，下次构建时如果 `build.gradle` 没有变化，直接反序列化跳过配置阶段。

启用方式：

```properties
# gradle.properties
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=warn  # 先用 warn 模式，排查兼容问题
```

### CC 兼容性：真正的工作量

CC 的难点不在开启，在**兼容性修复**。Gradle 要求 task 的所有输入输出在序列化时必须是 CC 安全的，以下三类写法会直接导致 CC 失效或行为异常：

**在 task action 里直接访问 `project` 对象：**

```kotlin
// ❌ task action 执行时 project 不可序列化
tasks.register("generateConfig") {
    doLast {
        val flavor = project.properties["flavor"]
    }
}

// ✅ 提前捕获为 Provider，声明为 @Input
tasks.register("generateConfig") {
    val flavor = providers.gradleProperty("flavor")
    doLast {
        val f = flavor.orNull
    }
}
```

**使用 `afterEvaluate` 修改 task 状态：**`afterEvaluate` 是配置阶段的副作用，CC 环境下行为不可预测。替代方案是用 `Provider` 延迟求值，或者重新梳理 task 依赖关系，通过声明式 API 表达依赖。

**第三方插件不兼容：** 实际项目里最头疼的部分。AGP 8.x 已全面兼容 CC，但一些老旧的代码生成插件（某些路由框架的 Gradle 插件）还没跟上。先用 `warn` 模式跑一遍，从报告里找不兼容的插件，逐个升级或替换。

实测下来，升级 AGP 到 8.1+ 并开启 CC 后，40 模块项目的增量构建配置时间从 18s 降到 2s 以内。这是收益最直接的一项优化，代价是一到两天的兼容性排查工作。

---

## 注解处理：KSP 替换 KAPT

KAPT（Kotlin Annotation Processing Tool）的工作原理决定了它天生慢：把 Kotlin 源码编译成 Java Stub → 把 Stub 喂给 Java APT 处理器 → 生成代码后再做一次完整编译。三步走，每一步都是实打实的编译开销。

一个模块的 `kaptDebugKotlin` task 在中型项目里耗时 15–30s 很正常，多个模块叠加就是分钟级的浪费。

**KSP（Kotlin Symbol Processing）** 直接作为 Kotlin 编译器插件运行，在符号解析层面处理注解，完全跳过 Java Stub 生成。官方数据是 2x 提升，大厂实测普遍在 2x–4x，这个数字有实际支撑。

### 迁移步骤

以 Room 和 Hilt 为例：

```kotlin
// 根 build.gradle.kts
plugins {
    id("com.google.devtools.ksp") version "2.0.0-1.0.21" apply false
}
```

```kotlin
// 模块 build.gradle.kts
plugins {
    id("com.google.devtools.ksp")
}

dependencies {
    // 把 kapt 改成 ksp，其他依赖不变
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")

    ksp("com.google.dagger:hilt-compiler:2.51")
    implementation("com.google.dagger:hilt-android:2.51")
}
```

迁移完后把所有模块的 `kotlin("kapt")` 插件声明删掉。混用 KAPT 和 KSP 处理同一个库会导致两套处理器都跑一遍，比单独用 KAPT 还慢。

### 不是所有库都已支持 KSP

Glide 的 KSP 支持长期处于 experimental 状态；国内部分路由框架（ARouter 旧版）依赖 KAPT，KSP 版本由社区维护，稳定性需要自行评估。迁移前查官方文档确认支持状态，不要抱着"试试能不能跑"的心态直接上——生成代码的差异在编译期不一定报错，运行时出问题才更难排查。

---

## 任务执行：增量编译与并行构建

### 增量编译的隐蔽杀手

Gradle 增量编译依赖两件事：task 的输入输出声明正确，以及 UP-TO-DATE 检查不被意外破坏。

踩过一个典型坑：有个自定义 task 把 `System.currentTimeMillis()` 写进了输出文件的注释里，导致每次输出都变化，这个 task 永远不是 UP-TO-DATE，下游所有依赖它的 task 也全部重新执行。定位方法：

```bash
./gradlew assembleDebug --info 2>&1 | grep "not up-to-date\|UP-TO-DATE"
```

自定义 task 的输入输出必须显式声明：

```kotlin
abstract class GenerateVersionTask : DefaultTask() {
    @get:Input
    abstract val versionCode: Property<Int>

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @TaskAction
    fun execute() {
        // ✅ 输出只依赖声明的 @Input，不引入时间戳等外部不确定因素
        outputFile.get().asFile.writeText("VERSION_CODE=${versionCode.get()}")
    }
}
```

### 并行执行与 JVM 调优

```properties
# gradle.properties
org.gradle.parallel=true
org.gradle.workers.max=8        # 建议 = CPU 核数，IO 密集型任务可以适当超一点
org.gradle.caching=true         # 开启 Build Cache，与 CC 独立，两者可同时启用
org.gradle.jvmargs=-Xmx4g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
```

并行构建发挥效果的前提是模块化拆分合理。所有业务代码堆在一个 `:app` 模块，并行根本没有发挥空间——这是架构问题，配置参数解决不了。

Build Cache 在 CI 环境收益最大：同一份代码、不同分支切换时，大量 task 可以从缓存恢复而不重新执行。多机 CI 可以配置远程缓存节点，一台机器的构建结果可以被其他机器直接复用。

---

## 三项优化的优先级和预期收益

从实测数据看，三类优化的收益差异明显：

| 优化项 | 增量构建收益 | 实施难度 |
|---|---|---|
| KSP 替换 KAPT | 注解处理 -50%–70% | 低（按库逐步迁移） |
| Configuration Cache | 配置时间 -85%+ | 中（需排查兼容问题） |
| 并行 + 增量修复 | 任务执行 -20%–40% | 低～中 |

我更倾向于先做 KSP 迁移：风险低，收益即时，按库分批推进，失败了回滚也容易。改几行依赖声明，构建时间直接少掉 20–30 秒，性价比最高。

Configuration Cache 的收益依赖项目规模，模块越多、配置越复杂，效果越显著。少于 10 个模块的小项目可以先观望；大项目建议把 CC 兼容性修复单独排一个迭代，不要混在功能开发里做——排查问题时上下文混乱会让工作量翻倍。

还在用 AGP 7.x 的项目，可以把升级 AGP 8.x 一并规划进来。CC 稳定支持、`buildFeatures` 精细控制（关掉不用的 `buildConfig`、`aidl`、`renderScript`）、R 文件生成优化，这些在 AGP 8 里都有实质性改善。升级本身有迁移成本，但收益是系统性的，值得做。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：移动端工程化](/android-engineering/)
- [Android 测试工程实践：JUnit、集成测试、Compose 语义与 CI](/blog/2026-05-10-%E6%B7%B1%E5%85%A5_Android_%E6%B5%8B%E8%AF%95%E5%85%A8%E9%93%BE%E8%B7%AF%E5%B7%A5%E7%A8%8B%E5%AE%9E%E8%B7%B5_%E4%BB%8E_JUnit_%E5%8D%95%E5%85%83%E6%B5%8B%E8%AF%95%E5%88%B0_Compose_Semanti/)
- [Android CI/CD 实践：Jenkins、GitLab CI、构建发布与质量门禁](/blog/Jenkins%E4%B8%8EGitLab%20CI%E5%AE%9E%E7%8E%B0Android%E6%8C%81%E7%BB%AD%E9%9B%86%E6%88%90%E4%B8%8E%E4%BA%A4%E4%BB%98%EF%BC%9A%E4%BB%8E%E6%9E%84%E5%BB%BA%E5%88%B0%E5%8F%91%E5%B8%83%E7%9A%84%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97/)
<!-- /seo-internal-links -->
