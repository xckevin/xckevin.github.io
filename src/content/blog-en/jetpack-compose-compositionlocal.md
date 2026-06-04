---
title: "Jetpack Compose CompositionLocal: Implicit Data, Scope, and Internals"
lang: en
translationKey: jetpack-compose-compositionlocal
slug: jetpack-compose-compositionlocal
excerpt: "A deep dive into CompositionLocal, including parameter tunneling, compositionLocalOf versus staticCompositionLocalOf, Slot Table internals, and engineering tradeoffs."
publishDate: '2026-05-14'
tags:
- "Android"
- "Jetpack Compose"
- "CompositionLocal"
- "Architecture"
- "UI Framework"
seo:
  title: "Jetpack Compose CompositionLocal: Implicit Data and Slot Table Internals"
  description: "Understand CompositionLocal in Compose, including provider strategies, common pitfalls, Slot Table internals, and when to use implicit context."
  pageType: article
---

While refactoring a large Compose project, I noticed that `MaterialTheme.colors` and `MaterialTheme.typography` can be accessed from Composables at any depth without passing them through every layer. This mechanism is "globally available" without being truly global. It is called `CompositionLocal`, and it is more subtle than it looks.

## The problem: parameter tunneling

When writing Compose UI, you eventually hit this pattern:

```kotlin
@Composable
fun UserProfile(user: User, theme: Theme, locale: Locale) {
    Column {
        UserAvatar(user, theme)
        UserInfo(user, locale, theme)
    }
}

@Composable
fun UserAvatar(user: User, theme: Theme) {
    // theme is only being forwarded to the next layer
    AvatarImage(user.avatarUrl, theme)
}
```

Every intermediate layer has to declare parameters it does not actually use, only so downstream Composables can access them. This is parameter tunneling. Once the parameter list grows past five or so entries, readability and maintenance cost climb quickly.

`CompositionLocal` solves this problem by letting data skip intermediate layers and be read directly by all children inside a specific scope of the Composition tree.

## The core mechanism of CompositionLocal

`CompositionLocal` depends on hierarchical scopes in the Composition tree. It is not a global singleton and not dependency injection. It is an implicit data slot maintained by Compose during composition.

```kotlin
// Definition
val LocalContentColor = compositionLocalOf { Color.Black }

// Providing a value inside a Composable scope
CompositionLocalProvider(LocalContentColor provides Color.Red) {
    Text("This text is red")  // Automatically gets Red
    Surface {
        Text("This text is also red") // Inherits the parent scope
    }
}
```

At runtime, Compose stores the values provided by the current `CompositionLocalProvider` inside an internal `CompositionLocalMap` in the Composer. That map is essentially a `PersistentHashMap`. When a child Composable reads `LocalContentColor.current`, the Composer searches upward through the Composition tree's map chain and returns the nearest value stored in scope.

The whole lookup happens during composition. The value lifecycle is tied to Composable nodes, so it does not introduce cross-thread issues or memory-leak risk by itself.

## Two Provider strategies: static versus dynamic

The two creation APIs behave very differently. Documentation often mentions the difference briefly, but misunderstanding it can directly cause unnecessary recomposition.

### compositionLocalOf

```kotlin
val LocalScrollState = compositionLocalOf { ScrollState(0) }
```

**Dynamic tracking**: when the value changes, only Composables that actually read `current` are recomposed. Other child nodes are not affected. This fits frequently changing values such as scroll position and animation state.

Internally, Compose marks an implicit dependency on the Composable that reads `current`. When the value changes, only those nodes are notified.

### staticCompositionLocalOf

```kotlin
val LocalDensity = staticCompositionLocalOf { Density(1f) }
```

**No read tracking**: when the value changes, every child Composable inside the `CompositionLocalProvider` scope is recomposed, whether it read the Local or not. This fits values that almost never change, such as theme, `Density`, and configuration.

The selection rule is straightforward: use `compositionLocalOf` for values that change frequently and are read by a narrow set of nodes. Use `staticCompositionLocalOf` for values that are effectively stable. In real projects, the static version is enough for about 90% of cases. `LocalContentAlpha` and `LocalTextStyle` in `MaterialTheme` are static-style values.

## Easy pitfalls

The expressions passed to `CompositionLocalProvider` run on every recomposition:

```kotlin
@Composable
fun ExpensiveScreen() {
    val heavyComputation = remember { computeSomething() } // Runs once
    
    CompositionLocalProvider(
        LocalMyData provides computeSomething()  // Runs on every recomposition!
    ) {
        Content()
    }
}
```

The expression on the right side of `provides` is not magically protected by Composable tracking, and `remember` does not apply to it unless you lift the computation out:

```kotlin
val data = remember { computeSomething() }
CompositionLocalProvider(LocalMyData provides data) {
    Content()
}
```

Nested scopes are another source of confusion. If an outer scope provides `LocalContentColor` and an inner scope provides a different value, inner Composables read the nearest value. The outer one becomes invisible from there. This behavior is expected, but nested providers can be hard to debug. During debugging, I like adding a custom lint rule that checks whether the same Local is provided repeatedly in one scope, which helps avoid meaningless overrides.

## Engineering choice: implicit or explicit?

This is the part teams argue about most. My decision logic is:

**Explicit parameters** fit when:

- The data is used by only one or two layers
- The data has a decisive effect on component behavior
- The component should clearly communicate that it cannot work without the parameter

**CompositionLocal** fits when:

- The data is consumed across three or more levels, and any level may need it
- The data represents environmental context rather than business input
- There is a reasonable default value, so the system can degrade predictably when it is not provided

Making `userId` a `CompositionLocal` so every child component can read it is a typical counterexample. It appears to reduce parameter passing, but it actually gives any Composable an implicit dependency on "the current user," which makes testing and reuse harder. I prefer explicit parameters for business data. `CompositionLocal` should carry infrastructure context: theme, dimensions, locale, and accessibility configuration.

Material 3 follows the same model. Design tokens such as Colors, Typography, and Shapes go through `CompositionLocal`; content data such as `text` and `onClick` stay as explicit parameters.

## Internal implementation: Slot Table in the Composer

In one sentence: `CompositionLocal` values live in the Composer's Slot Table. When `CompositionLocalProvider` enters the tree, the Composer writes a new Group into the Slot Table, and that Group contains a `CompositionLocalMap`. When a child Composable reads `current`, the Composer walks upward from the current position in the Slot Table and finds the nearest valid map.

This design explains several behavior constraints:

- Lookup cost grows with composition depth, O(n), but the tree is usually only a few dozen levels deep, so the impact is negligible
- Value changes trigger recomposition only during the composition phase; Layout and Draw are not directly affected
- `CompositionLocalProvider` itself does not create a layout node. It is a marker point and does not add layout depth

Once you understand the Slot Table, it becomes clear why `CompositionLocalProvider` should not be placed carelessly inside conditional branches and why the `provides` expression runs on every recomposition. It is fundamentally a Composer recording instruction, not a declarative UI node.

## Practical rules

**Give every CompositionLocal a clear default value.** Use the default lambda in `compositionLocalOf { default }`, and avoid throwing an exception from it. When a value is not provided, predictable fallback behavior makes debugging much easier.

**Use the `Local` prefix consistently.** This is a Compose community convention. IDE inspections and code review both benefit because implicit dependencies are easy to spot.

**Keep the count under control.** If a module has more than three `CompositionLocal` values, treat that as a warning sign and consider replacing some of them with explicit parameters. Too many implicit dependencies are just global variables in another form.

`MaterialTheme` internally injects more than a dozen Locals through `CompositionLocalProvider`, but the encapsulation is excellent. Externally, there is only one `MaterialTheme` entry point, and users do not feel the implicit dependency machinery at all. Encapsulation is the important part.
