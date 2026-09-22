---
title: Jetpack Compose
lang: en
translationKey: jetpack-compose
seo:
  title: 'Jetpack Compose Guide: Phases, LazyColumn and Gestures'
  description: Jetpack Compose notes covering recomposition, stability, Modifier internals, layout, gestures, animation, Glance, and View interoperability.
---

For Android engineers building Compose screens, this route connects state reads and rendering phases to list performance, gesture conflicts and regression checks. Start with the observable UI problem, then follow the relevant mechanism.

## Start with your question

| Question | Read first | What to inspect |
| --- | --- | --- |
| Which phase runs after this state changes? | [Composition, layout and draw phases](/en/blog/jetpack-compose-phases-composition-layout-draw/) | Where state is read and which scope is invalidated |
| Why does this LazyColumn stutter or recompose frequently? | [LazyColumn scroll performance](/en/blog/jetpack-compose-lazycolumn-performance/) | Frame duration, build mode, stable keys, contentType and work per item |
| Why do taps, drags or nested scrolling conflict? | [Gesture dispatch and nested scrolling](/en/blog/jetpack-compose-gestures/) | Input abstraction, consumption, coroutine keys and remaining scroll delta |

## A practical reading order

1. Use the [three-phase model](/en/blog/jetpack-compose-phases-composition-layout-draw/) to identify where state is read. Recomposition counts alone are not a performance verdict.
2. Inspect item identity, data changes and frame timing in a real [LazyColumn](/en/blog/jetpack-compose-lazycolumn-performance/). Record Compose and Kotlin compiler versions with measurements.
3. Follow the [gesture debugging workflow](/en/blog/jetpack-compose-gestures/) for competing taps and drags, then examine how nested scrolling distributes consumption.
4. For system evidence, continue with [Perfetto](/en/blog/android-perfetto/). For visual regressions, see [Compose screenshot testing](/en/blog/android-compose-screenshot-testing-paparazzi/).

## Core Articles

- [Jetpack Compose recomposition performance: stability, `derivedStateOf`, and skip behavior](/en/blog/jetpack-compose-recomposition-performance/)
- [Advanced Jetpack Compose applications and internals](/en/blog/jetpack-compose-advanced-applications-internals/)
- [Jetpack Compose `Modifier` internals: from chained APIs to `Modifier.Node`](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gesture internals: from `pointerInput` to the modifier node pipeline](/en/blog/jetpack-compose-gestures/)
- [Jetpack Compose animation internals: from `AnimationSpec` to spring physics](/en/blog/jetpack-compose-animation/)
- [Android Glance AppWidget internals: bridging Compose-style APIs to `RemoteViews`](/en/blog/android-glance-appwidget-remoteviews-deep-dive/)
- [Compose and View interoperability: embedding `AndroidView` and `ComposeView`](/en/blog/jetpack-compose-view-interop/)

## Layout, Drawing, and State Scope

- [Jetpack Compose phases: from composition to layout and draw](/en/blog/jetpack-compose-phases-composition-layout-draw/)
- [CompositionLocal internals: implicit data flow inside the composition tree](/en/blog/jetpack-compose-compositionlocal/)
- [Custom Compose layouts: from `MeasurePolicy` to fixed measurement constraints](/en/blog/jetpack-compose-custom-layout-measurepolicy/)
- [Compose Canvas custom drawing: from `DrawScope` to rendering details](/en/blog/jetpack-compose-canvas-drawscope/)
- [Compose `LazyColumn` scroll performance: from recomposition tracing to stable frame rate](/en/blog/jetpack-compose-lazycolumn-performance/)
- [Android Material 3 dynamic color: from Monet extraction to Compose theming](/en/blog/android-material3-dynamic-color-monet/)
- [Progressive Android Compose migration: from mixed View/Compose screens to declarative UI](/en/blog/android-compose-progressive-migration/)
- [Compose screenshot testing without devices: Paparazzi and JVM rendering](/en/blog/android-compose-screenshot-testing-paparazzi/)
- [Compose for Wear OS: building declarative watch interfaces](/en/blog/android-wear-os-compose/)

## Common Questions

- Why does this composable recompose so often?
- Should state be read in composition, layout, or draw?
- When is `remember` enough, and when do I need `derivedStateOf`?
- How should a screen be split to avoid making every state change invalidate the whole tree?
- How do I migrate a View-based screen without losing lifecycle control or scroll behavior?

## Next Step

If your Compose code relies heavily on Flow, StateFlow, and structured concurrency, continue with [Kotlin and Coroutines](/en/kotlin-coroutines/).
