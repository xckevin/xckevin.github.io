---
title: "Android Credential Manager: FIDO2, Passkeys, and Device-Side Security"
lang: en
translationKey: android-credential-manager-passkeys
slug: android-credential-manager-passkeys
excerpt: "A deep dive into Android Credential Manager, covering FIDO2 passwordless authentication, TEE-backed key protection, and passkey cross-device sync."
publishDate: '2026-05-19'
tags:
- "Android"
- "Credential Manager"
- "FIDO2"
- "Passkeys"
- "Security Architecture"
seo:
  title: "Android Credential Manager: FIDO2 Passwordless Auth and Passkey Sync"
  description: "Explore Android Credential Manager, FIDO2/WebAuthn, TEE key protection, StrongBox fallback, and passkey cross-device sync."
  pageType: article
---

# Android Credential Manager: FIDO2, Passkeys, and Device-Side Security

When we were rebuilding a login module, the product requirement was: "one-tap login, no password entry." My first thought was WebAuthn, but Android-side APIs used to be fragmented. FIDO2 API and One Tap API covered different halves of the problem, and whichever one you picked left gaps to fill.

Android 14 pulls this together. **Credential Manager** provides one unified entry point for login credentials, while the lower layers connect to password managers, FIDO2, and federated identity providers such as Google and Facebook. This article breaks down its architecture and full request path.

## Provider architecture: one entry point, many credential types

The core design of Credential Manager is the Provider model. Credential Manager itself does not store credentials; it coordinates providers.

```kotlin
val credentialManager = CredentialManager.create(context)
val request = GetCredentialRequest.Builder()
    .addCredentialOption(getPasskeyOption())
    .addCredentialOption(getPasswordOption())
    .addCredentialOption(getGoogleIdTokenOption())
    .build()

val result = credentialManager.getCredential(context, request)
```

After `getCredential()` is called, the system broadcasts the request to all registered providers. Each provider returns its own matching credential list, and the system merges the results into one UI. Under the hood, this uses AIDL cross-process communication. Every provider runs inside its own process sandbox and is isolated from the others.

To implement a custom provider, extend `CredentialProviderService`:

```kotlin
class MyProvider : CredentialProviderService() {
    override fun onGetCredential(
        request: GetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<GetCredentialResponse, GetCredentialException>
    ) {
        val credentials = queryLocalStore(request)
        callback.onResult(GetCredentialResponse(credentials))
    }
}
```

There are two core entry points: `onBeginCreateCredential()` handles credential creation, and `onGetCredential()` handles credential retrieval. Pay attention to `CancellationSignal`: when the user cancels the system sheet, the provider must respond to interruption. Otherwise, the system can treat it as an ANR.

## FIDO2 protocol path: the complete registration and authentication flow

FIDO2 contains two sub-protocols: **WebAuthn**, the browser-side JavaScript API, and **CTAP** (Client to Authenticator Protocol), the hardware communication protocol between client and authenticator. On Android, Credential Manager wraps the WebAuthn layer, while the TEE-side authenticator plays the CTAP role.

Registration has five steps:

1. The Relying Party (RP), meaning your server, sends `PublicKeyCredentialCreationOptions`, including the challenge, RP ID, and user information.
2. The Android client passes those options to Credential Manager.
3. Credential Manager asks the authenticator in the TEE to generate a public/private key pair.
4. The private key is stored in the TEE and **never leaves the chip**; the public key and signed challenge are returned to the server.
5. The server verifies the signature with the public key, stores the public key, and completes registration.

Authentication is symmetrical. The server sends a challenge, and the client signs it with the private key inside the TEE:

```json
{
  "challenge": "random_base64url_string",
  "allowCredentials": [{
    "id": "registered_credential_id",
    "type": "public-key"
  }],
  "rpId": "example.com",
  "userVerification": "required"
}
```

The server verifies the signature with the public key. If it matches, authentication succeeds.

The key security property is that FIDO2 keys are bound to the **RP ID**. A passkey registered under `example.com` cannot be used to authenticate with `evil.com`. This is guaranteed by the protocol layer, not by client-side application code. It blocks man-in-the-middle scenarios directly: even if an attacker obtains the challenge and signature result, they cannot reuse them across domains.

## TEE and Keystore integration path

Android TEE implementations vary by chip vendor: Qualcomm uses QTEE, Samsung uses TEEGRIS, and Pixel devices run Trusty TEE OS. Regardless of vendor, the upper-layer interface goes through **Keymaster HAL**.

When Credential Manager requests a FIDO2 key pair, the full path looks like this:

```
CredentialManager -> Framework (Java)
  -> KeyStore Service (Daemon)
    -> Keymaster HAL (C++)
      -> TEE Trusted App (hardware-isolated environment)
```

At the Framework layer, the key parameters are configured like this:

```java
KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
    "fido2_alias",
    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
)
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setUserAuthenticationRequired(true)
    .setIsStrongBoxBacked(true)
    .setAttestationChallenge(challenge)
    .build();
```

`setUserAuthenticationRequired(true)` requires biometric or lock-screen verification every time the private key is used. The verification result is managed at the kernel level by the `gatekeeper` service through an **AuthToken** mechanism with a timeout. After the user unlocks, the token remains valid inside the TEE for roughly 30 seconds; after that, the user must verify again.

`setIsStrongBoxBacked(true)` requests independent tamper-resistant hardware, such as the Titan M chip on Pixel devices, physically isolated from the main SoC. One real-world pitfall: some vendor ROMs have incomplete StrongBox support, and the call throws `StrongBoxUnavailableException` directly:

```kotlin
try {
    keyInfo.isInsideSecureHardware
} catch (e: StrongBoxUnavailableException) {
    specBuilder.setIsStrongBoxBacked(false)
}
```

Production code must handle this fallback. Otherwise, those devices will crash.

## Passkey cross-device sync

Cross-device passkey sync was introduced by the FIDO Alliance in CTAP 2.1. The core idea is that the private key is synced to the cloud with end-to-end encryption, but the decryption key stays only on the user's devices. The cloud stores ciphertext the entire time.

Google's implementation uses Google Password Manager as the sync channel:

- **Create passkey**: after the private key is generated in the TEE, it is encrypted with the device lock-screen key and uploaded as ciphertext to Google's cloud
- **Sign in on a new device**: the user scans a QR code from a signed-in device and completes a Bluetooth LE handshake
- **Key transfer**: the signed-in device fetches the ciphertext from the cloud, decrypts it locally, and transfers it to the new device over Bluetooth
- **Local storage**: after the new device receives the private key, it immediately re-encrypts and stores it with its own TEE

The Bluetooth stage uses CTAP 2.1 **hybrid transport**. Data on the BLE channel is encrypted again, so even if the Bluetooth link is observed, an attacker only sees data protected by a second encryption layer.

For business logic, cross-device sync is completely transparent. The same `getCredential()` call automatically determines whether a synced passkey can be used. The app code does not need to change.

There are practical limits: both devices must be signed in to the same Google account, screen lock must be enabled, and the target device needs Google Play Services. For users in mainland China, many deployments depend more on vendor-specific sync implementations from Huawei, Honor, Xiaomi, and others. Those implementations differ, so evaluate your target device distribution before integration.

## Practical guidance

When integrating FIDO2 or passkeys, three decisions are worth making early.

**Put fallback strategy at the Credential Manager layer.** Not every device supports FIDO2, and not every user will use passkeys. Put passkey, password, and federated identity options into the same `GetCredentialRequest`, and let the system select based on device capability. This is more reliable than hand-written branching.

**Do not choose the RP ID casually.** It defines the passkey scope, and migration is expensive once it is set. If your app is associated with multiple domains, such as `app.example.com` and `api.example.com`, use the top-level root domain `example.com` as the RP ID to leave room for later expansion. For a native app, the RP ID must match the domain in `assetlinks.json`.

**Prepare the local test environment.** FIDO2 requires HTTPS. For local development, use `adb reverse` for port forwarding, and in Android Chrome, enable `Allow invalid certificates for resources loaded from localhost` under `chrome://flags`.

---

The design I appreciate most in this architecture is that the private key never leaving the TEE is not just a slogan. It holds across registration, signing, and sync. The security boundary stays at the hardware layer. The system is not relying on application-layer code as a last line of defense; the architecture removes the credential-exfiltration path in the first place.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Engineering](/en/android-engineering/)
- [Android App Links: Digital Asset Links and Web-to-App routing](/en/blog/android-app-links-digital-asset-links/)

<!-- /seo-internal-links -->
