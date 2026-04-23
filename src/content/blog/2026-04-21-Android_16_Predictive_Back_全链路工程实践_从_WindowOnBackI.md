---
title: Android 16 Predictive Back 全链路工程实践：从 WindowOnBackInvokedDispatcher 到 Compose BackHandler 的迁移与动画架构解析
excerpt: Android 16 强制开启 Predictive Back，本文系统讲解 OnBackInvokedDispatcher 注册机制、OnBackAnimationCallback 帧驱动动画、Fragment 与 Compose PredictiveBackHandler 的迁移实践，并附完整迁移检查清单。
publishDate: '2026-04-21'
tags:
- Android
- Jetpack Compose
- 性能优化
- 架构设计
- 动画
seo:
  title: Android 16 Predictive Back 全链路工程实践：从 WindowOnBackInvokedDispatcher 到 Compose BackHandler 的迁移与动画架构解析
  description: 深入解析 Android 16 强制 Predictive Back 迁移方案，涵盖 OnBackInvokedDispatcher 优先级、OnBackAnimationCallback 帧动画、Fragment 与 Compose PredictiveBackHandler 实践及迁移检查清单。
---

Android 16 Beta 4 发布后，Google 正式宣布 targetSdk 36 将强制开启 Predictive Back（预测性返回），不再像 Android 13–15 那样允许通过 `android:enableOnBackInvokedCallback="false"` 跳过。如果你的 App 还在用 `onBackPressed()` 或 `KeyEvent.KEYCODE_BACK`，用户在 Android 16 设备上会看到系统默认的预测返回动画，但你的业务逻辑可能压根不触发。

这不是小版本升级，是一次强制架构迁移。

## 为什么 `onBackPressed()` 彻底失效了

传统的返回拦截链路是：用户按返回 → `KeyEvent` 传递 → `Activity.onBackPressed()` → `FragmentManager` 消费。这套机制建立在"返回是一个即时事件"的假设上。

Predictive Back 打破了这个假设。用户开始手势时，系统就要**提前知道**返回会发生什么，才能驱动预览动画。这要求返回处理从事件驱动变成状态驱动——系统在手势开始时注册回调，实时获取手势进度，最后在确认或取消时执行逻辑。

`OnBackInvokedDispatcher` 是这套新机制的入口。每个 `Window` 持有一个 `WindowOnBackInvokedDispatcher` 实例，通过它注册的回调会替代 `onBackPressed()`：

```kotlin
// 错误示范：这在 targetSdk 36 上不再可靠
override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack()
    else super.onBackPressed()
}

// 正确写法
private val callback = OnBackInvokedCallback {
    if (webView.canGoBack()) webView.goBack()
    else finish()
}

override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_DEFAULT,
        callback
    )
}

override fun onDestroy() {
    super.onDestroy()
    onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
}
```

## Dispatcher 注册优先级的坑

`OnBackInvokedDispatcher` 内置两个优先级常量：

- `PRIORITY_DEFAULT = 0`：普通业务逻辑
- `PRIORITY_OVERLAY = 1000000`：覆盖层（输入法、对话框等）

系统只触发**优先级最高的那个回调**，其余全部跳过。这与 `onBackPressed()` 的链式调用完全不同——以前可以 `super.onBackPressed()` 把事件往上传，现在这条路没了。

我踩过一个坑：在含多个 Fragment 的页面，Fragment A 和 Fragment B 都以 `PRIORITY_DEFAULT` 注册了回调，同时存在时只有最后注册的那个生效。正确做法是在 Fragment 的生命周期里管理注册和注销，而不是在 `onCreate` 里一次性注册：

```kotlin
// Fragment 里的正确写法：跟随 onResume/onPause 管理
override fun onResume() {
    super.onResume()
    requireActivity().onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback
    )
}

override fun onPause() {
    super.onPause()
    requireActivity().onBackInvokedDispatcher.unregisterOnBackInvokedCallback(backCallback)
}
```

如果用的是 `androidx.activity:activity:1.8+`，`OnBackPressedDispatcher` 已经内部适配了 `OnBackInvokedDispatcher`，继续用 `addCallback` 即可，Jetpack 帮你处理优先级和生命周期绑定。

## OnBackAnimationCallback：帧驱动动画的核心

`OnBackInvokedCallback` 只有一个 `onBackInvoked()` 方法，适合不需要动画的业务逻辑。要驱动预测返回动画，需要用 `OnBackAnimationCallback`，它额外提供三个方法：

```kotlin
val animationCallback = object : OnBackAnimationCallback {
    override fun onBackStarted(backEvent: BackEvent) {
        // 手势开始，backEvent 包含起始触摸点和手势进度
        prepareExitAnimation()
    }

    override fun onBackProgressed(backEvent: BackEvent) {
        // 手势进行中，每帧回调，驱动动画
        // backEvent.progress: 0.0 ~ 1.0
        // backEvent.touchX/touchY: 当前触摸位置
        // backEvent.swipeEdge: LEFT or RIGHT
        updateAnimationProgress(backEvent.progress)
    }

    override fun onBackInvoked() {
        // 用户松手确认返回，完成退出动画
        commitExitAnimation()
    }

    override fun onBackCancelled() {
        // 用户取消手势，恢复初始状态
        resetAnimation()
    }
}
```

`BackEvent.progress` 不是线性的，Google 对它做了曲线映射，越接近 1.0 表示用户越"确定"要返回。在 `onBackProgressed` 里直接用这个值驱动 `View` 的 `scaleX/scaleY` 或 `translationX`，可以实现跟手的缩放效果：

```kotlin
private fun updateAnimationProgress(progress: Float) {
    val scale = 1f - (progress * 0.1f) // 最多缩小到 0.9
    contentView.scaleX = scale
    contentView.scaleY = scale
    contentView.translationX = progress * 50f // 向边缘偏移
}
```

性能上有一点要注意：`onBackProgressed` 是每帧回调，里面不要触发 `requestLayout()`，只做 `RenderThread` 能处理的属性动画（`translationX`、`scaleX`、`alpha` 等）。

## Fragment 适配：用 FragmentManager 的内置支持

`androidx.fragment:fragment:1.7+` 的 `FragmentManager` 已经原生支持 Predictive Back。如果用 `addToBackStack()` 管理 Fragment 栈，不需要额外处理，系统会自动为 Fragment 事务生成预测返回动画。

自定义 Fragment 切换动画时，推荐用 `setCustomAnimations` 配合 `Animator` 而非 `Animation`，因为 `Animator` 支持 seek，可以被手势进度驱动：

```kotlin
fragmentManager.commit {
    setCustomAnimations(
        R.animator.slide_in,   // enter
        R.animator.slide_out,  // exit
        R.animator.slide_in,   // popEnter
        R.animator.slide_out   // popExit
    )
    replace(R.id.container, DetailFragment())
    addToBackStack(null)
}
```

旧项目如果用的是 `Animation` 而非 `Animator`，Predictive Back 的手势驱动功能会 fallback 到系统默认动画——不崩溃，但体验降级。这个问题 `lint` 不会报，只有实机测试才能发现。

## Compose BackHandler 的变化

`androidx.activity:activity-compose:1.8` 起，`BackHandler` 内部已接入新的 Dispatcher，用法没变：

```kotlin
BackHandler(enabled = showBottomSheet) {
    hideBottomSheet()
}
```

要实现手势驱动动画，需要换用 `PredictiveBackHandler`：

```kotlin
PredictiveBackHandler(enabled = showBottomSheet) { progress ->
    // progress 是 Flow<BackEventCompat>
    try {
        progress.collect { backEvent ->
            // 更新动画状态
            sheetOffset = backEvent.progress
        }
        // collect 正常结束 = 用户确认返回
        hideBottomSheet()
    } catch (e: CancellationException) {
        // 协程取消 = 用户取消手势
        sheetOffset = 0f
    }
}
```

`PredictiveBackHandler` 用 `Flow` 包装手势进度，在协程里消费，取消手势时通过 `CancellationException` 通知。设计很 Kotlin 原生，但有个坑：`progress.collect` 是挂起函数，`collect` 之后、协程结束之前不能做耗时操作，否则会阻塞手势响应。

多个 `BackHandler` 或 `PredictiveBackHandler` 同时存在时，**最后一个 `enabled = true` 的会生效**，遵循后进先出逻辑，与 `OnBackPressedDispatcher` 行为一致。

## 迁移检查清单

迁移到 targetSdk 36 时，以下几个点务必逐一确认：

**全局搜索 `onBackPressed`。** 直接 override 的全部迁移，调用 `super.onBackPressed()` 的地方确认是否还有业务逻辑依赖。

**检查 `KeyEvent.KEYCODE_BACK` 的监听。** 软键盘场景里很常见，新机制下不会收到这个事件。

**WebView 的返回处理。** `WebView` 没有自动适配 Predictive Back，需要手动注册回调并在其中调用 `webView.goBack()`。

**Dialog 和 BottomSheetDialog。** `androidx.appcompat` 的 `AlertDialog` 已经适配，继承自 `android.app.Dialog` 的自定义 Dialog 要检查回调注册是否正确。

**实机测试。** 在开发者选项里开启"预测性返回动画"，Android 14+ 设备可以提前验证，不必等 Android 16 真机。

---

Predictive Back 的迁移成本主要集中在两类场景：有自定义返回逻辑的 Activity/Fragment，以及有退出动画的页面。前者基本是机械替换，后者需要把 `Animation` 改成 `Animator`，或在 Compose 里接入 `PredictiveBackHandler`。

我更倾向于在 Compose 层直接用 `PredictiveBackHandler` 实现跟手动画，而不是在 View 层用 `OnBackAnimationCallback`。原因很直接：Compose 的状态驱动天然契合"进度 → UI"的映射，`Flow` 的取消机制也比手动管理 `onBackCancelled()` 清晰得多。View 层的 `OnBackAnimationCallback` 更适合存量页面迁移，毕竟不是所有界面都值得重写。
