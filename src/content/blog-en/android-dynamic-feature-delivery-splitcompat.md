---
title: "Android Dynamic Feature Delivery: From App Bundle to SplitCompat"
lang: en
translationKey: android-dynamic-feature-delivery-splitcompat
slug: android-dynamic-feature-delivery-splitcompat
excerpt: "An end-to-end guide to Android dynamic feature delivery, covering App Bundle splits, SplitCompat runtime loading, Play Feature Delivery, and package size tradeoffs."
publishDate: '2026-05-24'
tags:
- "Android"
- "App Bundle"
- "Dynamic Features"
- "SplitCompat"
- "Performance Optimization"
seo:
  title: "Android Dynamic Feature Delivery: App Bundle, Split APK, and SplitCompat"
  description: "Explore Android dynamic feature delivery from AAB builds and Split APKs to SplitCompat loading, Play delivery modes, testing, and size optimization."
  pageType: article
---

Last year I took over an international project whose APK had grown to 120 MB. Removing code and compressing resources helped only a little. The real breakthrough was moving "features users do not need right now" out of the initial install. That led us into Android's dynamic feature delivery system. This article walks through the full path: App Bundle builds, Split APK generation, SplitCompat runtime loading, and Play Feature Delivery on-demand installation.

## What App Bundle Really Changes: Compile-Time Splitting, Not Packaging-Time Splitting

Traditional APK builds put all code and resources into one file. App Bundle (AAB) changes that model: **the build artifact is no longer an installable APK, but an intermediate format that contains the raw resources for all modules**.

```bash
# Build an AAB instead of running assembleRelease
./gradlew bundleRelease
# Output: app/build/outputs/bundle/release/app.aab
```

The key parts of an AAB are `BundleConfig.pb` and the module directories:

```
app.aab
|-- BundleConfig.pb          # Describes the module split strategy
|-- base/                    # Base module, always installed
|   |-- manifest/
|   |-- dex/
|   `-- res/
|-- feature1/                # Dynamic feature module
`-- feature2/
```

After Google Play receives the AAB, it generates and **re-signs** a set of Split APKs based on the target device configuration, including screen density, CPU architecture, and language. The base APK is always delivered, while other Split APKs are delivered conditionally. That means you do not need separate packages for x86 and arm64; Play trims the package automatically.

One trap I hit: if `android:extractNativeLibs` is set to false in the manifest, `.so` files inside Split APKs may not load as expected and need extra handling. The reason is that native library paths inside Split APKs do not participate in the standard extraction flow in the same way.

## SplitCompat: Working Around ClassLoader Parent Delegation

Dynamic feature code is not inside `base.apk`. How does the runtime load classes from it? Android's standard ClassLoader uses parent delegation. `PathClassLoader` loads dex from `base.apk` and does not automatically "see" Split APKs.

SplitCompat solves this by **injecting Split APK dex paths into the Application ClassLoader path**:

```java
// Simplified SplitCompat internal flow
public static void install(Context context) {
    // 1. Find all installed Split APKs
    File[] splitApks = getSplitApkPaths(context);
    
    // 2. Create a ClassLoader that contains Split dex files
    ClassLoader splitLoader = createSplitClassLoader(splitApks);
    
    // 3. Set splitLoader as the parent of PathClassLoader
    //    Parent delegation will search splitLoader first
    Field parentField = ClassLoader.class.getDeclaredField("parent");
    parentField.setAccessible(true);
    parentField.set(context.getClassLoader(), splitLoader);
}
```

The key technique is **reflectively modifying the ClassLoader parent chain**, rather than replacing the ClassLoader itself. That keeps the `Application` instance's ClassLoader reference stable while allowing classes in Split APKs to be discovered.

Google goes further in `SplitCompatApplication`: it calls `SplitCompat.install()` during `attachBaseContext`, ensuring dynamic modules are available during Application initialization:

```java
public class MyApplication extends SplitCompatApplication {
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base); // SplitCompat.install() happens here
        // Dynamic module code is now accessible
    }
}
```

Resource loading also needs special handling. A Split APK's `resources.arsc` is not merged automatically. Google uses `SplitCompatResourcesLoader` to inject the Split APK resource ID table into `AssetManager`. Many pre-Android 6.0 dynamic loading frameworks had resource corruption bugs, and this is where those issues came from.

## Handling Modules That Are Not Ready for Dynamic Loading

SplitCompat uses reflection to modify the ClassLoader parent chain and indirectly load module code. That creates several unavoidable constraints.

**Unregistered components**

- Activity and Service classes inside a Split APK must be declared in the base module's AndroidManifest, or startup must be intercepted through reflection.
- Instant Run used instrumentation for this: it replaced Activity launch calls at compile time.

**Resource access path changes**

- `getClass().getResource()` and `ClassLoader.getResource()` query only resources associated with the current ClassLoader.
- Dynamic module resource files need to be injected ahead of time through `AssetManager.addAssetPath()`.

**ClassLoader isolation boundaries**

- If the same class appears in both the base module and a Split APK, which one wins depends on the injected parent chain order.
- I once hit an OkHttp version conflict in a real project: base used 3.x, the dynamic module depended on 4.x, and SplitCompat loaded 4.x, causing a runtime `NoSuchMethodError`.
- The fix is to align dependency versions and use Gradle `implementation` instead of `api` to control transitive exposure.

## Play Feature Delivery: The Last Mile to the User Device

The build system generates Split APKs, and Play delivers modules to the device at the right time. There are three delivery modes:

| Mode | Install timing | Suitable use case |
|---|---|---|
| install-time | During app installation | Supporting modules for core features |
| on-demand | When the user triggers it | Non-core features |
| conditional | Automatically when conditions match | Features for specific countries or regions |

The on-demand installation flow is: user taps a feature, the app sends a request through the Play Core SDK, Play Store downloads the Split APK, installs it into the app-private directory, and SplitCompat takes over class loading.

```kotlin
// Request on-demand module installation
val manager = SplitInstallManagerFactory.create(context)
val request = SplitInstallRequest.newBuilder()
    .addModule("feature_camera") // Module name matches dynamicFeature in build.gradle
    .build()

manager.startInstall(request)
    .addOnSuccessListener { /* Installed; now you can launch the module Activity */ }
    .addOnFailureListener { /* Network issue or insufficient storage */ }
```

Installed modules live under `/data/data/<package>/splitcompat/`, and each module has independent version management. One detail matters: after the user clears app data, files under the SplitCompat directory are also removed, so modules must be downloaded again. If an on-demand module is large, such as an AR feature with model files, listen for this scenario and preload proactively.

## Pitfall Memo

**1. MultiDex and SplitCompat interaction**

Devices below Android 5.0 require MultiDex, and MultiDex also modifies the ClassLoader chain. SplitCompat must run after MultiDex, or dex loading order can break. In `attachBaseContext`, call `MultiDex.install()` first, then `SplitCompat.install()`.

**2. ProGuard rules**

Entry classes in dynamic modules, especially classes loaded with `Class.forName()`, must be kept. Reflection code that modifies ClassLoader behavior also needs to be excluded from obfuscation:

```text
-keep class com.google.android.play.core.splitcompat.SplitCompat { *; }
-keep class * extends com.google.android.play.core.splitinstall.SplitInstallSessionState { *; }
```

**3. Test coverage**

Local builds cannot fully simulate Play Feature Delivery. Use `bundletool` to generate a device-specific APK set and install it locally:

```bash
bundletool build-apks --bundle=app.aab --output=app.apks
bundletool install-apks --apks=app.apks
```

This installs the full Split APK structure on the device instead of a single fat APK, so it can validate the real SplitCompat runtime behavior. Without this step in CI, dynamic loading failures may not appear until production.

Dynamic feature delivery can substantially reduce initial package size. In the 120 MB project, splitting modules reduced the first download to 45 MB and improved install conversion by roughly 12%. The cost is higher architectural complexity: the team needs to understand ClassLoader behavior to debug issues. If package size is not already hurting business metrics, I would not adopt this system just for architectural elegance.
