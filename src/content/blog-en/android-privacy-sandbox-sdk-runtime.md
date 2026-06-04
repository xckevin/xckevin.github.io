---
title: "Android Privacy Sandbox End to End: SDK Runtime and Protected Audience"
lang: en
translationKey: android-privacy-sandbox-sdk-runtime
slug: android-privacy-sandbox-sdk-runtime
excerpt: "A practical walkthrough of Android Privacy Sandbox, including SDK Runtime isolation, Protected Audience auctions, Attribution Reporting, and migration advice."
publishDate: '2025-08-28'
tags:
- "Android"
- "Privacy Sandbox"
- "Ad Tech"
- "Privacy Protection"
- "Architecture Design"
seo:
  title: "Android Privacy Sandbox: SDK Runtime, Protected Audience, and Attribution"
  description: "Understand Android Privacy Sandbox from SDK Runtime process isolation to on-device Protected Audience auctions, Attribution Reporting, and migration planning."
  pageType: article
---

## When device identifiers stop being a free lunch

During a release iteration in 2023, an ad SDK suddenly reported a much smaller volume of data. After investigating, we found that on some Android 14 devices, `ANDROID_ID` returned an empty string. Users had disabled cross-app tracking, and Privacy Sandbox's `getTopics()` path was replacing the traditional device identifier workflow.

GAID, the Google Advertising ID, can no longer be treated as a foundational dependency for attribution and ad delivery. Ad infrastructure needs to be redesigned from the SDK process model through bidding logic. My team spent nearly three months adapting to this shift. This article records the technical decisions from that work.

## SDK Runtime: putting ad SDKs in a sandbox

In the traditional model, a third-party ad SDK is integrated into the host APK as a dependency library. It runs in the same process as the host app and can access the app's permissions: SharedPreferences, the file system, and even host components through reflection.

SDK Runtime changes that model. Ad code runs in an **independent process** and communicates with the host through declarative APIs. The security boundary changes from "trust third-party code" to "allow only declared calls."

### How process isolation is implemented

Declare the configuration entry in the Manifest:

```xml
<!-- AndroidManifest.xml -->
<application>
    <property
        android:name="android.adservices.AD_SERVICES_CONFIG"
        android:resource="@xml/ad_services_config" />
</application>
```

```xml
<!-- res/xml/ad_services_config.xml -->
<ad-services-config>
    <custom-audiences>
        <sdk runtimeEnabled="true"
            android:name="com.example.adtech" />
    </custom-audiences>
</ad-services-config>
```

SDK developers expose functionality through `SandboxedSdkProvider`:

```kotlin
class MyAdSdkProvider : SandboxedSdkProvider() {
    override fun onLoadSdk(params: Bundle): SandboxedSdk {
        val controller = AdController.build(requireContext())
        return SandboxedSdk(IBinderWrapper(controller.asBinder()))
    }
}
```

The host loads the SDK with `SdkSandboxManager.loadSdk()`, and the two sides communicate across processes through Binder. But this is not ordinary Binder IPC. The SDK Runtime process **has no network permission**, **cannot read or write external storage**, and **cannot access the host process memory space**.

One pitfall I hit: the context inside `SandboxedSdkProvider` is not the Application Context, so it cannot start an Activity or register broadcasts. If your SDK depends on third-party libraries that are implicitly initialized by the Application, it is likely to crash.

## Protected Audience: replacing cloud profiles with on-device auctions

Protected Audience, formerly FLEDGE, is based on one principle: **user interest data stays on the device, and bidding happens on the device**.

### From joining an audience to on-device bidding

```kotlin
val buyer = AdTechIdentifier.fromString("com.example.adtech")
val customAudience = CustomAudience.Builder()
    .setBuyer(buyer)
    .setName("sports-enthusiasts")
    .setDailyUpdateUri(adsUri)          // Backend updates bidding data
    .setAds(listOf(
        AdData.Builder()
            .setRenderUri(renderUri)
            .setMetadata("{ \"bid\": 0.5 }")
            .build()
    ))
    .setActivationTime(Instant.now())
    .setExpirationTime(Instant.now().plus(30, ChronoUnit.DAYS))
    .build()

adServicesClient.joinCustomAudience(customAudience)
```

`joinCustomAudience` adds the user to the "sports-enthusiasts" audience. When the system triggers an auction, the backend referenced by `setDailyUpdateUri()` provides ad creatives and bidding parameters. One integration issue we ran into was the hardcoded 24-hour cache for daily updates. Dynamic price changes had to be deployed one day ahead, which forced operations to adjust their cadence.

### Bidding scripts and decision logic

Bidding logic is not hardcoded in client code. It is injected as a **JavaScript script** and executed in a WebView sandbox:

```javascript
// bidding_logic.js - executed in an isolated WebView sandbox
function generateBid(ad, auction_signals, per_buyer_signals,
                      trusted_bidding_signals, browser_signals) {
    const bidFloor = parseFloat(ad.metadata.bid);
    const budgetRemaining = browser_signals.original_budget /
        browser_signals.original_bid_count;

    if (budgetRemaining < bidFloor) return { bid: -1 };

    return {
        bid: bidFloor,
        render: ad.renderUri,
        adComponents: [ad.componentUri]
    };
}

function reportResult(auctionConfig, browserSignals) {
    sendReportTo(browserSignals.reportingUrls.reportingUrl +
        "&bid=" + browserSignals.bid +
        "&win=" + browserSignals.winningBid);
}
```

The script runs in a WebView sandbox that is fully isolated from the host. It can only read fields passed through `browser_signals`; it cannot inspect installed apps, contacts, or other private data.

### Gradual rollout strategy for scripts

Because bidding logic runs on the device, you cannot hotfix it like server-side logic. The approach I designed was to include a script version in every `dailyUpdateUri` response. The client caches scripts by version, and a new version overwrites the old one. To roll back, the backend returns the previous version number.

## Attribution Reporting: tracking conversions without Device ID

Without GAID, Privacy Sandbox provides the **Attribution Reporting API**. Attribution has two steps: register a Source when an ad is shown, then register a Trigger when a conversion occurs. The system matches them asynchronously and generates reports.

```kotlin
// Register Source: the ad was seen
val source = RegisterSourceRequest.Builder()
    .setAttributionSource(
        AttributionSource.Builder()
            .setRegistrant(AdTechIdentifier.fromString("com.advertiser"))
            .build())
    .setWebDestination(Uri.parse("https://advertiser.com"))
    .setAppDestination(Uri.parse("android-app://com.advertiser"))
    .setExpiry(30, TimeUnit.DAYS)
    .build()
measurementClient.registerSource(source)
```

```kotlin
// Register Trigger: the user completed a purchase
val trigger = RegisterTriggerRequest.Builder()
    .setAttributionSource(/* Same as above */)
    .setEventTriggers(listOf(
        EventTrigger.Builder()
            .setTriggerData(1)      // 0=view, 1=purchase, 2=signup
            .setTriggerPriority(100)
            .setDedupKey(10001L)
            .build()
    ))
    .build()
measurementClient.registerTrigger(trigger)
```

There are two report types. **Event-level reports** are sent after triggering and contain coarse conversion data. **Aggregate reports** are encrypted and delayed, then used for statistical analysis.

One practical limitation is easy to miss: `triggerData` only supports values from 0 to 7, or 3 bits. Do not expect to pass custom data through it. More conversion dimensions need to be modeled through histogram contribution values in aggregate reports.

## Engineering advice for migration

**SDK refactoring granularity.** SDK Runtime requires ad logic to run independently. I split the bidding engine, audience management, and attribution reporting into three separate modules. The benefit was independent updates and tests. The cost was that cross-module state synchronization had to go through the host. For smaller SDKs, one module is usually enough.

**Test environment setup.** Privacy Sandbox APIs behave differently on emulators and real devices. `selectAds()` often returns empty results on emulators because the system needs real on-device data to train interest models. I eventually built a real-device test cluster and added integration tests to CI.

If you are planning a migration now, I recommend this order: start with Attribution Reporting because it has the smallest change surface and produces immediate value; then move to Custom Audience management; finally tackle SDK Runtime process isolation. SDK Runtime is the most disruptive to existing architecture, but it also solves the third-party code trust problem at the root. That is the part of the Privacy Sandbox architecture I find most valuable.
