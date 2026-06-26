---
title: "Inside Android Photo Picker: Privacy Sandbox Architecture and Compose Integration"
lang: en
translationKey: android-photo-picker-privacy-compose
slug: android-photo-picker-privacy-compose
excerpt: "A close look at Android Photo Picker's privacy-sandbox design, from cross-process URI permission grants to Compose declarative integration, covering single/multi-select, persistent permissions, and ROM compatibility."
publishDate: '2026-06-25'
tags:
- "Android"
- "Jetpack Compose"
- "Photo Picker"
- "Privacy Sandbox"
- "Architecture"
seo:
  title: "Android Photo Picker: Privacy Sandbox & Compose Integration"
  description: "Android Photo Picker privacy sandbox and Compose integration: cross-process URI transfer, temporary grants, and multi-select flow."
  pageType: article
---

Last year, building an image picker for a social app, the product manager wanted album categories and multi-select preview. My first instinct was to request `READ_EXTERNAL_STORAGE` and roll my own gallery. But Android 13's privacy sandbox made that awkward — when users saw the "allow access to photos and videos" prompt, 30% of them denied it.

Photo Picker is Google's official answer from Android 13 onward. It requires no storage permission, surfaces a system UI for users to select photos, and hands the app only the URIs of the chosen files.

## The Design Logic of the Privacy Sandbox

The traditional gallery access model is blanket authorization: once an app has storage permission, it can traverse the entire `MediaStore` database and read paths, metadata, even contents of every media file. Users have no way to control which photos are accessed.

Photo Picker drops the authorization granularity from "album level" to "file level."

The core mechanism is three steps:

1. The app launches the system picker UI via Intent or API
2. The user selects photos in the system UI; the system process records the chosen files
3. The system returns temporary URIs to the app, which can read only those selected files

**The app process never learns what other photos exist in the user's gallery.** This isolation comes not from permission flags but from the process boundary — the picker runs in a system process, and the app process cannot query MediaStore for results.

## The Sandbox URI Across Processes

The URI returned by Photo Picker is `content://` format, but it differs fundamentally from a regular `MediaStore` URI.

```kotlin
// Regular MediaStore URI — readable if the app has storage permission
val uri = ContentUris.withAppendedId(
    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, imageId
)

// Photo Picker URI — bound to a temporary grant
val pickerUri: Uri = result.data?.data ?: return
```

Behind the Photo Picker URI is a **temporary grant ticket** implemented by `MediaProvider`. When the picker closes, the system binds the selected file IDs to the requesting app's package name and creates a time-limited URI permission record.

Two key constraints:

- **Time-limited**: the grant expires when the app process is killed; a restart requires re-selection
- **Unforgeable**: the URI carries a system-signed timestamp and hash; the app cannot construct a new URI that accesses unauthorized files

While debugging, I used `adb shell dumpsys media.provider` to inspect the grant records. Each record contains `packageName`, `uri`, and `expireTime` — a clean structure.

## Two Data Transfer Modes

Photo Picker supports single-select and multi-select, with different underlying data paths.

**Single-select** goes through the standard `ActivityResult` callback:

```kotlin
val pickMedia = rememberLauncherForActivityResult(
    PickVisualMedia()
) { uri ->
    if (uri != null) {
        // uri is content://media/picker/... format
        viewModel.processImages(listOf(uri))
    }
}
```

The returned `Uri` is delivered via `Intent.data`, serialized through Binder for cross-process transfer. A single URI has negligible overhead — 1-2ms.

**Multi-select** uses `PickMultipleVisualMedia`:

```kotlin
val pickMultipleMedia = rememberLauncherForActivityResult(
    PickMultipleVisualMedia(5)
) { uris ->
    // uris is List<Uri>, delivered via Intent.clipData
    viewModel.processImages(uris)
}
```

Multi-select results are delivered via `Intent.clipData` — a `ClipData` object crossing Binder. Under 50 items, performance is imperceptible. Above 100, the Binder transaction size approaches the 1MB ceiling and requires batching. Photo Picker's default ceiling of 50 clearly accounts for this limit.

## Compose Declarative Integration

The core of integrating Photo Picker in Compose is `rememberLauncherForActivityResult`, which wraps a callback-style API into composable state.

### Persisting URI Permissions

The URI returned by Photo Picker is valid while the process lives. If you need persistent access (a drafts scenario, for example), actively acquire long-term permission:

```kotlin
fun persistUriPermission(context: Context, uri: Uri) {
    try {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION
        )
    } catch (e: SecurityException) {
        Log.w("PhotoPicker", "URI does not support persistent grant: $uri")
    }
}
```

`takePersistableUriPermission` checks inside `MediaProvider` whether the URI originates from `DocumentsProvider` or Photo Picker. **Not all URIs support persistence.** On a Pixel 7, Photo Picker URIs are persistable; some vendor ROMs may trim this capability.

### Thumbnail Strategy for Image Preview

After selection, you need to show thumbnails. Decoding the original image with `BitmapFactory` will OOM. In Compose, use `AsyncImage` or hand-roll `BitmapFactory.Options` sampling:

```kotlin
fun loadThumbnail(context: Context, uri: Uri, size: Int): Bitmap? {
    return context.contentResolver.openInputStream(uri)?.use { stream ->
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeStream(stream, null, options)
        stream.close()
        
        val scaleFactor = (options.outWidth / size).coerceAtLeast(
            options.outHeight / size
        )
        
        context.contentResolver.openInputStream(uri)?.use { inputStream ->
            BitmapFactory.Options().apply {
                inSampleSize = scaleFactor.coerceAtLeast(1)
            }.let { BitmapFactory.decodeStream(inputStream, null, it) }
        }
    }
}
```

Each `ContentResolver.openInputStream()` call triggers a cross-process `openFile` request. A list of 20 images means 20 Binder calls. Inside a Compose `LazyColumn`, be careful to reuse — do not re-decode on every recomposition.

### Handling OS Version Compatibility

Photo Picker is natively supported from Android 13. Google backports it to Android 11 via the `activity` library (API levels below 30 require the Google Play Services modular component).

```kotlin
// build.gradle
implementation("androidx.activity:activity-compose:1.8.0")

// On Android 11-12, automatically degrades to ACTION_OPEN_DOCUMENT
val picker = rememberLauncherForActivityResult(
    PickVisualMedia()
) { uri -> /* ... */ }
```

When degraded to `ACTION_OPEN_DOCUMENT`, the experience worsens — users get the system file picker instead of a dedicated photo picker. My recommendation to product: **show a downgrade hint on Android 13 below, but do not block usage**. The privacy benefits of Photo Picker are compelling enough to persuade users to upgrade.

## Three Pitfalls From Practice

**Pitfall 1: URIs do not work in WebView.** The `content://` URI from Photo Picker requires `ContentResolver` to read; WebView's `loadUrl()` does not support it. The fix is to read into memory via `ContentResolver`, then convert to Base64 or a `blob:` URL for WebView.

**Pitfall 2: Some ROMs tamper with the result.** A vendor ROM redirected Photo Picker invocations to its own gallery and returned `file://` URIs. Defensive code should check the scheme after receiving the URI:

```kotlin
fun validateUri(uri: Uri): Boolean {
    if (uri.scheme != "content") {
        Log.w("PhotoPicker", "Non-standard URI scheme: ${uri.scheme}")
        return false
    }
    return true
}
```

**Pitfall 3: `onActivityResult` timing.** A Compose `LaunchedEffect` and the `rememberLauncherForActivityResult` callback may not fire in the same recomposition frame. If the callback updates State directly, wrap it in `Snapshot.withMutableSnapshot()` or hoist the state into the ViewModel.

## Selection and Landing Decisions

Choosing Photo Picker over a self-built gallery selector is not primarily a technical-complexity tradeoff — it is about **user privacy perception**. The psychological burden of "allow access to photos and videos" is far heavier than the system picker. In one project I handled, switching to Photo Picker lifted the album-feature completion rate by 18%.

URI lifecycle management is the most error-prone part of Photo Picker integration. Encapsulate a `PhotoPickerResult` data class that carries the URI, filename, size, and persistence flag together, avoiding `contentResolver` calls scattered across the codebase.

Vendor ROM compatibility work is non-negotiable. At minimum, do two layers of checks: URI scheme validation and `openInputStream` exception handling. If you detect that a ROM has trimmed Photo Picker capability, falling back to `ACTION_OPEN_DOCUMENT` is the safe choice.
