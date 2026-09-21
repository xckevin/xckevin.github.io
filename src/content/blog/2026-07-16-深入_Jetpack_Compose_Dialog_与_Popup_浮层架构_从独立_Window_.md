---
title: 深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路
excerpt: 剖析 Compose 浮层（Dialog/Popup）基于独立 Window 的底层机制，涵盖 Window 创建、焦点管理与软键盘交互的完整工程链路。
publishDate: '2026-07-16'
tags:
- Android
- Jetpack Compose
- Kotlin
- 浮层架构
- 焦点管理
seo:
  title: Compose Dialog 与 Popup：独立 Window 创建与焦点管理
  description: 深入解析 Jetpack Compose 中 Dialog 与 Popup 的浮层架构：不是简单 View 叠加，而是独立 Window 实例。从 Window 创建、软键盘模式、焦点抢占到工程化实践，一文讲透声明式浮层的底层原理。
  pageType: article
slug: jetpack-compose-dialog-popup-window-focus
translationKey: jetpack-compose-dialog-popup-window-focus
updatedDate: '2026-09-21'
---

在做 Compose 项目时，一个同事提了个问题：「为什么 Dialog 里的 TextField 弹键盘会把整个界面顶上去，但 BottomSheet 里的就不会？」这个问题我一开始也觉得理所当然——直到翻了源码才发现，Compose 的浮层机制远比直觉复杂。Dialog 不是简单的 View 叠加，它背后是独立的 Window 实例，享有自己的焦点链和输入法交互策略。这篇文章把这条链路拆开来看。

## Compose 浮层不是 View 叠加，是 Window 嵌套

很多人的直觉是：Dialog 和 Popup 不过是 Compose 树上的一个节点，显示时 `zIndex` 调高就行。这个理解在 Compose 层面说得通——`Dialog` 和 `Popup` 确实以 Composable 形式出现在代码里，写法上和 `Box` 没什么区别。

但 Android Framework 不是这么工作的。浮层的本质是在当前 Activity 之上附加一个新的 Window。Compose 的 `Dialog`、`Popup`、`DropdownMenu` 统统走这条路，区别只在于 Window 的类型和参数配置。

```kotlin
// Popup 的核心实现片段（源码简化）
@Composable
fun Popup(
    onDismissRequest: (() -> Unit)? = null,
    properties: PopupProperties = PopupProperties(),
    content: @Composable () -> Unit
) {
    // ...
    PopupLayout(
        onDismissRequest = onDismissRequest,
        properties = properties,
        testTag = testTag,
        content = content
    )
}
```

[AndroidX 实现](https://github.com/androidx/androidx/blob/androidx-main/compose/ui/ui/src/androidMain/kotlin/androidx/compose/ui/window/AndroidPopup.android.kt) 中的 `PopupLayout` 继承 `AbstractComposeView`，通过 `WindowManager.addView(this, params)` 将自身添加到窗口。这里直接使用 `WindowManager`，并未包装 Android 的 `PopupWindow`。Dialog 则更彻底——它直接创建一个独立的 `Window`，挂到 Activity 的 Window 层级之上：

```kotlin
// AndroidDialog 的核心链路（简化）
DialogWrapper(
    onDismissRequest = onDismissRequest,
    properties = properties,
    content = content
).apply {
    // 内部创建一个新 Window，默认 windowType 为
    // WindowManager.LayoutParams.TYPE_APPLICATION（可通过 DialogProperties.windowType 自定义）
}
```

这里有个容易被误解的细节：Dialog 的 Compose 树确实挂在一个新的 Window 上，但 **CompositionLocal 并不会因此断开**。Compose 在 `Dialog` 内部通过 `rememberCompositionContext()` 获取当前位置的 `CompositionContext`，并在创建新 Window 的 `ComposeView` 时调用 `setParentCompositionContext()` 把它传进去。这样新 Window 上的 Composition 会作为子 Composition 挂在原 Composition 下，`CompositionLocalProvider` 提供的值可以正常跟着这条链路传递到 Dialog 内部。所以如果你在 Dialog 外部用 `CompositionLocalProvider` 提供了某个值（比如 `LocalContentColor` 或自定义 `CompositionLocal`），Dialog 内的 Composable 一样能读到。

但 `Scaffold` 的 `snackbarHostState` 不能在 Dialog 里直接用是另一个问题——那是因为 `SnackbarHost` 本身渲染在 Scaffold 的 Compose 树中（属于原 Window），而 Dialog 内的内容渲染在新 Window 上，两边是不同的视觉层。想在 Dialog 里触发 Snackbar，需要把 `snackbarHostState`（对象引用）直接传进去或通过 `CompositionLocalProvider` 共享，而不是 CompositionLocal 传递本身的问题。

## Popup 的聚焦模型：从软键盘说起

理解了 Window 独立性之后，软键盘行为就好解释了。回到开头的问题——为什么 Dialog 里的键盘行为“反常”？

关键在于 `WindowManager.LayoutParams` 中的 `flags`。Compose 的 `Popup` 实现里，`PopupProperties` 的 `focusable` 和 `clippingEnabled` 参数分别控制两个不同的标位（来自 AndroidPopup 源码 `createFlags()`）：

```kotlin
// AndroidPopup.android.kt 中的 flags 构造逻辑（简化）
private fun createFlags(
    focusable: Boolean,
    securePolicy: SecureFlagPolicy,
    clippingEnabled: Boolean,
): Int {
    var flags = WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
    if (!focusable) {
        flags = flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
    }
    if (securePolicy == SecureFlagPolicy.SecureOn) {
        flags = flags or WindowManager.LayoutParams.FLAG_SECURE
    }
    if (!clippingEnabled) {
        flags = flags or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
    }
    return flags
}
```

注意这里并没有直接操作 `softInputMode`：

- **`focusable`** 对应 `FLAG_NOT_FOCUSABLE`。不可然时（默认值 `false`），Popup 的 Window 完全不参与系统的焦点分配，输入方法事件、软键盘不会发往这个 Window，因此其内部即使有 `TextField` 也无法弹出键盘
- **`clippingEnabled`** 对应 `FLAG_LAYOUT_NO_LIMITS`，控制的是 Popup 能不能超出屏幕边界布局，与软键盘行为没有直接关系

系统对 `softInputMode` 的默认处理遵循普通 Window 的规则：只有获取了焦点的 Window 才会因输入框获得键盘而触发 resize/pan 行为。因此 `focusable = true` 的 Popup 能正常弹出键盘，具体是 resize 还是遮挡输入框，取决于 Activity 本身的 `windowSoftInputMode` 配置和设备行为，并不是 Popup 自己去根据 `clippingEnabled` 切换 resize 模式。

现实开发中更常用的接口是前面提到的 `WindowInsets.ime`，它能直接反映软键盘可见高度的变化，比去推敗8推 `softInputMode` 的实际行为更可靠。

**平台限制**：`Popup` 的 `focusable = false`（默认值）时，因为 Window 不可获取焦点，内部任何可输入控件都不会弹出软键盘，这是固定行为，与设备、厂商无关。想在 Popup 里用 `TextField` 必须把 `focusable` 设为 `true`。

## 焦点管理的暗流：谁在抢占焦点

Dialog 和 Popup 在焦点（Focus）策略上也存在深层差异。Android 的焦点模型是树状的，每个 Window 维护自己独立的焦点链。

Dialog 弹出时，系统会：

1. 创建一个新的 Window Token
2. 将新的 Window 推入 WindowManager 栈顶
3. 调用 `requestFocus()` 让新 Window 获得输入焦点
4. 底层 Activity Window 失去焦点，触发 `onWindowFocusChanged(false)`

而 Compose 的 `Popup` 行为更灵活，取决于 `focusable` 参数的设置：

```kotlin
// PopupProperties 的焦点控制
class PopupProperties(
    val focusable: Boolean = false,          // 是否抢占 Window 焦点
    val dismissOnBackPress: Boolean = true,  // 返回键是否关闭 Popup
    val dismissOnClickOutside: Boolean = true,
    val clippingEnabled: Boolean = true,
    // ...
)
```

`focusable = false` 的 Popup 是一个值得细看的设计：它在 WindowManager 中存在，但声明自己不接管焦点。这意味着：

- 底层 Activity 仍然持有焦点
- 触摸事件先到达 Popup Window，如果 Popup 不消费，则穿透到下层
- 键盘输入由底层 Window 处理，Popup 只是视觉浮层

这个设计适合 Tooltip、瞬时提示等非交互型浮层。但如果你在 `focusable = false` 的 Popup 里放了 TextField，点击输入框不会弹出键盘——因为焦点从未转移到 Popup 的 Window 上。这个问题排查起来很隐蔽，日志里不会报任何错误，键盘就是静默地不弹。

## Compose 焦点的二次封装：FocusManager 介入

以上是 Android Window 层面的焦点机制。Compose 在这个基础上又封装了一层 `FocusManager`，通过 `Modifier.focusable()` 和 `Modifier.onFocusChanged()` 提供声明式焦点控制。

Dialog 内部会创建独立的 `ComposeView` 和 `AndroidComposeView`，这意味着 Dialog 有自己完整的 Compose 焦点树，和宿主 Activity 的焦点树完全隔离。在 Dialog 的 Compose 作用域内，`FocusRequester` 的行为和普通 Composable 一致：

```kotlin
@Composable
fun MyDialog() {
    val focusRequester = remember { FocusRequester() }
    
    Dialog(onDismissRequest = { /* ... */ }) {
        TextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.focusRequester(focusRequester)
        )
    }
    
    LaunchedEffect(Unit) {
        focusRequester.requestFocus() // 在 Dialog 内部正常工作
    }
}
```

但如果想从 Activity 层控制 Dialog 内某个元素的焦点，就需要额外的手段——跨 Window 的焦点传递不经过 Compose 的 FocusManager。一种做法是通过 `MutableState` 传递焦点意图，在 Dialog 内部用 `LaunchedEffect` 响应变化。

## 软键盘交互的工程化实践

在实际项目中，浮层 + 输入法的交互是最容易出问题的场景。以下是我在项目中积累的几个实践。

### 场景一：底部弹出 Popup + TextField，键盘遮挡

如果 Popup 底部对齐屏幕底部，弹出键盘后 Popup 整体上移，但 Popup 内部布局没有相应调整，输入框仍然被键盘盖住。解决思路是监听键盘高度，手动偏移 Popup 内容：

```kotlin
@Composable
fun KeyboardAwarePopup() {
    val imeInsets = WindowInsets.ime.asPaddingValues()
    
    Popup(properties = PopupProperties(focusable = true)) {
        Column(
            modifier = Modifier
                .padding(bottom = imeInsets.calculateBottomPadding())
        ) {
            // 输入框等交互内容
        }
    }
}
```

这里 `WindowInsets.ime` 是 Compose 1.5+ 提供的 IME 内边距 API，比之前用 `ViewTreeObserver` 监听布局变化的方式稳定得多。

### 场景二：Dialog 内嵌 WebView 或 SurfaceView

Dialog Window 独立于 Activity 的 DecorView。如果你在 Dialog 里放了 WebView，WebView 内部会持有自己的 Window——这就形成了三层 Window 嵌套。Z-order、焦点转移、键盘交互都会出现不符合预期的行为。

我的建议是避免在 Dialog 中使用 SurfaceView 或 WebView。如果业务必须这样做，考虑用全屏 Fragment 代替 Dialog，或者在 Dialog 关闭前手动让 WebView 失去焦点。

### 场景三：Popup 与系统导航栏的冲突

`Popup` 默认是全 Window 范围布局。如果设置了 `alignment = Alignment.BottomCenter` 但没有处理导航栏高度，内容可能被导航栏遮挡。Compose 1.4+ 提供了 `WindowInsets.navigationBars` 来获取导航栏高度。

## 选型建议

Dialog、Popup、DropdownMenu 三者的本质差异在于 Window 策略，选型时我按这个优先级判断：

- **需要模态遮罩 + 阻止背景交互** → `Dialog`，它独占焦点且自动添加遮罩层
- **需要非阻塞浮层 + 轻量交互** → `Popup(focusable = true)`，享受浮层能力但不完全打断用户
- **纯视觉提示（Tooltip、Badge 尾标）→ `Popup(focusable = false)`，零焦点副作用**
- **选择列表、菜单 → `DropdownMenu`**，它内部帮你处理了弹出位置计算和关闭逻辑

还有一个容易被忽略的问题：Dialog 和 Popup 的内存泄漏风险。因为它们持有独立的 Window 和 View 引用，如果 Composable 在 Dialog 显示期间被移除（如横竖屏切换时），Window 可能未正确 dismiss。不过实际上 Compose 的 `Dialog` Composable 内部已经用 `DisposableEffect` 在 `onDispose` 中调用了 `dialog.dismiss()`（对应前文 `DialogWrapper`），正常使用无需自己再处理。真正需要注意的是**你自己手动持有的原生 `android.app.Dialog` 或 `PopupWindow` 实例**（比如在非 Compose 代码里创建、再嵌入 Compose 树），这种情况才需要自己兜底清理：

```kotlin
@Composable
fun LegacyDialogHost(showDialog: Boolean) {
    val context = LocalContext.current
    val dialog = remember {
        android.app.AlertDialog.Builder(context).create()
    }

    DisposableEffect(showDialog) {
        if (showDialog) dialog.show() else dialog.dismiss()
        onDispose {
            // 确保 Composable 卸载时，手动创建的 Dialog 也被 dismiss
            dialog.dismiss()
        }
    }
}
```

这套浮层机制本质上是 Android Window 体系的声明式封装。知道了 Window 在底层如何运作，Compose 的各种“怪异”行为就都有了解释。
