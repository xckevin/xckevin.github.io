---
title: "Kotlin Contracts: Smart Casts, Type Inference, and callsInPlace"
lang: en
translationKey: kotlin-contracts-smartcast
slug: kotlin-contracts-smartcast
excerpt: "A deep dive into Kotlin Contracts, showing how returns() implies and callsInPlace help the compiler recover smart casts, variable initialization, and better type inference."
publishDate: '2026-01-20'
tags:
- "Kotlin"
- "Contracts"
- "Smart Cast"
- "Compiler"
- "Type Inference"
seo:
  title: "Kotlin Contracts: Smart Casts, Type Inference, and callsInPlace"
  description: "Learn how Kotlin Contracts use returns() implies and callsInPlace to explain function effects to the compiler and improve smart casts."
  pageType: article
---

During one code review, a reviewer asked about a snippet: "Why are you using `!!` here? Wouldn't `?.let` be safer?" I answered: we already called `requireNotNull` above, but the compiler does not recognize it. He paused, and then we both went quiet.

This is a wall every Kotlin developer eventually hits: **your logic is correct, but the compiler does not know it**.

```kotlin
fun validate(input: String?) {
    checkNotNull(input)  // Throws when null, so everything after this is non-null.
    println(input.length) // ❌ The compiler still treats input as String?.
}
```

`checkNotNull` guarantees that the value cannot be null afterward, so why does Smart Cast not kick in? The answer is a Kotlin compiler design choice: **a function boundary is a wall for type inference**. The compiler does not analyze what a called function does internally; it trusts the function signature. The signature of `checkNotNull` is `fun checkNotNull(value: Any?): Any`, so from the compiler's point of view it is just an ordinary function call. After the call, the world is unchanged.

To break through that wall, a function has to tell the compiler what it does. That is what Kotlin Contracts are for.

## What Contracts Are

Contracts are a DSL that lets functions declare their **call effects** to the compiler. The compiler uses those declarations at the **call site** to perform more precise type inference, instead of analyzing the function body.

Contracts first appeared as an experimental API in Kotlin 1.3 and became stable in 1.4. Standard library functions such as `checkNotNull`, `require`, `isNullOrBlank`, `apply`, and `run` all rely on them.

```kotlin
@kotlin.internal.InlineOnly
public inline fun checkNotNull(value: Any?): Any {
    contract {
        returns() implies (value != null)  // Tell the compiler: if this returns normally, value is non-null.
    }
    return if (value == null) throw IllegalStateException("...") else value
}
```

The declarations inside a `contract` block are **compile-time metadata**. They do not generate runtime code. When the compiler sees `checkNotNull(input)`, it updates the type information for `input` based on the contract, and Smart Cast becomes available afterward.

The core logic is straightforward: **the function author declares an effect, the compiler applies it at the call site, and the caller gets better type inference**.

## Three Core Contract Patterns

Contracts concentrate their declaration power in three areas.

### returns() implies: Conditions for Normal Return

This is the most common pattern. `returns()` means "when the function returns normally," and `implies` is followed by a boolean condition.

```kotlin
inline fun require(condition: Boolean) {
    contract {
        returns() implies condition  // Normal return means condition is true.
    }
    if (!condition) throw IllegalArgumentException("...")
}

fun doSomething(value: String?) {
    require(value is String)  // The compiler knows value is String afterward.
    println(value.length)     // ✅ Smart Cast works.
}
```

The condition can be a null check, type check, or boolean expression. `returns(null)` declares a condition for "when this function returns null," which is useful for functions such as `isNullOrBlank`.

### callsInPlace: Guarantees About Lambda Invocation Count

The phrase means the passed lambda is called in place, inside the function body. Its core meaning is to declare **how many times a lambda argument will be invoked**. It has four enum values:

| Enum value | Meaning |
|---|---|
| `AT_MOST_ONCE` | The lambda is called at most once, useful for variable-initialization inference. |
| `EXACTLY_ONCE` | The lambda is called exactly once, the strongest guarantee. |
| `AT_LEAST_ONCE` | The lambda is called at least once. |
| `UNKNOWN` | The invocation count is unknown, so no type optimization applies. |

Scope functions such as `run`, `let`, and `apply` depend on `callsInPlace`:

```kotlin
@kotlin.internal.InlineOnly
public inline fun <T, R> T.run(block: T.() -> R): R {
    contract {
        callsInPlace(block, InvocationKind.EXACTLY_ONCE)
    }
    return this.block()
}
```

Why does this matter? Consider this example:

```kotlin
fun example() {
    val x: Int
    run {
        x = 42  // ✅ Allowed because run declares that block is called exactly once.
    }
    println(x) // ✅ x is definitely initialized.
}
```

Without `callsInPlace`, the compiler treats the lambda passed to `run` as a block that might never be called, so it rejects initialization of a `val` inside that lambda. With `EXACTLY_ONCE`, the compiler knows `x = 42` definitely executes.

### Combining returns() and callsInPlace

A function can declare multiple contracts. `buildString` is a typical example:

```kotlin
@kotlin.internal.InlineOnly
public inline fun buildString(
    builderAction: StringBuilder.() -> Unit
): String {
    contract { callsInPlace(builderAction, InvocationKind.EXACTLY_ONCE) }
    return StringBuilder().apply(builderAction).toString()
}
```

Only `callsInPlace` is needed here. The function cares that `builderAction` is called exactly once; it does not need a return condition.

## Writing Your Own Contract

Custom functions can have contracts too. A real example is wrapping retry logic:

```kotlin
@OptIn(ExperimentalContracts::class)
inline fun <T> retryDefault(block: () -> T): T {
    contract {
        callsInPlace(block, InvocationKind.AT_LEAST_ONCE)
    }
    return try {
        block()
    } catch (e: Exception) {
        block()
    }
}

fun demo() {
    val result: Int
    retryDefault {
        result = 42  // ✅ AT_LEAST_ONCE guarantees result is assigned at least once.
    }
    println(result)
}
```

There are three hard constraints when writing a contract.

The `contract` block must be placed at the very beginning of the function body. Put it anywhere else and the compiler reports an error. This is a syntax-level restriction.

Contracts only work for `inline` functions. Their design depends on compile-time metadata, not runtime mechanisms. A non-inline function can contain a contract without necessarily failing compilation, but it has no useful effect at the call site because the compiler cannot propagate contract information across an ordinary function boundary.

The condition in `implies` can reference only function parameters or `this`; it cannot reference external variables. This locality is intentional and prevents uncontrolled effect propagation.

## A Real-World Limitation

I once wrote a DSL builder and wanted to use a contract to narrow the receiver type inside a lambda:

```kotlin
inline fun <T> Context.ifApiLevel(min: Int, block: Context.(Int) -> T): T? {
    contract {
        returns() implies (this@ifApiLevel is Activity)  // ❌ Does not work reliably.
    }
    if (Build.VERSION.SDK_INT >= min) return block(min)
    return null
}
```

`this@ifApiLevel` is a receiver parameter, so in theory a contract could describe it. In practice, receiver type narrowing with `is Activity` is not reliable and depends on compiler version details. `implies` supports a narrow set of conditions: `!= null`, `is` checks, and boolean combinations of those checks.

After spending time on that path, my conclusion was simple: split the function or perform the type check at the call site. Contracts have a narrower boundary than they appear to. They are not a silver bullet.

## When to Use Contracts, and When Not To

**Good use cases:**

- Utility functions that wrap `check`, `require`, or `assert` logic are natural fits for `returns() implies`.
- Custom scope functions or DSL lambdas that need the compiler to confirm variable initialization should use `callsInPlace`.
- Wrapper constructors can use `returns() implies (value != null)` to make null checks flow through the wrapper.

**Cases where contracts are unnecessary or a poor fit:**

- Ordinary business-logic functions. Contracts are designed for library authors; at the application layer, `!!` or `?.let` is usually enough.
- Trying to make the compiler "understand" complex business logic. Contracts are not a Turing-complete theorem prover, and their expression power is intentionally limited.
- Non-inline functions. There is no useful effect, so writing a contract there is wasted effort.

A practical rule: **if callers of your function often think "I already checked this, so why is the compiler still complaining?", the function is worth a contract**. Otherwise, keep it simple.

## How the Compiler Cooperates Internally

Contracts do not change Kotlin's type system itself. They operate on the compiler's **control-flow analysis** and **type-inference pipeline**.

Kotlin compiler type inference has two broad phases: first it performs local inference based on signatures without crossing function boundaries, then it performs data-flow analysis across code. Contract information is injected before the second phase. When the compiler parses a call site, it first checks whether the called function has a contract. If it does, the declared effects are merged into the current scope's type constraints. The entire process happens at compile time. There is no trace of contracts in JVM bytecode.

This also explains why contracts must be paired with inline functions: inline functions are expanded into the call site during compilation, so contract effects naturally apply to the expanded code. A non-inline function call is just an `invokevirtual` instruction, and the compiler's data-flow analysis cannot see through that wall.

## Tradeoff

Kotlin Contracts are essentially **a low-learning-cost way to give the compiler a precise understanding of function effects**. Their expression power intentionally converges on null checks and invocation count, but that is also why they do not impose much cognitive overhead.

If your standard-library-style helper leaves redundant `?.let` calls after null checks, spending five minutes adding a contract is worth it. But if you want contracts to perform more complex type narrowing, stop there. That is not what they were designed for.
