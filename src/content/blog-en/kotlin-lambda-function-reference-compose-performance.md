---
title: 'Kotlin Lambda vs Function Reference: Bytecode Differences, SAM Conversion, and Compose Recomposition Pitfalls'
lang: en
translationKey: kotlin-lambda-function-reference-compose-performance
slug: kotlin-lambda-function-reference-compose-performance
excerpt: A bytecode-level look at how Kotlin's `::` function references and `{}` lambda expressions compile differently, the object allocation traps of SAM conversion, and their impact on Jetpack Compose recomposition stability and performance.
publishDate: '2026-08-12'
tags:
- Kotlin
- Jetpack Compose
- Performance Optimization
- Bytecode
- SAM
- Recomposition
seo:
  title: 'Kotlin Lambda vs Function Reference: SAM Conversion & Compose Pitfalls'
  description: Kotlin function references and lambdas differ at the JVM bytecode level. See how SAM conversion and Compose recomposition turn those differences into pitfalls.
  pageType: article
---

A few weeks ago I was debugging a janky Compose screen. I swapped a `Modifier.clickable` that took a stable argument for a wrapped function-reference form. Lint didn't complain and the logic was correct, but Layout Inspector showed recomposition counts nearly doubled. My intuition said this was most likely a reference-equality problem, so I chased it down through the bytecode and found that the Kotlin compiler really does handle `::function` and `{ function(it) }` differently — and that difference matters a lot for Compose's runtime stability checks.

## Bytecode differences between `::` and `{}`: more than syntax sugar

Take a minimal example:

```kotlin
fun greet(name: String) = "Hello, $name"

val ref: (String) -> String = ::greet
val lambda: (String) -> String = { name -> greet(name) }
```

Many people assume the two forms are equivalent. At the field-declaration level they are indeed both `(String) -> String`, but the bytecode reveals a difference. Disassembling with `javap -c` shows:

```java
// ::greet 的字节码大致等效为：
INVOKEDYNAMIC getGreet()Ljava/util/function/Function;

// lambda 的字节码大致等效为：
INVOKEDYNAMIC getLambda$1()Lkotlin/jvm/functions/Function1;
```

`::greet` uses `invokedynamic` on the JVM to call `LambdaMetafactory` and create an instance. **Specifically for the "top-level function with no captured external variables" case,** the compiler optimizes that reference into a static singleton: the same `::greet` used multiple times in different places returns the same object. But this singleton optimization **does not apply to every function reference**. If it's a member-method reference bound to a concrete instance (such as `obj::method`), it captures the `obj` receiver, so every creation produces a new object and the singleton is not reused; a function reference that captures an external local variable also cannot be reused. So the claim that "`::` is always a singleton" only holds for the top-level, non-capturing function reference case and cannot be generalized to all `::` syntax.

Lambda expressions are different:

```kotlin
val a = { name: String -> greet(name) }
val b = { name: String -> greet(name) }
println(a === b) // false
```

Every `{ name -> greet(name) }` creates a new anonymous class instance. Even if the logic is identical and it captures no external variables, the `===` check is always `false`.

There's a subtlety here, though: a lambda that captures no external state is optimized by the Kotlin compiler into a static singleton, behaving just like `::function`. For example, `val noCapture: () -> String = { "Hello" }` — a lambda with no parameters and no external references — is created only once by the compiler. I only remembered this after getting burned: I once used a non-capturing lambda as a callback in a `RecyclerView.Adapter`, and multiple items ended up sharing the same instance. It took me a while to figure out the compiler's "helpful" optimization was the cause.

## SAM conversion: the rule is simple, the pitfalls are in the details

Kotlin's adaptation of Java SAM interfaces is another area that's easy to confuse with function references:

```kotlin
val clickListener = View.OnClickListener { view -> greet(view.toString()) }
```

The compiler generates bytecode roughly like this:

```java
new View.OnClickListener() {
    public void onClick(View view) {
        greet(String.valueOf(view));
    }
}
```

Every SAM conversion `new`s a fresh object. This differs from Kotlin lambdas — a Kotlin lambda that captures no state can be optimized into a singleton, but SAM conversion does not take that optimization path.

The problem gets subtler when a function reference is assigned to a SAM interface:

```kotlin
class MyView {
    fun setup() {
        val listener: View.OnClickListener = View.OnClickListener(::handleClick)
        // 每次 setup() 调用都会 new 一个 OnClickListener
    }

    private fun handleClick(view: View) {}
}
```

`::handleClick` is itself a singleton `Function` reference, but wrapping it into an `OnClickListener` produces a new object every time. In other words: even when a function reference is a singleton, assigning it to a SAM interface type still causes an allocation.

A bit of bytecode study or a look at the Bytecode tool window reveals this rule, but in day-to-day coding we rarely bother to verify it. I've seen people in projects write `RecyclerView.ViewHolder` click listeners as `itemView.setOnClickListener(::onItemClick)`, thinking this reuses the instance — when in fact every bind is `new`ing an object.

## Compose stability checks: why `::` becomes a stumbling block

The Compose compiler plugin has a set of default rules for marking parameter types as stable. For lambda-typed parameters, one of the core signals for stability is function reference equality.

```kotlin
@Composable
fun UserList(users: List<String>, onUserClick: (String) -> Unit) {
    LazyColumn {
        items(users, key = { it }) { user ->
            UserCard(
                user = user,
                onClick = { onUserClick(user) }
            )
        }
    }
}
```

In this code, even if `onUserClick` has a stable reference, the `onClick` each `UserCard` receives inside `items` is a lambda instance recreated on every recomposition. When the Compose compiler detects that the `onClick` parameter's reference changed, it triggers a recomposition of `UserCard`.

If the caller writes it like this:

```kotlin
@Composable
fun UserPage() {
    val onUserClick = remember { { user: String -> doSomething(user) } }
    UserList(users = viewModel.users, onUserClick = onUserClick)
}
```

`remember` guarantees that `onUserClick` keeps the same reference across recompositions, so `UserList`'s `onUserClick` parameter is stable. But `{ onUserClick(user) }` inside `items` still creates a new instance each time, so the child cards are still recomposed.

The function-reference form looks cleaner:

```kotlin
@Composable
fun UserPage() {
    UserList(users = viewModel.users, onUserClick = ::doSomething)
}
```

Here `::doSomething` is a top-level function reference, so it compiles to a static singleton and `===` holds across recompositions. `UserList`'s `onUserClick` parameter is indeed stable now. But the nested `onClick` inside `items` hasn't changed — when `UserList` recomposes, `{ onUserClick(user) }` is still a new lambda, so `UserCard`'s recomposition is not reduced. The outer-layer optimization doesn't penetrate to the inner layer, and recomposition counts won't meaningfully drop just from changing the syntax.

## A lambda wrapped in `remember` is the right fix

To let Compose fully skip recomposition, stability has to propagate through every layer. The `remember` at the `UserPage` level above is already correct; what's really missing is the `items` block inside `UserList`:

```kotlin
@Composable
fun UserList(users: List<String>, onUserClick: (String) -> Unit) {
    LazyColumn {
        items(users, key = { it }) { user ->
            val onClick = remember(user) { { onUserClick(user) } }
            UserCard(user = user, onClick = onClick)
        }
    }
}
```

`remember(user)` gives each `user` a lambda tied to a cache key, so recomposition of the same `user` can skip `UserCard`.

## A few practical recommendations

**Use `remember` to cache lambda instances; don't count on `::` to penetrate recomposition layers.** The singleton nature of a function reference only applies to the parameter it's directly assigned to; it can't replace `remember` along a nested chain. I've seen plenty of developers swap `remember { lambda }` for `::function` for the sake of cleaner code, only to find recomposition counts in Layout Inspector go up instead of down — a few characters saved, in exchange for a row of red highlights.

**When passing SAM interfaces to components that recompose frequently, hoist the instantiation into `remember`.** Every `OnClickListener { ... }` is a `new`; the cost of not caching it is higher than with a Kotlin lambda. This pitfall is especially visible in `LazyColumn` items, where each item's bind phase allocates a new object.

**For debugging recomposition issues, Layout Inspector is a surface-level tool; bytecode inspection is where you get a definitive answer.** Android Studio's `Tools → Kotlin → Show Kotlin Bytecode → Decompile` lets you see the `invokedynamic` and `NEW` instructions and the singleton marker directly, making the problem obvious. Rather than guessing at causes from recomposition counts, spend two minutes looking at the bytecode.

Function references and lambdas are the most frequently written Kotlin syntax in day-to-day work, but the differences in how they compile get amplified into performance problems along Compose's recomposition chain. `::function` looks noticeably cleaner than `remember { lambda }`, but the few characters you save may cost you pointless redraws of an entire list.
