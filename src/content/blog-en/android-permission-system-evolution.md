---
title: "Android Permissions: Runtime Grants, AppOps, and Testing"
lang: en
translationKey: android-permission-system-evolution
slug: android-permission-system-evolution
excerpt: "Understand Android permission decisions, recent platform changes, AppOps limits, and a testable feature-first request flow."
publishDate: '2026-05-17'
updatedDate: '2026-09-22'
tags:
- "Android"
- "Permissions"
- "AppOps"
- "Android 14"
- "Architecture"
seo:
  title: "Android Permissions: Runtime Grants, AppOps, and Testing"
  description: "Build robust Android permission flows with runtime grants, protected API enforcement, AppOps context, version boundaries, and ADB tests."
  pageType: article
---

`checkSelfPermission()` returning `GRANTED` is necessary, but it is not a universal promise that every later operation will work. Android makes decisions at the protected API, with a combination of manifest declaration, runtime grant, calling identity, device policy, role/privileged status, and—where that API uses it—AppOps. Code should ask for the smallest permission immediately before a user-visible feature, then handle `SecurityException`, cancellation, and revocation as normal outcomes.

This is more accurate than treating Android permissions as one fixed “three-layer” call chain. Different framework services enforce different permissions and AppOps; some APIs have no AppOps check, while a permission grant may be insufficient for a role-only or signature permission.

## What each check actually tells you

| Check or gate | What it answers | What it cannot prove |
| --- | --- | --- |
| Manifest `<uses-permission>` | Is the capability requested for installation/runtime? | That the user granted it |
| `checkSelfPermission()` | Is this runtime permission granted to this app? | That a particular API/operation will be allowed |
| Permission dialog / Activity Result | What did the user choose at that point? | That the grant will remain available |
| Protected framework API | Can this concrete call proceed now? | That the feature's network/device work will succeed |
| AppOps (when used) | Is this operation mode allowed for this UID/package? | A general replacement for all permission checks |

`AppOpsManager` is an operation-control and auditing layer used by many sensitive framework APIs. It is not an application policy API. Normal third-party apps should not try to change their own AppOps mode; production code should use the public feature API, catch its documented failures, and direct the user to Settings only when a recovery path exists.

## Request by feature, not at first launch

The Activity Result API keeps the callback tied to the requested feature and makes denial easy to model:

```kotlin
private val requestCamera = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
) { granted ->
    if (granted) startCameraPreview()
    else showCameraExplanationOrSettingsLink()
}

fun onScanReceiptClicked() {
    if (checkSelfPermission(Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED) {
        startCameraPreview()
    } else {
        requestCamera.launch(Manifest.permission.CAMERA)
    }
}
```

Re-check after every resume and before the sensitive call. A user can revoke a grant in Settings, an unused app can lose sensitive runtime permissions through auto-reset, and an Android 11 one-time grant ends when the system revokes it. Do not persist “permission granted” as an application preference.

If a documented API throws `SecurityException`, treat that as a controlled failure path. It can indicate a missing declaration/grant, an AppOps or policy restriction, or an API-specific precondition. Log the API, SDK level, and exception without recording private data; do not infer the exact lower-layer decision without device evidence.

## Version boundaries worth encoding in tests

These changes affect normal app behavior; they are not a complete history of the permission system.

- **Android 10 (API 29):** scoped-storage behavior and stricter location requirements affected many device and Wi-Fi APIs. File-path access assumptions need separate migration work.
- **Android 11 (API 30):** location, camera, and microphone can receive a one-time grant. Unused apps targeting Android 11+ can have sensitive runtime grants auto-reset. Repeated denial can suppress later dialogs.
- **Android 12 (API 31):** users may choose approximate location. Request `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` together when the feature genuinely needs precise location; still work with approximate or explain why it is insufficient.
- **Android 13 (API 33):** `POST_NOTIFICATIONS` is a runtime permission for non-exempt notifications. `NEARBY_WIFI_DEVICES` covers many nearby-Wi-Fi operations; scan results still have location rules. Media access is split by type.
- **Android 14 (API 34):** when requesting image/video media permissions, apps targeting 34+ must support the selected-photos path (`READ_MEDIA_VISUAL_USER_SELECTED`) or use the system photo picker when it meets the product need.

Target SDK changes can alter the exact behavior, so test on the relevant OS and target-SDK combination rather than flattening these rules into one `if (SDK_INT >= …)` statement.

## Diagnose a device state without guessing

Use ADB only on a device you control. `dumpsys package` shows runtime-grant flags; it cannot by itself prove the result of every protected API. The following sequence makes a camera grant/denial case reproducible:

```bash
PACKAGE=com.example.app
PERMISSION=android.permission.CAMERA

adb shell pm revoke "$PACKAGE" "$PERMISSION"
adb shell pm clear-permission-flags "$PACKAGE" "$PERMISSION" user-set user-fixed
adb shell dumpsys package "$PACKAGE"
```

Interpretation: the next in-app request should be eligible to display its system prompt. If it does not, inspect whether the permission is declared, whether the request is issued from a visible activity, and the app's target-SDK behavior. Android documents `USER_SET` as a prior denial and `USER_FIXED` as a repeated-denial state used for debugging. Do not run `pm grant` for a permission your app cannot normally obtain; that hides the user journey you need to test.

For data-access auditing on supported devices, Android also provides AppOps noting callbacks and platform tooling. Use those to find unexpected accesses from your own SDKs, then remove the access or make its purpose visible to the user.

## Official references and related reading

- [Request runtime permissions](https://developer.android.com/training/permissions/requesting) covers the request flow, one-time permissions, revocation, and auto-reset.
- [Android 11 permission updates](https://developer.android.com/about/versions/11/privacy/permissions) documents repeated-denial flags and the ADB inspection commands.
- [Android 13 notification permission](https://developer.android.com/develop/ui/compose/notifications/notification-permission) explains `POST_NOTIFICATIONS` behavior and test states.
- [Data access auditing](https://developer.android.com/privacy-and-security/auditing-access) explains how AppOps-based auditing is exposed to app developers.
- [Android ContentProvider IPC and permission control](/en/blog/android-contentprovider-ipc/) and [Binder internals](/en/blog/android-binder/) provide the framework context behind protected IPC calls.
