---
title: "Android Share Framework: ShareCompat, Chooser, and Dynamic Targets"
lang: en
translationKey: android-share-framework-chooser-targets
slug: android-share-framework-chooser-targets
excerpt: "An end-to-end look at Android sharing, from ShareCompat intent construction and Chooser target resolution to Direct Share dynamic targets and Compose integration."
publishDate: '2026-06-07'
tags:
- "Android"
- "Kotlin"
- "Jetpack Compose"
- "Intent"
- "Architecture"
seo:
  title: "Android Share Framework: ShareCompat and Chooser Targets"
  description: "Understand Android sharing from ShareCompat and Chooser resolution to Direct Share targets, Compose adapters, and common implementation traps."
  pageType: article
---

Last year, while building share features for a social app, product wanted recently contacted friends to appear directly on the system share sheet. I initially thought `Intent.createChooser()` would be enough. In practice, Android's share framework is deeper: intent construction, chooser rendering, and dynamic Direct Share targets each have their own mechanism.

This article walks through that system end to end.

## Share Entry: What ShareCompat Does

The share entry is an Intent carrying `ACTION_SEND` or `ACTION_SEND_MULTIPLE`. You can construct it manually, but `ShareCompat` handles MIME inference and stream permissions more reliably:

```kotlin
val shareIntent = ShareCompat.IntentBuilder(context)
    .setType("text/plain")
    .setText("Share this text")
    .createChooserIntent()
    .apply {
        putExtra(Intent.EXTRA_TITLE, "Choose target")
    }
startActivity(shareIntent)
```

`createChooserIntent()` wraps the original SEND intent inside an `ACTION_CHOOSER` intent. The target intent is placed in `EXTRA_INTENT`, so the framework enters the chooser-specific path instead of ordinary activity launch resolution.

MIME type matters. Text should use `text/plain`, images often use `image/*`, and mixed content needs both text and `EXTRA_STREAM`. Missing or inaccurate MIME types are a common reason for an empty or broken share sheet.

## How Chooser Matches Targets

When `ACTION_CHOOSER` reaches the system, Android does not immediately launch an app. It resolves possible targets first.

**Step 1: Resolve the original SEND intent.** The system extracts `EXTRA_INTENT` and calls PackageManager's query APIs to find activities with matching `intent-filter` declarations.

**Step 2: Merge chooser-specific entries.** `EXTRA_INITIAL_INTENTS` can inject custom targets at the top of the sheet:

```kotlin
val initialIntents = arrayListOf<Intent>()
resolveInfoList.forEach { resolveInfo ->
    val targetIntent = Intent(shareIntent).apply {
        component = ComponentName(
            resolveInfo.activityInfo.packageName,
            resolveInfo.activityInfo.name
        )
    }
    initialIntents.add(targetIntent)
}
intent.putExtra(Intent.EXTRA_INITIAL_INTENTS, initialIntents.toTypedArray())
```

**Step 3: Query Direct Share targets.** Apps can expose recent contacts or semantic destinations. System UI binds services or uses shortcut metadata to obtain dynamic targets such as recent conversations.

After resolution, `ChooserActivity` renders the final list.

## Direct Share: Dynamic Target Services

Direct Share was designed so apps can provide task-specific destinations. A chat app can expose "send to Alice" and "send to Bob" directly, instead of making the user open the app and choose a contact.

Older implementations used `ChooserTargetService`; newer Android versions prefer the ShortcutManager sharing shortcut path. The concept is the same: the target app provides a small set of ranked, user-meaningful destinations.

```xml
<service
    android:name=".MyChooserTargetService"
    android:permission="android.permission.BIND_CHOOSER_TARGET_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.service.chooser.ChooserTargetService" />
    </intent-filter>
</service>
```

The service should return a small list. Ranking matters more than quantity. Too many targets slow down the sheet and make the UI noisy.

For modern apps, publish share targets through dynamic shortcuts:

```kotlin
val shortcut = ShortcutInfoCompat.Builder(context, "chat_alice")
    .setShortLabel("Alice")
    .setIcon(IconCompat.createWithResource(context, R.drawable.ic_avatar))
    .setIntent(Intent(context, ShareReceiverActivity::class.java).apply {
        action = Intent.ACTION_SEND
        putExtra("conversation_id", "alice")
    })
    .setCategories(setOf("android.shortcut.conversation"))
    .build()

ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
```

Keep shortcuts fresh. If a user has not interacted with a contact for months, leaving that contact in the top share targets makes the sheet feel stale.

## Share Integration in Compose

Compose does not change the system share protocol. It only changes how you trigger it from UI state. A small adapter keeps the side effect outside pure composables:

```kotlin
@Composable
fun ShareButton(text: String) {
    val context = LocalContext.current
    IconButton(onClick = {
        val intent = ShareCompat.IntentBuilder(context)
            .setType("text/plain")
            .setText(text)
            .createChooserIntent()
        context.startActivity(intent)
    }) {
        Icon(Icons.Default.Share, contentDescription = "Share")
    }
}
```

For reusable code, wrap sharing behind an interface:

```kotlin
interface ShareLauncher {
    fun shareText(text: String)
    fun shareImages(uris: List<Uri>)
}
```

This prevents every screen from rebuilding the same MIME, permission, and chooser logic.

## Traps and Recommendations

First, always grant URI permissions for shared files. Use `FileProvider` or content URIs, not raw file paths.

Second, do not assume every target handles every extra. Some apps ignore `EXTRA_TITLE`; some require `EXTRA_STREAM`; some only accept a single URI.

Third, keep Direct Share targets conservative. The share sheet is system-owned UI, and returning noisy or irrelevant entries hurts user trust.

Finally, test across Android versions and major OEM builds. Sharing is a system integration surface, and small differences in permission handling or chooser ranking can surface only on real devices.
