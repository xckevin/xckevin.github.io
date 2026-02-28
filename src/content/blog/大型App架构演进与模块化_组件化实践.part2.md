---
title: "大型 App 架构演进与模块化、组件化实践（2）：模块化策略：大卸八块的艺术"
excerpt: "「大型 App 架构演进与模块化、组件化实践」系列第 2/3 篇：模块化策略：大卸八块的艺术"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 架构
  - 模块化
  - 组件化
series:
  name: "大型 App 架构演进与模块化、组件化实践"
  part: 2
  total: 3
seo:
  title: "大型 App 架构演进与模块化、组件化实践（2）：模块化策略：大卸八块的艺术"
  description: "「大型 App 架构演进与模块化、组件化实践」系列第 2/3 篇：模块化策略：大卸八块的艺术"
---
# 大型 App 架构演进与模块化、组件化实践（2）：模块化策略：大卸八块的艺术

> 本文是「大型 App 架构演进与模块化、组件化实践」系列的第 2 篇，共 3 篇。在上一篇中，我们探讨了「引言：应对规模化的必然演进」的相关内容。

## 三、模块化策略：大卸八块的艺术

模块化的核心是将单体应用拆分成多个更小、更内聚、低耦合的Gradle模块。

1. **目标**
   - **提升编译速度**：修改某个模块，理想情况下只需要重新编译该模块及其依赖它的模块。
   - **强制代码隔离**：通过模块边界和依赖规则，限制代码的随意引用，降低耦合度。
   - **清晰化代码归属**：每个模块可以由特定团队负责。
   - **促进代码复用**：公共功能可以抽取到共享的基础模块中。
   - **支持并行开发**：不同团队可以并行开发不同的模块。
   - **实现动态化**：为动态特性（Dynamic Features）或插件化打下基础。

2. **Gradle 模块类型**
   - `com.android.library`：标准的 Android 库模块，可以包含代码、资源、Manifest 文件。是模块化的主要单元。
   - `com.android.application`：主应用模块，负责组装所有其他模块并生成最终的 APK。也可以有多个 application 模块（如用于 Instant App）。
   - `java-library` / `kotlin("jvm")`：纯 Java/Kotlin 模块，不依赖任何 Android 框架 API。非常适合放置 Domain 层逻辑、数据模型、纯工具类等。编译速度最快。
3. **拆分策略（Slicing Strategies）**
   - **按层拆分（Layer-Based）**
     - **结构**：通常包含 `:app`、`:presentation`（或 `:ui`）、`:domain`、`:data` 等模块。`:app` 依赖 `:presentation`，`:presentation` 依赖 `:domain`，`:domain` 依赖（或定义接口由）`:data` 实现。
     - **优点**：结构清晰，强制遵循了 Clean Architecture 的依赖规则。
     - **缺点**
       - 不同业务**功能**的代码仍然散布在各个层模块中，修改一个功能可能需要同时修改多个模块。
       - 层内部的耦合可能依然很高。
       - 如果各层模块本身依然庞大，对编译速度的改善可能有限。
       - 不利于按功能团队划分职责。
   - **按功能拆分（Feature-Based）**
     - **结构**：通常包含 `:app`、若干 `:feature:<feature_name>` 模块（如 `:feature:login`、`:feature:profile`、`:feature:search`），以及若干 `:core:<layer_name>` 或 `:common:<utility_name>` 模块（如 `:core:ui`、`:core:data`、`:core:network`、`:common:utils`）。`:app` 模块依赖所有 `:feature` 模块和 `:core` 模块。`:feature` 模块依赖它们需要的 `:core` 模块。关键在于 `:feature` 模块之间原则上不直接相互依赖。
     - **优点**
       - **高内聚**：与特定功能相关的代码（UI、ViewModel、Domain Logic、Data Access）都集中在一个模块内。
       - **职责清晰**：可以将每个 Feature 模块分配给特定团队。
       - **编译速度提升显著**：修改一个 Feature 模块通常只需要编译该模块及其少数 Core 依赖，以及最终的 `:app` 模块。可以通过配置只运行/编译特定 Feature 模块（例如用于调试）。
       - **并行开发**：不同团队可以并行开发各自的 Feature 模块。
       - **支持动态化**：Feature 模块是实现按需下载的动态特性（Dynamic Feature Module）的天然单元。
     - **缺点**
       - **模块间通信/导航**：需要引入额外的机制（如路由框架）来处理 Feature 之间的跳转和数据传递。
       - **公共模块膨胀/管理**：Core 或 Common 模块如果设计不当，可能变得臃肿，或者不同 Feature 可能需要类似但又不完全相同的功能，导致 Core 模块难以维护或出现冗余。
       - **定义边界**：如何合理地划分 Feature 边界是一个挑战。
   - **混合策略（Hybrid）**
     - **实践中最常见**：结合按层和按功能的优点。例如：
       - 抽取纯粹的、与业务无关的基础设施到 `:core:` 或 `:common:` 模块（网络、数据库、缓存、基础 UI 组件、工具类）。
       - 抽取核心的 Domain 层实体和 Use Case 接口到 `:domain:api` 或 `:core:domain` 模块（纯 Kotlin/Java）。
       - 每个业务功能实现为一个 `:feature:` 模块，其内部可能再按层划分（或简化分层），依赖 `:core:` 和 `:domain:api` 模块。
       - `:app` 模块负责组装所有 feature。

**（图示：模块化结构对比）**

```plain
(A) Monolithic                 (B) Layer-Based                 (C) Feature-Based (Hybrid Example)

+----------------------+      +----------------------+      +----------------------+
|         App          |      |         App          |      |         App          |
| (All Code & Res)     |      +----------+-----------+      +----------+-----------+
+----------------------+                | Depends On                  | Depends On (Features & Core)
                                        V                           /       |       \
                             +----------------------+                /        |        \
                             |   :presentation    |               V         V         V
                             +----------+-----------+      +-----------+ +-----------+ +-----------+
                                       | Depends On         | :feature: | | :feature: | | :feature: |
                                       V                    |   Login   | |  Profile  | |   Feed    |
                             +----------------------+      +-----+-----+ +-----+-----+ +-----+-----+
                             |      :domain       |            |           |           | Depends On (Core/Domain API)
                             +----------+-----------+            \          |          /
                                       | Depends On (Interfaces)  \         |         /
                                       V                           V        V        V
                             +----------------------+      +-----------+ +-----------+ +-----------+
                             |       :data        |      |  :core:ui | | :core:data| | :domain:api|
                             +----------------------+      +-----------+ +-----------+ +-----------+
                                                                   \          |          /
                                                                    \         |         /
                                                                     V        V        V
                                                             +-----------------------------+
                                                             | :common:utils, :core:network| ...
                                                             +-----------------------------+
```

---

> 下一篇我们将探讨「组件化：模块化的延伸与独立运行」，敬请关注本系列。

**「大型 App 架构演进与模块化、组件化实践」系列目录**

1. 引言：应对规模化的必然演进
2. **模块化策略：大卸八块的艺术**（本文）
3. 组件化：模块化的延伸与独立运行
