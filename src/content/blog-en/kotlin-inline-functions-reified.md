---
title: "Kotlin Inline Functions and reified: Bytecode-Level Optimization"
lang: en
translationKey: kotlin-inline-functions-reified
slug: kotlin-inline-functions-reified
excerpt: "A bytecode-level look at Kotlin inline functions, noinline, crossinline, and reified generics, with practical notes for Compose and compiler optimization."
publishDate: '2026-01-26'
tags:
- "Kotlin"
- "Jetpack Compose"
- "Compiler Optimization"
- "Bytecode"
- "Generics"
seo:
  title: "Kotlin Inline Functions, noinline, crossinline, and reified"
  description: "Explore Kotlin inline functions at the bytecode level, including lambda allocation, noinline, crossinline, reified generics, and Compose usage."
  pageType: article
---

In Kotlin, every lambda you pass can cause the compiler to generate an anonymous object. One reason Compose `@Composable` functions do not collapse under heavy recomposition is that the compiler can move function bodies directly into call sites. That is what `inline` does.

But `inline` is not just about removing function-call overhead. Its effects on generic erasure, non-local returns, and bytecode size are where everyday development usually gets interesting.

## What inline Does in Bytecode

```kotlin
inline fun measureTime(block: () -> Unit) {
    val start = System.nanoTime()
    block()
    println("cost: ${System.nanoTime() - start}ns")
}

fun main() {
    measureTime { Thread.sleep(100) }
}
```

Decompile `main` with `javap -c`, and you can see the `System.nanoTime()` call and `println` logic embedded directly inside `main`. There is no method call to `measureTime`. The lambda argument `block` is expanded into the `Thread.sleep(100)` expression itself, and the anonymous function object allocation disappears.

At compile time, the function body and lambda body are pasted into the call site. At runtime, the abstraction costs nothing.

The cost is just as direct: every call site gets its own copy of the full function body. If an inline function grows large and is called frequently, dex size can increase noticeably. In one large project, removing unnecessary `inline` from hot utility methods reduced dex size by about 3%. For apps sensitive to package size, that is worth measuring.

## noinline: Keep a Lambda as an Object

An inline function inlines all lambda parameters by default. If you want to pass one lambda to another non-inline function, for example to store it as a callback, that parameter cannot be inlined. After inlining, there is no function object left to pass.

```kotlin
inline fun transaction(
    db: Database,
    noinline onComplete: () -> Unit,
    block: () -> Unit
) {
    db.beginTransaction()
    try {
        block()           // Inlined
        db.setTransactionSuccessful()
    } finally {
        db.endTransaction()
        onComplete()      // Function object is preserved and can be passed safely.
    }
}
```

With **noinline**, the compiler keeps the anonymous function object for `onComplete`, so it can be assigned to a variable or passed as a parameter. Without it, the compiler fails because it knows the thing you are referencing will not exist after inlining.

My habit in real projects is to inline the high-frequency core logic and mark side-effect callbacks as `noinline`. That is a reasonable balance between performance and control.

## crossinline: Forbid Non-Local Returns

Of the three related modifiers, `crossinline` causes the most confusion. Start with the core behavior:

```kotlin
inline fun runSafely(block: () -> Unit) {
    try {
        block()
    } finally {
        println("cleanup")
    }
}

fun main() {
    runSafely {
        return  // Returns from main, not from the lambda.
    }
}
```

Because `block` is inlined into `main`, `return` exits `main` directly. The `finally` block still runs. This is a **non-local return**, and it is an easy Kotlin feature to overlook.

When `block` is moved into another execution context, such as a coroutine or a Handler post, non-local returns no longer make sense:

```kotlin
inline fun postTask(crossinline block: () -> Unit) {
    Handler(Looper.getMainLooper()).post {
        block()  // block runs inside another lambda.
    }
}
```

You must add **crossinline** to tell the compiler that `block` will be called indirectly and must not use `return`. The compiler checks this at the call site and rejects a bare `return` immediately.

The "cross" in `crossinline` means the lambda crosses the direct call boundary of the current function and runs in another context. That maps naturally to cases such as `@Composable` recomposition scopes, where invocation context matters.

## reified: Breaking Erasure with Compile-Time Type Substitution

JVM generics are erased at runtime, so code such as `T::class.java` normally does not compile. It works only with **reified** type parameters:

```kotlin
inline fun <reified T> Gson.fromJson(json: String): T {
    return fromJson(json, T::class.java)  // Compiles
}
```

The principle is simple. After the function body is inlined, the compiler knows the concrete type argument at the call site. For `fromJson<User>(json)`, it replaces every `T` with `User` at compile time, and `T::class.java` becomes `User::class.java`. The bytecode contains no generic placeholder, only the concrete type.

With **inline + reified**, serialization and type-checking APIs can remove a lot of boilerplate. Gson and kotlinx.serialization both use this style heavily.

## The Real Battlefield in Compose

Many Compose `@Composable` helper functions are inline.

**Case 1: `rememberSaveable` and reified type lookup**

```kotlin
@Composable
inline fun <reified T : Any> rememberSaveable(
    key: String,
    crossinline init: () -> T
): T {
    val saver = autoSaver<T>()  // Infers the concrete Saver for T at compile time.
    return rememberSaveable(key, saver, init)
}
```

`autoSaver<T>()` can create the correct serializer only because `reified` preserves the real type of `T` at the call site. Without `reified`, callers would have to pass `Class<T>` manually.

**Case 2: crossinline constraints inside Composable lambdas**

`itemContent` can be passed into the `items` lambda of `LazyColumn`, which changes the invocation context. `crossinline` is not only about blocking `return`; it also helps the compiler generate correct Composer instrumentation so recomposition starts in the right composition scope.

**Case 3: inline cooperating with @Composable lowering**

Layout components such as `Row` and `Column` are inline, so calls do not allocate lambda objects. The Compose compiler plugin expands `@Composable` lambdas and rewrites them into direct calls with `$composer` parameters. During frequent recomposition, the lack of allocation pressure depends heavily on this compile-time expansion.

## When to Use It, and When to Hold Back

Before writing `inline`, ask three questions:

1. **Will this function be called frequently?** For Composable functions and collection-style utility functions, avoiding lambda allocation can pay off. For an ordinary helper called only a few times, skipping `inline` can save dex size.

2. **Does it take lambda parameters?** Without lambda parameters, function-body inlining alone usually brings little benefit. IntelliJ warns about this for a reason.

3. **Do you need reified types or non-local returns?** These are hard requirements. Without `inline`, they do not compile.

One trap I have hit: I added `inline` to a `suspend` function that returned `Result`, and compilation failed. Inline functions cannot freely call non-inline suspend functions because the coroutine state machine cannot be expanded that way. The official docs describe these boundaries, but most people only notice them after they hit one.

At its core, `inline` is a compile-time substitution tradeoff: you exchange bytecode size for runtime performance and use compile-time type information to work around JVM generic erasure. Understanding the actual bytecode behavior of `inline`, `noinline`, `crossinline`, and `reified` is far more useful than memorizing interview answers.
