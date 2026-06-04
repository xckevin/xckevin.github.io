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

- [Jetpack Compose recomposition performance: stability, `derivedStateOf`, and skip behavior](/blog/2026-05-07-jetpack_compose_重组性能全链路调优_从_stability_推断到_deriveds/)
- [Advanced Jetpack Compose applications and internals](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose `Modifier` internals: from chained APIs to `Modifier.Node`](/blog/2026-05-15-jetpack_compose_modifier_链式机制深度解析_从_modifier_node_/)
- [Jetpack Compose gesture internals: from `pointerInput` to the modifier node pipeline](/blog/2026-05-16-jetpack_compose_手势系统深度解析_从_pointerinput_事件管道到_modi/)
- [Jetpack Compose animation internals: from `AnimationSpec` to spring physics](/blog/2026-05-09-jetpack_compose_动画系统深度解析_从_animationspec_物理弹簧模型到_t/)
- [Android Glance AppWidget internals: bridging Compose-style APIs to `RemoteViews`](/blog/2026-05-28-深入_android_glance_appwidget_全链路_从_remoteviews_渲染桥接/)
- [Compose and View interoperability: embedding `AndroidView` and `ComposeView`](/blog/2026-05-19-jetpack_compose_与_view_互操作性深度解析_从_androidview_嵌入到_/)

## Layout, Drawing, and State Scope

- [Jetpack Compose phases: from composition to layout and draw](/blog/2026-01-15-深入_jetpack_compose_phases_三阶段模型_从_composition_到_dr/)
- [CompositionLocal internals: implicit data flow inside the composition tree](/blog/2026-05-14-深入_jetpack_compose_compositionlocal_全链路_从隐式数据传递到组合/)
- [Custom Compose layouts: from `MeasurePolicy` to fixed measurement constraints](/blog/2026-05-13-深入_compose_自定义_layout_全链路实战_从_measurepolicy_测量协议到固/)
- [Compose Canvas custom drawing: from `DrawScope` to rendering details](/blog/2026-02-25-深入_android_compose_canvas_自定义绘制全链路_从_drawscope_绘图模/)
- [Compose `LazyColumn` scroll performance: from recomposition tracing to stable frame rate](/blog/2026-02-26-深入_android_compose_lazycolumn_滑动性能调优全链路_从重组追踪到帧率稳定/)
- [Android Material 3 dynamic color: from Monet extraction to Compose theming](/blog/2025-08-05-深入_android_material_3_动态配色全链路_从_monet_引擎色彩提取算法到_co/)
- [Progressive Android Compose migration: from mixed View/Compose screens to declarative UI](/blog/2025-07-04-深入_android_compose_渐进式迁移全链路_从_view_compose_混用架构到全量/)
- [Compose screenshot testing without devices: Paparazzi and JVM rendering](/blog/2025-07-01-深入_android_compose_无设备截图测试全链路_从_paparazzi_jvm_渲染到_/)
- [Compose for Wear OS: building declarative watch interfaces](/blog/2026-03-19-深入_android_wear_os_全链路_compose_for_wear_os_的声明式手表_/)

## Common Questions

- Why does this composable recompose so often?
- Should state be read in composition, layout, or draw?
- When is `remember` enough, and when do I need `derivedStateOf`?
- How should a screen be split to avoid making every state change invalidate the whole tree?
- How do I migrate a View-based screen without losing lifecycle control or scroll behavior?

## Next Step

If your Compose code relies heavily on Flow, StateFlow, and structured concurrency, continue with [Kotlin and Coroutines](/en/kotlin-coroutines/).
