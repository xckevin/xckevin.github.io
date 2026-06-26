---
title: "Inside the Compose Compiler Plugin: From @Composable to Synthetic Parameters"
lang: en
translationKey: android-compose-compiler-plugin-internals
slug: android-compose-compiler-plugin-internals
excerpt: "How the Compose Compiler Plugin transforms @Composable functions at the IR level, covering $changed bitmasks, skip logic generation, state read/write markers, and stability inference rules."
publishDate: '2026-06-17'
tags:
- "Android"
- "Jetpack Compose"
- "Kotlin"
- "Compiler"
- "Performance"
seo:
  title: "Compose Compiler Plugin Internals: @Composable to IR Transformation"
  description: "How the Compose Compiler Plugin rewrites @Composable functions at the IR level: synthetic parameters, skip logic, state markers, and stability inference."
  pageType: article
---

I was debugging a recomposition problem last week, staring at decompiled bytecode for a long time. The source had a simple `@Composable` function, but the compiled output carried extra parameters like `$composer`, `$changed`, and `$default`, with calls to `startRestartGroup` and `endRestartGroup` scattered through the body. All of this is injected at compile time by the Compose Compiler Plugin.

Let's break down how this compiler plugin translates declarative UI code into the intermediate form that the Compose Runtime consumes.

## Plugin Registration Entry Point

The Compose Compiler Plugin is a Kotlin compiler plugin registered through the `ComponentRegistrar` interface. `ComposePlugin.kt` registers several IR extensions, with the core entry point being `IrGenerationExtension`:

```kotlin
// ComposePlugin.kt (simplified)
class ComposePlugin : ComponentRegistrar {
    override fun registerProjectComponents(
        project: MockProject,
        configuration: CompilerConfiguration
    ) {
        IrGenerationExtension.registerExtension(
            project,
            ClassStabilityTransformer()
        )
        IrGenerationExtension.registerExtension(
            project,
            ComposableFunctionTransformer()
        )
    }
}
```

Two key extensions: `ClassStabilityTransformer` infers type stability, and `ComposableFunctionTransformer` transforms `@Composable` functions. The plugin hooks in during the IR generation phase of the Kotlin compiler, operating on the **IR tree** rather than source text.

IR (Intermediate Representation) is the Kotlin compiler's middle layer — closer to the backend than an AST, but still platform-independent. Inserting code at the IR level balances flexibility with performance.

## Six Synthetic Parameters

When you write a Composable function, the compiler appends six parameters automatically. Take this function:

```kotlin
@Composable
fun Greeting(name: String) {
    Text("Hello $name")
}
```

After compilation, the IR equivalent is:

```kotlin
fun Greeting(
    name: String,
    $composer: Composer<*>,
    $changed: Int,
    $default: Int,
    key1: Any?,
    key2: Any?,
    key3: Any?
) {
    // ...
}
```

Each parameter has a specific role:

- **`$composer`**: The Compose Runtime's core scheduler — manages the group node tree, emits changes, and drives recomposition.
- **`$changed`**: A bitmask indicating which parameter values changed.
- **`$default`**: A bitmask marking which parameters used default values, coordinated with `$composer.startDefaults()`.
- **`key1/key2/key3`**: Composition keys used to locate the correct composable during recomposition.

The `$changed` encoding is straightforward: the bit index corresponds to the parameter index. Bit 0 maps to the first parameter, bit 1 to the second, and so on. A value of 0 means unchanged, 1 means changed, and 2 means "uncertain" — unstable-type parameters always return 2, forcing recomposition.

## Generating Skip Logic

The core of Compose's recomposition optimization is the **skippable** mechanism. The compiler plugin analyzes each `@Composable` function's parameter types, determines stability, and decides whether to generate skip logic.

The stability rules are direct: **primitives and String are stable; a data class is stable when all its fields are stable types; types annotated with `@Stable` are stable.** Interfaces and plain classes are unstable by default unless marked `@Stable`.

For functions where all parameters are stable, the compiler generates this structure:

```kotlin
$composer.startRestartGroup(0xF12345) // recomposition scope ID
if ($changed != 0 || $composer.skipping) {
    // A parameter changed — re-execute
    Text("Hello $name")
} else {
    $composer.skipToGroupEnd() // skip the function body
}
$composer.endRestartGroup()?.updateScope { composer, forceUpdate ->
    Greeting(name, composer, forceUpdate or 1, ...)
}
```

`$changed` is a bitmask passed by the caller. During recomposition, the caller compares old and new parameter values and sets the corresponding bits. If nothing changed and the composer isn't in forced-redraw mode, `$composer.skipping` is true and the entire body is skipped. This is why a `mutableStateOf` value change only recomposes the Composables that read that value, not the whole tree.

## State Read/Write Markers and Snapshot Awareness

Compose's state awareness relies on the `Snapshot` system working in concert with the compiler plugin. When a Composable function reads a `State` value, the compiler inserts `$composer.recordRead()`; when it writes, the compiler inserts `$composer.recordWrite()`.

```kotlin
@Composable
fun Counter() {
    var count by remember { mutableStateOf(0) }
    // compiler inserts: $composer.recordRead(count)
    Text("Count: $count")
    Button(onClick = { count++ }) {
        Text("Increment")
    }
}
```

`recordRead` registers an observer in the current `SlotTable`. When `count` is modified anywhere (via `mutableStateOf`'s `setValue`), the `Snapshot` system marks every Composable that registered for that state as "dirty." On the next frame, `$changed` reflects this change and triggers re-execution.

The compiler doesn't need to understand business logic. It only inserts marker code at state access points. Everything else is handled at runtime by `Snapshot` and `Composer`.

## Default Parameters and the `$default` Protocol

Composable functions support default parameters, but the compiled signature can't use Kotlin's default-value mechanism directly — synthetic parameters like `$composer` disrupt parameter positions. The compiler solves this with `$default` as a bitmask:

```kotlin
@Composable
fun Greeting(name: String = "World", count: Int = 1) {
    Text("$name: $count")
}

// compiled equivalent:
fun Greeting(name: String, count: Int, $composer: Composer<*>, $changed: Int, $default: Int) {
    val name = if ($default and 0b01 != 0) "World" else name
    val count = if ($default and 0b10 != 0) 1 else count
    // ...
}
```

Bit 0 of `$default` indicates whether `name` uses its default value; bit 1 does the same for `count`. When the caller omits a parameter, it sets the corresponding bit to 1, and the function body resolves the value with an `if` check. This is why you should avoid complex expressions as default values for Composable parameters — even if the parameter goes unused, the expression is re-evaluated on every recomposition.

## Stability Inference Edge Cases

The compiler's stability inference is static and can be wrong. I hit a pitfall with `List`-typed parameters: the list contents were fixed, but `List` as an interface isn't a stable type, so the function recomposed every time.

```kotlin
// compiler considers List unstable — $changed is always non-zero
@Composable
fun ItemList(items: List<String>) {
    items.forEach { Text(it) }
}
```

Two fixes: annotate a wrapper class with `@Stable`, or use `@Immutable`. But the better approach is making the parameter type itself stable — switch to `ImmutableList` from `kotlinx.collections.immutable`.

Lambda parameters are another trap. Lambdas are compared by reference, so creating a new lambda instance on every recomposition can keep invalidating otherwise stable call sites. The opposite failure mode also appears when a remembered lambda captures stale values: the function may skip correctly, but the callback still observes old state. Use `remember` only when the capture set is intentional, and use `rememberUpdatedState` when a long-lived callback needs the latest value without reallocating the callback on every frame.

## Understanding the Compiler Isn't About Hacking It

The point of breaking down the Compose Compiler isn't to write your own compiler plugin (Compose's IR transformation code spans tens of thousands of lines). It's to build intuition about recomposition behavior. Knowing that the compiler inserts `recordRead` at state access points explains why reading state inside a lambda is more error-prone than reading it in a Composable function body. Knowing the stability inference rules means that when something recomposes unexpectedly, you can quickly narrow it down to a parameter type.

The Compose Compiler Plugin is a black box, but its input-output rules are deterministic. Master those rules and you hold the key to Compose performance optimization.
