---
title: "Android Network Security Config to SSL Pinning: An End-to-End Guide"
lang: en
translationKey: android-network-security-config-ssl-pinning
slug: android-network-security-config-ssl-pinning
excerpt: "A practical walkthrough of Android's three-layer network defense: Network Security Config, SSL Pinning, and Certificate Transparency, from configuration traps to production monitoring."
publishDate: '2026-06-23'
tags:
- "Android"
- "Network Security"
- "SSL Pinning"
- "Certificate Transparency"
- "Network Security Config"
seo:
  title: "Android Network Security Config, SSL Pinning & CT Guide"
  description: "Build Android's three-layer network defense: Network Security Config, SSL Pinning, and Certificate Transparency, from config traps to live monitoring."
  pageType: article
---

During a security audit, Burp Suite could not capture our app's HTTPS traffic. The security team asked if I had pinned certificates. I combed through the code and found no OkHttp `CertificatePinner` configuration. The culprit turned out to be Android 7.0's default behavior — the system trusts only pre-installed CAs, and user-installed certificates (including Charles and Burp roots) do not apply to apps by default.

The mechanism behind this "secure default" is Network Security Config.

## Network Security Config: Declarative Certificate Trust Management

Network Security Config is an XML configuration framework introduced in Android 7.0. Declared in `AndroidManifest.xml`, it extracts certificate trust logic from code into static, auditable configuration.

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/debug_ca" />
        </trust-anchors>
    </base-config>
    
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.0.0.1</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
```

Key behaviors:

- `base-config` applies to all domains without a specific declaration; `domain-config` overrides per domain
- `cleartextTrafficPermitted="false"` blocks HTTP plaintext requests outright with `Cleartext HTTP traffic not permitted`. This is independent from `NetworkOnMainThreadException` — the former is a security policy block, the latter a threading restriction
- `src="user"` should only appear in debug builds — **shipping it in release disables your security entirely**

A trap I hit: I configured `base-config` with `src="system"` and `src="@raw/our_ca"`, but the test environment backend used a self-signed certificate not issued by `our_ca`. The `domain-config` did not cover the test domain, so requests failed with `Trust anchor for certification path not found`. The debugging lesson: do not only read OkHttp logs — **first confirm whether system-level certificate validation already failed**, because Network Security Config runs during the TLS handshake, earlier than any OkHttp interceptor.

## SSL Pinning: Narrowing Trust to Specific Certificates

System trust anchors are effectively a list of hundreds of CAs. SSL Pinning narrows that trust to one or two specific certificates or public keys, so a man-in-the-middle attack fails even if the attacker obtains a legitimately CA-signed fraudulent certificate.

OkHttp offers two pinning approaches:

```kotlin
// Approach 1: CertificatePinner — pin by SHA-256 hash
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .add("api.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=") // backup
    .build()

val client = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

```kotlin
// Approach 2: Custom TrustManager — compare the certificate chain directly
val customTrustManager = object : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val expectedPublicKey = loadPublicKeyFromRaw(R.raw.server_cert)
        if (!Arrays.equals(chain[0].publicKey.encoded, expectedPublicKey.encoded)) {
            throw CertificateException("Public key mismatch")
        }
    }
    // getAcceptedIssuers omitted
}
```

Approach 1 fits most scenarios — simple configuration, one chain. Approach 2 gives more flexibility, such as smooth rotation before certificate expiry. I once dealt with a production incident: the backend rotated certificates at midnight, the new SHA-256 hash was not updated in `CertificatePinner`, and every client request failed. The lesson: **always configure at least two pins — the current certificate and a backup** — and report pin-failure events to monitoring.

## Certificate Transparency: Forging Certificates in the Open

SSL Pinning is static — when a certificate expires, you need an app update to replace it. Certificate Transparency (CT) takes a different angle: instead of validating certificate content directly, it verifies that the certificate has been publicly logged in a CT log.

Since 2018, Google has required all certificates issued by Symantec-family CAs to carry an SCT (Signed Certificate Timestamp). If an attacker forges a certificate, it almost certainly does not appear in a public CT log — forged certificates rarely carry a submitted SCT.

On-device CT verification:

```kotlin
class CertificateTransparencyInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val handshake = chain.connection()?.handshake() as? Handshake
        val certificates = handshake?.peerCertificates ?: emptyList()
        
        // Check whether the certificate carries the SCT extension (OID 1.3.6.1.4.1.11129.2.4.2)
        for (cert in certificates) {
            val sctExtension = (cert as? X509Certificate)?.getExtensionValue("1.3.6.1.4.1.11129.2.4.2")
            if (sctExtension == null) {
                // In production: throw or report, do not silently pass
                reportToMonitoring("Missing SCT for ${cert.subjectDN}")
            }
        }
        return chain.proceed(chain.request())
    }
}
```

A practical compromise: **many certificates issued by domestic CAs do not carry the SCT extension**, especially non-Symantec-family CAs. Hard-blocking would kill a large volume of legitimate traffic. My approach was phased — report only for the first two weeks, then enable blocking for international business domains while continuing monitor-only for domestic domains.

## Layered Defense: How the Three Fit Together

Network Security Config, SSL Pinning, and CT verification are not mutually exclusive alternatives. They are three progressive layers:

1. **Network Security Config** guards the trust anchor entry — "which CAs may issue certificates I trust"
2. **SSL Pinning** narrows further on top of system trust — "I trust only these specific certificates"
3. **CT verification** dynamically validates certificate legitimacy, compensating for the static lag of pinning

A typical release configuration looks like:

```
Network Security Config: trust system CAs only
  └── OkHttp CertificatePinner: pin 2 certificates for core API domains
       └── CTInterceptor: check SCT presence for non-core domains
```

Debug builds allow packet-capture tool certificates via `src="user"`. The debug `CertificatePinner` is removed or overridden — otherwise you cannot even send a request through Charles.

## Production Monitoring Matters More Than the Crypto Itself

The biggest risk of certificate pinning is not being cracked — it is **locking yourself out**. Expired certificates, backend rotations without client sync, CDN origin certificate misconfiguration — any of these can take out a large share of users.

For monitoring, track at least three metrics:

- **SSL handshake failure rate**: aggregate by domain and error code. A spike in `SSLPeerUnverifiedException` almost always points to a certificate issue
- **CertificatePinner failure count**: directly reflects whether pin configuration and server certificates match
- **CT verification missing rate**: group by CA issuer to track which CAs issue certificates without SCT

The security benefit of pinning is proportional to the operational cost. If your team lacks a mature certificate change process and staged rollout mechanism, **Network Security Config alone is enough** — do not rush into SSL Pinning. NSC combined with Android's system CA trust already blocks most MITM attacks that rely on user-installed certificates.
