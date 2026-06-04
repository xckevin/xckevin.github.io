---
title: "Android Google Play In-App Update: Play Core Internals and Rollout Practice"
lang: en
translationKey: android-google-play-in-app-update
slug: android-google-play-in-app-update
excerpt: "A full-chain guide to Android In-App Update, from Play Core IPC and Immediate versus Flexible strategy to App Bundle delta behavior and production rollout practices."
publishDate: '2025-07-30'
tags:
- "Android"
- "Google Play"
- "Play Core"
- "In-App Update"
- "Engineering Practice"
seo:
  title: "Android In-App Update: Play Core Internals, Modes, and App Bundle Deltas"
  description: "Learn how Android In-App Update works through Play Core IPC, Immediate and Flexible mode strategy, App Bundle deltas, testing, and rollout practice."
  pageType: article
---

Last year, I took over the In-App Update module for an overseas project. Production data showed that only 30% of users completed the upgrade after seeing an update prompt. After reading the code, I found that the team only called `startUpdateFlowForResult` inside an Activity and handled none of the edge cases: what happens if the network disconnects, when should users be prompted again after declining, and how should a flexible update resume if the app is killed halfway through downloading?

In-App Update is not something you finish by calling one API. It involves the internal request path of the Play Core library, Google Play server-side version delta strategy, and client-side engineering around the two update modes.

## Play Core request flow: what happens after `startUpdateFlowForResult`

Start with the most basic call:

```kotlin
val appUpdateManager = AppUpdateManagerFactory.create(context)
val appUpdateInfoTask = appUpdateManager.appUpdateInfo

appUpdateInfoTask.addOnSuccessListener { info ->
    if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
        && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
    ) {
        appUpdateManager.startUpdateFlowForResult(
            info,
            AppUpdateType.IMMEDIATE,
            this,
            REQUEST_CODE_UPDATE
        )
    }
}
```

At the code level, you get an `AppUpdateInfo` object and start the update flow. Behind the scenes, Play Core does three things:

1. **Validate the Play Store version**: It uses `PlayCoreVersion` to check whether the Play Store installed on the device supports the In-App Update API. The minimum requirement is 4.0+. If the requirement is not met, `isUpdateTypeAllowed` on `appUpdateInfo` returns false directly without throwing an exception.
2. **Start an IPC request**: Play Core communicates with the Play Store process through AIDL and asks whether the current app has an available update. This step is asynchronous. After you call `addOnSuccessListener`, the callback may arrive hundreds of milliseconds or even several seconds later.
3. **Return update metadata**: `AppUpdateInfo` carries more than "is there an update." It also includes `availableVersionCode`, `updateAvailability`, `updatePriority`, and other fields. `updatePriority` influences whether the Play Store shows a forced update page in Immediate mode or downloads quietly in Flexible mode.

One pitfall I have hit: on some domestic vendor ROMs, such as certain MIUI versions, Play Core IPC can fail even when the Play Store is installed. The symptom is that `appUpdateInfoTask` never calls back. The practical fix is to add a five-second timeout and fall back to guiding the user to update manually in the Play Store.

## Priority strategy: choosing Immediate or Flexible

Google's documentation is concise: Immediate is a blocking full-screen update page for critical updates; Flexible downloads in the background and prompts users to restart after download completes.

In real selection, I group by **update type**:

| Update type | Recommended strategy | Typical scenarios |
|---------|---------|---------|
| Mandatory upgrade, such as breaking API changes | Immediate plus non-cancelable | Server API removal, incompatible data structures |
| Important update, such as severe bug fixes | Immediate plus one deferral | Crash rate above threshold, security issues |
| Feature update | Flexible | Regular feature iteration |
| Content or resource update | Flexible plus silent behavior | Asset packs, offline data |

`updatePriority` ranges from 0 to 5 and is configured in Play Console releases. The client can only read it and branch:

```kotlin
when {
    info.updatePriority() >= 4 && info.isUpdateTypeAllowed(IMMEDIATE) -> {
        // Force an immediate update and do not provide a close option
        appUpdateManager.startUpdateFlowForResult(info, IMMEDIATE, this, RC)
    }
    info.updatePriority() in 2..3 -> {
        // Flexible update with quiet background download
        appUpdateManager.startUpdateFlowForResult(info, FLEXIBLE, this, RC)
    }
    info.updatePriority() < 2 -> {
        // Low priority. Prompt again after three days.
        scheduleReminder(3.days)
    }
}
```

Flexible mode download progress must be observed with `InstallStateUpdatedListener`, and the listener is lost after Activity recreation. My approach is to hold a singleton listener at the `Application` layer and avoid Activity lifecycle limitations.

## App Bundle deltas: why Flexible updates can be almost as large as full packages

In-App Update reuses the Play Store patch installation mechanism underneath. When you upload an APK, Play's server uses `bsdiff` to generate a delta package. The smaller the code changes between two versions, the smaller the incremental package.

With App Bundle (AAB), the situation is more complex. AABs are dynamically split server-side into multiple split APKs, such as base and config splits, and updates are reassembled according to device characteristics. Two details matter:

1. **Incremental patches are calculated at the split level**, not against the entire APK. If your base split depends on a native library and that library has ABI changes between versions, the incremental package may be large even if business code barely changed.
2. **Play Asset Delivery (PAD) resource updates do not use deltas**. If the package contains an `install-time` asset pack, every update redownloads those resources in full, even if only one pixel changed.

During one package-size optimization pass, I found that the project used App Bundle plus PAD, and the Flexible update download size reached 85% of the full package. The root cause was that model filenames in the `install-time` asset pack included version numbers, such as `model_v3.tflite` to `model_v4.tflite`, which made `bsdiff` ineffective.

The fix is to distribute PAD asset packs with `fast-follow` or `on-demand` whenever possible, and keep only core base logic in `install-time`. Then Flexible updates only download the base split delta, while data packs are fetched after app startup as needed.

## Testing: simulating real scenarios beats reading docs

Play Console provides an Internal Test Track that can validate the real In-App Update flow. A few details are not clear enough in the documentation:

**Internal Test Track delay**: After uploading a new version, In-App Update availability is not immediate. It usually takes 15 to 30 minutes. Google Play CDN distribution has a cache window, so if you test too soon you may see `UPDATE_NOT_AVAILABLE`.

**versionCode must increase**: The Play Store determines updates only by `versionCode`, not `versionName`. If `versionCode` does not increase, `updateAvailability` returns `UPDATE_NOT_AVAILABLE` even if `versionName` changes.

**Immediate mode cannot be tested on the emulator**: Immediate depends on Play Store Activity overlay behavior, and the Play Store version on emulators does not support that feature. The emulator can only test the basic Flexible mode flow.

I added a validation script to CI: after publishing a new version to the Internal Test Track, wait 20 minutes, fetch `appUpdateInfo`, check that `updateAvailability` is `UPDATE_AVAILABLE`, and verify that `allowedUpdateTypes` includes the expected update mode. That removes a lot of manual tapping.

```bash
# Simplified ADB-triggered validation in CI
adb shell am broadcast \
  -a com.example.CHECK_UPDATE \
  --ei expected_version_code 42 \
  --ei expected_update_type 1
```

## Three key engineering decisions

The In-App Update API looks simple. Once engineered properly, the time-consuming part is not the API call; it is edge-case handling.

**1. Connect Play Core to the business lifecycle.** Flexible mode state listeners can outlive Activity lifecycles. Use `ProcessLifecycleOwner` to observe foreground and background transitions. When the app returns to the foreground, check `installStatus` immediately; if it is `DOWNLOADED`, trigger installation directly.

**2. Put a cap on "remind me later."** Do not show update prompts every time. Record rejection count. After more than three rejections, extend the prompt interval to seven days. After more than five, only perform a silent Flexible update check during cold start.

**3. Add a downgrade path for Immediate mode.** If Play services fail and the Immediate update page does not appear, automatically fall back to opening the Play Store detail page after 30 seconds. That avoids trapping the user in the update flow.

If these three areas are handled well, raising production update completion from 30% to above 70% is not difficult.
