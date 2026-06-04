---
title: "Android App Shortcuts Deep Dive: ShortcutManager, Pinning, and Compose"
lang: en
translationKey: android-app-shortcuts-shortcutmanager-deep-dive
slug: android-app-shortcuts-shortcutmanager-deep-dive
excerpt: "A deep dive into Android App Shortcuts, covering ShortcutManager limits, static and dynamic shortcut configuration, Intent routing, pinned shortcuts, and Jetpack Compose integration."
publishDate: '2026-02-24'
tags:
- "Android"
- "App Shortcuts"
- "ShortcutManager"
- "Jetpack Compose"
- "Startup Optimization"
seo:
  title: "Android App Shortcuts: ShortcutManager, Pinning, and Compose"
  description: "Analyze Android App Shortcuts from ShortcutManager limits and static or dynamic setup to Intent routing, pinned shortcuts, Launcher behavior, and Compose."
  pageType: article
---

While working on startup optimization, I ran into a strange issue: on a test device, the shortcut menu shown by long-pressing the app icon appeared only sometimes. Logcat contained a line saying `Shortcut exceeds max count`. After investigating, we confirmed the cause: we registered 6 dynamic shortcuts and 4 static shortcuts, for a total of 10, while the system limit was 5. But the issue only reproduced on Android 8.0. Newer versions behaved normally.

That bug pushed me to trace the full App Shortcuts lifecycle: registration, dispatch, and pinning.

## ShortcutManager's two channels: limits and priority

The shortcut count limit depends on the API version. `ShortcutManager.getMaxShortcutCountPerActivity()` returns 5 on Android 8.0, API 26, and static and dynamic shortcuts share that quota. Starting with Android 9, the limit increased to 15, but the Launcher long-press menu still directly displays only the first 5 shortcuts. The rest are placed behind a "more" entry.

That was the root cause of the bug: Android 8.0 leaves only 5 total slots. The system truncates by `rank`, and lower-priority shortcuts are dropped. Newer versions have a larger 15-item buffer, but some customized ROMs, such as Huawei EMUI and Xiaomi MIUI, may render only 4. In short: how many shortcuts the user actually sees is decided by the Launcher, not ShortcutManager.

Static shortcuts are declared in XML:

```xml
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:shortcutId="search"
        android:enabled="true"
        android:shortcutShortLabel="@string/search_short"
        android:icon="@drawable/ic_search_adaptive">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="com.example.app"
            android:targetClass="com.example.app.SearchActivity" />
    </shortcut>
</shortcuts>
```

The advantage of static shortcuts is that they do not require a cold start. They are available in the menu immediately after installation. The downside is that the icon can only reference a drawable resource. Dynamic icons delivered by a server must be handled through dynamic shortcuts.

Dynamic shortcuts are built at runtime:

```kotlin
val shortcut = ShortcutInfo.Builder(this, "dynamic_search")
    .setShortLabel("Search orders")
    .setLongLabel("Search historical orders and shipments")
    .setIcon(Icon.createWithAdaptiveBitmap(remoteBitmap))
    .setIntent(Intent(Intent.ACTION_VIEW, null, this, MainActivity::class.java))
    .setRank(0)
    .build()
shortcutManager.dynamicShortcuts = listOf(shortcut)
```

`setRank()` controls ordering. Lower values appear earlier. One pitfall I hit: multiple business teams each called `addDynamicShortcuts()` and set every rank to 0, so the order users saw was effectively random. We later centralized rank assignment in a `ShortcutRepository`, using business priority values such as 0, 10, and 20.

The difference between update and replacement is also easy to confuse. `addDynamicShortcuts()` appends, `setDynamicShortcuts()` replaces the full set, and `updateShortcuts()` updates incrementally by ID. My habit is to call `setDynamicShortcuts` and overwrite the full list each time, which prevents stale entries from retired features.

## Intent routing: dispatch from two entry points

After a shortcut is tapped, the Intent delivery path depends on the target Activity's current state:

- Foreground: `onNewIntent()`
- Not foreground: `onCreate()`

That means `handleIntent` logic has to exist in both places:

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleShortcutIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShortcutIntent(intent)
    }

    private fun handleShortcutIntent(intent: Intent?) {
        when (intent?.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID)) {
            "search" -> navigateToSearch()
            "order_history" -> viewModel.loadOrderHistory()
        }
    }
}
```

Custom data can be passed through two channels:

1. `Intent.putExtra()`: put data directly into Intent extras. It is simple, but it pollutes the original Intent.
2. `ShortcutInfo.Builder.setExtras(PersistableBundle)`: persist data into the system service. The data is automatically cleared on uninstall.

I prefer the second option, using `EXTRA_SHORTCUT_ID` as the routing key and keeping only lightweight parameters in the `PersistableBundle`, such as `{"tab": "pending"}`.

## Pinned Shortcuts: user-driven desktop pinning

Unlike static and dynamic shortcuts, a Pinned Shortcut is created by a user action. The user drags a shortcut from the menu to the home screen, where it becomes an independent icon. During that process, the shortcut's Intent is frozen by the system, and later content changes require explicit updates.

Requesting a pin takes two steps:

```kotlin
if (ShortcutManagerCompat.isRequestPinShortcutSupported(this)) {
    val pinInfo = ShortcutInfoCompat.Builder(this, "pinned_order_9527")
        .setShortLabel("Order #9527")
        .setIcon(IconCompat.createWithResource(this, R.drawable.ic_order))
        .setIntent(Intent(Intent.ACTION_VIEW, null, this, OrderActivity::class.java).apply {
            putExtra("order_id", "9527")
        })
        .build()
    ShortcutManagerCompat.requestPinShortcut(this, pinInfo, null)
}
```

The system shows a confirmation dialog. After the user taps "Add," an icon appears on the home screen. A key behavior matters here: once the Intent has been frozen, calling `updateShortcuts` keeps the Intent unchanged. Only the label and icon are refreshed. To change navigation behavior, the only option is to disable the old shortcut and create a new one.

Another easily missed parameter is the third argument of `requestPinShortcut`, which accepts an `IntentSender` for success or failure callbacks. If you pass null, the app has no idea whether the user confirmed or canceled. I once ran into this exact problem while adding analytics.

Pinned Shortcut lifecycle is independent from dynamic shortcuts. Even after `removeAllDynamicShortcuts()` is called, pinned home-screen icons remain valid. To remove one, call `disableShortcuts(listOf("pinned_order_9527"))`.

## Adaptation strategy for Compose

Compose does not provide a native shortcut-management API, so the underlying implementation still goes through `ShortcutManager`. The real adaptation work is in two areas: icon generation and navigation dispatch.

Shortcut icons in Compose need to convert an `ImageBitmap` to a `Bitmap`:

```kotlin
val imageBitmap = ImageBitmapConfig.Argb8888.toBitmap(
    painterResource(R.drawable.ic_shortcut), 96.dp, 96.dp
)
val icon = Icon.createWithAdaptiveBitmap(imageBitmap)
```

Loading network images with Coil for dynamic icons is technically feasible, but frequent updates are not recommended. Every `updateShortcuts` call triggers a Launcher icon redraw. If the frequency is too high, home-screen scrolling can start dropping frames.

Navigation dispatch has a timing pitfall. `handleIntent` cannot call `navController.navigate()` directly because the Compose tree may not have been composed yet:

```kotlin
LaunchedEffect(Unit) {
    val shortcutId = activity.intent
        ?.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID)
    shortcutId?.let { viewModel.onShortcutTriggered(it) }
}
```

Hand the navigation instruction to the ViewModel and consume it after Compose is stable. This avoids `IllegalStateException`. Another approach is to wrap navigation in a `Channel<Route>` and consume it from `LaunchedEffect`, which works well when multiple navigation actions need to be processed in order.

---

Before release, I usually do three things:

1. Run `adb shell dumpsys shortcut` to export all shortcuts, then verify every ID and rank against expectations.
2. Test Launcher behavior on at least three physical devices from different brands. Pinned Shortcut behavior varies heavily across ROMs.
3. Use Adaptive Icon format for shortcut icons and keep the core area at 48dp x 48dp. Otherwise, some Launchers will crop corner content.

The ShortcutManager API has barely changed in six years. The real variable has always been fragmented Launcher behavior. If you plan to support server-delivered shortcut configuration, a gradual rollout switch is safer than shipping everything at once.
