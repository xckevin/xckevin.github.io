---
title: "Android Task Stack and Activity Launch Modes: A Full-Path Guide"
lang: en
translationKey: android-task-stack-launch-modes
slug: android-task-stack-launch-modes
excerpt: "A practical guide to Android Tasks, the back stack, standard, singleTop, singleTask, and singleInstance, with Intent flags and taskAffinity tradeoffs."
publishDate: '2026-03-18'
tags:
- "Android"
- "Activity"
- "Task Stack"
- "Launch Modes"
- "Architecture"
seo:
  title: "Android Task Stack and Activity Launch Modes: standard, singleTop, singleTask"
  description: "Understand Android Tasks, launchMode behavior, Intent flags, taskAffinity, notification navigation, home reuse, and common singleTask traps."
  pageType: article
---

## A navigation bug that exposed the real problem

Last year, while working on an e-commerce app, I ran into a strange bug: a user tapped a product notification, landed on the product detail page, pressed Back, and went straight to the launcher instead of returning to the app's home page. The product manager mentioned me in the group chat three times.

After debugging, we found that the notification click used an Intent without `FLAG_ACTIVITY_NEW_TASK`, so the detail page was inserted into the system task that launched the notification. After the user backed out, the app's own task was still sitting in the background, but the user had no way to return to it.

At its core, this was a task-stack management bug. This article walks through Activity launch modes and Task management from the ground up.

## The core model: Task and back stack

Android uses a **Task** to organize a set of Activities. Each Task maintains an internal back stack. When the user presses Back, the system pops the top Activity from the current Task. Tasks can be switched independently, and each one keeps its own stack state.

**A Task is a container for Activities, not a process.** One process may hold multiple Tasks, and Activities inside one Task may come from different processes.

The system manages Tasks through three main inputs:

- **launchMode**: decides how Activity instances are reused
- **Intent Flag**: dynamically overrides default behavior for each launch
- **taskAffinity**: specifies which Task an Activity belongs to

Together, these decide "when the user taps a button, which screen opens, and which stack does it land in?"

## How the four launchMode values behave

### standard

This is the default mode. Every launch creates a new instance and puts it into the caller's Task. The caller and callee must be in the same Task, which is the right default for most cases.

```kotlin
// A is in Task1, B starts with standard
// Result: a new B instance is created in Task1, stack: A -> B
startActivity(Intent(this, BActivity::class.java))
```

### singleTop

If the target Activity is already at the top of the current Task, the system reuses that instance and calls `onNewIntent()`. If it is not on top, the system creates a new instance.

This fits search pages and detail pages where repeated taps should not keep stacking identical screens.

```kotlin
// Repeated searches should not produce Search -> Search -> Search
class SearchActivity : AppCompatActivity() {
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        // Refresh results with the new query instead of creating a new page
    }
}
```

### singleTask

The system keeps only one instance of this Activity. When launching it, if an instance already exists in the target Task, the system clears every Activity above it (`clearTop`) and then calls `onNewIntent()`.

The key difference between singleTask and singleTop is this: **singleTask does not only reuse the instance; it destructively clears the stack.** If you jump from a child page back to the home page, every intermediate page is destroyed. That is not a bug. It is the meaning of `clearTop`.

```xml
<activity
    android:name=".MainActivity"
    android:launchMode="singleTask" />
```

### singleInstance

This is a stronger version of singleTask. The Activity owns an entire Task, and that Task cannot hold any other Activity.

I rarely use it in real projects. It fits cases such as video-call floating windows or isolated settings pages that need complete separation. The cost is that navigation to other pages crosses Task boundaries, which makes animation and back behavior harder to handle.

## Intent Flag: runtime control

`launchMode` is declared statically in the Manifest. Intent flags adjust behavior dynamically for each `startActivity()` call. When they conflict, **flags have higher priority.**

Common flags:

| Flag | Behavior |
|------|----------|
| `FLAG_ACTIVITY_NEW_TASK` | Starts the Activity in a new Task |
| `FLAG_ACTIVITY_CLEAR_TOP` | Clears every Activity above the target |
| `FLAG_ACTIVITY_SINGLE_TOP` | Same behavior as singleTop |
| `FLAG_ACTIVITY_CLEAR_TASK` | Clears the target Task before launch; must be used with NEW_TASK |

```kotlin
// Notification navigation: clear the target Task to avoid stale stack entries
val intent = Intent(context, MainActivity::class.java).apply {
    flags = Intent.FLAG_ACTIVITY_NEW_TASK or 
            Intent.FLAG_ACTIVITY_CLEAR_TASK
}
// Then navigate to the detail page
intent.putExtra("target", "detail")
intent.putExtra("id", productId)
```

`CLEAR_TASK` with `NEW_TASK` clears the entire Task that contains the target Activity and makes the target Activity the new root. This combination is almost mandatory for notification and deep-link entry points.

## taskAffinity: an underrated stack-separation tool

The default `taskAffinity` is the app's package name. When an Activity has a different `taskAffinity` from the caller and is launched with `FLAG_ACTIVITY_NEW_TASK`, the system starts it in a separate Task.

```xml
<activity
    android:name=".WebViewActivity"
    android:taskAffinity=".webview"
    android:launchMode="singleTask" />
```

With this setup, the WebView page appears as an independent card in Recents. The user can switch back to it separately without mixing it into the main app navigation stack. I have used this pattern to isolate third-party login and payment pages. After payment, users return to the app through a separate task card, which keeps the experience cleaner.

## Three practical scenarios

### Notification navigation that returns "home"

Problem: after entering any page from a notification, pressing Back should return to the home page instead of exiting the app.

Solution:

```kotlin
fun buildNotificationIntent(context: Context, targetPage: String, id: String): Intent {
    // Start the home page first and clear the old stack
    val intent = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        putExtra("navigateTo", targetPage)
        putExtra("itemId", id)
    }
    return intent
}
```

`MainActivity` parses `navigateTo` in `onCreate` or `onNewIntent` and then navigates to the target page. The back stack becomes `MainActivity -> DetailActivity`, so Back returns to the home page.

### Home reuse and the singleTask trap

After setting the home page to `singleTask`, calling `startActivity(MainActivity::class.java)` from a child page clears every page above `MainActivity`, including the child page itself.

If you only want to bring the home page to the front without destroying intermediate pages, use:

```kotlin
val intent = Intent(this, MainActivity::class.java).apply {
    flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
}
```

`REORDER_TO_FRONT` moves `MainActivity` to the top of the stack without clearing other Activities. This flag is less widely known, but it is gentler than singleTask for home-return behavior.

### singleInstance and onActivityResult conflicts

When a `singleInstance` Activity starts another Activity, the new Activity is placed in **another Task**. This breaks `startActivityForResult`: Android does not deliver a result across Task launches.

One bug I hit: a `singleInstance` login page launched third-party authorization with `startActivityForResult`, and the callback never arrived. Switching to `ActivityResultLauncher` with the `NEW_TASK` flag fixed it.

## Common pitfalls

**Pitfall 1: `singleTask` triggers `onNewIntent`, not `onCreate`.** Initialization written only in `onCreate` may not run. I usually extract page setup into a `handleIntent(intent)` method and call it from both lifecycle paths.

**Pitfall 2: `FLAG_ACTIVITY_NEW_TASK` does not always create a new Task.** If the target Activity's `taskAffinity` matches the current Task, the system may still place it in the current Task. This is not counterintuitive: Activities with the same affinity are meant to be in the same Task.

**Pitfall 3: `singleInstance` plus `clearTop` can behave inconsistently on some ROMs.** Some vendors modify Task management logic. Calling `finishAffinity()` to manually clear the stack before launching is more reliable than depending on vendor behavior.

In day-to-day development, I prefer **Intent flags over Manifest launchMode** for controlling behavior. Flags are configured per scenario, which is flexible and avoids global side effects. I reserve Manifest launchMode for the few Activities that truly need global reuse, such as the home page or a WebView container.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Fragment and FragmentManager: lifecycle, transactions, and state loss](/en/blog/android-fragment-fragmentmanager/)
- [Android multi-process architecture: WebView isolation and Remote Service stability](/en/blog/android-multiprocess-architecture/)
- [Android configuration changes and ViewModel: surviving rotation without leaking state](/en/blog/android-configuration-changes-viewmodel/)
<!-- /seo-internal-links -->
