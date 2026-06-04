---
title: "Kotlin Type-Safe Builders and DSL Design: Receivers, Scopes, and @DslMarker"
lang: en
translationKey: kotlin-type-safe-builders-dsl
slug: kotlin-type-safe-builders-dsl
excerpt: "Starting from a Compose nesting error, this guide explains Kotlin DSL design through lambda with receiver, @DslMarker scope control, Compose, Gradle KTS, and custom builders."
publishDate: '2026-05-27'
tags:
- "Kotlin"
- "DSL"
- "Jetpack Compose"
- "Gradle KTS"
- "Type Safety"
seo:
  title: "Kotlin Type-Safe Builders and DSL Design with @DslMarker"
  description: "Learn how Kotlin DSLs work through lambda with receiver, @DslMarker implicit scope control, Compose scopes, Gradle KTS, and custom type-safe builders."
  pageType: article
---

## A confusing Compose nesting error

If you write Compose UI, you have probably seen this compiler error: `'Column' can't be called in this context by implicit receiver`. Two component calls may look identical, yet one compiles and the other does not.

```kotlin
Column {
    Text("Hello")        // OK
    Row {
        Text("World")    // OK
    }
}
```

At first glance, there is no visible issue. Then, as soon as you wrap your own components, the compiler starts enforcing rules that feel surprisingly strict. The foundation of that behavior is two Kotlin features: **lambda with receiver** and **@DslMarker implicit scope control**. Once you understand them, the design behind declarative APIs such as Compose and Gradle KTS becomes much clearer, and writing your own type-safe DSL stops feeling mysterious.

## Lambda with receiver: the syntax foundation of DSLs

A regular lambda receives parameters through `it` or a named argument:

```kotlin
val print: (String) -> Unit = { println(it) }
```

A lambda with receiver binds `this` to a specific object, so code inside the block can access that object's properties and methods directly:

```kotlin
val appendDot: String.() -> String = { this + "." }
// Equivalent to declaring an extension function on String.
```

In DSLs, this mechanism makes calls inside a block look like built-in language syntax. `Column { ... }` in Compose can call `Text()` directly because `Column` takes a parameter of type `ColumnScope.() -> Unit`. Inside the block, `this` is bound to `ColumnScope`.

Take `Box` as an example. `Modifier.align()` can only be called inside `BoxScope`:

```kotlin
Box {
    Text("Centered", modifier = Modifier.align(Alignment.Center)) // OK
}
// Outside BoxScope, align() is unavailable and fails at compile time.
```

This is the first layer of type safety: the compiler restricts where an API is visible.

## @DslMarker: cutting the implicit scope chain

Lambda with receiver solves API visibility, but it introduces another problem: the implicit receiver chain.

```kotlin
html {
    head { title("My Page") }  // head method: OK
    body {
        head { }  // Why can body call head?
    }
}
```

Inside the `body` lambda, the outer `html` receiver is still available through implicit `this`. The compiler resolves calls by walking the receiver stack: it checks the `body` receiver first, then moves outward layer by layer. As a result, code inside `body` can accidentally call methods that should only be used at the top level of `html`.

`@DslMarker` exists to cut that chain:

```kotlin
@DslMarker
annotation class HtmlDsl

@HtmlDsl
class Html {
    fun head(block: Head.() -> Unit) { }
    fun body(block: Body.() -> Unit) { }
}

@HtmlDsl
class Head {
    fun title(text: String) { }
}

@HtmlDsl
class Body { /* ... */ }
```

After the marker is applied, the compiler no longer allows implicit access to an outer receiver with the same DSL marker:

```kotlin
html {
    body {
        // head { } <- compile error: implicit outer receiver is blocked.
        this@html.head { } // OK: explicit access is still allowed.
    }
}
```

This tradeoff is practical. It does not make cross-layer access impossible, but it prevents accidental invalid nesting. If you really need to reach outward, `this@xxx` makes the intent explicit, and you have to know why you are doing it.

## Scope design in Compose

In Compose source code, annotations such as `@StableMarker` and the meta-annotations around `@Composable` participate in DSL-style scope control and valid component nesting.

Inside `LazyColumn`, `item {}` can only be used in `LazyListScope`:

```kotlin
LazyColumn {
    item { Text("Item 1") }                    // OK: LazyListScope
    items(10) { index -> Text("Item $index") } // OK
}
// item { } <- compile error: outside LazyListScope.
```

Compose's scope design principle is clear: each container component defines its own Scope interface and exposes only the APIs that are valid inside that container. `BoxScope` exposes `align()`, `LazyListScope` exposes `item()`, and `AnimatedVisibilityScope` exposes `animateEnterExit()`.

IDE autocomplete only lists valid options for the current context. Structural mistakes that would be hard to detect at runtime are rejected by the compiler.

## Type-safe builders in KTS

Gradle Kotlin DSL, or KTS, is another classic use case. In the old Groovy DSL, many configuration mistakes were only found at runtime. KTS gives feedback while you type:

```kotlin
android {
    compileSdk = 34
    defaultConfig {
        applicationId = "com.example"
        minSdk = 26          // Type-safe: must be an Int; "26" is an error.
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
```

Each layer, such as `android {}`, `defaultConfig {}`, and `buildTypes {}`, has an independent receiver type. Inside `ApplicationDefaultConfig`, autocomplete does not show `compileSdk`, because that property belongs to `BaseAppModuleExtension`. Scope rules hide it.

When writing Gradle scripts, I often jump directly to the receiver type definition. KTS's type system is the most immediate documentation: every available property is listed there, usually faster than searching web documentation.

## Designing your own type-safe DSL

Use a three-step path.

**Step one: define hierarchical Scope classes or interfaces.**

```kotlin
@MenuDsl
class MenuScope {
    fun item(name: String, action: () -> Unit) { /* ... */ }
    fun submenu(name: String, block: SubmenuScope.() -> Unit) { /* ... */ }
}
```

**Step two: annotate each Scope with @DslMarker.**

```kotlin
@DslMarker
annotation class MenuDsl

@MenuDsl
class SubmenuScope {
    fun item(name: String, action: () -> Unit) { /* ... */ }
}
```

**Step three: expose a top-level entry function.**

```kotlin
fun menu(block: MenuScope.() -> Unit) {
    MenuScope().apply(block)
}
```

The result looks like this:

```kotlin
menu {
    item("New") { createFile() }
    submenu("Export") {
        item("PDF") { exportPdf() }  // OK: inside SubmenuScope
    }
    // item("PDF") <- compile error: implicit scope is blocked by @DslMarker.
}
```

## Pitfalls and tradeoffs

Several issues show up repeatedly in real projects.

**Receiver conflicts.** When outer and inner Scope types have methods with the same name, the compiler chooses the innermost receiver by default if you do not use `@DslMarker`. That can silently call the wrong method. After adding `@DslMarker`, this ambiguity becomes a compile-time error.

**Object allocation.** Building a DSL creates Scope objects. Compose has optimization strategies, so UI code is usually not sensitive to this. But if you repeatedly build DSL trees in hot loops, the allocation cost is worth watching. In simple cases, changing a Scope to a value class can reduce overhead.

**Avoid over-designing.** Not every configuration deserves a DSL. If the structure has fewer than three layers and each layer performs mostly the same operations, ordinary function parameters may be clearer. A DSL pays off when three conditions are true: nested structure, different valid operations at each layer, and a need for compile-time constraints. Without those, it is usually too much machinery.

**An easy detail to miss:** `@DslMarker` applies to all classes annotated with that marker. It is not a one-to-one relationship. If the same marker is shared by unrelated DSL families, implicit access between those families will also be blocked. Use a separate marker annotation for each DSL family.

---

Kotlin type-safe builders come down to three ideas: lambda with receiver limits API visibility, `@DslMarker` cuts implicit receiver chains, and Scope types move structural errors from runtime to compile time. Whether you are reading Compose source or writing your own build configuration DSL, those are the core mechanics.
