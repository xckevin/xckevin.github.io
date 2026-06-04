---
title: "Android Modular Communication: Route Tables and SPI Service Discovery"
lang: en
translationKey: android-modular-communication
slug: android-modular-communication
excerpt: "A practical comparison of two Android modular communication strategies: route tables and interface extraction with SPI service discovery, including implementation details and selection guidance."
publishDate: '2026-05-19'
tags:
- "Android"
- "Kotlin"
- "Modularization"
- "SPI"
- "Architecture"
seo:
  title: "Android Modular Communication: Route Tables and SPI Service Discovery"
  description: "Compare Android modular communication with route tables and interface extraction, including SPI discovery, type safety, lifecycle, and fallback design."
  pageType: article
---

Last year I took over the modularization of an ecommerce app. The project was split into 12 modules. The first hard problem was not how to split the modules, but how those modules should communicate afterward. The shell project should not directly depend on feature modules, yet the payment module needs login state from the user module, and the product module needs APIs from the search module. Almost every modularized app runs into this problem.

## The essence of the problem

The core tension in modular communication is this: **modules need to collaborate, but they cannot create direct compile-time dependencies**.

If module A directly adds `implementation` on module B, that is not real modularization. Changes in B force A to recompile, and the benefit of parallel development disappears. What you need is: A does not know B exists at compile time, but can still call B's capabilities at runtime.

There are two main schools of solutions: **routing** and **interface extraction**. The former uses URL strings as the intermediary layer. The latter uses interface abstractions to decouple compile-time dependencies.

## Routing: using URLs as the intermediary

Early modular Android projects often start with routing. The idea is straightforward: use URLs for navigation, similar to the web, and piggyback communication on top of that.

```kotlin
// Called from module A
ARouter.getInstance()
    .build("/user/getUserInfo")
    .withString("userId", "12345")
    .navigation()

// Registered in module B
@Route(path = "/user/getUserInfo")
class UserServiceImpl : UserService {
    override fun getUserInfo(userId: String): UserInfo {
        // Real implementation
    }
}
```

Routing depends on a **centralized route table**. At compile time, APT scans every class marked with `@Route` and generates a mapping from string paths to concrete classes. At runtime, dispatch is just a table lookup.

I have used this approach in two projects. The integration cost is low, and web/frontend developers can understand it quickly. Those are real advantages. But the drawbacks are just as real:

- **Strong string coupling**: a typo in the path has zero compile-time signal
- **Parameter type erasure**: passing and reading parameters relies on documentation, not compiler checks
- **Route-table growth**: maintenance cost grows linearly, and path conflicts become common in multi-person development

The deeper issue is that routing has a **one-way communication model**. A can call B, but if B needs to call back into A, it goes through routing again. Once chained calls accumulate, the code turns into string-driven control flow.

## Interface extraction: invert the dependency

Interface extraction means **move interface definitions into a common layer, keep implementations in their own modules, and wire them together at runtime through SPI**.

```
common module
|-- IUserService (interface)
`-- IOrderService (interface)

user module
|-- UserServiceImpl (implements IUserService)
`-- does not depend on order module

order module
|-- OrderServiceImpl (implements IOrderService)
|-- does not depend on user module
`-- but can call IUserService
```

The compile-time dependency direction is inverted: user and order both depend only on interfaces in the common layer, and they do not know about each other. At runtime, SPI associates interfaces with implementations.

### Three ways to implement SPI service discovery

**Google AutoService** is the lightest option. It is based on annotations plus `ServiceLoader`:

```kotlin
@AutoService(IUserService::class)
class UserServiceImpl : IUserService {
    override fun getUserInfo(userId: String): UserInfo {
        // Implementation
    }
}
```

At compile time, it generates a file under `META-INF/services/` named after the interface's fully qualified name. The file content is the implementation class's fully qualified name. `ServiceLoader` reads it during startup and completes loading.

**Gradle plugin plus bytecode injection** scans interface implementations during the transform stage and injects them directly into a registration class. Early versions of Didi's VirtualAPK used a similar approach. The advantage is avoiding reflection. The cost is maintaining a Gradle plugin.

**APT-generated registration code** is my preferred option. It generates factory classes at compile time, and runtime code calls them directly:

```kotlin
// Generated automatically at compile time
object ServiceRegistry {
    private val services = mapOf(
        IUserService::class.java to UserServiceImpl(),
        IOrderService::class.java to OrderServiceImpl()
    )
    
    fun <T> get(cls: Class<T>): T = services[cls] as T
}
```

## Three unavoidable decisions in real projects

When landing interface extraction in a project, there are three decisions you need to make explicitly.

### 1. Singleton and lifecycle policy for the service registry

After interface extraction, services are usually singletons. But some scenarios need lifecycle awareness. For example, when the user logs out from the settings screen, cached user data inside `IUserService` must be invalidated.

My approach is to add an `onUserChanged()` callback to service interfaces:

```kotlin
interface IUserService : LifecycleAware {
    fun getUserInfo(userId: String): UserInfo
    override fun onUserChanged() {
        // Clear cache
    }
}
```

The Application layer iterates through all `LifecycleAware` services when login state changes and triggers the callback, without invading business modules.

### 2. Initialization order for service discovery

SPI registration must complete at the earliest stage of `Application.onCreate`; otherwise, other modules can call services during initialization and hit an NPE. But fully loading `ServiceLoader` during cold start can cost dozens of milliseconds, which hurts startup-sensitive projects.

For this project, I chose the APT approach. Registration code is hardcoded into generated classes at compile time, so runtime has zero scanning cost. The trade-off is that adding a new service implementation requires a rebuild. In practice, services are added or removed far less frequently than business code changes, so this trade-off is acceptable.

### 3. Fallbacks when communication fails

After interface extraction, if the order module calls `IUserService.getUserInfo()` while the user module is not installed, such as in pluginized or hotfix scenarios, the caller must handle the missing service.

```kotlin
fun getUserName(userId: String): String {
    return try {
        ServiceRegistry.get(IUserService::class.java)
            .getUserInfo(userId).name
    } catch (e: ServiceNotFoundException) {
        "Unknown user" // Fallback strategy
    }
}
```

We handled fault tolerance at the `ServiceRegistry` layer by returning a Null Object or throwing an explicit `ServiceNotFoundException`. That prevents implicit NPEs from spreading through the call chain and becoming hard to diagnose.

## Routing versus interface extraction: how to choose

After seeing several projects fail in similar ways, I use a clear set of criteria.

| Dimension | Routing | Interface extraction |
|------|---------|---------|
| Type safety | Weak; runtime validation | Strong; compile-time validation |
| Integration cost | Low; annotation plus path | Medium; requires a shared interface layer |
| Traceability | Poor; references rely on string search | Good; IDE navigation works directly |
| Module decoupling | Medium | Strong |
| Performance | Path matching has overhead | Close to direct calls |

**My position is clear: prefer interface extraction.** Not because routing is bad, but because routing solves a limited problem. It was designed for page navigation, and using it as a service-communication mechanism pushes it beyond its responsibility. Routing should handle page navigation. Interface extraction should handle service communication. That division is cleaner.

If your project has fewer than five modules, a small team, and little sensitivity to compile speed, routing can still work. Architecture selection is not about chasing novelty. It is about matching the current engineering complexity and the team's maintenance capacity.

One useful rule of thumb: when the common layer has more than 20 interfaces, split it by domain, such as `common-user` and `common-order`. Otherwise, the common layer grows into a second shell project.

There is no silver bullet for modular communication. Routing uses strings as the intermediary. Interface extraction uses abstractions as the intermediary. The important difference is whether that intermediary is resolved dynamically or compiled statically, and that choice directly determines future maintenance cost and debugging experience.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Engineering](/en/android-engineering/)
- [Android CI/CD quality gates: build, test, lint, performance, and release checks](/en/blog/android-ci-cd-quality-gates/)

<!-- /seo-internal-links -->
