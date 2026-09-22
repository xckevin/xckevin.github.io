---
title: "Android 16 and Platform Compatibility"
lang: en
translationKey: android-16-adaptation
seo:
  title: "Android 16 Compatibility: 16 KB Pages, Permissions and Wi-Fi"
  description: "Diagnose Android compatibility issues with native libraries, permissions, Wi-Fi APIs, fonts, insets and back navigation. Follow a practical migration checklist."
---

Use this guide when upgrading your target SDK or investigating a failure that only occurs on certain Android devices. Record the OS version, target SDK, dependency versions and reproduction steps first; those details determine whether the fix belongs in application code, a dependency or the build configuration.

## Start with the symptom

| Symptom | Read first | Expected outcome |
| --- | --- | --- |
| A native library fails on a 16 KB device, or a release check flags incompatibility | [16 KB page size, ELF and NDK compatibility](/en/blog/android-16kb-page-size-elf-ndk/) | Separate ELF segment alignment from APK ZIP alignment and identify affected dependencies |
| Access fails after permission approval or an OS upgrade | [Android permissions and version differences](/en/blog/android-permission-system-evolution/) | Distinguish runtime permissions, AppOps, special access and target SDK requirements |
| Wi-Fi connection fails or a legacy WifiManager API stops working | [Wi-Fi API selection and connection debugging](/en/blog/android-wifi-connection-wifimanager-wpa-supplicant/) | Choose between local connections and network suggestions, then inspect permissions and callbacks |
| Text has missing glyphs, different line heights or unexpected layout | [Typeface, font fallback and Skia rendering](/en/blog/android-font-rendering-typeface-skia/) | Separate font loading, glyph selection, shaping and rasterization |
| Content sits behind system bars or the keyboard | [Edge-to-edge and WindowInsets](/en/blog/android-16-edge-to-edge-windowinsets/) | Identify inset ownership and the affected UI states |
| Back gestures disagree with the screen back stack | [Predictive Back engineering](/en/blog/android-predictive-back/) | Review navigation components and custom back handling |

## Follow a migration through to verification

1. Read [API compatibility and runtime fallbacks](/en/blog/android-api-compatibility-minsdk-runtime-fallback/). List OS versions, target SDK requirements, available APIs and fallback behavior.
2. Audit [native dependencies for 16 KB support](/en/blog/android-16kb-page-size-elf-ndk/). Page-size compatibility depends on the device, system and native dependencies; an Android version number alone is insufficient evidence.
3. Exercise [permission flows](/en/blog/android-permission-system-evolution/) and [Wi-Fi connections](/en/blog/android-wifi-connection-wifimanager-wpa-supplicant/), including first grants, denial, retries, revocation and reinstall.
4. Check insets, back navigation and [text rendering](/en/blog/android-font-rendering-typeface-skia/). Keep reproducible before-and-after results.
5. Use the [performance and stability workflow](/en/android-performance/) to check startup, jank and crashes after migration.

## What to record in regression tests

- Versions: OS, target SDK, NDK, AGP and native SDKs. Separate an OS update from an app update.
- Installation: clean install, in-place upgrade, restored data, granted permissions and revoked permissions.
- UI: orientation, large fonts, split screen, keyboard transitions, gesture navigation and three-button navigation.
- Network: denied access, connection failure and reconnects. Record callbacks and errors, not only the Wi-Fi icon.
- Evidence: original logs, build artifacts, reproduction steps and regression results. A successful run on one device does not establish compatibility across the matrix.

## Optional capabilities and further reading

[App Functions and semantic entry points](/en/blog/android-16-app-functions-semantic-index/) are a product capability to evaluate separately. They are not a required implementation task for every compatibility upgrade; check current platform availability before adopting them.

Use the official [Android 16 changes for all apps](https://developer.android.com/about/versions/16/behavior-changes-all) and [changes for apps targeting Android 16](https://developer.android.com/about/versions/16/behavior-changes-16) as the platform reference. The permission, 16 KB and Wi-Fi articles link to their respective API documentation.

Continue with [Android Framework internals](/en/android-framework/) or return to the [topic index](/en/topics/).
