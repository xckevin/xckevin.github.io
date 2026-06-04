---
title: "Kotlin Context Receivers: Type-Safe Implicit Contexts"
lang: en
translationKey: kotlin-context-receivers
slug: kotlin-context-receivers
excerpt: "How Kotlin Context Receivers provide type-safe implicit context injection, avoid Multiple Receivers ambiguity, and fit Android ViewModel and Compose architecture."
publishDate: '2026-01-16'
tags:
- "Kotlin"
- "Context Receivers"
- "Android"
- "Architecture"
- "Dependency Injection"
seo:
  title: "Kotlin Context Receivers: Type-Safe Implicit Contexts for Android Architecture"
  description: "Explains Kotlin Context Receivers, implicit context injection, Multiple Receivers ambiguity, and Android architecture tradeoffs."
  pageType: article
---

During an Android architecture refactor, I kept running into the same problem: functions across several layers needed shared dependency context, such as `Logger`, `AnalyticsTracker`, and `CoroutineScope`. Passing these dependencies through every function was verbose, and the type constraints were easy to lose along the way. Traditional Multiple Receivers could remove the parameters, but the implicit scope rules made code review painful. Someone always asked: "Where does this receiver actually come from?"

**Context Receivers**, introduced in Kotlin 1.6.20, were designed to solve this class of problem: type-safe implicit context. They became more stable in Kotlin 2.0 and provide a compile-time, type-driven form of dependency injection.

## The Real Problem with Multiple Receivers

Start with a typical Android example that uses the traditional receiver style to pass `Logger` and `CoroutineScope`:

```kotlin
class UserRepository {
    fun UserScope.loadUser(userId: String) {
        // Where does logger come from? Which scope is this?
        logger.log("Loading user $userId")
        launch {
            val data = fetchUser(userId)
            logger.log("User loaded")
        }
    }
}
```

Poor readability is only the surface problem. The deeper issue is that when multiple classes define a `logger` property, the compiler resolves it by nearest scope. If there is a name conflict, you get **implicit ambiguity** rather than a compiler error. No error does not mean no bug. A silently selected wrong receiver is much harder to debug than an explicit failure.

Function references are another common trap. Function types with receivers, such as `UserScope.() -> Unit`, are not compatible with ordinary lambdas. If you want to pass one as a callback, the call site must construct the matching receiver instance. That makes extension-function-style code hard to extract into reusable higher-order functions.

Scope pollution is also worth watching. `with(userScope)` exposes **all** members of `UserScope` inside the block, including methods and properties that should not be accessible there. IDE completion gets noisy, and team members may call APIs that were never intended for that layer.

## How Context Receivers Work

The syntax is small: put `context()` before the function declaration and list the required context types:

```kotlin
context(Logger, CoroutineScope)
fun loadUser(userId: String) {
    log("Loading user $userId")   // From the Logger context
    launch {                       // From the CoroutineScope context
        val data = fetchUser(userId)
        log("User loaded")
    }
}
```

At the call site, the compiler checks whether every declared context instance exists in the current scope:

```kotlin
class UserViewModel(
    private val logger: Logger,
    private val scope: CoroutineScope
) {
    fun load(userId: String) {
        with(logger) {
            with(scope) {
                loadUser(userId)  // Compiles: both contexts are in scope.
            }
        }
    }
}
```

Context Receiver resolution happens at compile time, and every context must be explicitly present in the call chain. The compiler checks each layer. If any context is missing, the call fails immediately; it will not silently use an unrelated member with the same name.

Compared with Multiple Receivers, the improvements are structural:

1. **Multiple contexts are declared as peers**: in `context(A, B)`, A and B have equal status. There is no "primary receiver" or "secondary receiver," which removes implicit priority rules.
2. **The call site has an explicit requirement**: code that calls `loadUser` must prove that both `Logger` and `CoroutineScope` are in scope. That requirement is documentation by itself.
3. **Function types compose better**: `context(Logger) () -> Unit` is a passable first-class value and is easier to combine with higher-order functions than `Logger.() -> Unit`.

## Engineering Practice in Android Architecture

A typical use case for Context Receivers is **context injection in the ViewModel layer**. You do not need Dagger/Hilt, and you do not need to thread parameters manually. Describe the dependencies directly in the function declaration:

```kotlin
class OrderViewModel : ViewModel() {
    // These are the context providers.
    private val analytics by lazy { AnalyticsTracker() }
    private val repository by lazy { OrderRepository() }
    
    fun placeOrder(order: Order) {
        with(analytics) {
            with(repository) {
                submitOrder(order)   // context(AnalyticsTracker, OrderRepository)
            }
        }
    }
}

context(AnalyticsTracker, OrderRepository)
private suspend fun submitOrder(order: Order) {
    track("order_submitted", mapOf("id" to order.id))
    repository.save(order)
    track("order_saved")
}
```

This style pays off during refactoring. If `submitOrder` later adds a `Logger` context, every call site immediately receives a compiler error and is forced to add `with(logger)`. Manually auditing dependency chains is painful; compile-time constraints point directly to the missing context.

In **Jetpack Compose**, values provided by `LocalComposition` fit naturally with Context Receivers:

```kotlin
context(LocalContextProvides)
@Composable
fun ThemedButton(text: String, onClick: () -> Unit) {
    val colors = colorScheme  // From LocalContextProvides
    Button(onClick, colors = colors.primary) {
        Text(text)
    }
}
```

Context Receivers can also implement **lightweight compile-time DI**. Define a context interface at the module boundary and inject the implementation where it is used:

```kotlin
// Defined in the domain module
interface PaymentContext {
    val paymentGateway: PaymentGateway
}

// Used in the app module
context(PaymentContext)
fun processPayment(amount: Double): Result<Transaction> {
    return paymentGateway.charge(amount)
}
```

The `domain` layer does not need to know the concrete implementation of `PaymentContext`. The `app` layer injects it at the call site. Dependency injection is completed at compile time with zero runtime overhead.

## Design Tradeoffs and Practical Boundaries

Context Receivers are not a silver bullet. In real projects, I have found several cases where they are the wrong tool.

When dependencies need to be swapped at runtime, such as selecting different implementations through feature flags, Context Receivers are a poor fit. Their binding is determined at compile time and cannot be dynamically replaced. Interface injection is still better for that scenario.

A deeply nested context chain can turn call sites into `with(a) { with(b) { with(c) { ... } } }`, which hurts readability. My rule of thumb is to keep the number of contexts to two or three. If you need more than three, wrap them in a composite context class.

There is also a real learning curve for the team. Context Receiver visibility rules are less obvious than ordinary parameters, and new team members may wonder why a function does not need arguments. I recommend a clear team rule: use Context Receivers only for **stable cross-cutting concerns across layers**, such as logging, analytics, and transactions. Do not use them to pass business objects.

For Kotlin version compatibility, Context Receivers were experimental starting in 1.6.20 and required `-Xcontext-receivers`. They entered a stable phase in Kotlin 2.0. If you maintain a library that needs backward compatibility, traditional receivers or explicit parameters are still safer today.

The real value of Context Receivers is that **implicit context dependencies become compile-time enforced constraints**. When a function signature clearly states "these are the contexts I depend on" and the compiler strictly enforces that contract, refactoring and code review become much easier. You no longer need to search through implementation code to find dependency sources; if the code does not compile, the dependency chain is wrong.
