---
title: "Jetpack Compose Recomposition Performance: Stability, derivedStateOf, and Skipping"
lang: en
translationKey: jetpack-compose-recomposition-performance
slug: jetpack-compose-recomposition-performance
excerpt: "A practical end-to-end guide to diagnosing and optimizing Compose recomposition, covering stability inference, compiler reports, Layout Inspector, derivedStateOf, and state read placement."
publishDate: '2026-05-07'
tags:
- "Jetpack Compose"
- "Android"
- "Performance"
- "Kotlin"
- "Architecture"
seo:
  title: "Jetpack Compose Recomposition Performance: Stability and derivedStateOf"
  description: "Optimize Compose recomposition with stability inference, compiler reports, derivedStateOf, state read placement, and measured validation."
---

When debugging Compose performance, I have run into a painful class of issues: there is no obvious "heavy" operation, yet list scrolling still stutters. The profiler shows recomposition counts climbing quickly, but the root cause is not immediately visible. After digging through the documentation and tools, I realized the problem was not a single Composable. There were multiple hidden triggers across the recomposition path. Without the right tooling, the investigation turns into guesswork.

This article organizes the diagnosis and optimization workflow I use in real projects: **compiler stability inference -> quantitative tooling -> fixes with derivedStateOf and structure changes -> validation**.

## Stability inference: the compiler's skip condition

To understand why recomposition is triggered, you first need to understand how the compiler decides that a call can be skipped.

The Compose compiler performs stability inference on every Composable parameter type at compile time. Only when **all parameters of a Composable are stable types** can the runtime skip that call when the parameter values have not changed. This inference is not computed dynamically at runtime. It is baked into the `$changed` bitmask during compilation.

The compiler treats these cases as **stable**:

- Primitive types, `String`, and function types (lambdas)
- Data classes whose public properties are all `val` and whose property types are also stable
- Classes explicitly annotated with `@Stable` or `@Immutable`
- `MutableState<T>`, because state changes are notified through Snapshot rather than relying on `equals`

The following patterns directly make a parameter **unstable**, which means the corresponding Composable cannot be skipped:

```kotlin
// Bad: a regular class with var properties is marked Unstable by the compiler
data class UserProfile(
    val name: String,
    var avatarUrl: String   // var breaks stability
)

// Bad: using the standard List<T>, even when T itself is stable
@Composable
fun FeedList(items: List<FeedItem>) { /* ... */ }

// Bad: types from external modules, such as OkHttp, cannot be inferred by the compiler
@Composable
fun NetworkStatus(response: Response) { /* ... */ }
```

`List<T>` is the most common trap. The standard library `List` interface is unstable from the compiler's point of view because it may have mutable implementations, and the compiler cannot guarantee reliable `equals()` behavior. Using `ImmutableList<T>` from `kotlinx.collections.immutable` or wrapping the parameter in a `@Stable` type can solve it. I prefer the former because the semantics are clearer and the intent is explicit.

## Use compiler reports to find unstable types

Finding unstable types by reading code does not scale in a large project. The Compose compiler provides a **Stability Report**, and you can enable it with a small Gradle configuration:

```kotlin
// app/build.gradle.kts
composeOptions {
    kotlinCompilerExtensionVersion = "..."
    freeCompilerArgs += listOf(
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:stabilityConfigurationPath=${projectDir}/compose_stability_config.conf",
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:reportsDestination=${buildDir}/compose_reports"
    )
}
```

After running `./gradlew assembleDebug`, the `build/compose_reports/` directory contains `*-composables.txt` and `*-classes.txt`. Focus on `*-composables.txt`:

```
restartable skippable scheme("[androidx.compose.ui.UiComposable]") fun FeedItem(
  stable modifier: Modifier? = @static Companion
  unstable item: FeedItem     // This line marks the item as unstable
  <runtime stability> = Unstable
)
```

The `unstable` marker means this Composable can never be skipped. `*-classes.txt` lists each class's inferred stability, which is useful for batch investigation.

In real projects I have found two kinds of surprises: domain model data classes that quietly included a `var` property, and lists returned from a ViewModel that contained third-party objects. Both can make every Composable in the call chain lose skip ability.

## Quantitative diagnosis with Layout Inspector and recomposition counters

After finding unstable types, the next step is to confirm how much redundant recomposition they actually cause. Android Studio Hedgehog and later versions expose **Recomposition Count** in Layout Inspector, which is currently the most direct tool for this job.

Connect a device or emulator, open Layout Inspector, enable "Live Updates", then perform the target scenario, such as scrolling a list or tapping a button. Each Composable node shows two numbers: `recompose count / skip count`.

Useful patterns to look for:

- **High recompose count + low skip count**: usually caused by unstable parameters that prevent skipping
- **Parent recompose count much higher than child count**: the parent is reading state too broadly and the read can likely move down
- **One leaf node has unusually high recompose count**: it may be reading high-frequency state such as animation progress or scroll offset

During investigation, you can also use `SideEffect` as a temporary recomposition counter and feed it into CI regression checks:

```kotlin
@Composable
fun ExpensiveItem(item: FeedItem) {
    // Runs on every recomposition; can be wired into monitoring
    SideEffect {
        RecompositionTracker.increment("ExpensiveItem")
    }
    // ... actual content
}
```

This should not stay in production code. Treat it as an investigation probe and remove it when you are done.

## Root-cause fixes: three main techniques

Once the diagnosis is clear, fixes usually fall into three categories.

### Fix type stability

For classes you control, first make them satisfy the immutability contract:

```kotlin
// Option 1: make every property val and use stable types
data class FeedItem(
    val id: Long,
    val title: String,
    val imageUrl: String
)

// Option 2: wrap external-module types with @Stable
@Stable
class StableResponse(val raw: Response) {
    val isSuccessful get() = raw.isSuccessful
    val body get() = raw.body
}

// Option 3: replace standard List with ImmutableList
@Composable
fun FeedList(items: ImmutableList<FeedItem>) { /* ... */ }
```

For classes from external SDKs that are immutable in practice but invisible to compiler inference, you can declare them manually in `compose_stability_config.conf`:

```
// compose_stability_config.conf
com.example.sdk.ImmutableModel  // Tell the compiler this class is stable
```

This configuration file is supported by the Compose compiler plugin 1.5.5 and later, and it takes priority over automatic inference.

### Use derivedStateOf to narrow recomposition

`derivedStateOf` solves this problem: **upstream state changes frequently, but the derived value that downstream Composables care about changes rarely**. In that case, downstream UI should not recompose at the same high frequency as the upstream state.

A typical example is showing or hiding a FAB while a list scrolls:

```kotlin
// Bad: every scroll-offset change triggers recomposition
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    val showFab = listState.firstVisibleItemIndex > 0  // High-frequency read
    Box {
        LazyColumn(state = listState) { /* ... */ }
        if (showFab) FloatingActionButton(onClick = {}) { /* ... */ }
    }
}

// Good: use derivedStateOf as a Boolean cache
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    // Composables that read showFab recompose only when it changes between false and true
    val showFab by remember(listState) {
        derivedStateOf { listState.firstVisibleItemIndex > 0 }
    }
    Box {
        LazyColumn(state = listState) { /* ... */ }
        if (showFab) FloatingActionButton(onClick = {}) { /* ... */ }
    }
}
```

At its core, `derivedStateOf` creates an intermediate State node in the Snapshot system. It caches the computed value and marks subscribers dirty only when the result changes according to `equals()`. The scroll offset may change every frame, but the Boolean `firstVisibleItemIndex > 0` is stable most of the time, so the FAB does not recompose.

The pitfall is using `derivedStateOf` for ordinary calculations that read no State, or for derived values that change as frequently as their inputs. Neither case improves anything, and both add overhead.

### Move state reads down

Another class of recomposition problem has nothing to do with stability. It happens when **state is read too close to the root of the component tree**, causing a large recomposition scope.

```kotlin
// Bad: reading animation values in the parent causes the entire parent to recompose
@Composable
fun ArticleCard(article: Article) {
    val alpha by animateFloatAsState(targetValue = if (article.isRead) 0.5f else 1.0f)
    Column(modifier = Modifier.alpha(alpha)) {  // alpha changes every frame
        ArticleTitle(title = article.title)      // Recompose along with the parent
        ArticleSummary(summary = article.summary)
        ArticleMetadata(meta = article.meta)
    }
}

// Good: push the state read down to where it is actually needed
@Composable
fun ArticleCard(article: Article) {
    Column {
        ArticleTitle(title = article.title)
        ArticleSummary(summary = article.summary)
        ArticleMetadata(meta = article.meta)
        AlphaOverlay(isRead = article.isRead)  // Only this part pays the recomposition cost
    }
}

@Composable
private fun AlphaOverlay(isRead: Boolean) {
    val alpha by animateFloatAsState(targetValue = if (isRead) 0.5f else 1.0f)
    Box(modifier = Modifier.fillMaxSize().alpha(alpha))
}
```

The principle is simple: **the code that consumes state should be the code that reads it**. Do not make a parent read state on behalf of a child and then pass the result down.

A more aggressive option is replacing `Modifier.alpha()` with `Modifier.graphicsLayer { }`. The `graphicsLayer` lambda runs during the draw phase, bypasses recomposition entirely, and goes through RenderThread's property animation path:

```kotlin
// The graphicsLayer lambda runs in the draw phase and bypasses recomposition
Box(modifier = Modifier.graphicsLayer { this.alpha = animAlpha })
```

## Build a validation loop

After optimizing, you need measured validation. Otherwise one issue gets fixed and another appears somewhere else.

**1. Compile-time stability gate**: Parse the `compose_reports` directory in CI. If a new Composable with `<runtime stability> = Unstable` appears, fail or warn the build. This catches stability regressions before merge.

**2. Macrobenchmark frame-time metrics**: Record benchmarks for core scenarios and put P95 frame time on the performance dashboard:

```kotlin
@Test
fun feedScrollBenchmark() = benchmarkRule.measureRepeated(
    packageName = "com.example.app",
    metrics = listOf(FrameTimingMetric()),
    iterations = 5,
    setupBlock = { startActivityAndWait() }
) {
    device.findObject(By.res("feed_list"))
          .setGestureMargin(device.displayWidth / 5)
    device.findObject(By.res("feed_list")).fling(Direction.DOWN)
}
```

**3. Local regression checks with Recomposition Highlighter**: In debug builds, enable `ComposeUiFlags.isDebugInspectorInfoEnabled` and use Layout Inspector's Recomposition Count. Comparing before and after on important screens quickly reveals whether a change introduced a regression.

---

In practice, about 80% of Compose recomposition performance problems concentrate in three places: unstable `List` parameters, state reads that are too high in the tree, and high-frequency state that is not isolated with `derivedStateOf`. Stability Report makes the first category transparent, and Layout Inspector's Recomposition Count is usually enough to locate the other two.

With the toolchain in place, optimization moves from "guessing from experience" to "changing based on data." The time saved is far greater than the setup cost.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose Modifier internals: Modifier.Node, layout, drawing, and event handling](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/en/blog/jetpack-compose-gestures/)
- [Jetpack Compose animations: AnimationSpec, springs, and Transition](/en/blog/jetpack-compose-animation/)
<!-- /seo-internal-links -->
