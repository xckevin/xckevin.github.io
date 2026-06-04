---
title: "Android App Links: Digital Asset Links and Web-to-App Routing"
lang: en
translationKey: android-app-links-digital-asset-links
slug: android-app-links-digital-asset-links
excerpt: "A full-chain guide to Android App Links, covering Digital Asset Links, automatic domain verification, routing behavior, debugging tools, release signatures, and cross-domain pitfalls."
publishDate: '2026-05-20'
tags:
- "Android"
- "App Links"
- "Deep Link"
- "Intent"
- "Routing"
seo:
  title: "Android App Links: Digital Asset Links and Web-to-App Routing"
  description: "A practical guide to Android App Links, Digital Asset Links verification, Intent routing, release signatures, and debugging tools."
  pageType: article
---

## A strange failed redirect

Last year I integrated App Links for an ecommerce app. Everything worked in the test environment, but after release users reported that tapping links still opened the web page. The Digital Asset Links file was reachable at `https://example.com/.well-known/assetlinks.json`, and the SHA-256 fingerprint matched.

After comparing the setup repeatedly, I found the problem: the test build and production build used different signing certificates. App Links verification is **bound to the certificate fingerprint of the release signing key**, but I had put the debug signing fingerprint in `assetlinks.json`. The frustrating part is that there is no obvious error. The system silently degrades to a normal deep link.

This is what separates App Links from ordinary deep links: **they require both the domain owner and the app developer to confirm identity**. If you treat App Links as an Intent filter that "just works automatically," production will expose the gap.

## Digital Asset Links: the anchor of two-way trust

The App Links trust model starts from one premise: whoever can make `https://yourdomain.com/.well-known/assetlinks.json` return specific content is the legitimate controller of that domain. The app signing certificate's SHA-256 fingerprint proves the app's origin. When the two match, the trust loop is closed.

The standard `assetlinks.json` structure is:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.app",
      "sha256_cert_fingerprints": [
        "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:C6:20:FE:BA:CD"
      ]
    }
  }
]
```

Three fields matter most:

- **relation**: the fixed value `delegate_permission/common.handle_all_urls`, meaning "delegate URL handling for this domain to the app." This is the only valid value for this purpose.
- **package_name**: the app package name, used when one domain is associated with multiple apps.
- **sha256_cert_fingerprints**: the most important part. You can get it with the JDK's built-in `keytool`:

```bash
keytool -list -v -keystore release.keystore | grep SHA256
```

**This fingerprint is bound to the certificate, not to the signing file itself.** Different apps signed with the same certificate, such as a main app and a Lite app, can pass verification as long as their package names match the corresponding entries.

A common misunderstanding is that `assetlinks.json` can contain multiple certificate fingerprints for "signature compatibility." In practice, if you put both debug and release fingerprints in the file, the system uses **the first matching statement** and does not merge records as "any one of these may pass." Behavior also differs across Android versions: Android 12 and below are somewhat looser, while Android 13 and later are stricter.

## Behind the system's automatic approval flow

The core value of App Links is skipping user confirmation: tapping a link opens the app directly without showing a chooser. That experience is backed by a **system-level verifier mechanism**.

### Verification timing and conditions

The system does not request `assetlinks.json` every time a link is tapped. Verification happens at these moments:

1. After app installation completes, triggered by `ACTION_PACKAGE_ADDED`
2. During app update, on Android 12 and later
3. After device reboot, when cached verification results are checked again

Verification also has network requirements. The device must be on a non-metered network, and Android 13 and later require DNS resolution to succeed. One issue I hit was an internal-network test device that could not resolve the public domain. Verification never passed, but the system did not report a visible error.

### What the verification request really looks like

The verifier sends a standard HTTPS GET request with **no distinctive User-Agent**. It looks like ordinary traffic. If you serve `assetlinks.json` through an Nginx reverse proxy, you cannot allow only specific User-Agents for that path.

A few constraints matter:

- The request **does not follow redirects**; HTTP 301/302 fails directly
- Timeout is roughly 5 seconds
- Response must use `Content-Type: application/json`
- File size limit is 64 KB

```nginx
# Correct server-side configuration
location /.well-known/assetlinks.json {
    default_type application/json;
    add_header Cache-Control "public, max-age=3600";
    try_files /static/assetlinks.json =404;
}
```

`try_files` is the key detail. The server must return the file directly and avoid application-layer routing. I once used a `rewrite` rule that sent the request through PHP, where the framework overwrote the response header to `text/html`. Verification failed immediately.

### Verification state lifecycle

The system maintains a verification-state table in `Settings.Global`. You can inspect it with adb:

```bash
adb shell settings get global device_policy_manager_pending_intents
# Check App Links verification state on Android 11+
adb shell pm get-app-links com.example.app
```

Example output:

```
com.example.app:
    ID: 3f4b5c6d...
    Signatures: [14:6D:E9:...]
    Domain verification state:
      example.com: verified
      www.example.com: legacy_failure
```

There are four common states:

- **verified**: fully trusted; links open the app without confirmation
- **unverified**: pending or failed verification; behavior is the same as a normal deep link
- **legacy_failure**: verification failed previously; after Android 12, the system does not automatically retry, so the user must authorize it in Settings or the cache must be cleared
- **none**: no `autoVerify` declaration

`legacy_failure` is easy to miss. If you changed `assetlinks.json` while the app was already installed on a user's device, that state is not refreshed automatically. You must trigger reinstall or clear it manually:

```bash
adb shell pm clear-domain-preferences com.example.app
```

## Practical routing scenarios

Passing verification does not mean every scenario will route as you expect. These three issues came from real projects.

### Chrome address-bar input versus in-page link clicks

Chrome handles App Links in two categories:

- **Address-bar input or bookmark open**: even if the domain is verified, Chrome still shows a chooser, and the user must tap "Open in app."
- **In-page link click (`<a href>`)**: if the domain is verified, Chrome opens the app directly without showing a chooser.

This distinction comes from Chrome's own Intent dispatch logic, not from Android system behavior, and app code cannot override it.

If the business depends heavily on direct address-bar entry, such as users typing a short link after scanning offline material, consider using an `intent://` scheme on the web side as a fallback, or falling back to a custom scheme.

### Verification scope in cross-domain scenarios

App Links verification uses **strict domain matching**. `sub.example.com` and `example.com` are treated as different entities.

When multiple hosts are declared in the manifest:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
    <data android:scheme="https" android:host="sub.example.com" />
</intent-filter>
```

The system requests `assetlinks.json` from both `example.com` and `sub.example.com`. **If any host fails verification, the entire Intent filter is marked unverified.** This "all or nothing" behavior is not made very explicit in the official documentation.

### Priority conflict between App Links and Custom Tabs

If your app embeds a Chrome Custom Tab, and the page inside that Custom Tab contains a URL for your App Links domain, behavior depends on the Android version:

- **Before Android 12**: links inside the Custom Tab can open the app directly, causing the Custom Tab to exit and creating a broken experience.
- **Android 12+**: the system added an `Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER` check. Custom Tabs no longer trigger direct App Links navigation and instead show an "Open in app" banner.

If your business flow needs an in-app WebView or Custom Tab to jump to another screen inside the same app, an explicit `Intent` is much more reliable than going through App Links.

## Debugging toolbox

When diagnosing App Links, this order is the fastest way to narrow the problem.

**1. Verify the file layer**

```bash
curl -I https://example.com/.well-known/assetlinks.json
# Check Status 200 and Content-Type: application/json
```

Google provides an online verification API: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://example.com&relation=delegate_permission/common.handle_all_urls`

**2. Check system state**

```bash
adb shell dumpsys package domain-preferred-apps
adb shell pm get-app-links com.example.app
```

**3. Simulate system verification**

```bash
adb shell pm verify-app-links --re-verify com.example.app
```

This command forces reverification and prints the result for each domain. In production debugging, it is much faster than repeatedly reinstalling the app.

**4. Chrome debugging entry point**

Enter `chrome://interstitials` in the Chrome address bar. It exposes Chrome's internal App Links handling logs, including why Chrome did or did not choose a direct app launch.

## Final notes

The time-consuming part of App Links integration is not writing the XML or `assetlinks.json`; those can be done in 30 minutes. The real cost is understanding asynchronous verification, handling behavior differences across scenarios, and building a reusable debugging process.

My recommendation: before launch, build an internal test APK with the release signing key, run `pm verify-app-links` in a real network environment, and confirm every host is in the `verified` state. Skipping that step can easily multiply later debugging time by ten.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Engineering](/en/android-engineering/)
- [Android Credential Manager: FIDO2, passkeys, and device-side security](/en/blog/android-credential-manager-passkeys/)

<!-- /seo-internal-links -->
