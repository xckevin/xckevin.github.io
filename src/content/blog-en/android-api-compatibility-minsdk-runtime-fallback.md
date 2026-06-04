---
title: "Android API Compatibility: minSdk, Lint, and Runtime Fallbacks"
lang: en
translationKey: android-api-compatibility-minsdk-runtime-fallback
slug: android-api-compatibility-minsdk-runtime-fallback
excerpt: "A practical Android API compatibility strategy covering NewApi Lint, SDK_INT checks, reflection fallbacks, AndroidX Compat choices, CI enforcement, and low-version testing."
publishDate: '2026-01-28'
tags:
- "Android"
- "API Compatibility"
- "Lint"
- "Crash Prevention"
- "Engineering Practices"
seo:
  title: "Android API Compatibility: NewApi Lint and Runtime Fallbacks"
  description: "Build an Android API compatibility process with NewApi Lint, SDK_INT guards, reflection fallbacks, AndroidX Compat APIs, CI checks, and low-version tests."
  pageType: article
---

Last year I took over crash cleanup for an old project. Firebase reported a high-frequency crash with a three-line stack trace:

```text
java.lang.NoSuchMethodError: android.view.WindowInsetsController#setSystemBarsAppearance
```

`setSystemBarsAppearance` was introduced in API 30, while the project's `minSdk` was 23. It worked perfectly on the developer machine running Android 13. In production, many users were still on Android 9 and Android 10, where that method does not exist, so the app crashed immediately.

The bug was not about one bad line of code. It exposed a team-level lack of API compatibility awareness. The unsafe call was invisible during development, low-version testing did not cover the feature, and users became the test environment.

The compatibility system you want, from compile time to runtime, follows one rule: **make incompatible API calls visible during development, not after users trigger crashes.**

## Compile-Time Defense: NewApi Lint

Android Lint includes the built-in `NewApi` check. It scans calls to APIs whose level is higher than your `minSdkVersion`.

Lint maintains an API version database with the minimum API level for each class, method, and field. During analysis, it compares the target API level of each call with the project's `minSdkVersion`. If they do not match, it reports a warning.

By default this is only a yellow warning in the IDE, and it is easy to ignore. To make it impossible to ignore, promote it to an error in `build.gradle`:

```groovy
android {
    lint {
        warningsAsErrors = true
        check += "NewApi"
    }
}
```

After this configuration, any API call without proper version protection can fail the build.

NewApi still has two blind spots. The first is **reflection**: APIs accessed through `Class.forName()` or `Method.invoke()` are outside Lint's normal call graph. The second is **third-party SDKs**: AAR dependencies usually do not include source code, so their internal API calls are not scanned the same way.

I cover the reflection path below. For third-party SDKs, I usually prefer running full integration tests on low-version devices. That is far more practical than auditing every SDK source path manually.

## Two Patterns for SDK_INT Checks

Compile-time checks catch explicit calls. Runtime behavior still needs `Build.VERSION.SDK_INT`.

The most direct form is `if-else`:

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    window.insetsController?.setSystemBarsAppearance(
        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
    )
} else {
    @Suppress("DEPRECATION")
    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
}
```

There are two common traps.

First, **the else branch also has a minimum API level**. `SYSTEM_UI_FLAG_LIGHT_STATUS_BAR` was introduced in API 23. If your `minSdk` is 21, the else branch above can still crash on Android 5.0. Version checks must validate both the high-version branch and the fallback branch.

Second, **`@Suppress("DEPRECATION")` needs a comment**. An uncommented suppress annotation looks like laziness during code review. Add a short explanation such as `// Compatibility path: API 23-29 use the legacy system UI flag`, so future maintainers understand the intent immediately.

When behavior differs across multiple version ranges, `when` is clearer than nested `if-else`:

```kotlin
when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> handleApi33Plus()
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> handleApi30To32()
    else -> handleLegacy()
}
```

Keep the number of branches around three or four. Split by **versions where behavior actually changes**, not by every API level.

## Reflection and Compat: Two Fallback Paths

An `SDK_INT` check assumes the high-version API's class is available to the compiler and simply must not be executed on older devices. Some APIs are different: the class itself does not exist in the lower compile SDK you are using, so you cannot even write a direct reference.

That is when reflection appears:

```kotlin
try {
    val method = Class.forName("android.view.WindowInsetsController")
        .getMethod("setSystemBarsAppearance", Int::class.javaPrimitiveType)
    method.invoke(controller, 8) // APPEARANCE_LIGHT_STATUS_BARS = 1 << 3
} catch (e: Exception) {
    // Fallback handling
}
```

The constant `APPEARANCE_LIGHT_STATUS_BARS` is hard-coded as `8` here. The lower SDK does not have that symbol, so the value has to be calculated manually. Android framework constant values rarely change, but this style fights the framework design and should be reserved for narrow escape hatches.

The safer option is an AndroidX Compat class. `WindowInsetsControllerCompat` wraps reflection and `SDK_INT` checks internally:

```kotlin
val controller = WindowInsetsControllerCompat(window, window.decorView)
controller.isAppearanceLightStatusBars = true
```

One line gives consistent behavior across versions. The cost is an AndroidX dependency, which is effectively zero if the project already uses AndroidX.

My rule is simple: **use Compat when Compat covers the case; use reflection and hard-coded constants only when it does not.** The maintenance cost is completely different. Compat behavior evolves with AndroidX upgrades. Reflection code you own depends on manual upkeep. I have been burned by both: after one AndroidX upgrade, a small Compat behavior change took one version bump to resolve; a homegrown reflection path cost an afternoon just to diagnose.

## Engineering Rollout: Put Checks Into CI

If the practices above live only in a coding guidelines document, they will fade. A few engineering controls make API compatibility the team's default behavior.

**Run Lint in CI.** Add `./gradlew lintRelease` to the CI pipeline. If Lint reports an error, fail the build. Any unguarded new API call then fails merge checks.

**Build a `@ChecksSdkIntAtLeast` annotation pattern.** AndroidX provides this annotation to mark methods that perform `SDK_INT` checks. The IDE can understand it, trace the call chain, and avoid false-positive lint warnings. Six months later, the annotation also documents the original compatibility intent.

**Keep one fixed code review checklist item.** Every review should ask: does the new API call match `minSdk`? Is there a version guard? This rule is more effective for training new developers than any slide deck.

**Automate low-version device tests.** Run core flows on a `minSdk`-level device in Firebase Test Lab. This catches issues static analysis cannot see: wrong constants in reflection, third-party SDK behavior differences, and fallback paths that nobody manually exercised.

## Practical Principles

Set NewApi Lint to error. It takes about ten minutes and blocks more than 90% of API compatibility crashes. The return on investment is hard to beat.

Prefer AndroidX Compat APIs. When Compat does not cover a case, use `SDK_INT` plus `if-else` guards. Reflection with hard-coded constants is the last resort and should be used only when the class itself is unavailable.

Do not lower `minSdk` casually. Every lower version adds another compatibility range to maintain. In the projects I have worked on, `minSdk` is decided early through research, and after that it only moves upward.
