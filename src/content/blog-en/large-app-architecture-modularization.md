---
title: "Large App Architecture Evolution and Modularization"
lang: en
translationKey: large-app-architecture-modularization
slug: large-app-architecture-modularization
excerpt: "A practical guide to evolving large Android apps from monoliths toward modularized and componentized architectures with better ownership, builds, testing, and delivery."
publishDate: 2025-10-11
tags:
- "Android"
- "Architecture"
- "Modularization"
- "Componentization"
seo:
  title: "Large Android App Architecture and Modularization Practice"
  description: "Design large Android apps with modularization, componentization, routing, DI, Gradle dependency management, build optimization, and testing."
  pageType: article
---
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

## 4. Componentization: Extending Modularization Toward Independent Runtime

Componentization can be seen as an advanced form or target state of modularization. It is not only about splitting code into different modules. It emphasizes treating those modules as components that can be developed, tested, and even run independently.

1. **Core idea:** every component, usually a Feature module, should be able to run independently and also be assembled into the host app.

2. **Key practices**
   - **API/Implementation separation:** functionality exposed by a component is strictly defined through interfaces, usually placed in a separate `:api` module, while implementation details remain internal in an `:impl` module. Consumers depend only on the `:api` module.
   - **Programming to interfaces:** interactions between components should go through interfaces as much as possible.
   - **Dependency injection:** dependencies inside a component, such as Repository or Context, are injected from outside through a DI container instead of being created internally.
   - **Independent runtime capability, or Debug App:** create a small application module for each component. This Debug App depends only on the component and the necessary Core modules. It lets the component be compiled, run, and tested alone, greatly improving development and debugging efficiency.
   - **Lifecycle management:** the component's own lifecycle must be coordinated with the host environment lifecycle, such as the Application lifecycle.

## 5. Routing and Communication

After modularization, Activity navigation and direct method calls that used to be simple are no longer straightforward.

1. **Challenge:** Feature A cannot directly reference Activity or Service classes inside Feature B.

2. **Solution: router frameworks**
   - **Examples:** ARouter from Alibaba, WMRouter from Meituan Dianping, TheRouter from Huolala, CC from JD, and others. Their implementations differ, but the core idea is similar.
   - **How it works, common pattern**
     1. **Registration:** add annotations, such as `@Route` or `@Autowired`, to externally accessible components, including Activity, Fragment, Service implementation classes, or even methods.
     2. **Compile-time processing:** an Annotation Processor scans annotations and generates mapping code or configuration files, recording the relationship between a path, such as `"/user/profile"`, and the target component class, such as `com.example.feature.profile.UserProfileActivity`.
     3. **Runtime invocation:** business code uses APIs provided by the Router framework and starts a navigation request with a path string, such as `Router.getInstance().build("/user/profile").withInt("userId", 123).navigation()`.
     4. **Lookup and execution:** the Router framework looks up the compile-time generated mapping by path, finds the target class, creates an Intent or directly calls a method, and completes the navigation or execution.
   - **Core capabilities**
     - **Page routing:** Activity and Fragment navigation.
     - **Service calls:** obtain implementations of service interfaces provided by other modules, similar to ServiceLoader but more powerful.
     - **Parameter passing and injection:** pass parameters through `withXxx()` and inject them automatically into the target page through annotations such as `@Autowired`.
     - **Interceptors:** add logic before or after routing, such as login checks, permission requests, or analytics.
     - **Fallback strategy:** define handling logic when routing fails.
   - **Considerations and selection criteria**
     - **Choose the right framework:** consider maintenance status, community activity, performance, reflection vs. generated code, ease of use, and feature completeness.
     - **Understand internals:** know whether the framework is based on compile-time code generation or runtime reflection/class loading, because this affects performance and stability.
     - **Path management:** standardize and manage a large number of route path strings to avoid conflicts and hard-coded chaos.
     - **Type safety:** path parameter passing is usually based on Bundle or primitive types and lacks compile-time type safety.
     - **Debugging:** routing issues can be difficult to debug, so teams need to understand framework logs and error handling.
     - **Compatibility with Instant Run/Apply Changes:** some APT-based frameworks may have compatibility issues with IDE hot or cold update features.

3. **Other communication approaches**
   - **Interface extraction plus DI:** define the functionality Feature B needs to expose to Feature A as an interface and place it in a Core or API module that both modules depend on. Feature B implements the interface and binds the implementation into a collection through a DI framework, such as Hilt's `@Binds` and `@IntoSet`. Feature A injects that interface collection, finds the implementation, and calls it. This is more type-safe, but may introduce more interfaces and DI configuration.
   - **BroadcastReceiver:** suitable for one-to-many event notifications, but it is loosely coupled, weak at data passing, hard to trace, and **not recommended** as a regular inter-module communication or navigation mechanism.
   - **EventBus, such as EventBus or RxBus:** **strongly discouraged** in large modular projects. A global event bus makes data flow extremely confusing and hard to trace or debug, and it often becomes the source of difficult bugs.

## 6. Dependency Injection in Modular Architectures

DI is key to module decoupling.

1. **Challenge:** how can a module obtain the dependencies it needs, such as Repository, DataSource, or Analytics Logger, without knowing concrete implementations? How should a cross-module dependency graph be managed?

2. **Applying DI frameworks**
   - **Dagger / Hilt**
     - **Cross-module dependencies:** use Dagger's **Component Dependencies** mechanism. A downstream module's Component can depend on interfaces exposed by an upstream module's Component and obtain objects provided upstream.
     - **Aggregated contributions** (`@Binds` `@IntoSet`/`@IntoMap`): different modules can contribute interface implementations to the same global or parent Component, placing them into a Set or Map for other modules to inject and use. This is often used for plugin extension points, route table construction, and similar patterns.
     - **Hilt simplification:** Hilt simplifies modular DI setup through predefined Components and the `@InstallIn` annotation, but teams still need to understand its Component hierarchy and injection mechanism. `@EntryPoint` can be used to obtain dependencies from classes not managed by Hilt.
     - **Practice points:** design reasonable Component hierarchies and Scopes; manage Component dependencies carefully; use multibinding well; and pay attention to the build-speed impact of KAPT/KSP.
   - **Koin**
     - **Modularization support:** Koin supports loading and unloading modules through its Module DSL, with APIs such as `loadKoinModules` and `unloadKoinModules`. Different Gradle modules can define their own Koin Modules and load them together when the Application starts.
     - **Dynamism:** Koin modules can be loaded or unloaded dynamically at runtime, making it more flexible.
     - **Practical considerations:** runtime resolution cost; lack of compile-time safety checks; cross-module dependencies that are less obvious than in Dagger; and Module management in large projects.

## 7. Gradle Dependency Management

As the number of modules increases, dependency management becomes complex.

1. **api vs implementation**
   - **implementation** (default): the dependency is visible only at compile time and runtime inside the current module and is not propagated to modules that depend on it. **Advantages:** hide internal implementation details, reduce unnecessary transitive dependencies, and improve build speed because downstream modules do not need to be recompiled when upstream `implementation` dependencies change.
   - **api:** the dependency is propagated to modules that depend on the current module. **Use case:** when a module's public API, such as a class, method, or interface, directly uses types from another module, that type must be exposed through `api`. Use `api` as little as possible.

2. **Unified version management**
   - **Platform / BOM (Bill of Materials):** recommended. Add a BOM dependency that defines versions for a group of related libraries, so each library does not need its own explicit version. Example: `platform('androidx.compose:compose-bom:2024.03.00')`.
   - **Version Catalogs (`libs.versions.toml`):** recommended for Gradle 7.0+. Define all library coordinates and version aliases centrally in `gradle/libs.versions.toml` at the project root, then reference dependencies by alias in `build.gradle(.kts)`, such as `libs.androidx.core.ktx`. **Advantages:** excellent maintainability, code completion support, and easy sharing.
   - **ext block, traditional approach:** define version variables in the root `build.gradle`. It is easy to use, but less standardized than Version Catalogs.

3. **Gradle Convention Plugins**
   - **Purpose:** encapsulate common build logic into custom Gradle plugins, such as applying `com.android.library`, configuring `compileSdk`, `minSdk`, and `testOptions`, and adding common dependencies such as Kotlin stdlib and JUnit.
   - **Advantages:** avoid repeating configuration in every module's `build.gradle`; keep build configuration consistent; and make centralized updates easier. This is an essential practice for large multi-module projects.

## 8. Build Performance Optimization for Multi-Module Projects

This is one of the core benefits of modularization, but it still requires continuous attention and optimization.

1. **Use Gradle features**
   - **Configuration Cache** (`--configuration-cache`): caches configuration-phase results and greatly speeds up configuration in later builds.
   - **Build Cache** (`--build-cache`): caches task outputs and avoids rerunning unchanged tasks. Use a local cache, and consider setting up a **remote build cache** shared by the team.
   - **Parallel Execution** (`org.gradle.parallel=true`): allows multiple tasks to execute in parallel.

2. **Optimize modules themselves**
   - **Incremental compilation:** ensure code and resource changes can trigger incremental compilation.
   - **Incremental annotation processing:** use Annotation Processors that support incremental processing, and check their documentation. Prefer KSP, Kotlin Symbol Processing, over KAPT, because KSP is usually faster and has better incremental support.
   - **Reduce api dependencies:** as discussed above, `implementation` helps avoid unnecessary module recompilation.
   - **Use pure Java/Kotlin modules:** for code that does not depend on the Android framework, use `java-library` or `kotlin("jvm")` modules because they compile faster.

3. **Optimize build configuration**
   - **Configuration on demand:** Gradle already enables or no longer recommends explicitly enabling it in many cases. It configures only the projects needed for the current task.
   - **Avoid expensive work during configuration:** logic in `build.gradle` should be as simple as possible.
   - **Upgrade Gradle and AGP:** newer versions usually include performance improvements.

4. **Analyze and monitor**
   - **Gradle Build Scans** (`--scan`): upload build information to Gradle Enterprise, or a local Docker image, and get a detailed build analysis report, including task time, dependency resolution, bottleneck analysis, and more. **Strongly recommended.**
   - **Gradle Profiler** (`--profile`): generate a local HTML report to analyze task execution time.
   - **Monitor CI build time:** track build-time trends so performance regressions can be found and fixed quickly.

## 9. Testing Strategy in Modular Architectures

Modularization gives different test levels better isolation.

1. **Unit tests**
   - **Scope:** a single class or method.
   - **Advantages:** easier to implement in a modularized architecture. Pure Java/Kotlin Domain and Data modules can run quickly on the JVM. Presentation-layer ViewModels can also be tested with mocked dependencies.
   - **Practice:** use JUnit and Mockito/MockK.

2. **Integration tests**
   - **Scope:** interactions among multiple components inside one module or across modules through interfaces. For example, test the full ViewModel -> Use Case -> Repository flow.
   - **Environment:** can run on the JVM with Fake or Mock implementations for external dependencies such as databases and networking, or on Android devices/emulators if Android framework APIs are required.
   - **Practice:** use JUnit, Mockito/MockK, Robolectric for Android simulation on the JVM, and Espresso on devices.

3. **UI tests / end-to-end tests**
   - **Scope:** simulate user operations and test complete user flows, usually involving UI interaction.
   - **Advantages under modularization**
     - **Component-level UI tests:** create a Debug App for each Feature module containing only that module's UI and required dependencies, replacing other Features with Fake or Mock implementations. Run Espresso tests in this independent environment. **Advantages:** faster execution, higher stability, and stronger isolation.
     - **Full-app E2E tests:** run against the final assembled app and cover flows across multiple Features. Keep their count relatively small and focus on core paths because they are slow and flaky.
   - **Practice:** use Espresso and UI Automator. Inject Fake or Mock dependencies through DI or a dedicated Test Runner, such as using MockWebServer for network requests.

## 10. Team and Process Adaptation

Technical architecture evolution must be accompanied by changes in team structure and development process.

1. **Code ownership:** assign clear team or individual ownership by module, especially for Feature modules, to improve accountability and maintenance efficiency.

2. **Code style and review:** unified code style and strict code review are crucial for ensuring code quality across modules. Pay special attention to module API design and evolution.

3. **Branching strategy:** modularization makes feature branching more feasible and independent. Whether using Gitflow or Trunk-Based Development, the branching strategy needs to fit the modular structure.

4. **CI/CD optimization:** continuous integration and deployment pipelines can be optimized based on the scope of code changes, for example by building and testing only affected modules and their dependencies to reduce CI runtime.

5. **API contracts and communication:** inter-module interfaces, such as API modules, route paths, and data contracts, become critical contracts. API design, review, version management, and change notifications need clear processes and communication mechanisms.

6. **Technical debt management:** modularization itself can introduce new technical debt, such as router framework maintenance and DI configuration complexity. Teams need to keep watching and paying it down.

## 11. Conclusion: Architecture Evolution Never Ends

For large Android apps, moving from a monolith to modularization and componentization is the necessary path for addressing scale, improving engineering efficiency, and protecting app quality. This is not a one-time technical replacement. It is a systematic engineering evolution involving **architecture-pattern reasoning, modularization strategy tradeoffs, mastery of the technical stack including routing, DI, and the build system, and team/process coordination**.

Technical experts and leads play key roles as designers, decision-makers, and drivers in this process. They need to deeply understand the advantages, disadvantages, and suitable scenarios of each approach; make informed tradeoffs among build speed, runtime performance, code isolation, development efficiency, and type safety; master low-level technical details from Gradle optimization to advanced DI patterns and cross-module communication; and have the leadership to help the team accept change, establish standards, and continuously improve.

Modularization and componentization are not the destination. They bring new problems, such as communication complexity and dependency management challenges, that must be solved continuously. Architecture evolution is an endless loop. The goal is always to build a higher-quality software system that adapts better to future change, supports business growth, and lets developers work with less friction.
