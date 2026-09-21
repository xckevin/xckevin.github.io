---
title: "Kotlin Error Handling: try-catch, Result, and Arrow Either"
lang: en
translationKey: kotlin-functional-error-handling-result-either
slug: kotlin-functional-error-handling-result-either
excerpt: "A practical comparison of try-catch, Kotlin Result, and Arrow Either for structuring error handling in Android apps."
publishDate: '2026-08-05'
tags:
- "Kotlin"
- "Android"
- "Error Handling"
- "Functional Programming"
seo:
  title: "Kotlin Error Handling: try-catch, Result, Arrow Either"
  description: "How to structure Android error handling with try-catch, Kotlin Result, and Arrow Either: visibility, composition, and recovery trade-offs."
  pageType: article
---

## Reflection Triggered by a Production Crash

Last year I investigated a strange production crash: the order submission API returned 200, but parsing the body threw a `JsonSyntaxException`. The stack trace showed the exception was swallowed in the ViewModel layer by a catch-all `catch(e: Exception)`, which displayed a generic Toast. After seeing "Operation failed," the user tapped submit three more times, and the backend created three duplicate orders.

Where did it go wrong? The catch block ate the semantics of the exception. `catch(e: Exception)` flattened every error into a single sentence, so the business layer had no idea what actually happened—was the network down, were the parameters wrong, or had the server changed its response format?

try-catch has three structural flaws in engineering projects.

**Exceptions are invisible.** The caller cannot tell from a function signature whether it may throw. `fun fetchOrder(id: String): Order` looks harmless, yet it may throw `NetworkException`, `AuthException`, or `ParseException` internally. All of this information lives in the documentation—and the documentation most likely isn't maintained. The compiler neither prompts nor checks.

**It cannot be composed.** A sequential three-step operation—fetch user info → check permissions → create an order—can fail at every step. With try-catch, nesting either creates layers of indentation hell, or one large catch erases all the differences.

```kotlin
fun processOrder(): Order? {
    return try {
        val user = fetchUser()
        if (!checkPermission(user)) return null
        createOrder(user)
    } catch (e: Exception) {
        log("操作失败: ${e.message}")
        null  // 三种不同的业务状态被统一成了 null
    }
}
```

**Recovery is difficult.** A catch block usually offers three choices—throw a new exception (polluting the call chain), return null (losing context), or return a default value (masking bugs). The caller never gets the error details.

## Kotlin Result: Turning Errors into Return Values

The core idea of `Result<T>` is to make errors part of the return value rather than a side effect of control flow. It wraps an operation result as Success or Failure, and the compiler forces the caller to handle both states.

```kotlin
suspend fun fetchOrder(id: String): Result<Order> = runCatching {
    val response = api.getOrder(id)
    if (!response.isSuccessful) {
        throw HttpException(response)
    }
    response.body()!!
}

val result = fetchOrder("12345")
result
    .onSuccess { order -> showOrder(order) }
    .onFailure { e -> handleError(e) }
```

`runCatching` is the main entry point into the Result world; it automatically catches Throwable and wraps it into the failure branch of Result. One thing to note is that `Result<T>` is an inline class and does not expose public subclasses such as `Result.Success`/`Result.Failure` that can be matched directly. Internally it only uses a `value` field to distinguish success from failure. The correct approach is to inspect and extract values through `isSuccess`/`isFailure`/`getOrNull()`/`exceptionOrNull()`/`onSuccess`/`onFailure`, rather than using a `when` expression like `when (result) { is Result.Success -> ... }`.

There is another easy-to-miss trap: `runCatching` catches **all** `Throwable`s, including a coroutine's `CancellationException`. In a coroutine context, `CancellationException` is the signal of the coroutine cancellation mechanism. If it is swallowed by `runCatching`, cancellation propagation is blocked, causing an already-cancelled task to continue running in the background or breaking the cancellation propagation chain of structured concurrency. The safe approach is to explicitly rethrow `CancellationException` at the catch site:

```kotlin
suspend fun fetchOrder(id: String): Result<Order> = try {
    Result.success(api.getOrder(id).also {
        if (!it.isSuccessful) throw HttpException(it)
    }.body()!!)
} catch (e: CancellationException) {
    throw e  // 协程取消信号必须重新抛出，不能包进 Result
} catch (e: Exception) {
    Result.failure(e)
}
```

If you still want the concise style of `runCatching`, you can wrap it in a helper function that rethrows `CancellationException` whenever it is detected internally.

Result provides a set of transformation operators that support chained composition:

```kotlin
val finalResult = runCatching { fetchRawData() }
    .mapCatching { raw -> parseToModel(raw) }   // 转换成功值，捕获异常
    .recoverCatching { e -> loadFromCache() }    // 失败时降级到缓存
    .map { model -> enrichWithMetadata(model) }  // 不再可能失败的操作
```

`mapCatching` and `recoverCatching` preserve the Result wrapper, while plain `map` only runs on Success. This API lets you compose multiple fallible operations without writing try-catch, and the error at each stage is recorded precisely.

But Result has a key limitation: the Failure branch only carries a Throwable, so it loses precision about the error type. If you need to distinguish "network unreachable" from "parameter validation failed," you have to rely on type checks such as `when (e is XxxException)`—which essentially brings you back to try-catch.

Another engineering awkwardness: before Kotlin 1.9, suspend functions were forbidden from returning `Result<T>`. Kotlin 1.9 lifted the restriction, but the IDE still warns. The official tendency is to position Result as an intermediate type within a module, and not to let it cross module boundaries.

## Arrow Either and Railway Oriented Programming

Railway Oriented Programming compares functions to track switches: the normal path is the main line, and the error path is the branch. On success, data flows along the main line; once an error occurs, it switches to the side track and all subsequent operations are skipped until the terminal handler.

Arrow's `Either<L, R>` is the Kotlin implementation of this model: `Left<L>` carries the error, and `Right<R>` carries the success value. The difference from Result is that L can be any type:

```kotlin
sealed class OrderError {
    data class Network(val cause: Throwable) : OrderError()
    data class Auth(val reason: String) : OrderError()
    data class Validation(val field: String, val msg: String) : OrderError()
}

fun fetchOrder(id: String): Either<OrderError, Order> = either {
    val response = api.getOrder(id).bind()
    ensure(response.isSuccessful) { OrderError.Network(HttpException(...)) }
    response.body()!!
}
```

The `either { }` builder combined with `bind()` is the core of the Railway implementation. `bind()` unwraps and continues on Right, and short-circuits the entire either block on Left. When multiple operations are chained, the code reads like a synchronous flow while retaining complete error-propagation semantics:

```kotlin
fun createOrderWorkflow(id: String): Either<OrderError, OrderConfirmation> = either {
    val rawOrder = fetchOrder(id).bind()           // 网络失败 → 短路
    val validated = validate(rawOrder).bind()      // 校验失败 → 短路
    val enriched = applyPromotions(validated).bind() // 规则冲突 → 短路
    submitToBackend(enriched).bind()               // 提交失败 → 短路
}
```

When any step returns Left, all subsequent bind calls are skipped and the error is passed to the caller unchanged. The caller performs unified final handling with fold:

```kotlin
when (val result = createOrderWorkflow("12345")) {
    is Either.Left -> handleOrderError(result.value)
    is Either.Right -> showConfirmation(result.value)
}
```

The engineering value of this style is that the compiler forces you to exhaust all error branches. When you add a new subclass to `OrderError`, all `when` handlers emit a compile warning—no runtime mechanism can offer that guarantee.

## Trade-offs in Practice

I have used try-catch, Result, and Either in the network layers of three projects, and my impressions are as follows.

Using try-catch directly is still the fastest way to get started. When the team is not very receptive to functional paradigms, forcing Either actually increases cognitive load. For small tools or scripts, Result is enough.

Result is suitable for use inside a module. For example, inside the Repository layer you can use `runCatching` to compose network and cache logic, then convert it into a sealed class at the boundary to expose to the upper layer. Do not let Result cross module boundaries—Kotlin's design tendencies do not encourage this, and once it crosses modules the error type information is already lost.

Either is suitable for strongly typed error scenarios. Multi-role permission systems, payment flows, and form validation chains—when error branches have clear business meaning and require fine-grained handling, Either's type precision is something try-catch cannot provide. The cost is that the team needs to understand concepts such as `either { }`, `bind()`, and `traverse`.

As for dependencies: Kotlin's standard library includes Result at zero extra cost. Arrow's `arrow-core` is around 500KB, which has a negligible APK size impact, but the learning curve is not low. If you only want the Either type without introducing Arrow, you can hand-write a minimal version:

```kotlin
sealed class Either<out L, out R> {
    data class Left<L>(val value: L) : Either<L, Nothing>()
    data class Right<R>(val value: R) : Either<Nothing, R>()
}
```

Without `bind()`, chained calls degrade into nested `flatMap`, but you still get compile-time Left/Right error hints—a guarantee try-catch can never provide.

try-catch, Result, and Either are not a progression; they solve problems at different scales. A more practical criterion is this: once you start writing `if (e is A) ... else if (e is B)` inside your catch block, it is time to upgrade. Do not introduce Either just because functional programming "looks advanced," and do not dismiss try-catch because it is "too basic"—the choice of tool depends on the constraints you face, not the tool's fame.
