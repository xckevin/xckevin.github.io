---
title: 'Android CompatChange: PlatformCompat Behavior Toggles and targetSdk Governance'
lang: en
translationKey: android-compatchange-targetsdk-compatibility
slug: android-compatchange-targetsdk-compatibility
excerpt: 'A close look at Android''s PlatformCompat framework: the CompatChange decision path, adb debug toggles, vendor overlay pitfalls, and the adaptation engineering methodology behind targetSdk version governance.'
publishDate: '2026-09-20'
tags:
- Android
- PlatformCompat
- targetSdk
- Compatibility Framework
- AOSP
- adb
seo:
  title: 'Android CompatChange: PlatformCompat Toggles and targetSdk Governance'
  description: 'How CompatChange decides behavior by targetSdk: PlatformCompat logic, adb toggles, vendor overlays, and an engineering approach to version governance.'
  pageType: article
---

## A targetSdk Upgrade and the "Paranormal Incident" It Caused

Last year I upgraded an old project from targetSdk 28 to 31, and QA reported a pile of strange issues: the same APK worked fine on older devices, but on Android 12 some pages turned transparent and PendingIntent threw exceptions outright. After three days of investigation, every root cause pointed to the same thing — **system behavior switches with the targetSdk version**.

Every year, each new Android release changes a batch of behaviors — non-SDK interface restrictions, background launch restrictions, Parcel reading policies, and so on. These changes cannot be applied indiscriminately to all apps, otherwise every upgrade would crash legions of older apps. So the system introduced a toggling mechanism: **CompatChange**, which assigns each behavior change a change ID and decides its on/off state according to the app's targetSdk.

This mechanism is **PlatformCompat (the platform compatibility framework)**, the core implementation on the system side. Once you understand it, targetSdk adaptation turns from "stepping on landmines one by one" into "predictable engineering".

## CompatChange: Giving Every Behavior Change an ID Card

The system abstracts every behavior change into a `CompatChange` object, whose core fields include:

- `id`: the change's unique ID, hard-coded in the system source
- `name`: a human-readable name
- `enableAfterTargetSdk` / `enableSinceTargetSdk`: thresholds
- `disabled` / `enabled`: default state
- `loggingOnly`: whether it only logs without changing behavior

For example, Android 12's `UNTRUSTED_TOUCH_EVENTS_BLOCKED` (ID 158002751) has `enableAfterTargetSdk = 30`, meaning only apps with targetSdk 31 and above block untrusted touch events.

On the system side, these are defined in AOSP's `ChangeId` class, where each change is a static constant:

```java
public static final long UNTRUSTED_TOUCH_EVENTS_BLOCKED = 158002751L;
```

The threshold information lives in XML config, loaded at system startup:

```xml
<compat-change
    id="158002751"
    name="UNTRUSTED_TOUCH_EVENTS_BLOCKED"
    enableAfterTargetSdk="30" />
```

`enableAfterTargetSdk="30"` means this changed behavior is enabled only for apps with targetSdk greater than 30. The same ID may appear in both `framework-compat-config.xml` and a vendor overlay, with the latter overriding the former.

## PlatformCompat's Decision Path

When an app starts or calls a related API, the system queries the change state through the `PlatformCompat` service. The decision path has roughly four steps:

1. System code calls `isChangeEnabled(changeId, packageName, user, binder)`
2. `PlatformCompat` reads the change object for that ID from cache or config
3. It combines the app's `targetSdkVersion` to compute the thresholds: `enableAfterTargetSdk`, `enableSinceTargetSdk`
4. It returns the final boolean, and the caller takes the old or new logic path accordingly

The simplified decision logic looks like this function:

```java
boolean isChangeEnabled(CompatChange change, int appTargetSdk) {
    if (change.enableAfterTargetSdk() != NO_SDK) {
        return appTargetSdk > change.enableAfterTargetSdk();
    }
    if (change.enableSinceTargetSdk() != NO_SDK) {
        return appTargetSdk >= change.enableSinceTargetSdk();
    }
    return change.enabled();
}
```

Note that `enableAfterTargetSdk` is a **strict greater-than**, while `enableSinceTargetSdk` is **greater-than-or-equal-to** — a detail that is easy to miss when reading the source. Android 12's `UNTRUSTED_TOUCH_EVENTS_BLOCKED` is configured with `enableAfterTargetSdk=30`, so only targetSdk 31 triggers it, and targetSdk 30 is unaffected.

The same change can produce different results for different apps, because the decision depends on each app's targetSdk. `PlatformCompat` does not cache the boolean result; every query takes the app's current `targetSdkVersion` and computes on the fly. After an app upgrade changes its targetSdk, the next query naturally decides based on the new value.

## Debug Toggles: Turning Implicit Behavior into Explicitly Testable

What's truly useful is the **adb command-line toggle**: you can force a change on or off on any device, validating new behavior ahead of time without touching targetSdk.

```bash
# 查看某个应用启用了哪些 change
adb shell am compat list-changes com.example.app

# 强制启用（changeId 从 AOSP ChangeId 源码查）
adb shell am compat enable 158002751 com.example.app

# 强制关闭
adb shell am compat disable 158002751 com.example.app
```

Behind `am compat`, the system calls `ActivityManagerShellCommand`, which ultimately lands on `PlatformCompat`'s override interface. This override is stored in `PackageManager`'s runtime state; it survives app restarts and is only cleared when the app is uninstalled and reinstalled.

There is an even more direct way to troubleshoot: the **platform_compat log**. Every time a change is evaluated, the system writes a log line with the fixed tag `platform_compat`:

```bash
adb logcat -s platform_compat
```

Output looks like:

```text
Compatibility change info reported: CHANGE; UNTRUSTED_TOUCH_EVENTS_BLOCKED;
158002751; targetSdkVersion=31; ENABLED; package=com.example.app
```

In a real project, I used this log line to track down an input method issue: the log showed a certain change was `DISABLED`, but the app code was handling it as if it were enabled — we'd been looking in the wrong direction for half a day. Note that this log is printed by default only on userdebug/eng builds; it's off by default on user builds, so release devices won't capture it. This is intentional on the system's part.

## Three Control Mechanisms and Vendor Overlay Pitfalls

targetSdk is not the only source controlling compatibility toggles. The full priority order, from highest to lowest, is:

1. **Runtime override**: set manually via `am compat enable/disable`
2. **Vendor/carrier overlay**: custom XML under `/vendor/etc/compatconfig/`
3. **Default config**: AOSP's built-in framework-compat-config.xml plus the targetSdk thresholds

The vendor overlay is the layer most easily overlooked. Many ROMs in China disable or rewrite certain changes, causing the same APK to behave differently on stock Android and customized systems. One pitfall I hit: `PHONE_STATE_LISTENER_LIMIT_CHANGE` was force-disabled by a vendor on a certain ROM, so the background phone-listening logic behaved completely differently.

When troubleshooting, first confirm where the config comes from:

```bash
adb shell dumpsys platform_compat
```

This command dumps every change loaded on the current device, along with its state and source. I usually save it as text and diff the stock AOSP config against the vendor config to quickly pinpoint rewritten IDs.

## Making Adaptation an Engineering Practice: A Methodology for Early Verification

My approach is **not to wait until the targetSdk upgrade to verify behavior**, but to iterate through it on the current version. Three concrete steps:

**Step one: inventory the blast radius.** From AOSP's `ChangeId` source, filter out the changes that have thresholds for the target version, focusing on IDs whose `enableAfterTargetSdk` falls between the old targetSdk and the new targetSdk. This step produces a checklist and is far more efficient than a blind upgrade.

**Step two: inject toggles one by one.** On the app still at the old targetSdk, use `am compat enable` to turn on all of the target version's changes, then run a full regression. Whichever page crashes or whichever API throws can be immediately matched to a change ID, without waiting to sweep the whole fleet after the upgrade.

**Step three: codify it in CI.** Turn the checklist into a script that batch-enables changes on debug builds in CI, paired with `logcat -s platform_compat` to collect change-evaluation results as automated evidence of adaptation progress.

I prefer to rehearse in the **test environment using overrides rather than directly changing targetSdk**, because overrides can be enabled one at a time and rolled back one at a time, giving finer-grained localization. Changing targetSdk directly activates dozens of changes at once, and the problems get tangled together and become hard to disentangle.

The essence of targetSdk governance is turning the external event of a "system version upgrade" into an **internal engineering task that is enumerable, toggleable, and regression-testable**. PlatformCompat provides these toggles; what remains is to actually work them into your process.
