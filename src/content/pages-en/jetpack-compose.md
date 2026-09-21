---
title: Jetpack Compose
lang: en
translationKey: jetpack-compose
seo:
  title: Jetpack Compose Engineering Notes
  description: Jetpack Compose notes covering recomposition, stability, Modifier internals, layout, gestures, animation, Glance, and View interoperability.
---

This topic collects Jetpack Compose engineering notes.

It is written for Android developers who are already building with Compose and want clearer answers to questions such as why recomposition happens, why a `LazyColumn` drops frames, how `Modifier` chains work internally, and how to keep Compose and the legacy View system alive in the same app during migration.

## Learning Path

1. Start with recomposition and stability. Understand what actually invalidates composition and why some parameters are skippable while others are not.
2. Move into layout, drawing, and the `Modifier` pipeline. This is where most subtle UI performance and event-delivery issues come from.
3. Study animation, gestures, and View interoperability only after the basic runtime model is clear.
4. Treat Glance, AppWidget, Wear OS, and screenshots as specialized Compose environments rather than simple extensions of screen UI.

## Core Articles

- [Jetpack Compose recomposition performance: stability, `derivedStateOf`, and skip behavior](/blog/jetpack-compose-recomposition-performance/)
- [Advanced Jetpack Compose applications and internals](/blog/jetpack-compose-advanced-applications-internals/)
- [Jetpack Compose `Modifier` internals: from chained APIs to `Modifier.Node`](/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gesture internals: from `pointerInput` to the modifier node pipeline](/blog/jetpack-compose-gestures/)
- [Jetpack Compose animation internals: from `AnimationSpec` to spring physics](/blog/jetpack-compose-animation/)
- [Android Glance AppWidget internals: bridging Compose-style APIs to `RemoteViews`](/blog/android-glance-appwidget-remoteviews-deep-dive/)
- [Compose and View interoperability: embedding `AndroidView` and `ComposeView`](/blog/jetpack-compose-view-interop/)

## Layout, Drawing, and State Scope

- [Jetpack Compose phases: from composition to layout and draw](/blog/jetpack-compose-phases-composition-layout-draw/)
- [CompositionLocal internals: implicit data flow inside the composition tree](/blog/jetpack-compose-compositionlocal/)
- [Custom Compose layouts: from `MeasurePolicy` to fixed measurement constraints](/blog/jetpack-compose-custom-layout-measurepolicy/)
- [Compose Canvas custom drawing: from `DrawScope` to rendering details](/blog/jetpack-compose-canvas-drawscope/)
- [Compose `LazyColumn` scroll performance: from recomposition tracing to stable frame rate](/blog/jetpack-compose-lazycolumn-performance/)
- [Android Material 3 dynamic color: from Monet extraction to Compose theming](/blog/android-material3-dynamic-color-monet/)
- [Progressive Android Compose migration: from mixed View/Compose screens to declarative UI](/blog/android-compose-progressive-migration/)
- [Compose screenshot testing without devices: Paparazzi and JVM rendering](/blog/android-compose-screenshot-testing-paparazzi/)
- [Compose for Wear OS: building declarative watch interfaces](/blog/android-wear-os-compose/)

## Common Questions

- Why does this composable recompose so often?
- Should state be read in composition, layout, or draw?
- When is `remember` enough, and when do I need `derivedStateOf`?
- How should a screen be split to avoid making every state change invalidate the whole tree?
- How do I migrate a View-based screen without losing lifecycle control or scroll behavior?

## Next Step

If your Compose code relies heavily on Flow, StateFlow, and structured concurrency, continue with [Kotlin and Coroutines](/en/kotlin-coroutines/).
