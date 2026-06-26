---
title: "Speeding Up Android WebView: Resource Interception and Offline Package Caching in Practice"
lang: en
translationKey: android-webview-resource-interception-offline
slug: android-webview-resource-interception-offline
excerpt: "A practical walkthrough of using shouldInterceptRequest to serve WebView resources from a local offline package, cutting first-paint time from 2.8s to 0.6s."
publishDate: '2026-06-26'
tags:
- "Android"
- "WebView"
- "Performance"
- "Offline Cache"
- "shouldInterceptRequest"
seo:
  title: "Android WebView Resource Interception and Offline Package Caching"
  description: "How to use shouldInterceptRequest plus an offline package to cut WebView first-paint from 2.8s to 0.6s, with notes on sync IO, concurrency limits, and cookies."
  pageType: article
---

I inherited a hybrid app where the WebView activity page took 2.8 seconds to show anything on first paint. The brief from my lead was a single sentence: "get it under one second." My instinct was to move the assets local and branch the request stream through the interception API.

## Where the WebView load actually stalls

An H5 page inside WebView travels a much longer path than a native screen. From tap to first paint you pay for DNS, TCP, TLS, HTML download, then CSS/JS/image fetches — every hop adds network latency.

I captured 100 production traces and the bottleneck was not the HTML payload. It was the **serial dependency chain**: once HTML arrives, the parser discovers 8 CSS and 12 JS references and queues them one by one. On a flaky mobile network each request averages 200ms, so 20 resources put a theoretical ceiling near 4 seconds.

The interception idea is blunt: if the asset already lives on disk, read it from there. `shouldInterceptRequest` is the hook for that.

## How shouldInterceptRequest works

`WebViewClient` exposes this callback so you can take over any resource request:

```kotlin
webView.webViewClient = object : WebViewClient() {
    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        val url = request.url.toString()
        // Try the offline package first
        val local = loadFromOfflinePackage(url)
            ?: return null // null = fall back to network
        return WebResourceResponse(
            local.mimeType,
            "UTF-8",
            ByteArrayInputStream(local.bytes)
        )
    }
}
```

Two behaviors matter here.

First, interception happens before DNS. When the callback returns a non-null `WebResourceResponse`, the WebView engine skips the entire network stack and consumes the stream you hand it. That is the root of the win — the network cost is gone, not reduced.

Second, the callback sees every resource type: CSS, JS, images, fonts, fetch/XHR. That makes this entry point useful far beyond offline loading — request monitoring, content rewriting, mock injection all fit here.

On Android 5.0+ prefer the `shouldInterceptRequest(WebView, WebResourceRequest)` overload. It gives you full headers and the HTTP method, which the legacy signature does not.

## Offline package architecture

Three layers: package management, resource interception, network fallback.

### Distribution and versioning

The offline package is just a ZIP of all frontend static assets, versioned and shipped over CDN. After download the app extracts it into internal storage.

```kotlin
data class OfflinePackage(
    val version: Long,       // timestamp as version
    val url: String,         // CDN download URL
    val filePath: String     // local extraction path
)
```

The update strategy is **silent update, next-launch activation**: on app start we check for a new version asynchronously, download and extract to a temp dir, and switch over on the next cold start. This never blocks the home screen and avoids replacing files while the app is running.

One lesson learned the hard way: verify the ZIP MD5. We shipped a truncated download once, extraction failed, and the blank-screen rate jumped 15%. A single MD5 check made it disappear.

### Path mapping in the interceptor

After extraction, the file layout must map directly onto URL paths. Use the URL path as the lookup key:

```kotlin
fun loadFromOfflinePackage(url: String): LocalResource? {
    val uri = Uri.parse(url)
    // url:    https://cdn.example.com/static/js/app.abc123.js
    // local:  /offline_root/static/js/app.abc123.js
    val relativePath = uri.path ?: return null
    val localFile = File(offlineRoot, relativePath)
    if (!localFile.exists()) return null

    return LocalResource(
        bytes = localFile.readBytes(),
        mimeType = MimeTypeMap.getFileExtensionFromUrl(url)
            ?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
            ?: "application/octet-stream"
    )
}
```

MIME mapping is easy to skip and painful when wrong. Tag a CSS file as `text/html` and the browser will not treat it as a stylesheet — the page breaks. Do not hardcode MIME types.

### Network fallback

The offline package cannot hit 100%. Dynamically loaded images and user-generated content still need the network. Graceful fallback looks like this:

```kotlin
override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest
): WebResourceResponse? {
    val url = request.url.toString()

    // Pass through non-critical domains untouched
    if (isExcludedDomain(url)) return null

    // Try the offline package first
    val local = loadFromOfflinePackage(url)
    if (local != null) {
        reportHit("offline")
        return local.toResponse()
    }

    // Miss — let WebView hit the network
    reportHit("network")
    return null
}
```

Returning `null` tells WebView to proceed with a normal network request, so page behavior stays intact. That is the whole hybrid strategy: **offline first, network as fallback**.

## Pitfalls: from "it works" to production-stable

### Pitfall 1: synchronous IO blocking the WebView thread

`shouldInterceptRequest` runs on WebView's request thread. Do synchronous file IO there — especially `readBytes()` on a large image — and you stall the entire rendering pipeline.

The fix is an in-memory buffer layer:

```kotlin
private val cache = LruCache<String, LocalResource>(maxSize = 50 * 1024 * 1024)

fun loadFromOfflinePackage(url: String): LocalResource? {
    cache.get(url)?.let { return it }
    // First load hits disk
    val resource = doLoadFromDisk(url) ?: return null
    cache.put(url, resource)
    return resource
}
```

With a 50MB LruCache the hit rate settles at 92% across 200+ pages, and per-page IO drops from 50+ reads to single digits.

### Pitfall 2: Chromium's hidden concurrency cap

Chromium caps concurrent requests to the same domain at 6. When the interceptor returns dozens of local resources, that limit still applies — the engine does not know your bytes came from disk, so it queues them as if they were network fetches.

On pages with 20+ resources this is visible: everything is local, yet assets appear one by one.

The fix belongs on the build side, not the client: **merge assets**. Combine small CSS into one bundle, inline icons as SVG sprite or base64. The client just loads what the build produced.

### Pitfall 3: cookies and auth

When `shouldInterceptRequest` returns a custom response, WebView does not attach cookies for that URL. If static assets live behind an authenticated domain, offline interception silently breaks auth.

My workaround: the interceptor branches on domain type. Authenticated domains pass through to the network so WebView handles cookies itself; plain CDN domains go through the offline path. Trivial logic, but it has run clean in production for six months.

## Results and tradeoffs

After launch, first-paint P50 dropped from 2.8s to 0.6s and P90 from 4.2s to 1.1s on 4G weak networks.

One thing I would change: the package takes 30MB of storage, which is unkind to low-end devices. A redo would download only core assets at install time (first-paint CSS and framework JS) and lazy-load the rest on first use.

Full replace or incremental patch? Full replacement is simpler and avoids file-version drift, at the cost of re-downloading the whole package each update. For our 6MB package updated twice a month, full replace is fine. If your assets change often, use bsdiff — clients merge patches and save 70%+ of download bandwidth.
