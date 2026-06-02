---
title: 深入 Android 共享元素转场动画全链路：从 View 系统的 ActivityOptions 到 Compose SharedTransitionScope 的声明式过渡架构
excerpt: 本文系统梳理 Android 共享元素转场动画的两套实现体系：View 体系的 ActivityOptions（Snapshot → GhostView → RenderThread 动画）和 Compose 的 SharedTransitionScope 声明式过渡，涵盖底层机制、常见踩坑与渐进迁移策略。
publishDate: '2025-10-07'
tags:
- Android
- Jetpack Compose
- 动画
- SharedTransitionScope
- 性能优化
seo:
  title: 深入 Android 共享元素转场动画全链路：从 View 系统的 ActivityOptions 到 Compose SharedTransitionScope 的声明式过渡架构
  description: 从 View 体系的 ActivityOptions 到 Compose 的 SharedTransitionScope，系统梳理 Android 共享元素转场动画的底层机制、Snapshot 时机、渲染管线差异与渐进迁移策略。
---

做共享元素转场时踩过一个诡异的坑：两个 Activity 之间传了一个 ImageView，在 Pixel 设备上动画丝滑，到了某厂商的低端机上却直接闪白屏。排查发现，厂商 ROM 改了 Window 的动画帧提交时序，导致共享元素的 snapshot 还没生成完，过渡就已经开始了。这个问题的根源，得从 View 体系 Transition API 的底层机制聊起。

## View 体系：ActivityOptions 的共享元素是怎么工作的

`ActivityOptions.makeSceneTransitionAnimation()` 在 Activity 间传递共享元素，是 Android 5.0 引入的经典做法：

```kotlin
val options = ActivityOptions.makeSceneTransitionAnimation(
    this,
    Pair(imageView, "shared_image"),
    Pair(titleView, "shared_title")
).toBundle()
startActivity(intent, options)
```

B 页面在 `setContentView` 之前调用 `Window.setSharedElementEnterTransition()`，系统自动走完三步：A 页面共享元素截图 → 以 Overlay 形式叠加到 Window 上 → 执行动画变换 → B 页面真实 View 淡入。流程不复杂，但 Framework 层做的事不少。核心分三阶段：

**Snapshot 阶段**。A 页面 View 通过 `View.drawToBitmap()` 生成 Bitmap。如果 View 层级中有 SurfaceView 或 TextureView——视频播放场景很常见——`drawToBitmap` 只能拿到黑图。硬件渲染层的内容不在 View 的 Canvas 绘制路径里，这个限制没有 workaround。

**Ghost View 阶段**。截图被封装为 **GhostView**，挂在 DecorView 的 ViewOverlay 上。GhostView 不参与 measure/layout，只在 draw 阶段把 Bitmap 绘制到指定位置。共享元素动画期间触摸事件不会传递给 GhostView——它不在事件分发链路里。

**Transition 阶段**。Transition 框架计算起始和结束位置的矩阵变换（scale + translate），通过 `TransitionValues` 驱动属性动画。动画的实际执行线程是 RenderThread，主线程只负责提交 Animator 起始值和每帧更新回调。

完整调用时序：

```
Activity A  finish()  →  生成 Snapshot  →  GhostView 挂载
    ↓
Activity B  onCreate()  →  setEnterTransition()
    ↓
Transition 计算矩阵  →  RenderThread 执行动画  →  GhostView 移除
```

## Snapshot 时机与 Window 层级

实战中最容易出问题的是 Snapshot 的时机。

Android 默认在调用 `startActivity()` 后立刻触发 A 页面的 `onPause()`，但如果 B 页面的启动模式是 `singleTop` 且已存在于栈中，A 的 `onPause` 不会立即调用，Snapshot 迟迟不生成。后果是点击后卡顿半秒，然后直接跳转，动画消失。

`setExitSharedElementCallback` 的使用时机也是一个高频坑。回调里可以拦截 Snapshot 生成：

```kotlin
setExitSharedElementCallback(object : SharedElementCallback() {
    override fun onSharedElementEnd(
        names: List<String>,
        elements: List<View>,
        snapshots: List<View>
    ) {
        // 这里可以手动清理资源
    }
})
```

共享元素来自 RecyclerView Item 时，`onSharedElementStart` 回调触发时 View 可能已经因为列表回收而 `isAttachedToWindow == false`，`drawToBitmap` 直接返回透明图。解法是在 Adapter 的 `onViewRecycled` 里主动调用 `View.setTransitionName(null)`，告知 Transition 框架跳过这个 View 的 snapshot。

## Compose 方案：SharedTransitionScope 的声明式转变

View 体系的共享元素 API 分散在 Activity、Window、Fragment 三个层面，生命周期管理靠回调，出错时没有编译期提示。Compose 1.7 引入的 **SharedTransitionScope** 用声明式重新设计了这套机制——不依赖 Activity 边界，在 Compose 渲染树内通过 `sharedElement()` 修饰符标记同一棵（或不同棵）Compose 树中的节点，运行时自动计算过渡动画。

```kotlin
SharedTransitionScope {
    var showDetail by remember { mutableStateOf(false) }

    AnimatedContent(showDetail) { target ->
        when (target) {
            true -> DetailScreen(Modifier.sharedElement(
                state = rememberSharedContentState(key = "hero"),
                animatedVisibilityScope = this
            ))
            false -> ListScreen(Modifier.sharedElement(
                state = rememberSharedContentState(key = "hero"),
                animatedVisibilityScope = this
            ))
        }
    }
}
```

和 View 体系不同，这里不传 `transitionName` 字符串，而是用共享的 `SharedContentState` 对象。这个 State 内部保存了源端和目标端的位置、大小和 alpha 值。`AnimatedContent` 触发重组切换时，Compose 渲染引擎自动在两个 Composition 节点之间做属性插值。

## SharedTransitionScope 的渲染管线

Compose 共享元素动画完全绕过了 View 体系的 GhostView 机制：

1. Compose 的 `LayoutNode` 在测量阶段记录共享元素在源布局中的位置和尺寸。
2. 目标 `LayoutNode` 出现时，Modifier 层的 `sharedElement()` 拦截测量结果，计算矩阵变换。
3. 动画直接作用在 Compose 的 **RenderNode** 层——等价于 View 体系的 RenderThread 动画。

关键差异：Compose 不需要 Snapshot。源和目标的像素数据都在 GPU 缓存中，省掉了 `drawToBitmap` 一步。前面提到的 SurfaceView 黑图问题也自然规避了——如果你的共享元素是 `Image` 或 `Box` 包裹的内容，过渡动画零额外开销。

现实约束是：**SharedTransitionScope 只能处理 Compose 树内的过渡**。如果 A 页面是 View 体系的 Activity，B 页面是 Compose，跨体系的共享元素目前没有官方方案。我的做法是在 A 页面手动截 Bitmap，B 页面的 Compose 入口处用 `graphicsLayer` 模拟过渡动画，体验能接近原生效果，但确实多了维护成本。

## 两套体系的工程选型

| 维度 | View 体系 | Compose SharedTransitionScope |
|------|----------|------|
| 运行范围 | Activity/Fragment 间 | Compose 树内或跨 Composition |
| 实现机制 | GhostView + Snapshot | RenderNode 属性插值 |
| SurfaceView 兼容 | 需手动处理 | 不涉及（无 Snapshot 步骤） |
| 生命周期管理 | 回调 + 手动清理 | Compose 自动管理 |
| 调试难度 | 难以追踪 | Layout Inspector 可观测 |

纯 Compose 项目里，SharedTransitionScope 是更优的选择。但 View 和 Compose 混用的存量工程，短期内 `ActivityOptions` 依然是主力。折中策略：新页面用 Compose + `AnimatedContent` 做页内过渡，跨 Activity 的共享元素保持 View 体系方案，等 Compose Navigation 支持 `SharedTransitionScope` 的跨目的地动画后再统一迁移。

我在实际项目中更倾向于用 `AnimatedContent` + `sharedElement` 替代 ViewPager + Fragment 的 Tab 切换过渡——Compose 不需要处理 Fragment 生命周期同步的问题。但涉及 WebView 或地图 SDK 这类重型 View 的页面，别硬套 `SharedTransitionScope`，这些 View 的渲染不在 Compose 管线里，过渡效果要么丢帧要么直接不走动画。

## 实践工具箱

**调试共享元素动画**。View 体系下，开发者选项中打开「显示布局边界」和「过渡动画缩放 10x」，能直观看到 GhostView 的绘制区域和动画时长。Compose 下用 Layout Inspector 查看 `sharedElement` Modifier 挂载的节点属性变化。

**避免 Snapshot 失败**。View 体系里，确保共享元素的 View 在 `onSharedElementStart` 回调时仍处于 `attached` 状态。列表场景在 `onViewRecycled` 里清掉 `transitionName`。

**渐进迁移策略**。存量工程先在 Compose 子页面（Dialog、BottomSheet、Tab 内）试用 `SharedTransitionScope`，验证动画效果和性能后，再向主流程扩展。别一次性把所有 Activity 过渡都改掉——排查问题时你会感谢自己留了回退路径。
