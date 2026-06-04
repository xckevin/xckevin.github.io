---
title: Compose-first Migration
lang: en
translationKey: compose-first-migration
seo:
  title: Compose-first Android Migration
  description: Notes on migrating Android apps toward Jetpack Compose with architecture boundaries, View interoperability, testing, performance, and rollout strategy.
---

This topic focuses on migrating Android applications toward a Compose-first architecture.

Jetpack Compose has moved from "new UI framework" to the default path for new Android UI work. This page is for teams dealing with questions such as how to migrate from XML, why Compose screens become janky, and what a Compose-first architecture should mean in an existing app.

The goal is not a rewrite for its own sake. The goal is a controlled path toward simpler UI architecture, clearer state ownership, and better testability.

## Who This Is For

- Teams with existing View/XML screens that need to migrate module by module.
- Developers debugging frequent recomposition, `LazyColumn` frame drops, or poorly scoped state reads.
- Apps that must maintain both Compose and View code while handling `AndroidView`, `ComposeView`, lifecycle, and scroll conflicts.
- Teams exploring Compose for Wear OS, Glance AppWidget, large screens, foldables, or multi-platform UI.

## Migration Route

1. Start with low-risk screens. Do not begin by rewriting the most critical transaction flow.
2. Use View/Compose interoperability to connect existing screens while defining lifecycle, state hoisting, and event boundaries.
3. Trace recomposition on high-frequency lists and complex state screens. Pay close attention to stability, `derivedStateOf`, and where state is read.
4. Add Compose UI tests, screenshot tests, and CI regression checks so migration quality does not depend on manual acceptance.
5. Treat AppWidget, Wear OS, large screens, and foldables as separate adaptation tracks.

## Core Reading

- [Jetpack Compose engineering notes](/en/jetpack-compose/)
- [Why does Compose recompose so often? Stability and state-read scope](/blog/compose-recomposition/)
- [Jetpack Compose recomposition performance: stability, `derivedStateOf`, and skip behavior](/blog/2026-05-07-jetpack_compose_重组性能全链路调优_从_stability_推断到_deriveds/)
- [Compose `LazyColumn` scroll performance: from recomposition tracing to frame-rate stability](/blog/2026-02-26-深入_android_compose_lazycolumn_滑动性能调优全链路_从重组追踪到帧率稳定/)
- [Compose and View interoperability: `AndroidView`, `ComposeView`, and two-way communication](/blog/2026-05-19-jetpack_compose_与_view_互操作性深度解析_从_androidview_嵌入到_/)
- [Progressive Android Compose migration: from mixed View/Compose screens to full declarative UI](/blog/2025-07-04-深入_android_compose_渐进式迁移全链路_从_view_compose_混用架构到全量/)

## Performance Checklist

- Recomposition: parameter stability, `remember` scope, and state-read location.
- Lists: stable keys, `contentType`, item composition granularity, and image loading.
- Layout and drawing: `Modifier` order, custom `Layout`, Canvas drawing, and unnecessary remeasurement.
- Input and gestures: `pointerInput`, nested scroll, and touch-target boundaries.
- Test stability: Compose test dispatching, asynchronous state, and screenshot baselines.

## Related Topics

- [Kotlin and Coroutines](/en/kotlin-coroutines/): Compose state streams and side effects often depend on Flow, StateFlow, and structured concurrency.
- [Android Performance](/en/android-performance/): If the issue reaches startup, rendering, memory, or traces, use system-level performance methods.
- [Mobile Engineering](/en/android-engineering/): Migration needs testing, CI, release gates, and module-boundary support.
