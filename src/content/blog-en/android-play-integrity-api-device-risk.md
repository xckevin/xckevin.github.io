---
title: "Android Play Integrity API: Nonce Validation and Device Risk Scoring"
lang: en
translationKey: android-play-integrity-api-device-risk
slug: android-play-integrity-api-device-risk
excerpt: "A field-tested guide to Play Integrity API migration, covering device, app, and account integrity signals, nonce replay protection, server-side verification, retry behavior, and risk-based decisions."
publishDate: '2026-06-05'
tags:
- "Android"
- "Play Integrity"
- "Security"
- "Risk Control"
- "API Migration"
seo:
  title: "Android Play Integrity API: Nonce Validation and Device Risk"
  description: "Learn Play Integrity API signals, nonce replay protection, server verification, retry handling, and risk-based decisions for Android apps."
  pageType: article
---

In early 2025, Google formally moved SafetyNet Attestation API onto the deprecation path. At the time, our team was maintaining root-detection logic for a financial app and had to evaluate the migration cost and payoff. The migration exposed several integration traps, so this article walks through the end-to-end flow.

## Why SafetyNet Was Deprecated

SafetyNet Attestation essentially answered one question: "Does this device pass CTS certification?" It returned a JWS token, and after server-side decoding you got two booleans: `ctsProfileMatch` and `basicIntegrity`.

The problem was coarse granularity. A device with an unlocked bootloader running an official ROM and a device already injected with Magisk/Zygisk modules could both look like `ctsProfileMatch=false, basicIntegrity=true`. The server could not distinguish "user installed AOSP" from "hostile runtime environment", so many teams had to reject too broadly.

Play Integrity API splits the decision into finer dimensions and introduces signal strength levels, allowing the server to make graded decisions.

## The Three Integrity Dimensions

Play Integrity returns three main groups of signals.

### Device Integrity

This is the SafetyNet replacement, but with more levels:

- **MEETS_BASIC_INTEGRITY**: the device environment does not show obvious tampering. Even some emulator environments may pass.
- **MEETS_DEVICE_INTEGRITY**: the device passes Android compatibility checks and has no known signs of privilege escalation. This is enough for most non-financial apps.
- **MEETS_STRONG_INTEGRITY**: hardware-backed key attestation with a trusted execution environment. This is available only in limited scenarios.

In real projects, `MEETS_DEVICE_INTEGRITY` is the most common baseline. Most normal devices can pass it, while devices rooted with Xposed/LSPosed usually cannot.

### App Integrity

This verifies install source and package signature. If your app is repackaged and redistributed through an unofficial channel, `appRecognitionVerdict` exposes it:

- `PLAY_RECOGNIZED`: installed from a recognized Google Play release.
- `UNRECOGNIZED_VERSION`: package name or signature does not match.
- `UNEVALUATED`: the device or request could not be evaluated.

This is useful for anti-repackaging. The signature comparison happens on Google's side against published app metadata, which is much harder to bypass than local signature checks.

### Account Integrity

This matters when your flow also uses Google accounts. It can provide licensing-related verdicts such as `LICENSED` or `UNLICENSED`, which are useful for paid features and entitlement checks.

## Client Request: Nonce Replay Protection Is the Key

The standard request flow looks like this:

```kotlin
val nonce = generateRandomNonce() // one-time value issued by the server

val integrityManager = IntegrityManagerFactory.create(context)
val request = IntegrityTokenRequest.builder()
    .setNonce(nonce)
    .setCloudProjectNumber(123456789L)
    .build()

val response: Task<IntegrityTokenResponse> = integrityManager.requestIntegrityToken(request)
response.addOnSuccessListener { tokenResponse ->
    val integrityToken = tokenResponse.token()
    // Send the token to your server for verification
}
```

Nonce generation must be controlled by your backend. A reliable approach is to have the server generate a value from timestamp, random bytes, and session context, then mark it consumed after verification.

A common anti-pattern is generating the nonce locally on the client and asking the server to verify it. That does not prevent replay because an attacker can generate or reuse values freely. The nonce must come from the server and be bound to the current session.

`setCloudProjectNumber` connects the request to the Google Cloud project where Play Integrity API is enabled, which also controls quota and logs.

## Server Verification: Token Decoding and Decision Flow

The client receives a JWS-like integrity token. The server should verify it in several steps.

**Step 1: Decode the token through Google APIs**

```bash
curl -X POST "https://playintegrity.googleapis.com/v1/PACKAGE_NAME:decodeIntegrityToken" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"integrity_token": "'$TOKEN'"}'
```

Do not trust the client to interpret the verdict. The token must be sent to your server, and your server must decode and decide.

**Step 2: Validate request binding**

After decoding, check:

- package name matches the expected app.
- certificate digest matches the release signing key.
- nonce matches a server-issued, unused nonce.
- timestamp is within a short validity window.

**Step 3: Convert verdicts into policy**

A simple policy model can be:

```kotlin
when {
    deviceIntegrity.contains("MEETS_STRONG_INTEGRITY") -> RiskLevel.LOW
    deviceIntegrity.contains("MEETS_DEVICE_INTEGRITY") &&
        appRecognitionVerdict == "PLAY_RECOGNIZED" -> RiskLevel.NORMAL
    deviceIntegrity.contains("MEETS_BASIC_INTEGRITY") -> RiskLevel.MEDIUM
    else -> RiskLevel.HIGH
}
```

For high-risk scenarios, avoid a single hard block unless the business requires it. It is usually better to combine risk with action type: allow browsing, require additional verification for withdrawals or orders, and reject only clearly hostile cases.

## Retry Strategy and Error Handling

Play Integrity requests depend on Google Play services and network quality, so failures are normal. Treat request errors as infrastructure failures, not proof of risk.

The client should distinguish:

- transient network errors: retry with exponential backoff.
- API quota errors: degrade gracefully and report telemetry.
- unsupported devices: fall back to lower-confidence checks.
- user-facing high-risk actions: defer or require stronger verification.

A reasonable retry shape:

```kotlin
suspend fun requestIntegrityWithRetry(): String {
    var delayMs = 500L
    repeat(3) { attempt ->
        try {
            return requestIntegrityToken()
        } catch (e: Exception) {
            if (attempt == 2) throw e
            delay(delayMs)
            delayMs *= 2
        }
    }
    error("unreachable")
}
```

Do not retry endlessly. Integrity checks are security signals, not a reason to stall the entire app.

## Combining Risk Signals

Play Integrity is one signal, not the entire risk-control system. In production, combine it with:

- account age and login behavior.
- device fingerprint stability.
- network and region anomalies.
- transaction amount or action sensitivity.
- recent crash, hook, or tamper signals.

The server should store both raw verdicts and derived risk levels. Raw verdicts help later audits, while derived levels keep business logic simple.

## Three Common Integration Traps

First, do not verify the token on the client. Anything on the client can be patched or bypassed.

Second, do not block every non-Play install by default. Enterprise distribution, side-loading during QA, and regional channels may all be legitimate. Use channel policy instead of a single global rule.

Third, do not treat an unavailable verdict as "safe". The correct state is "unknown", and unknown should trigger a business-specific fallback.

Play Integrity is most valuable when it becomes part of a layered trust model. The API provides better signals than SafetyNet, but the final quality depends on how carefully you bind nonce, verify tokens, and translate verdicts into risk-aware product behavior.
