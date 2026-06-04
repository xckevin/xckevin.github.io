---
title: "Large App Architecture and Modularization, Part 3: Componentization"
lang: en
translationKey: large-app-architecture-modularization-part3
slug: large-app-architecture-modularization-part3
excerpt: "Part 3 of the Large App Architecture and Modularization series: componentization as an extension of modularization, with independent development, testing, and runtime practices."
publishDate: '2025-10-11'
displayInBlog: false
tags:
- "Android"
- "Architecture"
- "Modularization"
- "Componentization"
series:
  name: "Large App Architecture Evolution and Modularization Practices"
  part: 3
  total: 3
seo:
  title: "Large App Architecture: Componentization and Independent Runtime"
  description: "Explore Android componentization as advanced modularization, covering routing, DI, Gradle dependency control, build performance, testing, and team processes."
  pageType: article
---
> This is part 3 of the three-part series "Large App Architecture Evolution and Modularization Practices." In the previous article, we discussed modularization strategy: the art of splitting a large app into manageable pieces.

## 4. Componentization: extending modularization into independent runtime

Componentization can be seen as an advanced form or target state of modularization. It is not only about splitting code into different modules; it also treats those modules as components that can be developed, tested, and even run independently.

1. **Core idea**: each component, usually a feature module, should be able to run independently and also be assembled into the host app.

2. **Key practices**
   - **API/implementation separation**: expose component capabilities strictly through interface definitions, usually placed in a dedicated `:api` module, while implementation details stay internal in an `:impl` module. Consumers depend only on the `:api` module.
   - **Program to interfaces**: interactions between components should go through interfaces as much as possible.
   - **Dependency injection**: dependencies inside a component, such as repositories and `Context`, should be injected from the outside through a DI container instead of being created internally.
   - **Independent runtime capability, or Debug App**: create a small application module for each component. This Debug App depends only on that component and the required core modules. It lets the team compile, run, and test a component independently, greatly improving development and debugging efficiency.
   - **Lifecycle management**: coordinate the component's own lifecycle with the host environment lifecycle, such as `Application`.

## 5. Routing and communication

After modularization, previously simple Activity navigation or method calls are no longer direct.

1. **Challenge**: Feature A cannot directly reference Activity or Service classes inside Feature B.

2. **Solution: router frameworks**
   - **Examples**: ARouter from Alibaba, WMRouter from Meituan Dianping, TheRouter from Huolala, CC from JD, and others. Their implementations differ, but the core idea is similar.
   - **How they work, in the common pattern**
     1. **Registration**: add annotations such as `@Route` or `@Autowired` to components that need to be accessible externally, including Activity, Fragment, Service implementations, or even specific methods.
     2. **Compile-time processing**: an annotation processor scans annotations and generates mapping code or configuration files, recording the relationship between a path such as `"/user/profile"` and a target component class such as `com.example.feature.profile.UserProfileActivity`.
     3. **Runtime invocation**: business code uses the API provided by the router framework and starts navigation through a path string, for example `Router.getInstance().build("/user/profile").withInt("userId", 123).navigation()`.
     4. **Lookup and execution**: the router framework looks up the compile-time generated mapping information by path, finds the target class, creates an Intent or directly invokes a method, and completes navigation or execution.
   - **Core capabilities**
     - **Page routing**: Activity and Fragment navigation.
     - **Service invocation**: obtain service interface implementations provided by other modules, similar to `ServiceLoader` but usually more capable.
     - **Parameter passing and injection**: pass parameters through `withXxx()` and inject them automatically into the target page through `@Autowired`.
     - **Interceptors**: add logic before or after routing, such as login checks, permission requests, and analytics.
     - **Fallback strategy**: define handling logic when routing fails.
   - **Evaluation and selection**
     - **Choose the right framework**: consider maintenance status, community activity, performance, reflection versus generated code, ease of use, and feature completeness.
     - **Understand the internals**: know whether it relies on compile-time code generation or runtime reflection and class loading, because this affects performance and stability.
     - **Path management**: standardize and manage large numbers of route path strings to avoid conflicts and hard-coding.
     - **Type safety**: route parameter passing is usually based on `Bundle` or primitive types, with limited compile-time type checking.
     - **Debugging**: routing problems can be difficult to debug, so the team needs to understand the framework's logs and error handling.
     - **Compatibility with Instant Run and Apply Changes**: some APT-based frameworks can have compatibility issues with IDE hot or cold update features.

3. **Other communication approaches**
   - **Interface extraction plus DI**: define the capabilities Feature B exposes to Feature A as interfaces, and place them in a core or API module both sides depend on. Feature B implements the interface and binds the implementation into a collection through a DI framework, such as Hilt `@Binds` and `@IntoSet`. Feature A injects that interface collection, finds the implementation, and calls it. This is more type-safe, but it can introduce more interfaces and DI configuration.
   - **BroadcastReceiver**: suitable for one-to-many event notifications, but coupling is loose, data passing is weak, and tracing is difficult. It is **not recommended** as a regular inter-module communication or navigation mechanism.
   - **EventBus**, such as EventBus or RxBus: **strongly discouraged** in large modular projects. A global event bus makes data flow extremely confusing and hard to trace or debug, and it is the root cause of many difficult bugs.

## 6. Dependency injection in modular architectures

DI is the key to module decoupling.

1. **Challenge**: how can a module obtain the dependency objects it needs, such as repositories, data sources, and analytics loggers, without knowing their concrete implementations? How should cross-module dependency graphs be managed?

2. **Using DI frameworks**
   - **Dagger / Hilt**
     - **Cross-module dependencies**: use Dagger's **Component Dependencies** mechanism. A downstream module's component can depend on interfaces exposed by an upstream module component, thereby obtaining objects provided upstream.
     - **Aggregate contributions**, such as `@Binds` with `@IntoSet` or `@IntoMap`: different modules can contribute interface implementations to the same global or parent component, placing them into a Set or Map for other modules to inject and use. This is common for plugin extension points and route-table construction.
     - **Hilt simplification**: Hilt simplifies DI setup in modular projects through predefined components and the `@InstallIn` annotation, but teams still need to understand its component hierarchy and injection mechanism. `@EntryPoint` can be used to obtain dependencies from classes not managed by Hilt.
     - **Practice points**: design reasonable component hierarchy and scopes; manage component dependencies carefully; use multibinding well; watch the impact of KAPT or KSP on build speed.
   - **Koin**
     - **Modular support**: Koin provides module loading and unloading through its Module DSL, such as `loadKoinModules` and `unloadKoinModules`. Different Gradle modules can define their own Koin modules and load them centrally during `Application` startup.
     - **Runtime flexibility**: Koin modules can be loaded and unloaded dynamically at runtime.
     - **Practical considerations**: runtime resolution overhead; lack of compile-time safety checks; less obvious cross-module dependency relationships than Dagger; module management in large projects.

## 7. Gradle dependency management

As the number of modules grows, dependency management becomes more complex.

1. **`api` versus `implementation`**
   - **`implementation`**, the default: the dependency is visible only at compile time and runtime for the current module and is not transitively exposed to modules that depend on the current module. **Benefits**: hides internal implementation details, reduces unnecessary transitive dependencies, and improves build speed because downstream modules do not need to recompile when an upstream `implementation` dependency changes.
   - **`api`**: the dependency is transitively exposed to modules that depend on the current module. **Use case**: when a module's public API, including classes, methods, or interfaces, directly uses types from another module, `api` must be used to expose those types. Use `api` as little as possible.

2. **Unified version management**
   - **Platform / BOM, or Bill of Materials**: the recommended approach. Introduce a BOM dependency that defines versions for a group of related libraries, so each library does not need its own version declaration. Example: `platform('androidx.compose:compose-bom:2024.03.00')`.
   - **Version Catalogs, or `libs.versions.toml`**: recommended for Gradle 7.0 and later. Define all library coordinates and version aliases centrally in `gradle/libs.versions.toml` at the project root, then reference dependencies by alias in `build.gradle(.kts)`, for example `libs.androidx.core.ktx`. **Benefits**: excellent maintainability, code completion support, and easy sharing.
   - **`ext` block**, the traditional approach: define version variables in the root `build.gradle`. It is easy to use, but less standardized than Version Catalogs.

3. **Gradle convention plugins**
   - **Purpose**: encapsulate common build logic in custom Gradle plugins, such as applying `com.android.library`, configuring `compileSdk`, `minSdk`, and `testOptions`, and adding common dependencies like Kotlin stdlib and JUnit.
   - **Benefits**: avoids repeated configuration in every module's `build.gradle`; keeps build configuration consistent; makes unified changes easier. This is a required practice for large multi-module projects.

## 8. Build performance optimization in multi-module projects

This is one of the core benefits of modularization, but it still requires continuous attention and optimization.

1. **Use Gradle features**
   - **Configuration Cache**, `--configuration-cache`: caches configuration-phase results and greatly speeds up configuration in subsequent builds.
   - **Build Cache**, `--build-cache`: caches task outputs and avoids rerunning unchanged tasks. Use local cache, and consider setting up a **remote build cache** shared by the team.
   - **Parallel Execution**, `org.gradle.parallel=true`: allows multiple tasks to run in parallel.

2. **Optimize modules themselves**
   - **Incremental compilation**: make sure code and resource changes trigger incremental compilation.
   - **Incremental annotation processing**: use annotation processors that support incrementality, and check their documentation. Prefer KSP, Kotlin Symbol Processing, over KAPT when possible, because KSP is usually faster and has better incremental support.
   - **Reduce `api` dependencies**: as discussed above, `implementation` helps avoid unnecessary module recompilation.
   - **Use pure Java/Kotlin modules**: for code that does not depend on the Android framework, use `java-library` or `kotlin("jvm")` modules, which compile faster.

3. **Optimize build configuration**
   - **Configuration on demand**: Gradle either enables this by default in relevant cases or no longer recommends enabling it explicitly. It configures only projects required by the current task.
   - **Avoid expensive work during configuration**: logic in `build.gradle` should be as simple as possible.
   - **Upgrade Gradle and AGP**: newer versions usually include performance improvements.

4. **Analysis and monitoring**
   - **Gradle Build Scans**, `--scan`: upload build information to Gradle Enterprise or a local Docker image to get a detailed build analysis report, including task duration, dependency resolution, and bottleneck analysis. **Strongly recommended.**
   - **Gradle Profiler**, `--profile`: generate a local HTML report to analyze task execution time.
   - **Monitor CI build time**: track build-time trends and detect performance regressions early.

## 9. Testing strategy under modular architecture

Modularization provides better isolation for tests at different levels.

1. **Unit tests**
   - **Scope**: a single class or method.
   - **Advantage**: easier under modularization. Pure Java/Kotlin domain and data modules can run quickly on the JVM. Presentation-layer ViewModels can also be tested with mocked dependencies.
   - **Practice**: use JUnit and Mockito or MockK.

2. **Integration tests**
   - **Scope**: test interactions among multiple components inside the same module or across modules through interfaces. For example, test the complete flow from ViewModel to use case to repository.
   - **Environment**: can run on the JVM with fake or mock external dependencies such as databases and network, or on Android devices and emulators when Android framework APIs are required.
   - **Practice**: use JUnit, Mockito or MockK, Robolectric for simulating Android on the JVM, and Espresso on devices.

3. **UI tests / end-to-end tests**
   - **Scope**: simulate user operations and test complete user flows, usually involving UI interaction.
   - **Advantages under modularization**
     - **Component-level UI tests**: create a Debug App for each feature module that includes only that module's UI and required dependencies, replacing other features with fakes or mocks. Run Espresso tests in this independent environment. **Benefits**: faster execution, higher stability, and stronger isolation.
     - **Full app E2E tests**: run on the final assembled app and cover flows across multiple features. Keep the number relatively small and cover only core paths, because they are slow and less stable.
   - **Practice**: use Espresso and UI Automator. Inject fake or mock dependencies through DI or a specific test runner, such as MockWebServer for network requests.

## 10. Team and process adaptation

Technical architecture evolution must be accompanied by changes in team structure and development process.

1. **Code ownership**: define clear team or individual ownership by module, especially feature modules, to improve accountability and maintainability.

2. **Code style and review**: unified code standards and strict code review are critical for cross-module code quality. Pay special attention to the design and evolution of module APIs.

3. **Branching strategy**: modularization makes feature branching more feasible and independent. Whether the team uses Gitflow or trunk-based development, the branching process needs to fit the modular structure.

4. **CI/CD optimization**: continuous integration and deployment pipelines can be optimized according to the scope of code changes. For example, build and test only affected modules and their dependencies to reduce CI runtime.

5. **API contracts and communication**: interfaces between modules, including API modules, route paths, and data contracts, become critical contracts. API design, review, version management, and change notification all need clear processes and communication mechanisms.

6. **Technical debt management**: modularization itself can introduce new technical debt, such as router-framework maintenance and DI configuration complexity. The team must keep monitoring and paying it down.

## 11. Conclusion: architecture evolution never ends

For large Android applications, moving from a monolith to modularization and componentization is the necessary path for handling scale, improving engineering efficiency, and protecting application quality. This is not a one-time technical replacement. It is a systematic engineering evolution involving **architectural pattern reasoning, modularization trade-offs, mastery of the technical stack including routing, DI, and build systems, and coordination with team process**.

Technical experts and leaders play the key roles of designer, decision maker, and driver in this process. They need to deeply understand the strengths, weaknesses, and applicable scenarios of each approach; make sound trade-offs across build speed, runtime performance, code isolation, development efficiency, and type safety; master technical details from Gradle optimization to advanced DI patterns and cross-module communication; and have the leadership required to help the team accept change, establish standards, and keep improving.

Modularization and componentization are not the endpoint. The new problems they introduce, such as communication complexity and dependency-management challenges, also need continuous resolution. Architecture evolution is an endless cycle. The goal is always to build a high-quality software system that can adapt better to future change, support business growth, and make developers more productive and satisfied.

---

**Series directory: Large App Architecture Evolution and Modularization Practices**

1. Introduction: the inevitable evolution toward scale
2. Modularization strategy: the art of splitting a large app
3. **Componentization: extending modularization into independent runtime** (this article)
