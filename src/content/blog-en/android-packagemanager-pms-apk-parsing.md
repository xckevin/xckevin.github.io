---
title: "Android PackageManager End to End: APK Parsing, PMS Registration, and Permissions"
lang: en
translationKey: android-packagemanager-pms-apk-parsing
slug: android-packagemanager-pms-apk-parsing
excerpt: "A deep dive into Android PackageManager, from APK parsing and component registration to Intent matching, permission checks, signing, and real-world PMS pitfalls."
publishDate: '2025-08-15'
tags:
- "Android"
- "PackageManager"
- "Permission Checks"
- "Intent Matching"
- "APK Parsing"
seo:
  title: "Android PackageManager: APK Parsing, PMS Registration, and Permission Checks"
  description: "Understand Android PMS from APK structure and Manifest parsing to component indexes, Intent matching, permission checks, signatures, and multidex pitfalls."
  pageType: article
---

A few years ago, I investigated a production crash where the stack trace showed a `ClassNotFoundException` for an Activity declared in `AndroidManifest.xml`. PMS logs showed that `mPackages` did contain the component, yet `startActivity` could not find the class. The final cause was a packaging pipeline that had modified the Manifest: the component was registered, but the class file was not present in dex.

At runtime, PMS acts as Android's component routing table. Starting an Activity, sending a broadcast, and binding a Service all begin by consulting this table. This article breaks down the full path.

## What an APK really is: structured data inside a ZIP

An APK is a signed ZIP archive. After extraction, its structure looks like this:

- `classes.dex / classesN.dex`: Dalvik bytecode
- `resources.arsc`: compiled resource index table
- `AndroidManifest.xml`: binary Manifest
- `res/`, `lib/`, `assets/`: resources, native libraries, and raw files
- `META-INF/`: signatures and certificate data

At build time, AAPT or AAPT2 converts `AndroidManifest.xml` into a binary format. It is no longer readable XML text. It becomes binary data encoded in the AXML structure. PMS reads this binary structure directly and never parses the original XML source.

```xml
<!-- Manifest before compilation -->
<activity
    android:name=".MainActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
</activity>
```

After compilation, this configuration becomes a sequence of chunk nodes in AXML format. When PMS parses the `<activity>` node, it builds a `PackageParser.Activity` object and stores fields such as `name`, `exported`, and `intent-filter`.

## Install-time parsing: PackageParser and component collection

Installation starts with `PackageParser.parsePackage()`. The source lives in `frameworks/base/core/java/android/content/pm/PackageParser.java`. Starting with Android 10, some of this logic moved into `ParsingPackageUtils`.

The core flow has two steps.

**Step 1. Parse basic package information**

```java
// Simplified parseMonolithicPackage flow
Package pkg = new Package(packageName);
AssetManager assets = new AssetManager();
assets.addAssetPath(apkPath); // Add the APK path to AssetManager

// Parse package attributes from the Manifest
Resources res = new Resources(assets, metrics, null);
XmlResourceParser parser = (XmlResourceParser)assets.openXmlResourceParser(
    "AndroidManifest.xml");
```

`AssetManager.addAssetPath()` does not need to extract the APK. It uses `mmap` to map the APK file into memory, then reads AXML and `resources.arsc` directly from the mapped region.

**Step 2. Traverse the Manifest and collect components**

```java
// Typical switch-case while traversing the Manifest
while ((type = parser.next()) != XmlPullParser.END_DOCUMENT) {
    if (type == XmlPullParser.START_TAG) {
        String tagName = parser.getName();
        switch (tagName) {
            case "activity":
                Activity a = parseActivity(parser, pkg);
                pkg.activities.add(a);
                break;
            case "service":
                Service s = parseService(parser, pkg);
                pkg.services.add(s);
                break;
            case "provider":
                Provider p = parseProvider(parser, pkg);
                pkg.providers.add(p);
                break;
            case "receiver":
                Activity r = parseReceiver(parser, pkg);
                pkg.receivers.add(r);
                break;
            // permission, uses-permission, feature...
        }
    }
}
```

When each component is parsed, PMS extracts the class name, process attributes, configuration change declarations, and its list of `IntentFilter` objects. Every `<intent-filter>` becomes an `IntentFilter` object that stores matching rules such as action, category, and data scheme.

An app's component metadata is packaged into a `PackageParser.Package` object that contains:

- Four ArrayLists: `activities`, `services`, `providers`, and `receivers`
- Permission lists: `permissions` and `requestedPermissions`
- Signing metadata: `mSigningDetails`

## PMS registration: writing Package objects into in-memory indexes

The `PackageParser.Package` object only exists during installation. Re-parsing the APK on every runtime query would be far too expensive. PMS converts it into a lightweight `AndroidPackage` interface instance and writes it into two core data structures:

```java
// Core indexes in frameworks/base/services/core/java/com/android/server/pm/
// PackageManagerService.java

// Full mapping of installed packages
final WatchedArrayMap<String, AndroidPackage> mPackages =
    new WatchedArrayMap<>();

// Component IntentFilter resolver tables, one per component family
final ActivityIntentResolver mActivities = new ActivityIntentResolver();
final ServiceIntentResolver mServices = new ServiceIntentResolver();
final ProviderIntentResolver mProviders = new ProviderIntentResolver();
final ReceiverIntentResolver mReceivers = new ReceiverIntentResolver();
```

Registration is roughly:

```java
// Write Package data into PMS indexes
mPackages.put(pkg.getPackageName(), pkg);

// Register IntentFilters for all Activities
for (ActivityInfo ai : pkg.getActivities()) {
    mActivities.addActivity(ai, "activity");
}
// Services, Providers, and Receivers follow the same pattern
```

Internally, `ActivityIntentResolver` is a matching tree built around MIME type and scheme. During lookup, PMS quickly prunes candidates based on the Intent action and data instead of scanning every filter. Once hundreds of apps are installed, this optimization matters.

## Runtime query: Intent matching and permission checks

After `startActivity(intent)`, control enters AMS, and AMS calls PMS through `queryIntentActivities()`:

```java
@Override
public List<ResolveInfo> queryIntentActivities(Intent intent,
        @ResolveInfoFlagsBits int flags, int userId) {
    enforceCrossUserPermission(userId, "query intent activities");

    // Key step: match against the registered filter table
    List<ResolveInfo> result = mActivities.queryIntent(
            intent, flags, userId);

    // Sort by priority before returning
    Collections.sort(result, PRIORITY_COMPARATOR);
    return result;
}
```

Inside `queryIntent()`, there are three layers of filtering:

1. **IntentFilter matching**: action, category, and data must all match. `action` cannot be empty and must exist in the filter's action list. Every category must match. `data` type and scheme use wildcard matching, not a simple equals check.
2. **Component visibility filtering**: Android 11 introduced package visibility rules. If a package is not declared under `queries` and does not qualify for a `uses-permission` exemption, its components are invisible in the result.
3. **Permission checks**: if the target Activity declares a `permission` attribute, the caller must hold that permission. This is not finalized inside `queryIntentActivities`; AMS performs the final check before starting the Activity.

One common trap: the `exported` attribute is stored in `ActivityInfo.exported` during Manifest parsing, but **Intent matching does not check it**. The real exported check happens in AMS inside `startActivityUnchecked()`. `queryIntentActivities` can return an `exported=false` Activity, but AMS will reject the launch. That timing gap can lead to wrong conclusions during matching investigations.

## Permission registration and signature checks

During installation, PMS also processes `<permission>` declarations:

```java
// App declares a custom permission
pkg.permissions.add(new PermissionInfo("com.example.CUSTOM_PERM",
    ProtectionLevel.DANGEROUS));
```

Permission metadata is written into `mSettings.mPermissions` and persisted to `/data/system/packages.xml`. When an app is uninstalled, the system checks whether other apps still use the permission. If it only belongs to that app, the permission is removed as well.

Signature verification also happens during scanning:

```java
// Signature collection in PackageParser
PackageSignatures signatures = new PackageSignatures();
signatures.mSigningDetails = PackageParser.collectCertificates(
    pkg, parseFlags);
pkg.mSigningDetails = signatures.mSigningDetails;
```

Signatures have two roles: validating that an update APK matches the existing installed APK, and protecting permissions with `signature` level. If a permission uses `protectionLevel=signature`, only apps signed with the same certificate can use it. The common `sharedUserId` scenario depends on this mechanism.

## A few pitfalls from real projects

**Multidex can make component classes disappear.** In a multidex setup, PMS may have already registered every component before `Application.attachBaseContext()` finishes initializing all dex files. Starting an Activity at that point can trigger `ClassNotFoundException`. The fix is to call `MultiDex.install()` as early as possible in Application initialization and avoid triggering any component call before installation completes.

**Manifest Merger can unexpectedly make exported true.** If a library module declares an `<intent-filter>` inside an `<activity>`, manifest merge rules may result in `android:exported` being true or requiring an explicit value. On Android 12, missing an explicit declaration can fail installation outright. The reliable debugging method is to inspect the merged output under `build/intermediates/merged_manifests/` instead of guessing.

**Duplicate permission names conflict.** If two apps declare the same `<permission>` name with different `protectionLevel` values, the first installed app owns the permission name. The later install fails with `INSTALL_FAILED_DUPLICATE_PERMISSION` if the protection levels differ. If a permission is already defined, later apps should either omit the protection level and use the existing definition, or keep it exactly consistent.
