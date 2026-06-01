---
title: Jetpack Compose 动画系统深度解析：从 AnimationSpec 物理弹簧模型到 Transition 多属性状态机的声明式帧驱动全链路
excerpt: 深入解析 Compose 动画系统的物理引擎本质——基于阻尼谐振子模型的动画规范、从 Choreographer 到 Snapshot 的帧驱动管道，以及 Transition 如何实现多属性同步动画。
publishDate: '2026-05-09'
tags:
- Jetpack Compose
- Android
- 动画
- Kotlin
seo:
  title: "Jetpack Compose 动画系统：AnimationSpec、弹簧模型与 Transition"
  description: "讲解 Compose 动画系统的 AnimationSpec、Spring、Transition、状态驱动动画和性能优化策略。"
---

第一次用 `animateDpAsState`，三行代码就让按钮有了弹性缩放。后来尝试在同一个组件里同时驱动位置、透明度和颜色，动画却变得卡顿且不同步。翻源码才搞清楚——Compose 的动画系统不是属性插值器，它本质是一个物理引擎。

## AnimationSpec：阻尼谐振子的物理模拟

`animate*AsState` 的 `animationSpec` 参数默认是 `spring()`——这不是缓动函数，而是一个阻尼谐振子（Damped Harmonic Oscillator）的物理模拟。

核心参数就两个：`dampingRatio`（阻尼比）和 `stiffness`（刚度）。源码默认 `dampingRatio = 1.0`（临界阻尼），`stiffness ≈ 1500 N/m`。每帧位置由 `SpringSimulation` 计算：

```kotlin
// animation-core SpringSimulation.kt（简化）
override fun getValueFromNanos(playTimeNanos: Long): AnimationResult {
    // 半隐式欧拉积分（Semi-implicit Euler）
    val k = stiffness * -(lastDisplacement - finalPosition)  // F = -kx
    val c = dampingRatio * 2 * sqrt(stiffness)               // 阻尼系数
    val force = k - c * lastVelocity                         // 合力
    lastVelocity += force / mass * timeStep
    lastDisplacement += lastVelocity * timeStep
    return AnimationResult(lastDisplacement, lastVelocity)
}
```

每帧做的不是"从 A 到 B 走了百分之几"的进度比例，而是重新计算质点受力、加速度、速度，做一次时间积分。动画的每一帧都依赖上一帧的速度状态——它有记忆，不是无状态的补间。

`dampingRatio` 三个区间的行为差异：

- **< 1（欠阻尼）**：在目标值附近来回震荡后收敛，适合强调性动画
- **= 1（临界阻尼）**：最快到达目标值且不震荡，Material Design 推荐
- **> 1（过阻尼）**：缓慢逼近目标值，几乎没人用——太肉了

## Choreographer 到 Snapshot：帧驱动的状态管道

`Animatable`（`animate*AsState` 底层实现）持有两个关键对象：`AnimationState` 记录当前值和速度，`TargetBasedAnimation` 用 `AnimationSpec` 计算每帧位置。

帧回调链的核心逻辑：

```kotlin
suspend fun Animatable.animateTo(targetValue: T, animSpec: AnimationSpec<T>) {
    val animation = TargetBasedAnimation(animSpec, typeConverter, value, targetValue)
    val startTime = withFrameNanos { it }   // 挂起，等待下一个 VSync
    while (!animation.isFinished) {
        val playTime = withFrameNanos { it } - startTime
        val result = animation.getValueFromNanos(playTime)  // 物理引擎计算
        value = result.value       // 写入 MutableState，触发重组
    }
}
```

`withFrameNanos` 底层是 `MonotonicFrameClock`，Android 上对接 `Choreographer.postFrameCallback`。VSync 信号到达时，挂起点恢复，拿到 `frameTimeNanos` 传给 AnimationSpec 做物理计算。计算结果直接写入 `MutableState`——Snapshot 系统自动追踪依赖，读了这个状态的 Composable 被标记失效，下一帧重组时拿到新值。

链路是：**VSync → Choreographer → withFrameNanos → 物理积分 → MutableState 写入 → Snapshot 通知重组 → Composable 重绘**。

动画系统和 UI 系统通过 Snapshot State 彻底解耦——动画不关心谁在消费它的值。这就是声明式架构落地的实际价值。

## Transition：统一帧回调的多属性协调

单个属性的动画用 `animate*AsState` 足够。多属性协同场景下，`updateTransition` 才是正确的选择。

踩过的一个坑：用四个独立的 `animateFloatAsState` 驱动按钮的位置、缩放、透明度和颜色。四个属性各自按自己的 Choreographer 回调更新，帧与帧之间的时间误差累积后，动画完全不同步。

`Transition` 的解法是创建一个总控目标状态，所有子动画共享同一个帧回调：

```kotlin
val transition = updateTransition(targetState = currentPage, label = "page")
val offsetX by transition.animateDp(
    transitionSpec = { tween(300) }, label = "offsetX"
) { page -> pageToOffset(page) }
val alpha by transition.animateFloat(
    transitionSpec = { tween(300) }, label = "alpha"
) { page -> pageToAlpha(page) }
```

内部实现中，`Transition` 维护一个 `_animations` 列表。`targetState` 变化时，遍历所有子动画，为每个属性创建 `TargetBasedAnimation`，在同一个 `withFrameNanos` 循环里批量更新：

```kotlin
// Transition 内部帧循环（简化）
while (animations.any { !it.isFinished }) {
    val frameTime = withFrameNanos { it }
    for (anim in animations) {
        val result = anim.animation.getValueFromNanos(frameTime - anim.startTime)
        anim.value = result.value  // 所有属性在同一帧内同步写入
    }
}
```

这是 Transition 与多个独立 `animate*AsState` 的本质区别——**不是并发，而是同步**。

## 性能边界和选型建议

翻 animation-core 源码时注意到的细节：`SpringSimulation` 的时间步长是固定的，不会因掉帧而调整。如果前一帧耗时过长，下一帧用更大的 `playTime` 输入物理模型，算出的位移就会跳变。这不是 bug，是物理引擎对掉帧的正确响应——但视觉上表现为"瞬移"。

实际项目中的选型判断：

- 纯装饰性动画（按钮 hover、滚动回弹）：`animate*AsState` + `spring()`，代码最少，效果符合物理直觉
- 多属性协同动画（页面切换、引导流程）：必须用 `Transition`，别省事堆多个 `animate*AsState`
- `Animatable` 是底层 API，需要手动管理协程生命周期。只有动画中途需要根据外部事件改变目标值时，直接操作 `Animatable` 才有意义——绝大多数场景用不上

Compose 的动画系统用起来顺手，是因为物理引擎、帧同步、状态管理三层封装都做对了。理解这套机制的价值很具体：知道 `spring(dampingRatio = 0.3f)` 会产生多次震荡，就不需要反复调参试错了。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Jetpack Compose](/jetpack-compose/)
- [Jetpack Compose 重组性能优化：Stability、derivedStateOf 与跳过重组](/blog/2026-05-07-Jetpack_Compose_%E9%87%8D%E7%BB%84%E6%80%A7%E8%83%BD%E5%85%A8%E9%93%BE%E8%B7%AF%E8%B0%83%E4%BC%98_%E4%BB%8E_Stability_%E6%8E%A8%E6%96%AD%E5%88%B0_derivedS/)
- [Jetpack Compose 原理与高级应用：状态、布局、重组与性能实践](/blog/Jetpack%20Compose%20%E9%AB%98%E7%BA%A7%E5%BA%94%E7%94%A8%E4%B8%8E%E5%8E%9F%E7%90%86/)
- [Jetpack Compose Modifier 原理：链式节点、布局绘制与事件处理](/blog/2026-05-15-Jetpack_Compose_Modifier_%E9%93%BE%E5%BC%8F%E6%9C%BA%E5%88%B6%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_Modifier_Node_/)
- [Jetpack Compose 手势系统：PointerInput 事件管道与嵌套滚动](/blog/2026-05-16-Jetpack_Compose_%E6%89%8B%E5%8A%BF%E7%B3%BB%E7%BB%9F%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E_PointerInput_%E4%BA%8B%E4%BB%B6%E7%AE%A1%E9%81%93%E5%88%B0_Modi/)
<!-- /seo-internal-links -->
