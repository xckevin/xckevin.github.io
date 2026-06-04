---
title: "Kotlin Value Classes and Inline Classes: Zero-Overhead Type Safety"
lang: en
translationKey: kotlin-value-class-inline-class
slug: kotlin-value-class-inline-class
excerpt: "A deep dive into Kotlin inline class and value class compilation, boxing elimination, JVM signatures, Android performance patterns, and serialization compatibility."
publishDate: '2026-01-23'
tags:
- "Kotlin"
- "Android"
- "Performance Optimization"
- "Compiler Internals"
- "Memory Optimization"
seo:
  title: "Kotlin Value Classes: Boxing Elimination and Zero-Overhead Types"
  description: "Understand how Kotlin value classes remove boxing, reshape JVM signatures, improve Android type safety, and affect Compose and serialization."
  pageType: article
---

Last month I investigated a memory issue where Android Profiler showed `UserId` instances occupying about 3 MB of heap. In the code, `UserId` was only a wrapper around `String`, but in a hot allocation path every wrapper still carried a real object header. Changing the wrapper from a regular `class` to a `value class` cut that memory by about 80%. The change was so small that I suspect many teams never notice how much it can buy them.

## What inline class Actually Does

Kotlin 1.3 introduced inline classes as a compile-time transformation. You write this:

```kotlin
@JvmInline
value class UserId(val value: String)
```

At the JVM bytecode level, the compiler applies a simple strategy: replace the wrapper with the underlying type whenever it safely can. For `UserId("abc123")`, the compiler passes `"abc123"` directly at the call site and does not create a `UserId` object.

Inlining is not unconditional. When `UserId` is used as a generic argument, nullable type, or interface type, the compiler falls back to boxing and creates a real wrapper object. The same `value class` can be fully inlined in `fun process(uid: UserId)`, while every element in `List<UserId>` may still carry an object header.

If your type mostly appears inside collections and generic APIs, the benefit of inline classes shrinks quickly. That is the first question to answer before introducing them.

## What the Compiled Output Really Looks Like

Decompile a small example with `javap -c`, and the result is clear:

```kotlin
// Source
value class Password(val value: String)

fun verify(pwd: Password): Boolean {
    return pwd.value.length > 8
}
```

The compiled bytecode method signature becomes:

```java
public static final boolean verify-GBZ80Ow(String pwd)
```

The `-GBZ80Ow` suffix is Kotlin's name mangling to avoid JVM signature conflicts. The parameter type is directly `String`; there is no wrapper class. The caller also passes a `String` directly, so the runtime overhead is zero.

Interfaces are different:

```kotlin
interface Validator {
    fun validate(input: Password): Boolean
}
```

Inside interface method signatures, `Password` must be boxed because the JVM cannot express Kotlin's mangled inline-class calling convention there. Each call across that boundary can allocate a `Password` object. This is the largest limitation of inline classes: the cost cannot always be eliminated across interface boundaries.

## Zero-Overhead Type Safety

The most underrated value of inline classes is not performance. It is type safety. Consider a common API:

```kotlin
fun transfer(from: String, to: String, amount: String)
```

Everything is a `String`, so the compiler cannot distinguish an account ID from an amount. A call like `transfer(amount, from, to)` can slip into production. Replace raw strings with value classes:

```kotlin
value class AccountId(val value: String)
value class Amount(val value: BigDecimal)

// Compile-time behavior: arithmetic and comparison with other numeric types still require explicit operator extensions.
fun transfer(from: AccountId, to: AccountId, amount: Amount)
```

Swap one parameter and compilation fails. A runtime bug becomes a compile-time error, while the runtime representation remains the underlying type.

In real projects I use this pattern to build a domain primitives layer:

```kotlin
value class Email(val value: String) {
    init { require(value.contains("@")) }
}

value class OrderId(val value: Long)
```

Replacing raw `String` and `Long` fields with these types, plus a small amount of `init` validation, keeps invalid values from entering business logic. The only cost is a few type definitions.

## Android Performance-Sensitive Patterns

### Optimizing Hot Data Classes

On Android, `data class` models are often major allocation sources. A typical network response model might look like this:

```kotlin
// Before optimization: multiple objects, including nested wrappers.
data class FeedItem(
    val id: Long,
    val authorId: Long,
    val authorName: String,
    val likeCount: Int
)
```

Extract IDs into inlineable types:

```kotlin
value class FeedId(val value: Long)
value class AuthorId(val value: Long)

data class FeedItem(
    val id: FeedId,
    val authorId: AuthorId,
    val authorName: String,
    val likeCount: Int
)
```

In scrolling lists, dozens of `FeedItem` instances can be created per frame. Avoiding two boxed `Long` wrappers per item usually does not transform frame rate by itself, but it can noticeably reduce GC pressure by removing many short-lived temporary objects.

### Compose State Management

`mutableStateOf` in Compose drives recomposition. Inline classes help in two ways:

```kotlin
value class Count(val value: Int)

var count by remember { mutableStateOf(Count(0)) }
```

First, `Count` prevents this state from being confused with other `Int` values on the screen. Second, Compose checks state changes with `equals`, and the compiled equality for an inline class compares the underlying `int` value directly instead of relying on object identity.

If `Count` appears inside `mutableStateListOf<Count>()`, the generic list causes boxing and the performance advantage disappears. That case is a tradeoff: type safety versus boxing overhead.

### Serialization Compatibility

Gson and Moshi handle value classes differently:

```kotlin
// Moshi: native support, serialized directly as the underlying type.
@JsonClass(generateAdapter = true)
value class Score(val value: Int)
// JSON -> {"score": 100}

// Gson: custom adapter required.
class ScoreAdapter : JsonSerializer<Score> {
    override fun serialize(src: Score, ...): JsonElement =
        JsonPrimitive(src.value)
}
```

In my projects I standardize on Moshi plus a custom annotation for value-class fields, so the serialization layer stays transparent to business code. Kotlin Serialization has even more native support for value classes, and I would prefer it for new projects.

## When Not to Use Them

After running into a few traps, I group poor inline-class use cases into three buckets.

**Generic-heavy data structures.** If `UserId` mostly lives in `List<UserId>` or `Map<UserId, T>`, the boxing rate approaches 100%. Inline classes still add type safety, but they do not save memory in that path. Be honest about the tradeoff.

**Public APIs that require Java interoperability.** From Java, a call to `verify(Password)` may surface as the mangled `verify-GBZ80Ow`, unless you manually specify a name with `@JvmName`. If your SDK exposes many APIs to Java callers, this friction may not be worth it.

**Deeply nested wrappers.** If `value class A(val b: B)` and `B` is also a value class, the compiler keeps unwrapping the layers. Past two levels, the cognitive overhead can outweigh the type-safety benefit.

Inline classes are not a universal optimization strategy. Their best use is type-safety enhancement at method parameter and return-value boundaries, especially when the same domain type appears repeatedly across a module boundary.

In practice, I recommend introducing them first in APIs and core domain objects. Once the team is comfortable, expand them selectively into the data layer. Wrapping every ID and primitive in one pass makes the code bulky and can slow compilation.
