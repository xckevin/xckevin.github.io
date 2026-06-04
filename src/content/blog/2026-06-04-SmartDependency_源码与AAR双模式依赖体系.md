---
title: SmartDependency 源码/AAR 双模式依赖体系：让模块化工程既快又稳
excerpt: 在大型 Android 工程中，模块数量增长后依赖方式直接影响研发效率。本文介绍一种源码/AAR 双模式依赖体系，通过统一注册、配置切换、版本治理和 CI 约束，让开发者按需打开源码模块，同时保证发布时回归二进制真实形态。
publishDate: '2026-06-04'
tags:
- Android
- Gradle
- 模块化
- 依赖管理
- 工程效能
seo:
  title: SmartDependency 源码/AAR 双模式依赖体系：让模块化工程既快又稳
  description: 大型 Android 工程中源码/AAR 双模式依赖体系设计，通过统一注册、配置切换、版本治理和 CI 约束，让开发者按需打开源码模块，同时保证发布时回归二进制真实形态。
---

模块化是大型 Android 工程的必选项，但模块化不会自动带来效率提升。我在一个多 App 壳、多业务模块的项目里就深刻体会到这一点：上层有 AppA、AppB、RegionA、RegionB 等多个壳，中间有 features 业务页面模块，下方有 domain 领域模块和 infrastructure 基础设施模块，旁路还有动态特性模块。它们的依赖关系多、构建变体多，如果全部源码加载，每个开发者都被拖进全量工程，Gradle 配置、Kotlin 编译缓存、IDE 索引都慢得让人想切回去写单体。

改状态页时，其实只需要打开 feature_state、state_domain 和必要的基础设施源码，其他稳定模块完全可以走 AAR。但问题来了：怎么让"切源码"和"切 AAR"的成本足够低？

## 为什么需要双模式依赖

全部源码依赖方便调试，但会拉长配置、编译和索引时间。一次看似简单的页面修改，可能触发大量无关模块的配置和校验。全部 AAR 依赖更接近发布形态，但开发者在调试跨模块逻辑时又遇到源码不可见、断点不稳定、修改链路长的问题。尤其当一个业务模块依赖多个基础模块时，单次联调可能要反复发布本地包，体验很差。

更麻烦的是，本地源码依赖下通过的编译，不一定等同于发布环境里 AAR 依赖下的编译。源码工程里存在未显式声明但可见的间接依赖，到了 AAR 模式可能就暴露为缺包；资源名、混淆规则、consumer 配置在二进制形态下表现也不同。

所以，要解决的不是"源码好还是 AAR 好"，而是"什么时候应该用源码，什么时候应该用 AAR，以及如何让切换成本足够低"。

## 核心设计：统一注册 + 配置切换

SmartDependency 的核心思路是在构建逻辑中维护"模块坐标表"和"源码映射表"。模块坐标表描述逻辑模块名、Maven 坐标、默认版本；源码映射表描述当启用源码模式时，该逻辑模块对应哪个本地 Gradle project。

依赖声明被包装成 `smartApi("feature.profile")`、`smartImplementation("foundation.network")` 的形式。构建脚本读取当前模式后，如果模块在源码白名单中，就生成 `project(":feature:profile")`；否则生成二进制坐标。

```kotlin
data class ModuleSpec(
    val name: String,
    val artifact: String,
    val sourceProject: String
)

val registry = mapOf(
    "feature.profile" to ModuleSpec(
        name = "feature.profile",
        artifact = "group:feature-profile:1.2.3",
        sourceProject = ":feature:profile"
    ),
    "foundation.log" to ModuleSpec(
        name = "foundation.log",
        artifact = "group:foundation-log:2.0.0",
        sourceProject = ":foundation:log"
    )
)

fun DependencyHandler.smartImplementation(moduleName: String) {
    val spec = registry.getValue(moduleName)
    val sourceEnabled = localConfig.sourceModules.contains(moduleName)
    if (sourceEnabled) {
        add("implementation", project(spec.sourceProject))
    } else {
        add("implementation", spec.artifact)
    }
}
```

但光替换依赖还不够。如果所有源码模块仍然被 include 进 Gradle 工程，IDE 索引和配置时间不会明显下降。所以还需要在 settings 阶段做同样判断，只 include 需要的 project：

```kotlin
val sourceModules = readLocalSourceModuleList()

registry.values.forEach { spec ->
    if (sourceModules.contains(spec.name)) {
        include(spec.sourceProject)
        project(spec.sourceProject).projectDir = file(resolvePath(spec.name))
    }
}
```

这里有一个关键约束：依赖解析和 project include 必须使用同一份配置。否则会出现依赖脚本想引用 project，但 settings 没有 include 的问题。

## 实际工程中的两个落点

这套方案在实际项目中不是停留在概念层，而是落在两个构建入口上：`settings.gradle` 负责"模块是否 include 进 Gradle 工程"，`buildSrc` 中的 SmartDependency 负责"依赖最终指向源码 project 还是本地/远端 AAR 坐标"。这两个点必须同时存在，否则只做依赖替换但仍 include 所有源码模块，IDE 索引时间不会明显下降；只做 settings 裁剪但业务模块仍写死 `project(":xxx")`，又会在 AAR 模式下编译失败。

另一个亮点是 `configurePublishing(project)` 把 Android library 模块统一发布到本地 Maven 仓库，并配合 `preferProjectModules()` 保证源码模块优先。这让"从源码调试到 AAR 验证"形成闭环：先源码开发，确认后发布 snapshot，再切回 AAR 模式验证传递依赖、consumer 配置、资源暴露和二进制边界。

## 配置入口与 CI 约束

配置入口可以设计为本地文件优先：

```properties
# local-dependency.properties
sourceModules=feature.profile,foundation.log
dependencyMode=hybrid
```

CI 环境则通过环境变量强制覆盖，确保发版构建始终使用二进制依赖：

```kotlin
val mode = env("DEPENDENCY_MODE") ?: localFile.get("dependencyMode")
if (isCiBuild()) {
    require(mode == "binary") { "CI build must use binary dependencies" }
}
```

版本治理同样重要。AAR 模式必须知道每个模块使用哪个版本，源码模式也要知道当前源码对应哪个发布版本。我们把版本信息集中放在版本目录或平台 BOM 里，再由 SmartDependency 读取，避免版本漂移导致的"本地通过但集成失败"。

## 可观测性：让依赖模式一目了然

排查问题时，开发者经常不知道自己到底使用了哪种产物。一个简单的工具输出就能解决这个问题：

```text
Dependency mode: hybrid

feature.profile      source   :feature:profile
foundation.log       source   :foundation:log
foundation.network   binary   group:foundation-network:3.1.0
```

这个输出能快速回答三个问题：当前模块是不是源码模式、对应 project 路径是什么、二进制版本是什么。在大型工程里，这种可观测性价值巨大。

## 落地中的几个坑

源码模式不能成为绕过模块边界的理由。模块之间仍然应该通过公开 API 交互，不能因为源码在同一个工程里就直接访问内部类或测试工具。可以通过包可见性、lint、依赖约束等方式降低越界风险。

AAR 产物要足够完整。consumer 混淆规则、资源前缀、公开依赖、原生库、注解处理产物等都要在二进制模式下验证。很多模块在源码依赖下能工作，是因为上层工程"顺手"带上了某些配置；一旦独立发布，就会暴露缺失。

迁移要分阶段。可以先让少数高频模块接入 SmartDependency，再逐步扩大范围。不要一次性重写所有依赖声明，否则一旦出问题，很难判断是脚本问题、版本问题还是模块自身问题。

---

SmartDependency 的价值不在于创造一种新依赖类型，而在于把源码和 AAR 两种形态纳入同一套规则。开发阶段需要灵活性，发布阶段需要确定性，构建体系要同时服务这两个目标。真正难的部分不只是写一个 Gradle helper，而是长期维护依赖边界和发布纪律。只要边界不清，源码模式会放大耦合；只要版本不稳，AAR 模式会放大差异。它应该被视为模块化治理的一部分，而不是一个单独的构建技巧。