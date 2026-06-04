---
title: "Android 16 Predictive Back: Migration, Dispatchers, and Gesture-Driven Animation"
lang: en
translationKey: android-predictive-back
slug: android-predictive-back
excerpt: "A practical Android 16 Predictive Back migration guide covering OnBackInvokedDispatcher registration, OnBackAnimationCallback frame-driven animation, Fragment support, Compose PredictiveBackHandler, and a migration checklist."
publishDate: '2026-04-21'
tags:
- "Android"
- "Jetpack Compose"
- "Performance"
- "Architecture"
- "Animation"
seo:
  title: "Android 16 Predictive Back: Dispatcher, Animation, Fragment, and Compose Migration"
  description: "Migrate to Android 16 Predictive Back with OnBackInvokedDispatcher, animation callbacks, Fragment support, Compose handlers, and checks."
  pageType: article
---

After Android 16 Beta 4, Google officially announced that targetSdk 36 will force-enable Predictive Back. It will no longer be possible to opt out with `android:enableOnBackInvokedCallback="false"` the way Android 13 through 15 allowed. If your app still relies on `onBackPressed()` or `KeyEvent.KEYCODE_BACK`, users on Android 16 devices may see the system's default predictive back animation while your business logic never runs.

This is not a minor version upgrade. It is a forced architecture migration.

## Why `onBackPressed()` no longer works

The traditional back interception path was: user presses Back -> `KeyEvent` dispatch -> `Activity.onBackPressed()` -> `FragmentManager` consumes it. That model assumes "Back is an immediate event."

Predictive Back breaks that assumption. As soon as the user starts the gesture, the system must **know in advance** what Back will do so it can drive the preview animation. Back handling has to move from event-driven to state-driven: the system registers callbacks when the gesture starts, reads gesture progress in real time, and finally either commits or cancels the action.

`OnBackInvokedDispatcher` is the entry point for this new mechanism. Every `Window` owns a `WindowOnBackInvokedDispatcher`, and callbacks registered through it replace `onBackPressed()`:

```kotlin
// Wrong example: no longer reliable on targetSdk 36
override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack()
    else super.onBackPressed()
}

// Correct pattern
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

## The dispatcher priority trap

`OnBackInvokedDispatcher` has two built-in priority constants:

- `PRIORITY_DEFAULT = 0`: normal business logic
- `PRIORITY_OVERLAY = 1000000`: overlays such as IMEs and dialogs

The system invokes **only the highest-priority callback** and skips all others. This is completely different from the old `onBackPressed()` chain, where `super.onBackPressed()` could pass the event upward. That path no longer exists.

I hit one trap on a page with multiple Fragments: Fragment A and Fragment B both registered callbacks with `PRIORITY_DEFAULT`, and when both were present, only the last registered callback ran. The correct approach is to manage registration and unregistration with the Fragment lifecycle instead of registering once in `onCreate`:

```kotlin
// Correct Fragment pattern: bind registration to onResume/onPause
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

If you use `androidx.activity:activity:1.8+`, `OnBackPressedDispatcher` already adapts internally to `OnBackInvokedDispatcher`. You can keep using `addCallback`; Jetpack handles priority and lifecycle binding for you.

## OnBackAnimationCallback: the core of frame-driven animation

`OnBackInvokedCallback` has only one method, `onBackInvoked()`, so it is suitable for business logic that does not need animation. To drive predictive back animation, use `OnBackAnimationCallback`, which adds three more methods:

```kotlin
val animationCallback = object : OnBackAnimationCallback {
    override fun onBackStarted(backEvent: BackEvent) {
        // Gesture starts. backEvent contains the initial touch point and gesture progress.
        prepareExitAnimation()
    }

    override fun onBackProgressed(backEvent: BackEvent) {
        // Called every frame during the gesture to drive animation.
        // backEvent.progress: 0.0 ~ 1.0
        // backEvent.touchX/touchY: current touch position
        // backEvent.swipeEdge: LEFT or RIGHT
        updateAnimationProgress(backEvent.progress)
    }

    override fun onBackInvoked() {
        // User releases and confirms Back. Complete the exit animation.
        commitExitAnimation()
    }

    override fun onBackCancelled() {
        // User cancels the gesture. Restore the initial state.
        resetAnimation()
    }
}
```

`BackEvent.progress` is not linear. Google applies curve mapping to it, and values closer to 1.0 mean the user is more "committed" to going back. Using this value directly in `onBackProgressed` to drive `View` properties such as `scaleX`, `scaleY`, or `translationX` gives a gesture-following scale effect:

```kotlin
private fun updateAnimationProgress(progress: Float) {
    val scale = 1f - (progress * 0.1f) // Shrink down to 0.9 at most
    contentView.scaleX = scale
    contentView.scaleY = scale
    contentView.translationX = progress * 50f // Move toward the edge
}
```

One performance detail matters: `onBackProgressed` is called every frame. Do not trigger `requestLayout()` inside it. Stick to property animations that `RenderThread` can handle, such as `translationX`, `scaleX`, and `alpha`.

## Fragment migration: use FragmentManager's built-in support

`androidx.fragment:fragment:1.7+` has native Predictive Back support in `FragmentManager`. If you manage your Fragment stack with `addToBackStack()`, no extra handling is required. The system automatically generates predictive back animations for Fragment transactions.

For custom Fragment transition animations, prefer `setCustomAnimations` with `Animator` rather than `Animation`, because `Animator` supports seeking and can be driven by gesture progress:

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

If an older project uses `Animation` instead of `Animator`, gesture-driven Predictive Back falls back to the system default animation. It does not crash, but the experience degrades. `lint` will not catch this; only real-device testing will.

## What changes for Compose BackHandler

Starting with `androidx.activity:activity-compose:1.8`, `BackHandler` is wired into the new dispatcher internally. Usage stays the same:

```kotlin
BackHandler(enabled = showBottomSheet) {
    hideBottomSheet()
}
```

For gesture-driven animation, switch to `PredictiveBackHandler`:

```kotlin
PredictiveBackHandler(enabled = showBottomSheet) { progress ->
    // progress is Flow<BackEventCompat>
    try {
        progress.collect { backEvent ->
            // Update animation state
            sheetOffset = backEvent.progress
        }
        // Normal collect completion means the user confirmed Back
        hideBottomSheet()
    } catch (e: CancellationException) {
        // Coroutine cancellation means the user cancelled the gesture
        sheetOffset = 0f
    }
}
```

`PredictiveBackHandler` wraps gesture progress in a `Flow` and consumes it in a coroutine. When the gesture is cancelled, it reports that through `CancellationException`. The design is idiomatic Kotlin, but there is one trap: `progress.collect` is a suspending function. Do not perform slow work after `collect` and before the coroutine finishes, or you will block gesture response.

When multiple `BackHandler` or `PredictiveBackHandler` instances exist at the same time, **the last one with `enabled = true` wins**. This follows last-in-first-out behavior, matching `OnBackPressedDispatcher`.

## Migration checklist

When moving to targetSdk 36, check these items one by one.

**Search globally for `onBackPressed`.** Migrate all direct overrides, and inspect every `super.onBackPressed()` call for business logic dependencies.

**Check `KeyEvent.KEYCODE_BACK` listeners.** These are common in soft keyboard flows, but the new mechanism will not deliver that event.

**Handle WebView Back explicitly.** `WebView` does not automatically adapt to Predictive Back. Register a callback manually and call `webView.goBack()` from it.

**Audit Dialog and BottomSheetDialog.** `androidx.appcompat` `AlertDialog` is already adapted, but custom dialogs inheriting from `android.app.Dialog` need registration checks.

**Test on real devices.** Enable "Predictive back animations" in Developer options. Android 14+ devices can verify behavior before you have Android 16 hardware.

---

Predictive Back migration cost is concentrated in two kinds of screens: Activity or Fragment pages with custom back logic, and pages with exit animations. The first group is mostly mechanical replacement. The second needs `Animation` to become `Animator`, or Compose code to adopt `PredictiveBackHandler`.

I prefer implementing gesture-following animation directly in Compose with `PredictiveBackHandler` rather than using `OnBackAnimationCallback` in the View layer. The reason is simple: Compose's state-driven model naturally fits a "progress -> UI" mapping, and `Flow` cancellation is clearer than manually managing `onBackCancelled()`. View-layer `OnBackAnimationCallback` is better for migrating existing pages, because not every screen is worth rewriting.
