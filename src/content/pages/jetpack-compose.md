---
title: "Jetpack Compose 深度解析专题"
seo:
  title: "Jetpack Compose 深度解析：重组、Modifier、动画、手势与 Glance"
  description: "系统整理 Jetpack Compose 原理与性能优化文章，覆盖重组、Stability、Modifier、PointerInput、动画系统、Glance 与 View 互操作。"
---

这个专题面向已经使用 Compose 的 Android 开发者，重点解决“为什么会重组”“为什么会卡顿”“Modifier 到底做了什么”“如何和 View 体系共存”等问题。

## 学习路径

1. 先读重组和 Stability。
2. 再看 Modifier、布局、绘制和事件管道。
3. 接着补动画、手势和互操作。
4. 最后看 Glance，把 Compose 思维迁移到 AppWidget。

## 核心文章

- [Jetpack Compose 重组性能优化：Stability、derivedStateOf 与跳过重组](/blog/2026-05-07-Jetpack_Compose_%E9%87%8D%E7%BB%84%E6%80%A7%E8%83%BD%E5%85%A8%E9%93%BE%E8%B7%AF%E8%B0%83%E4%BC%98_%E4%BB%8E_Stability_%E6%8E%A8%E6%96%AD%E5%88%B0_derivedS/)
- [Jetpack Compose 原理与高级应用：状态、布局、重组与性能实践](/blog/Jetpack%20Compose%20%E9%AB%98%E7%BA%A7%E5%BA%94%E7%94%A8%E4%B8%8E%E5%8E%9F%E7%90%86/)
- [Jetpack Compose Modifier 原理：链式节点、布局绘制与事件处理](/blog/2026-05-15-Jetpack_Compose_Modifier_%E9%93%BE%E5%BC%8F%E6%9C%BA%E5%88%B6%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_Modifier_Node_/)
- [Jetpack Compose 手势系统：PointerInput 事件管道与嵌套滚动](/blog/2026-05-16-Jetpack_Compose_%E6%89%8B%E5%8A%BF%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_PointerInput_%E4%BA%8B%E4%BB%B6%E7%AE%A1%E9%81%93%E5%88%B0_Modi/)
- [Jetpack Compose 动画系统：AnimationSpec、弹簧模型与 Transition](/blog/2026-05-09-Jetpack_Compose_%E5%8A%A8%E7%94%BB%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_AnimationSpec_%E7%89%A9%E7%90%86%E5%BC%B9%E7%B0%A7%E6%A8%A1%E5%9E%8B%E5%88%B0_T/)
- [Android Glance AppWidget 原理：RemoteViews、更新机制与 Compose 小组件](/blog/2026-05-28-%E6%B7%B1%E5%85%A5_Android_Glance_AppWidget_%E5%85%A8%E9%93%BE%E8%B7%AF_%E4%BB%8E_RemoteViews_%E6%B8%B2%E6%9F%93%E6%A1%A5%E6%8E%A5/)
- [Jetpack Compose 与 View 互操作：AndroidView、生命周期与迁移策略](/blog/2026-05-19-Jetpack_Compose_%E4%B8%8E_View_%E4%BA%92%E6%93%8D%E4%BD%9C%E6%80%A7%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_AndroidView_%E5%B5%8C%E5%85%A5%E5%88%B0_/)

## 常见问题

- 为什么参数没变，Composable 还是频繁重组？
- derivedStateOf 应该用在哪里，不应该用在哪里？
- Modifier 的顺序为什么会影响布局、绘制和点击？
- Compose 动画卡顿时应该看什么指标？
- Glance 和 RemoteViews 的关系是什么？

## 下一步

Compose 的状态流通常依赖 Kotlin Flow 和协程，建议继续阅读 [Kotlin 与协程工程实践](/kotlin-coroutines/)。
