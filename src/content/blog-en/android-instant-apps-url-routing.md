---
title: "Android Instant Apps: URL Routing and Architecture Notes"
lang: en
translationKey: android-instant-apps-url-routing
slug: android-instant-apps-url-routing
excerpt: "A hands-on record of building an Android Instant App, from App Bundle slicing and sandboxed launch to URL routing and install prompts."
publishDate: '2026-07-27'
tags:
- "Android"
- "Instant Apps"
- "App Bundle"
- "URL Routing"
seo:
  title: "Android Instant Apps URL Routing and Architecture"
  description: "How Android Instant Apps slice App Bundles, launch in a sandbox, route URLs, and prompt installation, with practical trade-offs."
  pageType: article
---

> **⁉️ Important note:** Google Play Instant (Instant Apps) was discontinued in December 2025 — Instant Apps can no longer be published through Google Play, the related Google Play services Instant API has also been retired, and the Play platform no longer distributes Instant experiences to users in any way (official announcement: https://developer.android.com/topic/google-play-instant/overview). The official guidance now recommends using Deep Links to route users directly to the fully installed app. This article is retained as a historical record of the technical solution at the time and as a reference for architecture design ideas (ideas such as App Bundle slicing, sandboxed launch, and URL intent routing remain useful references for today's dynamic feature delivery), but do not use the solution in this article as the basis for new project development.

In 2024, when I took over an e-commerce SDK project, the product team raised a requirement: after users tapped a product link, they should be able to complete an order without waiting for installation. At the time, the team's first reaction was "mini programs," but the client-side experience differed too much. In the end we chose Instant Apps, and only after hitting a series of pitfalls did we get the whole chain working.

## App Bundle Slicing: The Physical Foundation of an Instant App

An Instant App is not a standalone artifact; it is a "slice" of an App Bundle. Through the `dynamic delivery` mechanism, Google Play extracts modules from the bundle on demand and delivers them, rather than packaging the entire APK.

A project that supports an Instant experience usually has three layers:

```
app/              → 可安装应用（主入口）
feature/order/    → 订单功能模块（Instant 可访问）
base/             → 共享基础代码和资源
```

Hard constraint: **the Instant module size limit is 10 MB**. This limit forces you to strip away everything non-essential — put shared dependencies in the `base` module, and keep only a minimal single-scenario implementation in the `feature` module.

In `base/build.gradle`, older AGP versions use `com.android.feature` + `baseFeature true` to declare this as the base slice; in newer AGP versions, `base` can use a regular application/library plugin, and the `feature` module changes to `com.android.dynamic-feature`:

```groovy
apply plugin: 'com.android.feature'

android {
    baseFeature true
    // ...
}
```

At compile time, AGP packages each `dynamic-feature` and the `base` module into `.apk` sub-artifacts and writes them into the AAB along with metadata. At runtime, Google Play matches the requested URL path to the corresponding feature module and delivers only that slice.

During actual compilation I ran into one problem: the `base` module referenced `com.google.android.gms:play-services-location`, and that single dependency was 3.2 MB. Add image resources and the Kotlin runtime, and base directly exceeded 6 MB. The final approach was to replace `api` with `implementation` to control dependency propagation more precisely, move image resources into the installable module, and have the Instant module use only vector icons; only then did it fit within the limit.

## Install-Free Launch: Three Hops from the Play Store to the Activity

The launch path for an Instant App differs from a normal APK path. Breaking it down, there are three stages.

**Stage one: Play Store resolution.** After the user taps the link, the Play Store checks whether the URL matches an Instant App's `intent-filter`. If it matches, it does not download immediately; it first verifies whether the device supports the Instant experience — requiring Android 5.0+ and a sufficiently new Google Play Services version.

**Stage two: slice download and sandbox loading.** The Play Store downloads only the matching `dynamic-feature` slice plus the `base` module. After downloading, the system launches the process in a restricted sandbox. The sandbox restrictions include:

- External storage is inaccessible (the `READ_EXTERNAL_STORAGE` permission is ignored)
- Background service starts are restricted (except foreground services)
- Cannot create background download tasks
- The app does not need to be preinstalled; it is loaded and run directly online

**Stage three: Activity rendering.** The system creates the Application instance and starts the target Activity. By the time the user sees the UI, the entire flow usually completes within **3-5 seconds** — this is the core experience metric.

A pitfall I hit: in the Instant App's `Application` class initialization, I was fetching Firebase Remote Config. In the sandbox, Firebase initialization crashed directly, because some Google Play Services background capabilities are missing. The solution was to wrap Firebase initialization in the negative branch of `InstantApps.isInstantApp(context)`:

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (!InstantApps.isInstantApp(this)) {
            FirebaseApp.initializeApp(this)
        }
    }
}
```

A `ContentProvider`'s `onCreate` runs even earlier than `Application.onCreate`; in Instant mode, you likewise cannot do heavy operations in a Provider, otherwise the launch time jumps from 3 seconds to more than 8 seconds.

## URL Intent Routing: The Dispatch Hub from Link to Target Page

The URL-intent routing of an Instant App is the most easily underestimated part of the whole architecture; its design directly determines whether the install-free experience can accurately reach the target page.

### Basic Route Declaration

Declare an `intent-filter` in AndroidManifest to map URL patterns to an Activity:

```xml
<activity android:name=".feature.order.OrderActivity">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="https"
            android:host="shop.example.com"
            android:pathPrefix="/order" />
    </intent-filter>
</activity>
```

`android:autoVerify="true"` triggers Digital Asset Links verification. You need to deploy a verification file at `https://shop.example.com/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.shop",
    "sha256_cert_fingerprints": ["XX:XX:XX:..."]
  }
}]
```

If verification fails, every time the user taps the link a chooser dialog pops up; it changes from "zero waiting" to "choose first, then wait," and the experience collapses.

### Designing the Route Dispatcher

A single Activity can only handle fixed paths. In real scenarios, the same feature module may have multiple page targets, so you need a route dispatcher:

```kotlin
class InstantRouter {

    fun resolve(uri: Uri): RouteTarget? {
        val path = uri.path ?: return null

        return when {
            path.startsWith("/order/") -> RouteTarget(
                activity = OrderActivity::class.java,
                params = mapOf("orderId" to uri.lastPathSegment)
            )
            path.startsWith("/product/") -> RouteTarget(
                activity = ProductActivity::class.java,
                params = mapOf("productId" to uri.lastPathSegment)
            )
            else -> RouteTarget(activity = MainActivity::class.java)
        }
    }
}
```

For routes enabled only in Instant mode, parameter passing must be carefully budgeted — an Instant App's Intent dispatch chain is longer than that of a fully installed build, and too many parameters can hurt parsing efficiency. Here I strictly kept the parameters within three keys.

For the upgrade jump from Instant to the installed version, you need to call the official install-prompt API. Note that the form `getInstantAppClient().getInstallIntentFilter()` does not exist — the official API is a static method `InstantApps.showInstallPrompt()`. You pass an `Activity`, the target `Intent`, and a request code; the system shows an install guide dialog, and after the user confirms it jumps to the Play Store to complete the installation. After installation completes, the result is returned through the `onActivityResult` callback. The timing should be before the user triggers a critical action (such as order checkout/payment), not popping up immediately when the page opens.

## Trade-offs in Practice

After finishing this project, my assessment of Instant App is clear: **it suits lightweight transactional scenarios, not content-oriented or heavy-interaction scenarios.**

**The 10 MB limit is the hardest constraint.** ProGuard/R8 is not optional; it is mandatory. In testing, a medium-complexity order page, after adding Retrofit + Gson + OkHttp, already had 2.8 MB occupied by DEX. Adding a few WebP images easily broke the limit. In the end I split out an extremely thin network layer and used only `HttpURLConnection` + manual JSON parsing, saving nearly 1.6 MB.

**The testing chain is long.** An Instant App must be distributed through Play Console's internal testing track; you cannot simply use adb install. Each debugging cycle had to go through "modify code → build AAB → upload to Play Console → generate pre-release link → scan QR code on phone and test." I abstracted the CI flow into three steps: automatically build the AAB → use `bundletool` to extract the Instant APK locally → `bundletool build-apks` to generate a device-specific package. Local debugging uses that package directly, eliminating the wait for uploading to Play.

**Instant modules are independent APKs but share a process.** Data passing between multiple feature modules cannot rely on singletons — different slices enter the process at different times, so singleton state is unreliable. In the end I chose a combination of `SharedPreferences` + an in-memory LRU cache, without making cross-process assumptions.

After the Instant App adaptation, the time from tapping a link to seeing the order page dropped from 40+ seconds for "download the full APK" to about 4 seconds, and the conversion rate rose from 8% to 19%. The cost was that module splitting added roughly 20% more architecture design work. If you maintain core pages in the transaction chain, that investment is worth it; if you are just building a product introduction page, Deep Link is enough.
