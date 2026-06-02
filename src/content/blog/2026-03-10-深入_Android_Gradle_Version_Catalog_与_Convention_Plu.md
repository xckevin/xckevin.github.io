---
title: 深入 Android Gradle Version Catalog 与 Convention Plugins 全链路：从 buildSrc 单体到声明式依赖治理的模块化构建架构演进
excerpt: 介绍 Android 30+ 模块项目从 buildSrc 向 Version Catalog + Convention Plugins 迁移的实践经验，涵盖声明式依赖治理、预编译脚本分发及踩坑总结。
publishDate: '2026-03-10'
tags:
- Android
- Gradle
- 构建优化
- 模块化
- 依赖管理
seo:
  title: 深入 Android Gradle Version Catalog 与 Convention Plugins 全链路：从 buildSrc 单体到声明式依赖治理的模块化构建架构演进
  description: Android 多模块项目从 buildSrc 迁移到 Version Catalog + Convention Plugins 的完整实践指南，包含性能对比、命名规则、协同方案与避坑经验。
---

去年接手一个 30+ 模块的 Android 项目时，`build.gradle.kts` 里的依赖声明让我头疼了好一阵子。同一个 `androidx-core-ktx` 的版本在三个模块里各写了一个数，gradle sync 倒是能过，但实际构建出来的类路径版本取决于解析顺序——这种不确定性问题，排查起来很要命。

当时团队用的是 `buildSrc` 统一管理依赖，但问题也很明显：**改一行依赖版本，整个 buildSrc 重编译**，模块越多等得越久。那之后我开始推动向 Version Catalog + Convention Plugins 迁移，一年下来踩了不少坑，这里把经验整理出来。

## buildSrc 方案为什么不够用了

`buildSrc` 的本质是一个特殊的 included build，Gradle 在配置阶段优先编译它，产出 class 文件供 root project 引用。典型写法：

```kotlin
// buildSrc/src/main/kotlin/Dependencies.kt
object Versions {
    const val compose = "1.6.0"
    const val hilt = "2.50"
}

object Libs {
    const val composeUi = "androidx.compose.ui:ui:${Versions.compose}"
    const val hiltAndroid = "com.google.dagger:hilt-android:${Versions.hilt}"
}
```

模块里引用 `Libs.composeUi`，看起来整洁，但有三个硬伤：

**编译性能退化**。`buildSrc` 里任何文件变更——哪怕只是加一个常量——都会触发全部模块的配置阶段重新解析。30 个模块的项目，改一行依赖名就要等 20 秒以上。

**缺乏结构化的依赖分组**。所有依赖平铺在一个 object 里，当 `Dependencies.kt` 超过 300 行时，审阅者很难一眼看出某个依赖属于哪个功能域。

**跨项目复用困难**。`buildSrc` 与项目强绑定，没法像 library 一样通过 maven 坐标分发。多项目共享构建逻辑时，只能复制粘贴。

## Version Catalog：TOML 声明式的依赖治理

Gradle 7.0 引入的 Version Catalog 是官方给出的解法。核心思路：**用 TOML 文件声明依赖坐标，Gradle 自动生成类型安全的访问器**。

在 `gradle/libs.versions.toml` 中：

```toml
[versions]
agp = "8.5.0"
kotlin = "2.0.0"
compose-bom = "2024.06.00"
hilt = "2.51"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version = "1.13.0" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-android-compiler", version.ref = "hilt" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
```

四个区段各司其职：

- `[versions]`：集中定义版本号，通过 `version.ref` 引用
- `[libraries]`：定义 module 坐标，支持 version 和 version.ref 两种写法
- `[plugins]`：声明 Gradle 插件，可直接在 `plugins {}` 块中使用
- `[bundles]`：将多个 library 打包成组，适合"引入 Compose 全家桶"这类场景

在模块的 `build.gradle.kts` 中，Gradle 为每个声明生成访问器：

```kotlin
dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.compose.ui)
    implementation(platform(libs.compose.bom))
    implementation(libs.hilt.android)
    kapt(libs.hilt.compiler)
}
```

Gradle 把 TOML 的 `-` 分隔符自动映射为 Kotlin 的属性访问路径，`androidx-core-ktx` 变成 `libs.androidx.core.ktx`，在 IDE 里有完整的自动补全。版本号在 TOML 里改一处，所有引用自动跟进，没有 buildSrc 重编译的开销。

TOML 文件变更只影响依赖解析阶段，不触发 buildSrc 编译。实测 30 模块项目，修改依赖版本后在 AS 里 sync 只需 3-5 秒，而 buildSrc 方案需要 15-25 秒。

## Convention Plugins：预编译脚本的模块化分发

Version Catalog 解决了依赖管理，但每个模块的 `build.gradle.kts` 里仍然充斥着大量重复的插件声明和 android 配置块。以 Compose 模块为例，每个都要写：

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    defaultConfig.minSdk = 26
    kotlinOptions.jvmTarget = "17"
    buildFeatures.compose = true
    composeOptions.kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
}
```

Convention Plugin 的思路是把这些样板配置**预编译成独立的 Gradle 插件**，按需应用到模块上。具体做法是创建一个 `build-logic` 目录（或者继续用 `buildSrc` 但仅放插件逻辑），定义约定插件：

```kotlin
// build-logic/convention/src/main/kotlin/compose-module.gradle.kts
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    defaultConfig.minSdk = 26
    kotlinOptions.jvmTarget = "17"
    buildFeatures.compose = true
    composeOptions.kotlinCompilerExtensionVersion = "1.5.14"
}
```

然后在根 `settings.gradle.kts` 里用 `includeBuild` 引入：

```kotlin
// root settings.gradle.kts
pluginManagement {
    includeBuild("build-logic")
}
```

子模块只需要一行：

```kotlin
plugins {
    id("myproject.compose-module") // convention plugin
}
```

声明式构建的核心就在于此——模块开发者在 `plugins {}` 里声明自己"是什么类型的模块"，具体的编译配置由 Convention Plugin 集中维护。当项目需要统一升级 compileSdk 或修改 Compose 编译器版本时，改一个文件生效全局。

## Version Catalog 与 Convention Plugin 的协同

两者在不同层面互补：Version Catalog 管"用什么版本"，在依赖解析层起作用；Convention Plugin 管"怎么配置"，在 project 配置层起作用。

在 Convention Plugin 内部同样可以使用 Version Catalog。关键是使用 `libs` 扩展，它来自 `gradle/libs.versions.toml` 的自动映射：

```kotlin
// build-logic/convention/src/main/kotlin/compose-module.gradle.kts
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures.compose = true
}

// Convention Plugin 内也可以引用 Version Catalog 的版本
dependencies {
    // 利用 Gradle 的 platform 机制统一 Compose 版本
    "implementation"(platform(libs.compose.bom))
}
```

一个完整的模块配置，最终精简为：

```kotlin
plugins {
    id("myproject.compose-module")
    id("myproject.hilt-module")
}

android.namespace = "com.example.feature.profile"

dependencies {
    implementation(project(":core:common"))
    implementation(libs.androidx.lifecycle.viewmodel)
}
```

模块声明只包含差异化内容：自己的 namespace、模块间依赖、额外三方库。通用配置全部下沉到 Convention Plugin。

## 踩过的坑

这一年的迁移并不顺利，几个问题值得单独讲。

**TOML 的命名转换规则是单向的**。Gradle 把 `-` 转成 `.`，但 TOML 里的 `_` 和 `.` 也有各自的映射逻辑。比如 `androidx-core` 会变成 `libs.androidx.core`，`androidx_core` 也会变成 `libs.androidx.core`——两个名字冲突时编译报错。我现在的做法：library alias 统一用 `-` 分隔，让 group 的 `.` 和 alias 的 `-` 在视觉上区分开，避免踩坑。

**Convention Plugin 的 `plugins {}` 块不能直接引用 Version Catalog**。在预编译脚本的 `plugins {}` 中写 `id(libs.plugins.kotlin.android.get().pluginId)` 是不行的，`plugins {}` 块在脚本编译前就要解析。解决方案是让 Convention Plugin 也通过 TOML 声明自己的插件依赖：

```kotlin
// build-logic/settings.gradle.kts
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}
```

**新建模块请用 AS 模板**。手动创建模块容易忘记在 `settings.gradle.kts` 里加 `include`，或者忘了指定 Convention Plugin。AS 的自定义模板支持选择 Convention Plugin 类型，省去手动配置。

还有一个实践上的取舍：我在 Convention Plugin 里用**字符串硬编码 compileSdk**，不引用 Version Catalog 里的变量。compileSdk 本质上是一个"构建环境参数"，不是"依赖版本"，它应该与 AGP 版本绑定而非独立管理。把 compileSdk 放进 TOML 反而容易让人误以为可以独立升级。

## 迁移路线

如果你的项目还在用 buildSrc 管理依赖，分两步走：

**第一步，把依赖声明迁移到 Version Catalog**。这一步几乎零风险，`buildSrc` 里的 `Dependencies.kt` 可以和 TOML 共存，逐个模块替换即可。完成后先跑一轮完整构建验证，再把老的 constants 删掉。

**第二步，抽离 Convention Plugin**。建 `build-logic` 目录，创建预编译脚本，从最"干净"的模块开始改——也就是那些没有过度自定义 android 块的模块。每改一个就跑一轮该模块的 assemble，确认没问题再推进下一个。

迁移完成后，buildSrc 可以完全移除。目前在维护的 30+ 模块项目，根 `build.gradle.kts` 从 200 行减到 40 行，单个模块的构建脚本平均不到 15 行，新模块搭建时间从 10 分钟降到 30 秒。

日常开发中两个实用技巧：用 `./gradlew dependencies` 可以查看 Version Catalog 解析出的实际版本，排查冲突时很有用；Convention Plugin 的调试可以在插件脚本里临时加 `println`，运行任意 task 都能看到输出，比打断点快得多。
