---
title: "Large App Architecture Evolution and Modularization (1): Scaling"
lang: en
translationKey: large-app-architecture-modularization-part1
slug: large-app-architecture-modularization-part1
excerpt: "Part 1 of the large Android app architecture series, covering monolith pain points and the architecture patterns that prepare a codebase for modularization."
publishDate: 2025-10-11
displayInBlog: false
tags:
- "Android"
- "Architecture"
- "Modularization"
- "Componentization"
series:
  name: "Large App Architecture Evolution and Modularization"
  part: 1
  total: 3
seo:
  title: "Large Android App Architecture: Scaling Beyond the Monolith"
  description: "Explore why Android monoliths break down at scale and how MVVM, MVI, and Clean Architecture prepare teams for modularization."
  pageType: article
---
> This is part 1 of the three-part "Large App Architecture Evolution and Modularization" series.

## Introduction: The Inevitable Evolution Toward Scale

As business grows quickly and engineering teams expand, many successful Android apps evolve from small early projects into enormous codebases with millions of lines of code maintained by dozens or even hundreds of developers. At that scale, the once simple and effective **Monolithic Architecture** gradually exposes its inherent weaknesses and becomes a bottleneck for engineering efficiency, code quality, and product iteration speed. Build times grow dramatically, coupling becomes increasingly severe, every change feels risky, and team collaboration turns into conflict and waiting. These are the persistent nightmares of large monolithic apps.

To overcome these challenges, **architecture evolution** becomes unavoidable, and **Modularization** plus **Componentization** are the core tools for dealing with scale. Their goal is to split a huge, single codebase into smaller, more independent, and more manageable parts.

For Android experts, architects, and technical leads, the job is not merely to write feature code. It is to **identify architectural pain points, plan and drive the direction of architecture evolution, make strategic decisions among modularization approaches and technologies, and guide the team through the transition**. This requires a deep understanding of the tradeoffs behind architecture patterns, mature solutions to new modularization problems such as communication and dependency management, and the engineering ability to turn theory into practice.

This article explores the evolution of large Android app architecture in depth. It starts with the monolith problem, critically examines architecture patterns that support modularization, such as MVVM, MVI, and Clean Architecture, explains mainstream modularization and componentization strategies, including layer-based vs. feature-based slicing, routing, dependency injection, and communication mechanisms, analyzes key challenges and responses, and concludes with best practices for large teams.

## 1. The Monolithic App Nightmare: Pain at Scale

In the early stage of a project, or while the project is still small, putting all code into a single main app module is simple and direct. But as code volume and team size grow, the following pain points become increasingly obvious.

1. **Slow build times:** any tiny code change, even a resource update or logic in an obscure corner of the app, may trigger a full or broad rebuild of the entire project. Build time grows from minutes to ten-plus minutes or longer, severely damaging iteration speed and developer focus.
2. **High coupling:** without clear boundaries and dependency constraints, code from different features and business layers can reference each other freely and become tangled. Changing one feature easily causes unexpected side effects and breaks seemingly unrelated areas. The code becomes hard to understand, maintain, and refactor, and technical debt accumulates into an unmanageable pile.
3. **Difficult testing:** unit tests become difficult or superficial because dependencies are complex and hard to mock. Integration test boundaries are hard to define. UI automation tests become extremely slow and flaky because they need to build the entire app and run in a complex environment. Without effective test coverage, code quality is hard to guarantee and release risk increases sharply.
4. **Team conflicts and bottlenecks:** multiple teams or developers modify the same huge module at the same time, causing frequent merge conflicts and accidental overwrites. Development parallelism is low, teams need heavy coordination, and people may end up waiting for each other. Code ownership is vague and responsibility is unclear.
5. **Slow feature delivery:** new features often require careful threading through complex existing code, which lengthens development cycles. When multiple features are developed in parallel, code interleaving and conflicts become more serious.
6. **Onboarding difficulty:** new developers face a huge codebase without a clear structure. They need a long time to understand the overall logic and hidden dependency relationships, making it hard to contribute quickly.

When these problems seriously block business development and team efficiency, architecture upgrades become urgent.

## 2. Architecture Patterns: The Foundation Before Modularization

Before large-scale module splitting, a good **inside-the-module** architecture pattern is the foundation. These patterns help separate concerns within a smaller scope, improve testability and maintainability, and prepare the codebase for later modularization.

1. **MVP/MVC (Model-View-Presenter / Model-View-Controller)**
   - **Limitations:** the Presenter or Controller can easily take on too many responsibilities and become a Massive Presenter or Massive Controller. The View and Presenter/Controller often have strong bidirectional dependencies and many interface definitions, producing substantial boilerplate. In modern Android development, especially for large and complex screens, these patterns are less often the first choice.
2. **MVVM (Model-View-ViewModel)**
   - **Strengths**
     - Clear separation of concerns: the View, such as Activity or Fragment, handles UI rendering and forwards user input. The ViewModel handles business logic and state management and exposes the data the View needs. The Model layer handles data acquisition and storage.
     - Strong testability: the ViewModel does not directly depend on the View, usually exposing state through LiveData or StateFlow, so it can be unit tested independently.
     - Deep integration with Jetpack components: ViewModel has built-in lifecycle handling through `viewModelScope`; LiveData or StateFlow/SharedFlow can build reactive UI data streams. Data Binding can further reduce View-layer boilerplate.
   - **Considerations and challenges**
     - **ViewModel bloat:** if a ViewModel takes on too much business logic, data transformation, and state aggregation, it still becomes large and hard to maintain. Introducing Use Cases or Interactors from Clean Architecture can further split the logic.
     - **Model layer definition:** the responsibilities of the Model layer need to be clear. A Repository pattern is commonly used to encapsulate data sources such as network, database, and cache, and it may include Domain-layer entities.
     - **UI state management:** for complex screens, managing multiple LiveData or StateFlow objects in a ViewModel and their relationships can become complex. State aggregation and event handling patterns, such as SingleLiveEvent or Channel/SharedFlow, need to be considered.
     - **Lifecycle awareness:** make full use of `viewModelScope` for coroutine management so asynchronous work is canceled correctly when the ViewModel is destroyed.
3. **MVI (Model-View-Intent)**
   - **Core idea:** Unidirectional Data Flow, immutable state, and Intents that represent user operations or events. The View observes a single State stream and wraps user actions as Intents, sending them to the handling logic, usually a ViewModel or similar role. The handling logic computes a new State from the Intent and current State, then flows it back to the View.
   - **Strengths**
     - **Predictable state:** because state is single and immutable, and the data flow is unidirectional, state changes are easier to trace and debug.
     - **Complex state management:** it is especially suitable for screens with complex state transition logic.
     - **Functional style:** it encourages pure functions for state changes, often called reducers, which are easy to test.
   - **Considerations and challenges**
     - **Boilerplate:** compared with MVVM, MVI usually requires more boilerplate classes such as State, Intent, and Effect or SideEffect.
     - **Library and implementation choices:** there are many MVI implementations, such as Orbit MVI, libraries used by TIVI, or in-house frameworks. Teams need to choose based on familiarity and project requirements.
     - **Side-effect handling:** elegantly handling asynchronous work, navigation, Toasts, and other side effects is a key point in MVI practice, usually through a separate SideEffect stream or dedicated operators.
     - **State granularity:** for extremely complex screens, a single huge State object may no longer be appropriate. State splitting or local state management may be needed.
     - **Learning curve:** teams used to traditional MVVM need time to learn and adapt.
4. **Clean Architecture - a guiding principle**
   - **Core idea:** separate concerns through layers and emphasize the **Dependency Inversion Principle** and the **Dependency Rule**: source code dependencies must point inward, toward more stable and abstract layers.
   - **Typical layers, adjustable in practice**
     - **Entities:** enterprise-wide business objects and rules. This is the most central and stable layer.
     - **Use Cases / Interactors:** application-specific business logic that orchestrates entities and data access. This belongs to the Domain layer.
     - **Interface Adapters:** responsible for data format conversion. This includes Presenters/ViewModels and Gateways, such as Repository interface implementations.
     - **Frameworks & Drivers:** the outermost layer, containing concrete implementation details such as UI, databases, network frameworks, and device APIs.
   - **Value**
     - **Framework independence:** the core Domain layer, including Entities and Use Cases, does not depend on the Android framework. It can be a pure Java/Kotlin module and is very easy to unit test.
     - **Testability:** layers are decoupled through interfaces, making them easy to mock and test.
     - **Clear boundaries:** it forces explicit boundaries between layers with different responsibilities.
     - **Maintainability and replaceability:** changes in lower-level implementations, such as databases or networking libraries, are less likely to affect core business logic.
     - **Foundation for modularization:** Clean Architecture's enforced layering and dependency rules are an ideal foundation for effective modularization, especially when extracting the Domain layer into independent modules.
   - **Practical considerations:** how to map theoretical layers to Android practice, such as where Activity/Fragment belongs and what role ViewModel plays; how to define interfaces, or ports, and implementations, or adapters, between layers; how to assemble layers through dependency injection; and how to avoid overengineering while balancing purity with engineering pragmatism.

**Diagram: Clean Architecture dependencies**

```plain
+-------------------------------------------------------------------+
| Frameworks & Drivers (Outer Layer)                              |
| +-----------------+   +-----------------+   +-----------------+ |
| |       UI        |   |    Database     |   |     Network     | | (Details, Concrete Implementations)
| | (Activity/Frag) |   | (Room/SQLite)   |   | (Retrofit/OkHttp)| |
| +-------+---------+   +--------+--------+   +--------+--------+ |
+---------|----------------------|----------------------|---------+
          |                      |                      | Depends On Interfaces
          V                      V                      V
+-------------------------------------------------------------------+
| Interface Adapters (Middle Layer)                               |
| +-----------------+   +---------------------------------------+ |
| | ViewModels /    |   |         Repository Implementations      | | (Data Conversion, Interface Implementation)
| | Presenters      |   | (Implements Data Port defined in Domain)| |
| +-------+---------+   +------------------+--------------------+ |
+---------|---------------------------------|---------------------+
          |                                 | Depends On Use Cases / Entities
          V                                 V
+-------------------------------------------------------------------+
| Use Cases / Interactors (Inner Layer - Domain)                  |
| +-------------------------------------------------------------+ |
| |           Application Specific Business Logic             | | (Orchestrates Entities and Data Ports)
| |           (Defines Data Ports / Repository Interfaces)    | |
| +---------------------------------+---------------------------+ |
+-----------------------------------|-----------------------------+
                                    | Depends On Entities
                                    V
+-------------------------------------------------------------------+
| Entities (Innermost Layer - Domain)                             |
| +-------------------------------------------------------------+ |
| |             Enterprise Wide Business Objects & Rules        | | (Most Stable, Abstract)
| +-------------------------------------------------------------+ |
+-------------------------------------------------------------------+

<---------- DEPENDENCY RULE: Arrows point inwards -------------->
```

---

> In the next article, we will discuss "Modularization Strategy: The Art of Splitting the App."

**"Large App Architecture Evolution and Modularization" Series**

1. **Introduction: The Inevitable Evolution Toward Scale** (this article)
2. Modularization Strategy: The Art of Splitting the App
3. Componentization: Extending Modularization Toward Independent Runtime
