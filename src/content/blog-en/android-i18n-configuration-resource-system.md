---
title: "Android Internationalization: Configuration, Resources, and App Locale"
lang: en
translationKey: android-i18n-configuration-resource-system
slug: android-i18n-configuration-resource-system
excerpt: "A practical guide to Android internationalization, covering Configuration, ContextWrapper isolation, Android 13 per-app locales, and Crowdin translation pipelines."
publishDate: '2025-05-13'
tags:
- "Android"
- "Kotlin"
- "Internationalization"
- "Resource Management"
- "Architecture"
seo:
  title: "Android I18n: Configuration, Resources, and Per-App Locale"
  description: "Learn Android internationalization patterns from Configuration and ContextWrapper to Android 13 per-app locales, WebView caveats, and Crowdin CI pipelines."
  pageType: article
---

When I took over an overseas app, the product requirement sounded simple: after users switch languages inside the app, the change should take effect immediately without killing the process. At first I thought it was just a matter of changing the Locale. Once I dug in, I realized it involved the entire Android resource-loading chain: global side effects from Configuration, ContextWrapper-based interception, and the system-level APIs added in Android 13. Every step has traps.

## Global side effects of Configuration switching

Android uses `Configuration.locale` to decide whether to load resources such as `values-zh` or `values-en`. The most direct approach is to modify it:

```kotlin
val config = resources.configuration
config.setLocale(Locale.ENGLISH)
resources.updateConfiguration(config, resources.displayMetrics)
```

`updateConfiguration()` takes effect globally at the process level. If Activity A switches to English, Activity B changes too. More importantly, a Configuration change usually triggers Activity destruction and recreation unless `android:configChanges="locale"` is declared in `AndroidManifest.xml` to intercept it.

After declaring `configChanges`, the Activity no longer recreates, but every UI refresh must be handled manually in `onConfigurationChanged()`. Each Activity needs its own handling, so maintenance cost grows linearly with the number of screens. Once a project reaches a dozen pages, adding refresh logic to every `onConfigurationChanged` becomes a real tax.

## Isolating locale changes with ContextWrapper

Instead of modifying global state, intercept at the Context layer. The idea is to create a custom `ContextWrapper`, override `getResources()`, and return Resources with the target locale applied:

```kotlin
class LocaleContextWrapper(base: Context, locale: Locale) : ContextWrapper(base) {
    override fun getResources(): Resources {
        val config = Configuration(super.getResources().configuration)
        config.setLocale(locale)
        return base.createConfigurationContext(config).resources
    }
}
```

Mount it in `BaseActivity.attachBaseContext()`:

```kotlin
override fun attachBaseContext(newBase: Context) {
    val locale = Locale(LanguageManager.currentLanguage)
    super.attachBaseContext(LocaleContextWrapper(newBase, locale))
}
```

This approach isolates language switching within a single Activity and does not affect global state. When the Activity is recreated, the new Locale is applied automatically without manual intervention. AppCompat 1.6+ uses a similar idea under `AppCompatDelegate.setApplicationLocales()`, except it persists language preference in `AppLocalesMetadataHolderService` and manages it at the Application level.

One trap I hit: **WebView ignores your ContextWrapper**. WebView caches `ApplicationContext` Resources during initialization, so Configuration changes do not reach it. The fix is to explicitly pass a wrapped Context when creating the WebView:

```kotlin
val wrappedContext = LocaleContextWrapper(context, targetLocale)
WebView(wrappedContext)
```

## Android 13 per-app locale

Android 13 introduced a system-level solution: per-app language preferences. Users can set a separate language for each app in system settings, so the app no longer needs to build a separate language selector just for basic support.

The core API is `LocaleManager.setApplicationLocales()`:

```kotlin
val localeManager = context.getSystemService(LocaleManager::class.java)
localeManager.applicationLocales = LocaleList(Locale.forLanguageTag("zh"))
```

After this call, the system sends the `ACTION_LOCALE_CHANGED` broadcast. All Activities receive it, recreate automatically, and apply the new Locale. There is no need for ContextWrapper or manual Configuration management. This is the cleanest solution.

But the API has two hard limitations: it only works on Android 13+, and it is tied to the system settings panel. If your app needs a custom in-app language selector, you still need to maintain the UI and mapping logic.

In production, I usually wrap the behavior behind an abstraction and dispatch by Android version:

```kotlin
object LocaleDelegate {
    fun applyLocale(context: Context, tag: String) {
        val locale = Locale.forLanguageTag(tag)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.getSystemService(LocaleManager::class.java)
                ?.applicationLocales = LocaleList(locale)
        } else {
            LanguageManager.saveLocale(tag)
            // Restart the Activity stack manually so ContextWrapper can take effect.
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            context.startActivity(intent)
        }
    }
}
```

The tradeoffs across the three approaches are:

| Approach | Version requirement | Activity recreation | Intrusiveness |
|------|---------|-------------|--------|
| updateConfiguration | None | Manual handling required | Global |
| ContextWrapper | None | Automatic | Per Activity |
| Per-App Locale | Android 13+ | Automatic | No intrusion |

For new projects, I prefer Per-App Locale with ContextWrapper as the fallback. I no longer hand-roll the old `updateConfiguration` path.

## Crowdin translation pipeline

After language switching works, where do translations come from? Manually maintaining `values-zh/strings.xml` is painful once an app supports many languages. After integrating Crowdin, the process becomes:

1. Developers maintain only the English source file, `values/strings.xml`.
2. CI uploads source files to Crowdin through the Crowdin CLI.
3. The translation team collaborates on each language in the platform.
4. CI periodically downloads translation results and generates matching files such as `values-zh/strings.xml`.
5. The build packages the generated resources directly.

The GitHub Actions configuration can be reduced to a few lines:

```yaml
- name: Sync translations
  run: |
    crowdin upload sources --config crowdin.yml
    crowdin download --config crowdin.yml
```

Once the pipeline is running, one easy-to-miss issue is **translation file conflicts**. Content changed by translators in Crowdin can conflict with commits made by developers in the repository. The fix is to add generated translation outputs to `.gitignore`: commit only the English source file, and let CI generate all localized `strings.xml` files instead of keeping them in version control.

Another lesson is key naming. `btn_submit` may become "Submit" in English and "Send" in another language, but translators rely on key names and comments to understand context. A key like `order_confirm_btn` is much clearer than `btn_submit` and reduces back-and-forth clarification.

## Practical points

Do not hand-write `updateConfiguration` from scratch. AppCompat 1.6+ `setApplicationLocales()` already handles most compatibility cases. New projects should use a dual-track setup: Per-App Locale on supported versions and ContextWrapper as fallback.

Commit translation source files, not generated outputs. Add directories such as `values-zh/` to `.gitignore` to avoid merge conflicts during collaboration.

Landscape and portrait changes, dark mode, split-screen mode, and other Configuration changes must be included in regression testing. Custom Context propagation for WebView and Dialog is especially easy to miss; in real projects, those two areas cause the most trouble.
