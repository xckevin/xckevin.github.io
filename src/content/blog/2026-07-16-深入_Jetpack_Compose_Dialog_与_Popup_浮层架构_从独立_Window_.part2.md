---
title: "深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路（2）：Compose 焦点的二次封装：FocusManager 介入"
excerpt: "「深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路」系列第 2/2 篇：Compose 焦点的二次封装：FocusManager 介入"
publishDate: 2026-07-16
displayInBlog: false
series:
  name: "深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路"
  part: 2
  total: 2
seo:
  title: "深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路（2）：Compose 焦点的二次封装：FocusManager 介入"
  description: "「深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路」系列第 2/2 篇：Compose 焦点的二次封装：FocusManager 介入"
---


> 本文是「深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路」系列的第 2 篇，共 2 篇。在上一篇中，我们探讨了「Compose 浮层不是 View 叠加，是 Window 嵌套」的相关内容。

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

---

**「深入 Jetpack Compose Dialog 与 Popup 浮层架构：从独立 Window 创建到焦点管理的声明式浮层全链路」系列目录**

1. Compose 浮层不是 View 叠加，是 Window 嵌套
2. **Compose 焦点的二次封装：FocusManager 介入**（本文）
