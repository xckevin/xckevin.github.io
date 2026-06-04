---
title: "Large App Architecture Evolution and Modularization (2): Strategy"
lang: en
translationKey: large-app-architecture-modularization-part2
slug: large-app-architecture-modularization-part2
excerpt: "Part 2 of the large Android app architecture series, covering Gradle module types, layer-based slicing, feature-based slicing, and hybrid modularization."
publishDate: 2025-10-11
displayInBlog: false
tags:
- "Android"
- "Architecture"
- "Modularization"
- "Componentization"
series:
  name: "Large App Architecture Evolution and Modularization"
  part: 2
  total: 3
seo:
  title: "Android Modularization Strategy: Layers, Features, and Hybrid"
  description: "Learn practical Android modularization strategies, including Gradle module types, layer-based slicing, feature modules, and hybrid structures."
  pageType: article
---
> This is part 2 of the three-part "Large App Architecture Evolution and Modularization" series. The previous article covered "Introduction: The Inevitable Evolution Toward Scale."

## 3. Modularization Strategy: The Art of Splitting the App

The core of modularization is splitting a monolithic app into multiple smaller Gradle modules with higher cohesion and lower coupling.

1. **Goals**
   - **Improve build speed:** after changing one module, ideally only that module and the modules depending on it need to be rebuilt.
   - **Enforce code isolation:** use module boundaries and dependency rules to restrict arbitrary references and reduce coupling.
   - **Clarify code ownership:** each module can be owned by a specific team.
   - **Promote code reuse:** shared functionality can be extracted into common foundation modules.
   - **Support parallel development:** different teams can develop different modules in parallel.
   - **Enable dynamic delivery:** lay the foundation for Dynamic Features or plugin-style architectures.

2. **Gradle module types**
   - `com.android.library`: the standard Android library module. It can contain code, resources, and Manifest files, and is the main unit of modularization.
   - `com.android.application`: the main app module, responsible for assembling all other modules and producing the final APK. A project can also have multiple application modules, for example for Instant Apps.
   - `java-library` / `kotlin("jvm")`: pure Java/Kotlin modules that do not depend on Android framework APIs. They are very suitable for Domain-layer logic, data models, pure utilities, and similar code. They also compile the fastest.
3. **Slicing strategies**
   - **Layer-based slicing**
     - **Structure:** usually includes modules such as `:app`, `:presentation` or `:ui`, `:domain`, and `:data`. `:app` depends on `:presentation`, `:presentation` depends on `:domain`, and `:domain` depends on `:data` or defines interfaces implemented by `:data`.
     - **Advantages:** the structure is clear and enforces Clean Architecture dependency rules.
     - **Disadvantages**
       - Code for different business **features** is still scattered across layer modules, so changing one feature may require modifying multiple modules.
       - Coupling inside each layer can still be high.
       - If the layer modules themselves remain huge, build speed may not improve much.
       - It does not map well to feature-team ownership.
   - **Feature-based slicing**
     - **Structure:** usually includes `:app`, multiple `:feature:<feature_name>` modules, such as `:feature:login`, `:feature:profile`, and `:feature:search`, and several `:core:<layer_name>` or `:common:<utility_name>` modules, such as `:core:ui`, `:core:data`, `:core:network`, and `:common:utils`. The `:app` module depends on all `:feature` modules and `:core` modules. Each `:feature` module depends on the `:core` modules it needs. The key rule is that `:feature` modules should generally not directly depend on each other.
     - **Advantages**
       - **High cohesion:** code related to a specific feature, including UI, ViewModel, Domain Logic, and Data Access, is concentrated in one module.
       - **Clear responsibility:** each Feature module can be assigned to a specific team.
       - **Significant build-speed improvement:** changing one Feature module usually only requires rebuilding that module, a small number of Core dependencies, and the final `:app` module. You can also configure the project to run or compile only a specific Feature module for debugging.
       - **Parallel development:** different teams can develop their own Feature modules in parallel.
       - **Dynamic delivery support:** Feature modules are a natural unit for on-demand Dynamic Feature Modules.
     - **Disadvantages**
       - **Inter-module communication and navigation:** additional mechanisms, such as routing frameworks, are needed to handle navigation and data passing between Features.
       - **Core/Common module bloat and management:** if Core or Common modules are poorly designed, they may become bloated. Different Features may also need similar but not identical functionality, making Core modules hard to maintain or causing redundancy.
       - **Boundary definition:** deciding how to draw reasonable Feature boundaries is difficult.
   - **Hybrid strategy**
     - **Most common in practice:** combine the advantages of layer-based and feature-based approaches. For example:
       - Extract pure business-agnostic infrastructure into `:core:` or `:common:` modules, such as networking, databases, caches, base UI components, and utilities.
       - Extract core Domain-layer entities and Use Case interfaces into `:domain:api` or `:core:domain` modules, usually pure Kotlin/Java.
       - Implement each business feature as a `:feature:` module. Internally, it may still be organized by layers, or use a simplified layering model, and depend on `:core:` and `:domain:api` modules.
       - Let the `:app` module assemble all features.

**Diagram: modular structure comparison**

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

> In the next article, we will discuss "Componentization: Extending Modularization Toward Independent Runtime."

**"Large App Architecture Evolution and Modularization" Series**

1. Introduction: The Inevitable Evolution Toward Scale
2. **Modularization Strategy: The Art of Splitting the App** (this article)
3. Componentization: Extending Modularization Toward Independent Runtime
