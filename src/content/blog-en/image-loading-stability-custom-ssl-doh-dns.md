---
title: "Image Loading Stability: Custom SSL Verification and DoH DNS in Practice"
lang: en
translationKey: image-loading-stability-custom-ssl-doh-dns
slug: image-loading-stability-custom-ssl-doh-dns
excerpt: "Mobile image failures often come from certificate-chain validation issues, DNS pollution, or regional carrier-resolution problems. This article explains two network-layer improvements for image loading: explicit SSL verification and DoH-based DNS resolution."
publishDate: '2026-06-04'
tags:
- "Android"
- "Image Loading"
- "Network Security"
- "DNS"
- "Stability"
seo:
  title: "Image Loading Stability with Custom SSL and DoH DNS"
  description: "Improve mobile image-loading stability with explicit SSL verification and DoH DNS resolution, reducing certificate and DNS-related failures."
  pageType: article
---

Image requests behave differently from standard API requests. They are numerous, they appear in pressure-heavy scenarios such as first-screen loads, list scrolling, and page transitions, and their failures often do not block the main flow. A broken avatar or blank content image is easy to miss until users report that the page "looks incomplete." Image requests are also usually hidden behind loading libraries, so product code may only set a URL. If network configuration, certificate policy, and DNS strategy are not centralized, they quickly become scattered across unrelated call sites.

On Android, differences between the system network stack and OEM implementations can amplify these issues. Some system versions have incomplete certificate stores, some proxies or public Wi-Fi networks replace certificates, and local DNS in certain regions may resolve the same image domain to an unreachable node. The goal is not to bypass checks just to show more images; it is to improve availability within clear security boundaries, keep failure causes observable, provide fast fallback, and roll out changes gradually.

In our project, image-loading stability is handled mainly in `common/imageloader/ssl` and `common/imageloader/glide/progress/doh`. The SSL part contains custom handlers, trust managers, and user confirmation handling. The DoH part covers DNS record encoding and OkHttp DNS integration. In other words, images are not treated as plain HTTP URLs passed directly to Glide; image-domain resolution, certificate anomalies, user confirmation, and fallback strategies are all part of the image-loading facade.

## DoH DNS: Not a Gimmick, but a Safety Net

DoH should not be enabled universally for all domains. Image domains are usually manageable in number and can be controlled via a whitelist. The resolution result must distinguish between A and AAAA records, and the sorting strategy should consider the client's network capabilities. In environments with unstable IPv6 support, it's better to attempt the address family with a historically higher success rate first, rather than blindly trusting the return order. Cache TTL should also not be too long, as frequent switching in mobile networks can cause connection timeouts with expired addresses; however, it also shouldn't be completely absent, or the high volume of images in a list will overwhelm the DoH request rate.

```kotlin
class ImageDnsResolver(
    private val dohClient: DohClient,
    private val systemDns: Dns,
    private val cache: DnsCache,
    private val enabledHosts: Set<String>
) : Dns {
    override fun lookup(host: String): List<InetAddress> {
        if (host !in enabledHosts) {
            return systemDns.lookup(host)
        }

        cache.get(host)?.let { cached -> return cached.addresses }

        val dohResult = runCatching { dohClient.query(host) }.getOrNull()

        if (dohResult != null && dohResult.addresses.isNotEmpty()) {
            val sorted = AddressPolicy.sortByNetworkQuality(dohResult.addresses)
            cache.put(host, sorted, ttl = dohResult.safeTtl())
            return sorted
        }

        return systemDns.lookup(host)
    }
}
```

DoH itself can fail. If the DoH service is unreachable, the system DNS must fallback quickly; the image request cannot stall on an extra resolution chain. The DoH timeout should be significantly shorter than the overall image connection timeout, and concurrency control must be implemented to prevent a flood of resolution requests on weak networks.

## Custom SSL Validation: A Clearer Security Boundary

Custom SSL validation adopts a "system default validation plus extra constraints" model. First, the system's trust manager performs the basic certificate chain validation, and then we check for domain matching, public key pinning, or other business-allowed certificate attributes. This approach maintains the platform's security model while providing clearer error classification during anomalies:

```kotlin
class ImageTrustManager(
    private val platformTrustManager: X509TrustManager,
    private val pinStore: CertificatePinStore,
    private val reporter: TlsReporter
) : X509TrustManager {

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        platformTrustManager.checkServerTrusted(chain, authType)

        val leaf = chain.firstOrNull() ?: error("empty certificate chain")
        val pinMatched = pinStore.matches(leaf.publicKey)
        if (!pinMatched) {
            reporter.reportPinMismatch(leaf.subject())
            throw CertificateException("image certificate pin mismatch")
        }
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    override fun getAcceptedIssuers(): Array<X509Certificate> =
        platformTrustManager.acceptedIssuers
}
```

Finally, DNS and SSL configurations are combined in the image network client:

```kotlin
fun buildImageHttpClient(config: ImageNetworkConfig): HttpClient {
    val dns = ImageDnsResolver(
        dohClient = config.dohClient,
        systemDns = SystemDns,
        cache = MemoryDnsCache(),
        enabledHosts = config.imageHosts
    )

    val trustManager = ImageTrustManager(
        platformTrustManager = PlatformTrustManager.create(),
        pinStore = config.pinStore,
        reporter = config.tlsReporter
    )

    return HttpClient.Builder()
        .dns(dns)
        .sslSocketFactory(SslFactory.from(trustManager), trustManager)
        .eventListener(ImageRequestEventListener())
        .connectTimeout(config.connectTimeout)
        .readTimeout(config.readTimeout)
        .build()
}
```

## Structured Errors: Making Failures Clearer

Error objects should be as structured as possible, rather than just recording a block of exception strings:

```kotlin
enum class ImageFailureStage {
    DNS_LOOKUP, TCP_CONNECT, TLS_HANDSHAKE,
    HTTP_RESPONSE, DECODE, UNKNOWN
}

data class ImageFailure(
    val stage: ImageFailureStage,
    val safeReason: String,
    val fallbackUsed: Boolean
)
```

This design makes subsequent analysis more direct. If `TLS_HANDSHAKE` errors increase in a certain version, check the certificate policy first; if `DNS_LOOKUP` timeouts are concentrated in a specific network type, check DoH availability and system DNS fallback; if `DECODE` errors rise, the issue might be with the image format or decoding library.

## Key Constraints in Implementation

Never trust all certificates in a production environment. During development, independent debugging configurations can be used for easier packet capture, but this must be isolated via build types, runtime environments, or feature flags.

Certificate pinning must account for rotation. Pinning only a single leaf certificate is high-risk; if the server updates its certificate, older clients might fail to load images. A more robust approach is to pin a public key or a set of acceptable fingerprints and release a client version containing the new fingerprints in advance.

Rollout must proceed by domain and client version. Start by observing success rates, latency, TLS error rates, and fallback rates with a small set of image domains before expanding to more. Do not apply the same aggressive DNS strategy across APIs, WebViews, downloads, and images, as their failure costs and traffic characteristics differ.

---

Image loading stability is not achieved by simply increasing timeouts or relying on placeholders to hide failures. A reliable solution puts DNS, TLS, HTTP, decoding, and UI rendering on one observable pipeline. A custom `TrustManager` defines explicit security policy and error classification; DoH DNS reduces uncertainty in the local resolution environment. Together, they should remain secure by default, enabled per domain, fast to fall back, and fully observable. After launch, do not look only at the overall success rate; monitor failure-stage distribution, network-type differences, DoH hit rate, system-DNS fallback rate, and certificate-error trends. Only when those metrics are stable is the image experience truly stable.
