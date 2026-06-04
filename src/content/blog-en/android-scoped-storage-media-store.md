---
title: "Android Scoped Storage Internals: From Sandbox Isolation to MediaStore Mapping"
lang: en
translationKey: android-scoped-storage-media-store
slug: android-scoped-storage-media-store
excerpt: "A full-path look at Android Scoped Storage, covering FUSE interception, MediaStore database mapping, permission layers, SAF migration, and practical Android 10+ adoption."
publishDate: '2026-05-18'
tags:
- "Android"
- "Scoped Storage"
- "MediaStore"
- "File System"
- "Storage Access Framework"
seo:
  title: "Android Scoped Storage Internals: FUSE, MediaStore, and SAF"
  description: "Learn how Android Scoped Storage works through FUSE interception, MediaStore URI mapping, permission layers, and practical migration paths for Android 10+."
  pageType: article
---

During an Android 10 migration, our team hit a classic failure: code that had always read photos from the gallery started returning an empty list after we raised `targetSdkVersion` to 29. After digging through the docs, we realized Android had introduced Scoped Storage and rebuilt the entire file access model.

Scoped Storage is not just a permission change. It is an end-to-end architecture: FUSE interception at the kernel-facing layer, MediaStore as a database abstraction, and a multi-layer permission model in the app layer. Understanding that path is far more useful than memorizing a few API names.

## The FUSE Interception Layer: The "Fake" File System Apps See

Starting with Android 10, Android enables a FUSE (Filesystem in Userspace) layer to intercept file access requests. When an app uses the `File` API to access shared storage, the request does not go directly to the underlying file system. It first passes through the FUSE daemon.

```bash
# Check whether FUSE is enabled on the device
adb shell mount | grep fuse
# Typical output: /storage/emulated on ... type fuse ...
```

The core rule in the FUSE layer is: **decide whether to allow a file operation based on the caller UID and permission labels**. When an app tries to read a file with `new File("/sdcard/DCIM/photo.jpg")`, the call path looks like this:

1. libc `open()` enters VFS, the virtual file system.
2. VFS routes the request to the FUSE driver.
3. The FUSE driver forwards the request to the userspace `sdcard` daemon.
4. `sdcard` checks the caller permissions and either allows the operation or returns `EACCES`.

This mechanism has existed since Android 4.4, but Android 10 changed it from optional to mandatory. For apps targeting `targetSdkVersion >= 29`, FUSE strictly intercepts access to non-app-owned directories under `/sdcard`, even if the app declares `READ_EXTERNAL_STORAGE`.

While debugging a production issue, I once traced a real call with `strace`: after FUSE intercepted the `openat()` system call, the kernel returned `-EACCES` directly, and MediaProvider produced no logcat output at all. The request never reached the app layer. **It was blocked in kernel space.**

## MediaStore Database Mapping: From File Paths to Content URIs

FUSE is only the first gate. The real abstraction behind Scoped Storage is the MediaStore database, a SQLite-backed mapping between file system paths and structured content URIs.

Key fields:

| Field | Description |
|------|------|
| `_id` | Primary key of the media record |
| `_data` | Absolute file system path |
| `_display_name` | File name |
| `mime_type` | MIME type |
| `date_modified` | Last modified time |
| `owner_package_name` | Package name of the owning app |

When an app inserts a media file, MediaProvider receives `ContentValues`, creates a database record, and then writes the file to the actual storage location. Querying works in the opposite direction: the app queries the database for `_id`, then reads or writes through the corresponding content URI.

```kotlin
// Build a content URI from _id instead of stitching together a _data path
val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME)
contentResolver.query(
    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, null, null, null
)?.use { cursor ->
    while (cursor.moveToNext()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID))
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        // Read with contentResolver.openInputStream(uri), not File(uri.path)
    }
}
```

After Android 10, the `_data` field is no longer reliable for third-party apps. Even if you can query a path string, the FUSE layer may still reject direct file access. The correct model is to treat the content URI as the only operation handle and route all I/O through `ContentResolver`.

## The Three-Layer Permission Model

Scoped Storage authorization is split into three layers, and each layer makes its own decision.

**App-Owned Directories**

Every app has its own directory under `/sdcard/Android/data/<package>/`. Reading and writing there requires no additional permission. Android removes the directory when the app is uninstalled, so it is a good fit for caches and private files.

**The MediaStore Contributor Model**

An app has full access to media files it created. For media files created by other apps, images, videos, and audio can be read with `READ_EXTERNAL_STORAGE`. Writes should go through the MediaStore API, where the system handles ownership. The mental model is simple: you can manage what you contributed, but you can only inspect what belongs to someone else.

**MANAGE_EXTERNAL_STORAGE, or Broad File Access**

This permission gives broad access to all files, similar to the old `WRITE_EXTERNAL_STORAGE` behavior. It requires Google Play review and is only allowed for specific app categories such as file managers and backup tools.

```xml
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
```

I submitted this permission for a file-management app and was rejected by Play review three times. It finally passed only after we provided detailed feature explanations, operation recordings, and user feedback screenshots. If the business case is not essential, **do not treat this as a migration shortcut**.

## Migration Path: From Temporary Exemption to Full Migration

Google provided `requestLegacyExternalStorage` as a temporary exemption:

```xml
<application android:requestLegacyExternalStorage="true" ...>
```

This flag tells the FUSE layer to allow legacy path access, but it only works on Android 10. Android 11 and later **ignore the flag outright**.

Our team used a three-step migration plan:

1. **Audit every file operation**: use lint to scan `File`, `FileInputStream`, and `FileOutputStream` usage.
2. **Replace APIs by scenario**: use MediaStore for media files, SAF (Storage Access Framework) for documents, and keep the File API for app-private data.
3. **Remove the exemption gradually**: ship `requestLegacyExternalStorage=true` first to avoid release-blocking crashes, migrate module by module, then remove the flag.

SAF integration is straightforward: use `ACTION_OPEN_DOCUMENT` to let the user choose a file, receive a content URI from the system, and use that URI as the read/write handle. After a reboot, `takePersistableUriPermission` keeps the grant valid.

```kotlin
// Open a file with SAF and persist read permission
val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
}
startActivityForResult(intent, REQUEST_CODE)

// In onActivityResult
val uri = data?.data
contentResolver.takePersistableUriPermission(uri!!, Intent.FLAG_GRANT_READ_URI_PERMISSION)
```

The URI returned by SAF is generated by the system, and its format can vary by device. Do not parse its structure. Treat it as an opaque handle.

## Practical Guidance

After migrating several Android 10+ projects, three lessons stand out:

1. **Plan early**: design file operations around Scoped Storage from the start of the project. In one project, migration started two weeks before the deadline, and we had to cut two features to ship on time.

2. **Choose APIs by scenario**: use MediaStore for media files, SAF for documents, and `context.filesDir` for app-private data. Do not try to cover every case with `MANAGE_EXTERNAL_STORAGE`; Play review and future Android versions can both tighten the rules.

3. **Cover it with automated tests**: use `ShadowContentResolver` in unit tests to simulate MediaStore behavior, and validate integration flows on real Android 10+ devices. We once had a feature pass on Android 9 devices and then crash for many Android 11 users in production because the test environment did not match the target system.

The core architecture of Scoped Storage is this: **replace path access with a database abstraction, and enforce sandbox boundaries through FUSE interception**. Once you understand how those two layers work together, migration stops being an API rename and becomes a change in storage design.
