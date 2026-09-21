---
title: "Compose Dialog, Popup, and Window Focus"
lang: en
translationKey: jetpack-compose-dialog-popup-window-focus
slug: jetpack-compose-dialog-popup-window-focus
excerpt: "Why a TextField inside a Dialog pushes the UI up but one inside a BottomSheet doesn't: a practical look at Compose overlays, Window focus, and IME behavior."
publishDate: '2026-07-16'
tags:
- "Jetpack Compose"
- "Android Window"
- "Popup"
- "Dialog"
- "Soft Keyboard"
seo:
  title: "Compose Dialog, Popup, and Window Focus Explained"
  description: "Why Dialog and Popup handle focus and the soft keyboard differently in Jetpack Compose, and how Window-level flags drive that behavior."
  pageType: article
updatedDate: '2026-09-21'
---

While working on a Compose project, a colleague asked: “Why does a TextField inside a Dialog push the entire UI up when the keyboard opens, but the same TextField inside a BottomSheet doesn't?” At first the question seemed trivial to me—until I dug into the source code and realized Compose's overlay mechanism is far more complex than intuition suggests. A Dialog is not a simple View stacked on top; behind it is an independent Window instance with its own focus chain and IME interaction strategy. This article breaks that chain open.

## Compose overlays are not stacked Views; they are nested Windows

Many people's intuition is that Dialog and Popup are just nodes in the Compose tree, and that showing them is simply a matter of raising `zIndex`. That understanding works at the Compose level—`Dialog` and `Popup` do appear as composables in code, and syntactically they are no different from a `Box`.

But Android Framework doesn't work that way. An overlay is essentially a new Window attached on top of the current Activity. Compose's `Dialog`, `Popup`, and `DropdownMenu` all use this path; the only difference is the Window type and parameter configuration.

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

In the [AndroidX implementation](https://github.com/androidx/androidx/blob/androidx-main/compose/ui/ui/src/androidMain/kotlin/androidx/compose/ui/window/AndroidPopup.android.kt), `PopupLayout` extends `AbstractComposeView` and attaches itself through `WindowManager.addView(this, params)`. It does not wrap an Android `PopupWindow`. Dialog goes further—it directly creates an independent `Window` and attaches it above the Activity's Window hierarchy:

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

There is a detail here that is easy to misunderstand: the Dialog's Compose tree is indeed mounted on a new Window, but the **CompositionLocal is not broken because of this**. Inside `Dialog`, Compose obtains the current `CompositionContext` through `rememberCompositionContext()`, and when creating the new Window's `ComposeView`, it calls `setParentCompositionContext()` to pass it in. This makes the Composition on the new Window attach as a child Composition of the original Composition, so values provided by `CompositionLocalProvider` can flow along this chain into the Dialog. Therefore, if you provide a value outside the Dialog with `CompositionLocalProvider` (for example `LocalContentColor` or a custom `CompositionLocal`), composables inside the Dialog can read it as well.

But the fact that `Scaffold`'s `snackbarHostState` cannot be used directly in a Dialog is a different issue—it's because `SnackbarHost` itself renders in Scaffold's Compose tree (which belongs to the original Window), while content inside Dialog renders on the new Window; the two are different visual layers. To trigger a Snackbar inside a Dialog, you need to pass the `snackbarHostState` (object reference) in directly or share it via `CompositionLocalProvider`; this is not a problem with CompositionLocal propagation itself.

## Popup's focus model: starting from the soft keyboard

Once you understand Window independence, the soft keyboard behavior becomes easy to explain. Returning to the original question—why does the keyboard behavior inside a Dialog seem “abnormal”?

The key lies in the `flags` in `WindowManager.LayoutParams`. In Compose's `Popup` implementation, the `focusable` and `clippingEnabled` parameters of `PopupProperties` control two different flag bits (from the `createFlags()` method in the AndroidPopup source):

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

Notice that it does not directly manipulate `softInputMode`:

- **`focusable`** corresponds to `FLAG_NOT_FOCUSABLE`. When it is not focusable (the default is `false`), the Popup's Window does not participate in the system's focus allocation at all, and input method events and the soft keyboard are not sent to this Window; therefore, even if it contains a `TextField`, the keyboard cannot be opened.
- **`clippingEnabled`** corresponds to `FLAG_LAYOUT_NO_LIMITS`, and controls whether the Popup can lay out beyond the screen boundary; it has no direct relationship to soft keyboard behavior.

The system's default handling of `softInputMode` follows the rules for ordinary Windows: only a Window that has gained focus will trigger resize/pan behavior because an input field received the keyboard. Therefore, a Popup with `focusable = true` can open the keyboard normally. Whether the result is resize or the input field being covered depends on the Activity's own `windowSoftInputMode` configuration and device behavior, not on the Popup switching resize mode based on `clippingEnabled`.

In real development, the more commonly used interface is `WindowInsets.ime`, mentioned earlier, which directly reflects changes in the visible height of the soft keyboard and is more reliable than trying to infer the actual behavior of `softInputMode`.

**Platform limitation**: When `Popup` has `focusable = false` (the default), the Window cannot acquire focus, so any input control inside it will not open the soft keyboard. This is fixed behavior, independent of device or manufacturer. To use a `TextField` inside a Popup, you must set `focusable` to `true`.

## The undercurrent of focus management: who is grabbing focus

Dialog and Popup also differ deeply in focus strategy. Android's focus model is tree-shaped, and each Window maintains its own independent focus chain.

When a Dialog opens, the system does the following:

1. Creates a new Window token
2. Pushes the new Window onto the top of the WindowManager stack
3. Calls `requestFocus()` to give the new Window input focus
4. The underlying Activity Window loses focus and triggers `onWindowFocusChanged(false)`

Compose's `Popup` behavior is more flexible and depends on the `focusable` parameter:

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

A `focusable = false` Popup is a design worth looking closer at: it exists in WindowManager but declares that it does not take over focus. This means:

- The underlying Activity still holds focus
- Touch events first reach the Popup Window; if the Popup does not consume them, they pass through to the layer below
- Keyboard input is handled by the underlying Window; the Popup is only a visual overlay

This design suits non-interactive overlays such as tooltips and transient hints. But if you put a TextField inside a `focusable = false` Popup, tapping the input field will not open the keyboard—because focus never transfers to the Popup's Window. This problem is very hard to diagnose: no error appears in logs; the keyboard simply stays silent.

## Compose's second layer of focus encapsulation: FocusManager enters

The above is the focus mechanism at the Android Window level. On top of this, Compose adds another layer with `FocusManager`, providing declarative focus control through `Modifier.focusable()` and `Modifier.onFocusChanged()`.

Dialog internally creates a separate `ComposeView` and `AndroidComposeView`, which means a Dialog has its own complete Compose focus tree, fully isolated from the host Activity's focus tree. Inside the Dialog's Compose scope, `FocusRequester` behaves the same as in any ordinary composable:

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

But if you want to control the focus of an element inside the Dialog from the Activity layer, you need extra measures—cross-Window focus transfer does not go through Compose's `FocusManager`. One approach is to pass focus intent through a `MutableState`, and respond to changes inside the Dialog with a `LaunchedEffect`.

## Engineering practice for soft keyboard interaction

In real projects, overlay + input method interaction is the area most prone to problems. Below are a few practices I have accumulated.

### Scenario 1: bottom-anchored Popup + TextField, keyboard occlusion

If the Popup is anchored to the bottom of the screen, after the keyboard opens the whole Popup moves up, but if the Popup's internal layout does not adjust accordingly, the input field is still covered by the keyboard. The solution is to observe the keyboard height and manually offset the Popup content:

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

Here `WindowInsets.ime` is the IME inset API provided in Compose 1.5+; it is much more stable than the previous approach of using `ViewTreeObserver` to observe layout changes.

### Scenario 2: Embedding WebView or SurfaceView in a Dialog

A Dialog Window is independent of the Activity's DecorView. If you put a WebView in a Dialog, the WebView internally holds its own Window—this forms a three-layer Window nesting. Z-order, focus transfer, and keyboard interaction can all behave unexpectedly.

My advice is to avoid using SurfaceView or WebView in a Dialog. If the business requirement makes it unavoidable, consider using a full-screen Fragment instead of a Dialog, or manually remove focus from the WebView before the Dialog closes.

### Scenario 3: Popup conflicts with the system navigation bar

`Popup` by default lays out over the entire Window area. If you set `alignment = Alignment.BottomCenter` but do not account for navigation bar height, the content may be covered by the navigation bar. Compose 1.4+ provides `WindowInsets.navigationBars` to obtain the navigation bar height.

## Selection guidance

The essential difference among Dialog, Popup, and DropdownMenu lies in their Window strategies. When choosing, I judge by this priority:

- **Need a modal mask + block background interaction** → `Dialog`; it exclusively owns focus and automatically adds a mask layer
- **Need a non-blocking overlay + lightweight interaction** → `Popup(focusable = true)`; enjoy overlay capability without fully interrupting the user
- **Pure visual hints (tooltips, badge tail labels)** → `Popup(focusable = false)`; zero focus side effects
- **Selection lists, menus → `DropdownMenu`**; it handles popup positioning and closing logic for you

There is another easily overlooked issue: the memory leak risk of Dialog and Popup. Because they hold independent Window and View references, if the composable is removed while the Dialog is displayed (for example during a configuration change), the Window may not be dismissed correctly. In practice, however, Compose's `Dialog` composable already uses `DisposableEffect` to call `dialog.dismiss()` in `onDispose` internally (corresponding to `DialogWrapper` mentioned earlier), so normal usage does not require additional handling. What you really need to watch for are **native `android.app.Dialog` or `PopupWindow` instances that you hold manually** (for example, created in non-Compose code and then embedded into the Compose tree); only in those cases do you need to handle cleanup yourself:

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

This whole overlay mechanism is essentially a declarative wrapper over Android's Window system. Once you understand how Window operates underneath, Compose's various “strange” behaviors all have explanations.
