---
title: "Jetpack Compose 深度解析专题"
seo:
  title: "Jetpack Compose 深度解析：重组、Modifier、动画、手势与 Glance"
  description: "系统整理 Jetpack Compose 原理与性能优化文章，覆盖重组、Stability、Modifier、PointerInput、动画系统、Layout、Canvas、CompositionLocal、Glance 与 View 互操作。"
---

面向正在开发 Compose 界面的 Android 工程师。这条路线从状态读取和渲染阶段出发，连接列表性能、手势冲突与回归验证，帮助把“界面不对劲”收敛为可以检查的问题。

## 按问题选择入口

| 当前问题 | 先读这篇 | 检查重点 |
| --- | --- | --- |
| 不清楚状态变化会触发哪一阶段 | [Composition、Layout、Draw 三阶段](/blog/jetpack-compose-phases-composition-layout-draw/) | 状态在哪里读取，以及哪个作用域被重新执行 |
| LazyColumn 卡顿，重组次数很多 | [LazyColumn 滑动性能排查](/blog/jetpack-compose-lazycolumn-performance/) | 帧耗时、构建模式、稳定 key、contentType 与工作量 |
| 点击、拖拽或父子滚动冲突 | [手势分发与嵌套滚动](/blog/jetpack-compose-gestures/) | 输入抽象层、事件消费、协程 key 与剩余滚动量 |

## 推荐阅读顺序

1. 用 [三阶段模型](/blog/jetpack-compose-phases-composition-layout-draw/) 理解状态读取位置。不要仅凭重组计数判断性能。
2. 在 [LazyColumn](/blog/jetpack-compose-lazycolumn-performance/) 中检查真实列表的身份、数据变更和帧时间；记录 Compose 与 Kotlin 编译器版本。
3. 用 [手势排查流程](/blog/jetpack-compose-gestures/) 处理点击与拖拽竞争，再检查嵌套滚动的消费分配。
4. 需要系统证据时转到 [Perfetto 入门](/blog/android-perfetto/)；需要防止视觉回归时看 [Compose 截图测试](/blog/android-compose-screenshot-testing-paparazzi/)。

## 核心文章

- [Jetpack Compose 重组性能优化：Stability、derivedStateOf 与跳过重组](/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose 原理与高级应用：状态、布局、重组与性能实践](/blog/jetpack-compose-advanced-applications-internals/)
- [Jetpack Compose Modifier 原理：链式节点、布局绘制与事件处理](/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose 手势系统：PointerInput 事件管道与嵌套滚动](/blog/jetpack-compose-gestures/)
- [Jetpack Compose 动画系统：AnimationSpec、弹簧模型与 Transition](/blog/jetpack-compose-animation/)
- [Android Glance AppWidget 原理：RemoteViews、更新机制与 Compose 小组件](/blog/android-glance-appwidget-remoteviews-deep-dive/)
- [Jetpack Compose 与 View 互操作：AndroidView、生命周期与迁移策略](/blog/jetpack-compose-view-interop/)

## 布局、绘制与状态作用域

- [深入 Jetpack Compose Phases 三阶段模型：从 Composition 到 Drawing 的声明式像素生产全链路](/blog/jetpack-compose-phases-composition-layout-draw/)
- [深入 Jetpack Compose CompositionLocal 全链路：从隐式数据传递到组合作用域的内部机制与工程实践](/blog/jetpack-compose-compositionlocal/)
- [Compose 自定义 Layout：MeasurePolicy、固有尺寸与瀑布流实战](/blog/jetpack-compose-custom-layout-measurepolicy/)
- [深入 Android Compose Canvas 自定义绘制全链路：从 DrawScope 绘图模型到声明式数据可视化图表的架构设计与实战](/blog/jetpack-compose-canvas-drawscope/)
- [深入 Android Compose LazyColumn 滑动性能调优全链路](/blog/jetpack-compose-lazycolumn-performance/)
- [深入 Android Material 3 动态配色全链路：从 Monet 引擎色彩提取算法到 Compose MaterialTheme 的声明式主题架构](/blog/android-material3-dynamic-color-monet/)
- [深入 Android Compose 渐进式迁移全链路：从 View/Compose 混用架构到全量声明式 UI 的工程化转型策略与性能验证](/blog/android-compose-progressive-migration/)
- [深入 Android Compose 无设备截图测试全链路：从 Paparazzi JVM 渲染到 Roborazzi 像素级 Golden Test 的视觉回归工程实践](/blog/android-compose-screenshot-testing-paparazzi/)
- [当手机版 Compose 组件在手表上崩掉：Wear OS 声明式 UI 的排坑之路](/blog/android-wear-os-compose/)

## 常见问题

- 为什么参数没变，Composable 还是频繁重组？
- derivedStateOf 应该用在哪里，不应该用在哪里？
- Modifier 的顺序为什么会影响布局、绘制和点击？
- Compose 动画卡顿时应该看什么指标？
- Glance 和 RemoteViews 的关系是什么？

## 下一步

Compose 的状态流通常依赖 Kotlin Flow 和协程，建议继续阅读 [Kotlin 与协程工程实践](/kotlin-coroutines/)。
