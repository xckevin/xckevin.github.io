---
title: "Jetpack Compose Phases: From Composition to Layout and Drawing"
lang: en
translationKey: jetpack-compose-phases-composition-layout-draw
slug: jetpack-compose-phases-composition-layout-draw
excerpt: "A deep dive into the three Jetpack Compose phases: Composition, Layout, and Drawing, with state reads, skip behavior, and performance guidance."
publishDate: '2026-01-15'
tags:
- "Android"
- "Jetpack Compose"
- "Performance"
- "State Management"
- "Kotlin"
seo:
  title: "Jetpack Compose Phases: Composition, Layout, Drawing, and State Reads"
  description: "Understand the three Jetpack Compose phases, how state reads decide recomposition boundaries, and how phase skipping affects UI performance."
  pageType: article
---

After writing Compose for a while, you eventually run into a confusing bug: the value inside `mutableStateOf` clearly changes, but the UI does not move at all. After debugging, the cause is often the **location where state is read**. Reading state inside a `Modifier` and reading it inside `Canvas` are completely different things.

To understand this behavior, you need to understand the three-phase Compose pipeline.

## Three-phase overview

Compose turns "declarative components" into "screen pixels" through three phases:

- **Composition**: decide what UI tree should be shown on the screen
- **Layout**: measure each node and determine its position
- **Drawing**: draw the nodes onto the Canvas

The three phases run in order, and **each phase has its own skip decision**. The phase in which you read state determines which logic will run again after that state changes.

```text
Composition  ->  Layout  ->  Drawing
    |              |          |
 Create UI tree   Measure +   Actual drawing
                  position
    |
 State reads decide whether recomposition is needed
```

The best way to enter this model is to look at when `Modifier` logic actually executes.

## Modifier chains: the implicit scheduler for the three phases

Each `Modifier` has corresponding callback interfaces across the three phases. Take a basic `Modifier.size()`-style behavior as an example:

```kotlin
// How a custom Modifier participates in the three phases
fun Modifier.trackedSize(size: Dp) = this.then(object : LayoutModifier {
    // Composition phase: do nothing here, just capture parameters

    override fun MeasureScope.measure(
        measurable: Measurable,
        constraints: Constraints
    ): MeasureResult {
        // Layout phase: measure and decide size
        val placeable = measurable.measure(constraints.copy(
            maxWidth = size.roundToPx()
        ))
        return layout(placeable.width, placeable.height) {
            placeable.placeRelative(0, 0)
        }
    }
}).then(object : DrawModifier {
    override fun ContentDrawScope.draw() {
        // Drawing phase: execute drawing
        drawRect(Color.Red)
        drawContent()
    }
})
```

A Modifier chain is the declaration. The three phases are the execution. When you declare a size constraint with `Modifier.size()`, the actual measuring and placement happen in the Layout phase. Several layers of state reads and recomposition checks may sit between those two moments.

Modifier calls are linked from left to right, but the execution order differs by phase:

- **Composition phase**: the Modifier chain mostly does not participate, except for `composed()`
- **Layout phase**: the outer modifier receives constraints first, then passes them inward. With `Modifier.size(100.dp).padding(16.dp)`, `size` caps the max width at 100 dp, `padding` subtracts 32 dp of margins, and the content receives 68 dp
- **Drawing phase**: the outer modifier draws first, and every layer is composited on the same Canvas

I once hit a performance trap here. I read animation state inside `Modifier.drawBehind`, then read the same state inside `remember`. The Drawing phase could no longer skip cleanly, and every recomposition caused a full redraw. Frame rate dropped from 60 to 30 FPS. Each piece looked reasonable alone; together they became a hidden performance problem.

## Boundary effects of state reads

Compose tracks state separately by phase:

```kotlin
@Composable
fun ProfileCard() {
    var name by remember { mutableStateOf("Alice") }
    var badgeColor by remember { mutableStateOf(Color.Unspecified) }

    Text(
        text = name,           // Read in the Composition phase
        modifier = Modifier
            .offset(x = badgeOffset)  // Read in the Layout phase
            .drawBehind {
                drawCircle(badgeColor)  // Read in the Drawing phase
            }
    )
}
```

The three pieces of state affect different phases:

- `name` changes -> triggers **Recomposition**
- `badgeOffset` changes -> triggers **Relayout**, without recomposition
- `badgeColor` changes -> triggers **Redraw**, without recomposition or relayout

This is where Compose gets its granularity. A state change does not rerun the whole pipeline. It invalidates work at the phase where that state was read. Not many UI frameworks can do this well.

`Modifier.composed()` is the exception. It injects Composition-phase logic into the Modifier chain, which means its lambda runs again on recomposition. Using it for animation state management can easily promote a Drawing-level cost into a Composition-level cost. Use it only when that tradeoff is necessary.

## Phase skipping: why it works and when it fails

For `@Composable` functions, the Compose compiler performs `@Stable` inference on parameters at compile time. If a parameter is inferred to be stable and its value has not changed, meaning `equals()` returns true, the Composition phase can skip the function body completely.

```kotlin
// Equivalent from the Compose compiler's perspective
@Composable
fun Greeting(name: String) {  // String is inferred as @Stable
    Text("Hello $name")
}

// Pseudocode for compiler-injected skip logic
fun Greeting(name: String, %composer: Composer) {
    if (!%composer.skipping || name != %composer.rememberedValue) {
        Text("Hello $name")  // Runs only when the value changes
    }
}
```

Common cases where skipping fails:

1. **Unstable parameter types**: passing `List<T>` and creating a new instance on every recomposition prevents skipping, even when the content is identical
2. **State reads inside `composed()`**: the Modifier identity becomes unstable, invalidating Layout-phase skip decisions
3. **Changing lambda references**: `Modifier.clickable { doSomething() }` can create a new lambda object on every frame

In real projects, I enable the Compose compiler stability report and add a CI check to ensure key UI component parameters are marked `@Stable` or `@Immutable`. This is a silent optimization. Everything looks normal when it works, but once it stops working, the jank becomes visible.

## Practical recommendations

**Use `derivedStateOf` to move state reads to a cheaper boundary.** If pure derived computation can be done in `derivedStateOf`, do that instead of reading raw state in the Composition phase with `remember` and transforming it there. The latter turns a simple calculation into a recomposition signal.

**Modifier order is a performance boundary.** Put infrequently changing Modifiers, such as fixed `size`, near the front of the chain, and frequently changing ones, such as `animatedOffset`, near the end. This lets the Layout phase skip more outer work and cuts away a lot of unnecessary measurement.

**Do not optimize phase skipping too early.** Compose injects skip logic automatically at compile time, and most code does not need manual intervention. When there is a real performance bottleneck, use Layout Inspector first to confirm which phase is expensive, then fix that specific phase. Most of the time, the culprit is unstable type propagation, not one isolated line of code.
