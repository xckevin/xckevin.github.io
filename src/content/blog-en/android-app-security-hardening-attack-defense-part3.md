---
title: "Android App Security Hardening (3): Strengthening Network Security"
lang: en
translationKey: android-app-security-hardening-attack-defense-part3
slug: android-app-security-hardening-attack-defense-part3
excerpt: "Part 3 of the Android App Security Hardening series: HTTPS enforcement, certificate pinning, secure local storage, Android Keystore, and secure coding."
publishDate: 2024-12-13
displayInBlog: false
tags:
- "Android"
- "Security"
- "Hardening"
- "Reverse Engineering Defense"
series:
  name: "Android App Security Hardening: Attack and Defense"
  part: 3
  total: 3
seo:
  title: "Android App Security Hardening Part 3: Network and Storage Security"
  description: "Secure Android apps with HTTPS, certificate pinning, API authorization, Android Keystore, encrypted storage, WebView hardening, and defense in depth."
  pageType: article
---
> This is part 3 of the Android App Security Hardening: Attack and Defense series, a three-part series. The previous article covered "Code protection: raising the reverse engineering bar."

## 5. Strengthening network security

Protect the communication channel between the app and the server.

### Enforce HTTPS

- Encrypt all network communication with TLS/SSL.
- Configure `res/xml/network_security_config.xml` to **disable cleartext traffic** with `<domain-config cleartextTrafficPermitted="false">`.

**Configuration example:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

Reference it inside the `<application>` tag in `AndroidManifest.xml`: `android:networkSecurityConfig="@xml/network_security_config"`.

### Certificate pinning and public key pinning

**Goal:** defend against TLS/SSL man-in-the-middle attacks, especially when attackers can introduce a CA certificate trusted by the device, such as in a corporate network or through a user-installed proxy certificate.

**Mechanism:** embed or securely deliver the server certificate public key information, or the hash of the full certificate, inside the app. After the TLS handshake, the client additionally checks whether the server's certificate chain contains the expected public key or certificate. If not, the connection is terminated.

**OkHttp implementation:** configure the domain and public key hash with `CertificatePinner.Builder()` in `sha256/BASE64` format.

```kotlin
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // Replace with actual SHA-256 hash of public key
    .add("backup.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")
    .build()

val okHttpClient = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

**Major risks and challenges:**

- **Certificate renewal can become a disaster:** if the server rotates its certificate, even for a legitimate renewal, released app versions pinned to the old certificate may be **unable** to connect, making the app **unusable**.
- **Operational complexity:** pinning requires an extremely strict and reliable certificate management and app update process. Backup pins must be deployed in advance, and there must be a mechanism to force users onto a version that supports the new certificate before it goes live.
- **Dynamic configuration:** one mitigation is to fetch the latest pinning configuration from an **absolutely trusted** endpoint at startup. That endpoint may itself need pinning or other verification, which introduces another security dependency.

**Use carefully.** Consider it only when the app faces high-risk MitM threats and the team can manage the operational complexity. For most apps, enforcing HTTPS and trusting the system CA store is sufficient.

### API security

Do not make final authorization decisions for sensitive operations on the client. Any operation involving permissions, payments, or data modification must be strictly authenticated and authorized on the server. Client-side checks are easy to bypass.

---

## 6. Secure data storage

Protect sensitive data stored locally by the app.

**Principle:** **do not store sensitive data unless necessary; when you must store it, encrypt it.**

### Android Keystore: the foundation of secure key management

**Features:**

- Provides a secure container for generating and storing cryptographic keys, including symmetric AES keys and asymmetric RSA/EC key pairs.
- **Hardware support:** on devices with TEE (Trusted Execution Environment) or SE (Secure Element), key generation, storage, and use can happen inside the hardware security module. The key material **never leaves** the hardware, greatly improving security. You can request SE usage with `KeyGenParameterSpec.Builder.setIsStrongBoxBacked(true)`.
- **Access control:** keys can have usage conditions, such as encryption/decryption only, signing/verification only, or requiring user authentication through fingerprint, face, or lock-screen credentials before use with `setUserAuthenticationRequired(true)`.
- **Non-extractability:** the design prevents keys from being extracted by the OS or other apps.

**Usage:**

1. Obtain a KeyStore instance with `KeyStore.getInstance("AndroidKeyStore")`.
2. Use KeyGenerator for AES or KeyPairGenerator for RSA/EC together with KeyGenParameterSpec to generate a key, specify an alias and parameters, and store the key automatically in Keystore.
3. Retrieve the key by alias with `keyStore.getKey(alias, null)` or `keyStore.getCertificate(alias).getPublicKey()`.
4. Use the retrieved key with Cipher to encrypt and decrypt data.

### Jetpack Security (`androidx.security:security-crypto`)

**Goal:** simplify encrypted files and SharedPreferences backed by Android Keystore.

**Core classes:**

- **EncryptedSharedPreferences:** creates an encrypted SharedPreferences instance. It automatically uses Keystore-generated keys to encrypt keys and values while preserving an API similar to regular SharedPreferences.
- **EncryptedFile:** provides encrypted file input and output streams through `openFileInput()` and `openFileOutput()`, using Keystore-managed keys internally.

**Advantage:** it greatly lowers the barrier to secure storage and hides most Keystore and Cipher complexity.

### Database encryption

- **SQLCipher for Android:** a popular open source library that provides transparent encryption for the full SQLite database file. It requires adding the dependency and configuring the database setup.
- **Room with custom encryption:** use a custom `SupportSQLiteOpenHelper.Factory` with Room and encrypt specific fields or database pages using a key from Keystore during reads and writes. This is more complex and requires careful performance handling.

---

## 7. Secure coding practices

Many security issues originate from careless implementation.

- **Input validation:** validate all external input from UI, Intent parameters, network responses, and file content. Check legality and boundaries to prevent injection, overflow, and similar issues.

**Secure IPC:**

- **Protect exported components:** explicitly set `android:exported="false"` unless external access is truly required. If a component is exported, require a strict `android:permission` and perform permission checks in code.
- **Validate Intents:** when processing a received Intent, verify its Action, Data, Component, and Extras to prevent maliciously crafted Intent attacks.
- **PendingIntent:** when creating a PendingIntent that contains sensitive data, prefer `FLAG_IMMUTABLE` or explicitly specify the target Component.
- **Broadcasts:** for in-app communication, prefer observable patterns such as LiveData or Flow instead of broadcasts. `LocalBroadcastManager` is deprecated. When sending system broadcasts, consider receiver permissions. When receiving broadcasts, verify sender identity when possible. Avoid transmitting sensitive information through broadcasts.
- **Content Providers:** control URI permissions with `android:grantUriPermissions` and enforce permissions in query/insert/update/delete. Prevent SQL injection by using parameterized queries. Room does this by default.

**WebView security:**

- **Limit JS bridges:** if `addJavascriptInterface` is required, ensure exposed methods do not provide sensitive functionality and strictly validate arguments. Use the `@JavascriptInterface` annotation. Android O+ provides the safer `WebViewCompat.addWebMessageListener` API. Another common approach is prompt-based communication.
- **Validate URLs:** intercept `shouldOverrideUrlLoading` and allow only trusted URLs, often through dynamically delivered rules.
- **Disable file-domain access:** call `setAllowFileAccess(false)`.
- **Mixed content:** avoid loading HTTP resources inside HTTPS pages.
- **Keep WebView updated:** WebView implementation, usually Chrome or the system WebView component, may contain vulnerabilities. Apps cannot directly control it, but should prompt users to update the system WebView when appropriate.

**Dependency security:** keep third-party libraries updated, follow their security advisories, and scan dependencies for known vulnerabilities such as CVEs.

---

## 8. Security thinking: continuous attack-defense tradeoffs

- **There is no absolute security:** any hardening measure can be bypassed by a more experienced or better-resourced attacker. Security is a continuous process of **raising the attack cost**.
- **Defense in depth:** do not rely on a single measure. Combine code obfuscation, runtime detection, data encryption, network security, and backend validation.
- **Risk assessment and cost-benefit analysis:** decide how much to invest based on business context, threats, and protected asset value. Not every app needs bank-grade protection. Excessive hardening can introduce unnecessary performance overhead, compatibility problems, and development cost.
- **Keep learning:** security vulnerabilities, attack techniques, defenses, and tools change quickly. Stay current.

---

## 9. Conclusion: hardening is a long-term effort

In the open Android ecosystem, app hardening is an important way to protect the app and its users. It is not a one-time solution, but a system-level effort that combines **code obfuscation and encryption, resource protection, runtime self-protection (RASP), network security, secure storage, and secure coding standards**.

We need a broad security view. It is not enough to understand attack vectors and defensive techniques. We must also **weigh tradeoffs, choose a practical combination of hardening strategies based on real risk, and manage the performance, compatibility, and maintenance costs those strategies introduce**. Security awareness should be integrated into the development process, and teams should practice secure coding while tracking security developments continuously.

Hardening is an attack-defense game with no finish line. By continuously raising the attack bar, we can protect the app's core value, preserve user trust, and support stable business growth.

---

**Android App Security Hardening: Attack and Defense series**

1. Security in an Open Ecosystem
2. Code protection: raising the reverse engineering bar
3. **Strengthening network security** (this article)
