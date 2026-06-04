---
title: "Android App Shortcuts: ShortcutManager, Pinned Shortcuts, and Compose Adaptation"
lang: en
translationKey: android-app-shortcuts
slug: android-app-shortcuts
excerpt: "A full-chain guide to Android App Shortcuts, covering ShortcutManager limits, static and dynamic shortcut configuration, Intent routing, pinned shortcuts, and Compose icon and navigation adaptation."
publishDate: '2026-02-24'
tags:
- "Android"
- "App Shortcuts"
- "ShortcutManager"
- "Jetpack Compose"
- "Startup Optimization"
seo:
  title: "Android App Shortcuts: ShortcutManager, Pinned Shortcuts, and Compose"
  description: "Debug Android App Shortcuts through ShortcutManager limits, static and dynamic entries, Intent routing, pinned shortcuts, and Compose adaptation."
  pageType: article
---

During startup optimization, I found a strange issue: on a test device, the shortcut menu shown after long-pressing the app icon appeared only sometimes. Logcat had one line sitting there: "Shortcut exceeds max count." After investigation, the cause was clear. We had registered 6 dynamic shortcuts plus 4 static shortcuts, for a total of 10, while the system limit was 5. But the issue reproduced only on Android 8.0; newer versions looked fine.

That bug pushed me to map the full App Shortcuts path: registration, dispatch, and pinning.

## ShortcutManager's two channels: limits and priority

The shortcut count limit depends on API level. `ShortcutManager.getMaxShortcutCountPerActivity()` returns 5 on Android 8.0 (API 26), and static plus dynamic shortcuts share that quota. Starting with Android 9, the limit increases to 15, but Launcher long-press menus directly show only the first 5 and put the rest behind a "More" entry.

That was the root cause of the bug. Android 8.0 had only 5 total slots, so the system truncated by `rank` and dropped lower-priority shortcuts. Newer versions have a 15-item buffer, which is more forgiving, but some customized ROMs, such as Huawei EMUI and Xiaomi MIUI, may render only 4. In one sentence: how many shortcuts actually appear is decided by the Launcher, not by ShortcutManager.

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

The advantage of static shortcuts is that they do not require a cold start. They appear in the menu immediately after installation. The downside is that icons can only reference drawable resources, so server-delivered dynamic icons must use dynamic shortcuts.

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

`setRank()` controls ordering; smaller values appear earlier. One trap I hit: multiple business teams each called `addDynamicShortcuts()` and all set rank to 0, so users saw a nearly random order. We later centralized rank allocation in `ShortcutRepository`, assigning values by business priority with steps like 0, 10, and 20.

The difference between update and replacement is also easy to confuse: `addDynamicShortcuts()` appends, `setDynamicShortcuts()` fully replaces, and `updateShortcuts()` updates incrementally by ID. My default is to call `setDynamicShortcuts` each time to avoid leaving stale business entries around after they have been retired.

## Intent routing: two entry paths

After a shortcut is clicked, Intent delivery depends on the target Activity's current state:

- Foreground -> `onNewIntent()`
- Not foreground -> `onCreate()`

That means `handleIntent` logic must exist in both places:

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

There are two ways to pass custom data:

1. `Intent.putExtra()`: puts data directly into Intent extras. It is simple, but it pollutes the original Intent.
2. `ShortcutInfo.Builder.setExtras(PersistableBundle)`: persists data into the system service and clears it automatically on uninstall.

I prefer the second option. Use `EXTRA_SHORTCUT_ID` as the routing key, and keep only lightweight parameters in `PersistableBundle`, such as `{"tab": "pending"}`.

## Pinned Shortcuts: desktop icons controlled by the user

Unlike static and dynamic shortcuts, a Pinned Shortcut is created by explicit user action. The user drags it from the shortcut menu to the home screen, where it becomes an independent icon. During this process, the shortcut Intent is frozen by the system. Later content changes require explicit updates.

Requesting a pinned shortcut takes two steps:

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

The system shows a confirmation dialog. After the user taps "Add," an icon appears on the home screen. One behavior is important: once the Intent is frozen, calling `updateShortcuts` keeps the Intent unchanged. Only the label and icon refresh. To change navigation logic, the only option is to disable the old shortcut and create a new one.

Another easily missed parameter is the third argument to `requestPinShortcut`, which accepts an `IntentSender` for success or failure callbacks. If you pass `null`, the app has no idea whether the user confirmed or cancelled. I was burned by that once while adding product analytics.

Pinned Shortcut lifetime is independent of dynamic shortcuts. Even after `removeAllDynamicShortcuts()` is called, the pinned desktop icon remains valid. To remove it, call `disableShortcuts(listOf("pinned_order_9527"))`.

## Adaptation strategy for Compose

Compose does not provide a native shortcut management API. Under the hood, you still have to use `ShortcutManager`. The real adaptation work is in two areas: icon generation and navigation dispatch.

Shortcut icons in Compose need to convert `ImageBitmap` to `Bitmap`:

```kotlin
val imageBitmap = ImageBitmapConfig.Argb8888.toBitmap(
    painterResource(R.drawable.ic_shortcut), 96.dp, 96.dp
)
val icon = Icon.createWithAdaptiveBitmap(imageBitmap)
```

Using Coil to load network images for dynamic icons is technically possible, but frequent updates are not recommended. Every `updateShortcuts` call triggers Launcher icon redraw. If the frequency is high, home screen scrolling can drop frames.

The navigation dispatch trap is timing. You should not call `navController.navigate()` directly inside `handleIntent`, because the Compose tree may not have composed yet:

```kotlin
LaunchedEffect(Unit) {
    val shortcutId = activity.intent
        ?.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID)
    shortcutId?.let { viewModel.onShortcutTriggered(it) }
}
```

Hand the navigation command to the ViewModel, then consume it after Compose is stable. This avoids `IllegalStateException`. Another approach is to wrap navigation in a `Channel<Route>` and consume it from `LaunchedEffect`, which works well for flows that must navigate in order.

---

Before release, I usually do three things:

1. Run `adb shell dumpsys shortcut` to export all shortcuts, then verify each id and rank against expectations.
2. Test Launcher behavior on at least three devices from different brands. Pinned Shortcut behavior varies heavily across ROMs.
3. Use the Adaptive Icon format for shortcut icons and keep the core area at 48 dp x 48 dp; otherwise, some Launchers crop corner content.

ShortcutManager has barely changed over the last six years. The real variable has always been fragmented Launcher implementations. If you plan to ship server-driven shortcut configuration, adding a gradual rollout switch is safer than flipping everything at once.
