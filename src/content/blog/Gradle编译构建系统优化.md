---
title: Gradle 编译构建系统优化
excerpt: 对于 Android 开发者而言，尤其是身处大型、多模块项目的团队中，Gradle 构建时长往往是日常开发中最主要的痛点之一。每一次等待编译、打包的过程，都是对耐心和生产力的消耗。缓慢的构建不仅降低了开发迭代速度，影响了编码心流，甚至可能成为团队扩张和项目复杂度增加的严重障碍。
publishDate: 2025-02-24
tags:
  - Android
  - Gradle
  - 构建优化
  - 编译
seo:
  title: Gradle 编译构建系统优化
  description: 对于 Android 开发者而言，尤其是身处大型、多模块项目的团队中，Gradle 构建时长往往是日常开发中最主要的痛点之一。每一次等待编译、打包的过程，都是对耐心和生产力的消耗。缓慢的构建不仅降低了开发迭代速度，影响了编码心流，甚至可能成为团队扩张和项目复杂度增加的严重障碍。
---
# Gradle 编译构建系统优化

## 引言：效率的瓶颈与解放

对于 Android 开发者而言，尤其是身处大型、多模块项目的团队中，Gradle 构建时长往往是日常开发中最主要的痛点之一。每一次等待编译、打包的过程，都是对耐心和生产力的消耗。缓慢的构建不仅降低了开发迭代速度，影响了编码心流，甚至可能成为团队扩张和项目复杂度增加的严重障碍。

Gradle 本身是一个极其强大和灵活的自动化构建工具，它支撑着现代 Android 应用的构建、测试和打包。然而，正是它的灵活性，如果不加以理解和善用，也可能导致构建脚本臃肿、配置复杂、执行效率低下。

对于高级别的 Android 专家或架构师而言，**深入理解 Gradle 的工作原理、诊断构建性能瓶颈、并熟练运用各种高级优化技术来缩短构建时间，是一项至关重要的职责**。这直接关系到整个研发团队的效率和幸福感。这需要超越 `build.gradle` 的基础语法，深入到 Gradle 的生命周期、任务图、缓存机制、并行处理以及与 Android Gradle 插件（AGP）的交互中去。

本文将深入探讨 Gradle 构建系统优化，主要涵盖以下内容：

- **Gradle 核心原理**：生命周期、任务图、输入/输出对优化的重要性
- **性能瓶颈诊断**：利用 `--profile` 和 `--scan` 定位构建耗时环节
- **核心优化技术**：Gradle Daemon、并行执行、配置缓存、构建缓存、增量编译与注解处理
- **依赖管理优化**：`api` 与 `implementation` 的区别，版本管理策略
- **多模块项目策略**：针对模块化架构的特定优化
- **AGP 优化配置**：Android Gradle 插件提供的性能相关选项
- **KAPT 与 KSP**：注解处理的性能关键

![](../../assets/gradle编译构建系统优化-1.webp)

---

## 一、Gradle 核心原理回顾（性能视角）

要优化 Gradle，首先要理解其基本工作流程。

### 1. 构建生命周期（Build Lifecycle）

Gradle 构建经历三个主要阶段：

- **初始化阶段（Initialization）**
  - Gradle 确定参与构建的项目（对于多模块项目，解析 `settings.gradle(.kts)`）
  - 创建 Settings 对象
  - 通常非常快，除非 `settings.gradle` 中有复杂逻辑

- **配置阶段（Configuration）—— 极其关键的性能影响阶段**
  - **执行脚本**：按顺序执行所有参与项目的 `build.gradle(.kts)` 脚本
  - **构建模型**：创建并配置 Project 对象及其所有 Task 对象
  - **构建任务图**：解析任务之间的依赖关系（`dependsOn`、输入/输出关系），构建一个有向无环图（DAG），确定需要执行哪些任务以及执行顺序
  - **性能陷阱**：此阶段耗时直接影响所有构建的启动时间，即使最终没有任务需要执行（如 UP-TO-DATE 构建）。避免在此阶段执行：文件 IO、网络请求、复杂的计算、不必要的对象创建。配置阶段的目标应该是快速、确定性地定义好任务及其关系

- **执行阶段（Execution）**
  - Gradle 根据配置阶段生成的任务图，以及请求执行的任务（如 `assembleDebug`），按顺序执行需要运行的任务
  - 优化重点在于：**让任务执行得更快**（代码优化），以及**避免不必要的任务执行**（利用增量构建和缓存）

**Gradle 构建生命周期示意图：**

```plain
+-----------------+      +------------------------------------+      +-------------------------------------+
| Initialization  | ---> |           Configuration            | ---> |              Execution              |
|-----------------|      |------------------------------------|      |-------------------------------------|
| - Discover Projects |  | - Execute build.gradle(.kts) scripts|     | - Execute Tasks based on Task Graph |
| - Create Settings Obj| | - Create/Configure Project Objects  |     |   (Respects Dependencies)           |
+-----------------+      | - Create/Configure Task Objects     |     | - Skip UP-TO-DATE Tasks             |
                         | - Build Task Dependency Graph (DAG) |     | - Use Build Cache for Cacheable Tasks |
                         +------------------------------------+      +-------------------------------------+
                                      ^
                                      |
                                      +---- MAJOR BOTTLENECK AREA (Configuration Time)
```

### 2. 任务（Tasks）

Gradle 中的工作单元（如 `compileKotlin`、`mergeDebugResources`、`lint`、`test`、`assembleDebug`）。

- **任务输入（Inputs）与输出（Outputs）—— Gradle 优化的基石**
  - 任务通过注解（如 `@Input`、`@InputFile`、`@InputDirectory`、`@OutputFile`、`@OutputDirectory`、`@Nested` 等）声明其输入（影响任务结果的因素）和输出（任务产生的结果）
  - **作用**：
    - **增量构建（Incrementality）**：Gradle 比较当前构建和上次构建的输入。如果输入没有变化，任务的输出就被认为是 **UP-TO-DATE**，Gradle 会跳过该任务的执行。这需要任务实现者（或插件开发者）正确标注所有输入输出
    - **构建缓存（Build Cache）**：Gradle 根据任务的输入（以及任务实现本身）计算一个**构建缓存键（Build Cache Key）**。如果当前构建的缓存键与之前某次构建（可能在本地或其他机器上）匹配，Gradle 可以直接从缓存中恢复任务的输出，而无需执行任务。同样依赖于精确的输入输出声明

### 3. 插件（Plugins）

如 AGP、Kotlin Gradle Plugin、KAPT/KSP 等，通过添加预定义的任务和配置来扩展 Gradle 功能。插件的行为（特别是它们添加的任务的效率和输入输出声明的准确性）对构建性能有重大影响。

### 4. 依赖管理（Dependency Management）

Gradle 解析和下载依赖项的过程发生在配置阶段和执行阶段（如果需要下载）。复杂的依赖关系图或缓慢的网络会影响构建时间。

---

## 二、诊断先行：定位构建性能瓶颈

在进行优化前，必须先准确找到瓶颈所在。

### 1. Gradle Profiler（--profile）

- **用法**：在执行 Gradle 任务时附加 `--profile` 参数，如 `./gradlew assembleDebug --profile`
- **输出**：在 `build/reports/profile/` 目录下生成一个 HTML 报告
- **内容**：
  - **Summary**：总体构建时间、配置时间、任务执行时间
  - **Configuration**：配置阶段各个脚本和插件应用的耗时
  - **Task Execution**：按耗时排序的所有执行过的任务列表
- **价值**：快速定位是配置阶段慢，还是特定任务执行慢，找出耗时最长的任务

### 2. Gradle Build Scan™（--scan）

- **用法**：在执行 Gradle 任务时附加 `--scan` 参数。首次使用会提示同意服务条款并输入邮箱接收报告链接
- **输出**：一个详细的、交互式的 Web 报告
- **核心价值**（远超 `--profile`）：
  - **性能概览**：清晰的构建时间分解图（配置、依赖下载、任务执行等）
  - **任务详情**：每个任务的执行时间、结果（SUCCESS、FROM_CACHE、UP-TO-DATE、SKIPPED、FAILED）、是否可缓存、输入输出
  - **Timeline 视图**：可视化任务执行顺序和并行情况
  - **依赖分析**：详细的依赖解析过程和耗时
  - **网络活动**：依赖下载耗时和流量
  - **构建缓存分析**：缓存命中率、未命中原因、可避免的缓存（Avoidable Build Cache Misses）。**对于优化缓存配置极其有用**
  - **配置阶段分析**：详细展示脚本执行、插件应用、任务创建的耗时
  - **测试报告**：集成测试结果
  - **环境与对比**：构建环境信息，可以与历史构建进行对比
- **P8 必备**：**强烈推荐使用 Build Scan** 进行深入、全面的构建性能分析和问题诊断

### 3. Android Studio Build Analyzer

- **位置**：Build -> Build Analyzer
- **功能**：自动分析构建输出，识别出耗时较长的任务和可能存在问题的插件（如未增量的注解处理器），并提供一些优化建议（如启用非传递 R 类、迁移到 KSP）
- **价值**：作为日常开发中的快速检查工具，提供一些常见问题的线索

---

## 三、核心优化技术：为构建加速

掌握并应用以下技术是提升 Gradle 构建速度的关键。

### 1. Gradle Daemon（守护进程）

- **原理**：在后台保持一个 Gradle 进程运行，避免每次构建都重新启动 JVM 和加载 Gradle 类，显著减少构建启动时间
- **配置**：默认启用。确保 `gradle.properties` 中 `org.gradle.daemon=true`
- **检查**：使用 `./gradlew --status` 查看 Daemon 状态

### 2. 并行执行（Parallel Execution）

- **原理**：在多模块项目中，如果模块间没有依赖关系，Gradle 可以并行执行它们内部的任务，充分利用多核 CPU
- **配置**：在 `gradle.properties` 中设置 `org.gradle.parallel=true`
- **前提**：项目模块划分合理，依赖关系清晰

### 3. 配置缓存（Configuration Cache）—— 重量级优化

- **原理**：缓存**配置阶段**的结果（任务图、任务配置）。如果构建脚本和相关输入（如 `gradle.properties`）没有变化，后续构建直接加载缓存的任务图，**完全跳过**配置阶段的脚本执行
- **配置**：在 `gradle.properties` 中设置 `org.gradle.configuration-cache=true`
- **效果**：**极大缩短**大型多模块项目的构建**启动时间**（特别是对于 UP-TO-DATE 或小改动后的构建）
- **挑战与实践**：
  - **兼容性**：需要项目使用的所有插件和自定义任务都**兼容**配置缓存。不兼容的任务（如在执行阶段访问 Project 对象）会导致缓存失效或构建错误
  - **迁移**：可能需要更新插件版本、修改自定义任务或构建脚本来解决兼容性问题。**使用 Build Scan 是诊断配置缓存问题的最佳方式**，它会明确指出不兼容的原因
  - **状态管理**：Gradle 需要序列化任务执行所需的状态。确保任务状态可序列化
  - **投入产出比**：对于大型项目，投入时间解决兼容性问题以启用配置缓存，通常**回报巨大**

### 4. 构建缓存（Build Cache）

- **原理**：缓存**可缓存任务**的输出。当任务的输入（源码、依赖、参数等）与之前某次构建完全相同时，直接从缓存中恢复输出，跳过任务执行
- **配置**：在 `gradle.properties` 中设置 `org.gradle.caching=true`（默认已开启本地缓存）
- **本地缓存**：存储在用户目录（`~/.gradle/caches/build-cache-1`）。对本机重复构建、切换分支有加速作用
- **远程缓存（Remote Build Cache）—— 团队协作的关键**：
  - **机制**：将构建缓存上传到一个共享的远程存储（如公司内建的 HTTP/S3 服务器、Gradle Enterprise Cache Node）。团队成员和 CI 服务器可以共享缓存结果
  - **配置**：在 `settings.gradle(.kts)` 中配置 `buildCache` 块，指定远程缓存类型、URL、凭证等
  - **效果**：极大提升团队整体构建速度，开发者可以利用 CI 或其他同事已经生成的缓存
- **关键**：任务必须正确声明输入输出才能被缓存。Build Scan 可以分析缓存命中率和未命中原因

### 5. 增量编译（Incremental Compilation）

- **Java**：Javac 本身支持增量编译，Gradle 默认利用
- **Kotlin**：Kotlin Gradle Plugin 也支持增量编译。确保使用的是较新版本。有时复杂的类型推断或模块间依赖可能破坏增量性，需要关注

### 6. 增量注解处理（Incremental Annotation Processing）—— 常见痛点

**KAPT：**

- **问题**：KAPT 通过生成 Java Stubs 来让 Java 注解处理器处理 Kotlin 代码。这个过程通常**不支持精确的增量处理**，并且会**禁用**该模块的 Java 和 Kotlin 增量编译。即使用了 KAPT，该模块很可能在每次构建时都被完全重新编译
- **影响**：严重拖慢构建速度，尤其在使用了多个 KAPT 依赖的模块中

**KSP（Kotlin Symbol Processing）：**

- **优势**：Google 官方推出，作为 KAPT 的替代品。它是一个直接作用于 Kotlin 编译器前端的 API，理解 Kotlin 代码结构
  - **更快**：通常比 KAPT 快得多
  - **支持增量**：如果 Annotation Processor 本身支持 KSP 的增量模式，KSP 可以实现真正的增量注解处理
  - **不破坏 Kotlin/Java 增量编译**：KSP 的运行不影响模块自身的增量编译
- **迁移**：**强烈建议将项目中的 KAPT 依赖迁移到 KSP**。检查你使用的库（Dagger/Hilt、Room、Moshi、Glide 等）是否提供了 KSP 支持
- **效果**：迁移到 KSP 通常能带来显著的构建速度提升

---

## 四、优化依赖管理

依赖的数量和解析方式也会影响构建性能。

1. **implementation 与 api**：坚持使用 `implementation`，除非绝对必要（模块的公开 API 暴露了依赖库的类型）。减少不必要的传递依赖可以加快编译速度并改善缓存命中率

2. **固定依赖版本**：**避免使用动态版本**（`+`、`latest.release`、版本范围）。使用明确的版本号（如 `1.2.3`）。动态版本会强制 Gradle 在每次构建时（或按一定策略）检查网络获取最新版本，破坏了构建的确定性和缓存有效性，还可能引入兼容性问题

3. **版本目录（Version Catalogs）**：使用 `libs.versions.toml` 文件集中管理所有依赖的坐标和版本。提高可维护性、一致性，并与 IDE 良好集成

4. **依赖分析**：定期审查项目依赖，移除不再使用的库。使用 `./gradlew :app:dependencies` 查看依赖树，分析是否存在版本冲突或不必要的传递依赖

---

## 五、多模块项目特定策略

模块化本身是为了解决单体问题，但也需要特定的优化。

1. **并行执行**（`parallel=true`）：效果在多模块项目中更明显

2. **构建缓存（特别是远程缓存）**：核心收益点。可以缓存未修改模块的构建结果

3. **配置缓存**：对于模块众多的项目，配置阶段耗时可能很长，配置缓存效果显著

4. **约定插件（Convention Plugins）**：在 `buildSrc` 或独立 `includedBuild` 中创建自定义插件来统一管理各模块的通用配置（AGP 版本、SDK 版本、公共依赖、插件应用等）。极大简化各模块 `build.gradle` 文件，提高一致性和可维护性

5. **纯 Java/Kotlin 模块**：将不依赖 Android 框架的逻辑（Domain 层、工具类、数据模型）抽取到 `java-library` 或 `kotlin("jvm")` 模块，它们的编译速度比 `com.android.library` 模块快得多

---

## 六、Android Gradle Plugin（AGP）优化配置

AGP 自身也提供了一些优化选项。

1. **保持 AGP 版本更新**：Google 持续在 AGP 中进行性能优化

2. **非传递 R 类**（`android.nonTransitiveRClass=true`）：
   - **原理**：默认情况下，库模块的 R 类包含其所有传递依赖的资源 ID。开启此选项后，库模块的 R 类只包含其自身定义的资源 ID。应用模块或其他库模块需要直接依赖包含资源的库才能访问其 R 类
   - **优点**：增强了模块间的资源隔离，修改一个库的资源通常不再需要重新编译依赖它的其他库（除非是 api 依赖），**显著改善**资源相关的构建增量性
   - **实践**：**强烈推荐开启**。可能需要调整代码，确保直接依赖包含所需资源的模块

3. **关闭 Debug 构建的 PNG Crunching**：在 `buildTypes.debug` 中设置 `crunchPngs false`（旧版 AGP 用 `aaptOptions.cruncherEnabled = false`）。可以加快 debug 构建的资源处理速度。Release 构建应保持开启以优化 APK 大小

4. **优化 BuildConfig / ResValue**：如果没有使用 BuildConfig 或 resValue，可以在 `buildFeatures` 中禁用它们（`buildConfig = false`、`resValues = false`），减少代码生成

---

## 七、插件与构建逻辑考量

- **自定义任务/插件的输入输出**：如果编写自定义 Gradle Task 或 Plugin，**必须**精确声明所有输入和输出属性，以确保增量构建和构建缓存正常工作。使用 `@Input`、`@InputFile`、`@InputFiles`、`@InputDirectory`、`@OutputFile`、`@OutputDirectory`、`@Nested` 等注解

- **配置阶段与执行阶段**：明确区分哪些逻辑应该在配置阶段执行（定义任务和依赖），哪些应该在执行阶段执行（任务的实际工作）。避免在配置阶段做过多工作

- **兼容配置缓存**：编写任务和插件时，遵循配置缓存的最佳实践（如使用 Provider API 延迟计算输入值，避免在执行阶段访问 Project 对象）

---

## 八、结论：持续优化，追求极致效率

Gradle 构建优化是一个系统性且需要持续投入的工程领域。对于大型 Android 项目，它不再是「锦上添花」，而是保障团队开发效率和项目健康发展的「生命线」。显著的性能提升通常来自于对 Gradle 核心机制的深刻理解，并大胆启用和适配关键特性，特别是**配置缓存（Configuration Cache）**、**构建缓存（Build Cache，尤其是 Remote Cache）**、**并行执行**以及**从 KAPT 迁移到 KSP**。

仅仅应用配置开关是不够的，我们还需要掌握使用 `--profile` 和 `--scan` 进行性能瓶颈分析的方法论，能够解读报告并定位问题。同时，还需要在项目结构（模块化）、依赖管理（implementation、Version Catalog）、构建逻辑封装（Convention Plugins）等方面采取最佳实践。

Gradle 优化没有银弹，需要根据项目的具体情况，结合数据分析，持续迭代改进。一个快速、稳定、可靠的构建系统，是高效能研发团队的坚实基础。对 Gradle 构建系统的掌控力，是衡量资深 Android 工程师和架构师能力的重要维度。
