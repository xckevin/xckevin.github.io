---
title: "Android Permission System Evolution: From Framework Checks to Android 14 Granular Control"
lang: en
translationKey: android-permission-system-evolution
slug: android-permission-system-evolution
excerpt: "A deep dive into Android's three-layer permission interception model, the evolution from Android 10 to 14, and practical adaptation guidance."
publishDate: '2026-05-17'
tags:
- "Android"
- "Permissions"
- "AppOps"
- "Android 14"
- "Architecture"
seo:
  title: "Android Permissions: Runtime Grants, AppOps, and Security Boundaries"
  description: "Trace Android permission checks from Framework interception to runtime grants, AppOps, compatibility rules, and secure engineering practices."
  pageType: article
---

A real bug from one project: `ContextCompat.checkSelfPermission()` returned `GRANTED`, but the camera call still crashed with `SecurityException` in the log. Another app on the same device worked normally.

The reason was simple: permission checks do not flow through `checkSelfPermission` alone.

## Three-layer interception: the gates behind one permission check

Android permission checking is a three-layer progressive interception system. If you only check the top layer, a lower layer can still block the operation.

**Layer 1: Context.checkSelfPermission**

This is the most commonly used API. It is implemented in `ContextImpl` and directly checks the grant state recorded by `PackageManager`. This layer only asks whether a permission declared in AndroidManifest has been granted by the user. It does not care about AppOps.

```java
// ContextImpl.java
public int checkPermission(String permission, int pid, int uid) {
    return ActivityManager.getService().checkPermission(permission, pid, uid);
}
```

**Layer 2: ActivityThread interception**

When an app calls a permission-protected API, the Binder request eventually reaches the system process, and `ActivityManagerService` performs a permission check. This step queries PMS and also passes through the AppOps layer.

**Layer 3: AppOpsService**

AppOps is the permission-control extension layer introduced in Android 4.3. It does not change the grant state, but it can control in real time whether an app may perform a specific operation. A permission can appear "granted" at the PMS layer while AppOps says "deny."

That was the issue on my device. Another app had disabled the camera operation through an AppOps manager, while PMS still showed the permission as granted. So `checkSelfPermission` checked PMS and returned `GRANTED`, but the actual call was rejected by AppOps and threw `SecurityException`.

## The full Runtime Permission path

The call chain from `requestPermissions()` to `onRequestPermissionsResult()` is longer than it looks:

`Activity.requestPermissions()` -> `ActivityThread.getPackageManager()` -> `PackageManagerService.grantRuntimePermission()` -> system permission dialog -> user action -> `ActivityThread.handleRequestPermissionsResult()`

The critical point is the dialog phase. `GrantPermissionsActivity` displays the permission request UI. Only after the user taps "Allow" is the PMS database actually updated. One detail is easy to miss:

```java
// PermissionManagerService.java - simplified grantRuntimePermission logic
if (AppOpsManager.noteOp(appOpCode, uid, packageName) != MODE_ALLOWED) {
    // AppOps denies the operation, but PMS may still mark it as GRANTED
    // This makes checkSelfPermission return GRANTED while the real call fails
}
```

**Why `PermissionChecker` matters**: `androidx.core.content.PermissionChecker` does one extra thing compared with `ContextCompat.checkSelfPermission`: it checks AppOps as well. Replacing the call with `PermissionChecker.checkSelfPermission()` would have prevented the bug above.

```kotlin
// Checks both PMS and AppOps
PermissionChecker.checkSelfPermission(context, Manifest.permission.CAMERA)

// Checks only PMS, so it can miss AppOps denial
ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
```

## Android 10 to 14: increasingly strict permission control

**Android 10 - Scoped Storage**

Media reads and writes no longer require `READ_EXTERNAL_STORAGE`; apps should use the `MediaStore` API instead. If an app strongly depends on file-path access, the `requestLegacyExternalStorage` flag only works on Android 10 and stops working completely on Android 11.

**Android 11 - one-time permissions and permission auto-reset**

Users can choose "Allow only this time." After the app process is killed, the permission is automatically revoked. This means permission state must be checked on every cold start, and grant results should not be cached.

**Android 12 - precise location vs approximate location**

Location permissions are split into `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`. In the permission dialog, the user chooses "Precise" or "Approximate." The two modes are mutually exclusive in practice. If the user chooses approximate location and later wants precise location, they must change it from Settings.

```kotlin
// On Android 12+, request both permissions together
val permissions = arrayOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION
)
// If the user chooses approximate location, FINE_LOCATION will not be granted
```

**Android 13 - notification permission becomes runtime-granted**

`POST_NOTIFICATIONS` changed from granted by default to a runtime permission. Once targetSdk reaches 33, an app cannot even create useful notification behavior without requesting notification permission.

**Android 14 - partial photo and video access**

Users can choose selected photos or selected videos, and the app can only access that selected media subset. `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` must be requested separately. Android 14 also blocks installation of apps whose `targetSdkVersion` is below 23, effectively forcing Runtime Permission compatibility.

## Engineering adaptation guidance

**Use `PermissionChecker` instead of `ContextCompat.checkSelfPermission`.** It is often just a one-line import change, but it gives you AppOps coverage at very low cost.

**Wrap permission requests in a state machine.** Do not scatter `requestPermissions` calls across every Activity. Use one manager for the request queue and handle concurrent cases such as a second request arriving while a dialog is already visible. I currently use `MutableStateFlow<Map<String, PermissionState>>`, checking state before each request to avoid repeated dialogs.

**Test different authorization combinations.** Android 14's granular permissions make the combination count explode: location has precise, approximate, and denied; photos have all, partial, and denied. Manual dialog testing does not scale. Use `adb` to construct scenarios directly:

```bash
# Create a state where AppOps denies the operation while PMS grants the permission
adb shell pm grant com.example android.permission.CAMERA
adb shell appops set com.example CAMERA deny
```

The permission system has moved from Android 6.0's broad runtime permission model to Android 14's fine-grained controls. The core of adaptation is not chasing every new API. It is understanding the decision path across the three layers. Do not be fooled by PMS-level `GRANTED`; AppOps may be the layer that actually decides whether the operation can run.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Binder internals: from driver communication to the AIDL call chain](/en/blog/android-binder/)
- [Android Framework system services: AMS, WMS, and the app-process interaction model](/blog/android系统服务与framework层交互模型/)
- [Android process and thread model: Zygote, main thread, and Binder thread pools](/blog/android进程与线程模型深度剖析/)
- [Android ContentProvider IPC: URI routing, cross-process access, and permission control](/en/blog/android-contentprovider-ipc/)
<!-- /seo-internal-links -->
