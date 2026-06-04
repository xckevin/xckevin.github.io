---
title: "Android 16 Edge-to-Edge: WindowInsets Dispatch and System Bar Adaptation"
lang: en
translationKey: android-edge-to-edge-windowinsets
slug: android-edge-to-edge-windowinsets
excerpt: "Android 16 treats forced edge-to-edge as a breaking change for targetSdk 36 apps. This guide explains the WindowInsets dispatch path and practical adaptation strategies for both View and Compose UIs."
publishDate: '2026-04-17'
tags:
- "Android"
- "WindowInsets"
- "Edge-to-Edge"
- "Performance"
- "System Compatibility"
seo:
  title: "Android 16 Edge-to-Edge: WindowInsets Dispatch and System Bars"
  description: "Adapt targetSdk 36 apps to Android 16 edge-to-edge with WindowInsets handling for status bars, navigation bars, IME, Views, and Compose."
  pageType: article
---

After upgrading to targetSdk 36, QA sent over a batch of screenshots: the bottom TabBar was half covered by the navigation bar, and status bar icons overlapped the Toolbar. This is not an isolated app problem. Android 16 Beta 3 makes forced edge-to-edge a breaking change. For every app targeting SDK 36 or higher, the system ignores `Window.setStatusBarColor()` and `setNavigationBarColor()`, then forces content to extend behind the system bars.

This article is not about a quick patch. It first walks through how WindowInsets are dispatched, then lays out adaptation strategies for both View-based and Compose-based UIs.

## Why Google is forcing this

Before Android 10 introduced `WindowCompat.setDecorFitsSystemWindows(window, false)`, apps ran by default inside a safe area clipped by the system. Content did not appear below the status bar or navigation bar. Apps set system bar colors themselves, often to solid black or white. The cost was a visible separation between app content and system bars on full-screen devices, plus awkward interaction around gesture areas.

Android 16's forced edge-to-edge behavior is essentially **taking that choice away from apps**. Google has recommended this adaptation for several releases, but adoption has not been high enough, so targetSdk 36 makes it mandatory. According to the platform behavior, `Window.setDecorFitsSystemWindows(false)` is applied automatically for targetSdk 36, and apps can no longer use any API to push content back above the system bars.

## The WindowInsets dispatch path

The system injects a `WindowInsets` object into the root of the View tree through `ViewRootImpl.dispatchApplyWindowInsets()`. From there, it is dispatched down the View hierarchy. Each `ViewGroup` calls `dispatchApplyWindowInsets()`, and child Views either consume or forward the insets. **Consumption is one-way**: once a View calls `insets.consumeSystemWindowInsets()`, later child Views no longer receive that portion of the insets.

```kotlin
// Default View behavior
override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    // The default implementation returns directly without consuming or changing anything.
    return insets
}
```

`WindowInsetsCompat` is Jetpack's wrapper around `WindowInsets`, with backward-compatible APIs. Use it consistently instead of the platform class:

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(view) { v, insetsCompat ->
    val systemBars = insetsCompat.getInsets(WindowInsetsCompat.Type.systemBars())
    val ime = insetsCompat.getInsets(WindowInsetsCompat.Type.ime())
    // systemBars includes statusBars + navigationBars + captionBar
    v.updatePadding(
        top = systemBars.top,
        bottom = systemBars.bottom
    )
    insetsCompat // Do not consume; keep dispatching to child Views
}
```

A common real-project bug appears after `updatePadding`: if a child View also listens to the same insets, you get **double padding**. The correct approach is to define clear layers in the View tree: the top-level View handles top insets, the bottom container handles bottom insets, and the middle layers do not apply the same insets again.

## Adapting View-based UIs

The core of View adaptation is **finding the right View node and applying padding or margin at the right place**, not adding padding to the root layout and calling it done.

### Status bar area

A `Toolbar` or custom top bar usually needs to handle `statusBars` insets:

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(toolbar) { v, insets ->
    val statusBar = insets.getInsets(WindowInsetsCompat.Type.statusBars())
    v.updateLayoutParams<ViewGroup.MarginLayoutParams> {
        topMargin = statusBar.top
    }
    insets
}
```

Use margin instead of padding. A Toolbar usually has a fixed height; changing padding pushes its content down, while changing margin moves the whole bar.

### Navigation bar area

Bottom navigation and FAB handling are similar, but you must distinguish gesture navigation from three-button navigation:

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(bottomNav) { v, insets ->
    val navBar = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
    v.updatePadding(bottom = navBar.bottom)
    insets
}
```

In gesture navigation mode, `navBar.bottom` is usually the height of `tappable_element`, around 20 dp. In three-button navigation, it is the full navigation bar height, around 48 dp. Never hardcode this value. Read it dynamically from insets.

### IME insets

With targetSdk 36, showing the soft keyboard no longer automatically resizes the Window. You need to handle `ime` insets manually. This is the part most often missed in real projects:

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(scrollView) { v, insets ->
    val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
    val navInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
    // When the IME is visible, use IME height; otherwise use navigation bar height.
    v.updatePadding(bottom = maxOf(imeInsets.bottom, navInsets.bottom))
    insets
}
```

`WindowInsetsAnimationCompat` can synchronize keyboard animation, but that is a separate topic.

## Adapting Compose UIs

Compose introduced native `WindowInsets` support after 1.5, but its mechanism differs from Views: **Compose passes insets through CompositionLocal, not through View tree dispatch.**

`Scaffold` already has built-in inset handling. If your structure is a standard `Scaffold + TopAppBar + BottomNavigationBar`, most cases only require using the right parameter:

```kotlin
Scaffold(
    topBar = { TopAppBar(title = { Text("Title") }) },
    bottomBar = { BottomNavigationBar() },
    contentWindowInsets = WindowInsets.safeDrawing // Use safeDrawing instead of systemBars
) { paddingValues ->
    // paddingValues already includes system bar insets
    LazyColumn(
        contentPadding = paddingValues
    ) { /* ... */ }
}
```

`WindowInsets.safeDrawing` is more complete than `WindowInsets.systemBars`. It includes the status bar, navigation bar, and display cutouts. On devices with notches or unusual screen shapes, using only `systemBars` can miss cutout areas. `safeDrawing` is the safer default.

### Manually consuming insets

Compose provides the `consumeWindowInsets()` modifier to mark a given inset type as already handled, preventing children from applying it again:

```kotlin
Column(
    modifier = Modifier
        .fillMaxSize()
        .windowInsetsPadding(WindowInsets.statusBars) // Apply padding
        .consumeWindowInsets(WindowInsets.statusBars)  // Mark as consumed
) {
    // Child Composables will not receive statusBars insets again
}
```

If you skip `consumeWindowInsets`, a child Composable that also calls `windowInsetsPadding(WindowInsets.systemBars)` will add top padding again and shift content incorrectly. This bug is hard to diagnose in mixed Compose hierarchies because it often looks like "just a bit too much blank space."

### Mixed View + Compose screens

This is the most troublesome case. When Compose content sits inside a `ComposeView`, and the outer View hierarchy has already consumed part of the insets, the Compose tree may receive a clipped version of `LocalWindowInsets`.

To check, log `WindowInsets.systemBars.asPaddingValues()` inside the Composable. If `top` is 0 but there is a real status bar, the outer View already consumed `statusBars` and the Compose layer should not handle it again. Conversely, if the outer View passes everything through, Compose must handle the full insets itself.

## Breaking-change details during migration

Beyond forced edge-to-edge, targetSdk 36 has several related changes to watch.

`Window.setStatusBarColor()` and `setNavigationBarColor()` are completely ignored under targetSdk 36. System bar colors become dynamic: light mode uses a light background with dark icons, and dark mode does the reverse. If your app has a brand-colored status bar, that visual style must be dropped under targetSdk 36, or simulated with a custom View covering the status bar area. The latter adds maintenance cost.

`android:windowSoftInputMode="adjustResize"` no longer works in edge-to-edge mode. Use `WindowInsetsAnimationCompat` or manually listen for `ime` insets instead.

**The `UnusedWindowInsets` lint rule is useful.** It can detect Views that receive insets but never apply them, which helps find missing adaptation points:

```groovy
android {
    lintOptions {
        enable "UnusedWindowInsets"
    }
}
```

## Practical guidance

**Handle insets by layer and define consumption boundaries.** View trees and Compose trees follow the same principle: if a layer handles a given inset type, it should consume that type there. Do not let multiple nodes apply the same inset. In debug builds, use `View.requestApplyInsets()` to verify whether inset values are what you expect.

**Test soft keyboard behavior separately.** IME insets are the easiest area to regress. Add Espresso plus `WindowInsetsController` automation in CI and cover layout snapshots with the keyboard shown and hidden. One lesson from production: every ScrollView or BottomSheet layout change almost inevitably risks keyboard overlap, and automation is the only reliable way to catch it before review misses it.

Android 16's forced change does increase adaptation work in the short term. But after the inset model is unified, UI code becomes clearer. At minimum, you no longer need to maintain a pile of system bar color settings that only work on specific API levels.
