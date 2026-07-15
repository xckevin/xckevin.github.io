---
title: "Android APK Signing: From V1 JAR to V4 Incremental Signatures"
lang: en
translationKey: android-apk-signing-schemes
slug: android-apk-signing-schemes
excerpt: "Trace the evolution of Android APK signing schemes, their verification models, security implications, and release-time checks."
publishDate: '2026-07-03'
tags:
- "Android"
- "APK"
- "App Security"
- "Build System"
seo:
  title: "Android APK Signing Schemes: V1 Through V4"
  description: "Understand Android APK signing schemes, verification, security trade-offs, and practical release guidance."
  pageType: article
---

Last year, I helped the team troubleshoot an online crash: when the user installed the APK downloaded from the app store, it prompted "Signature Inconsistency". After investigation, it was found that different certificates were used for V2 signature and V1 signature in the CI process. This question made me review the four signature schemes from beginning to end, and found that many details are easily overlooked in daily development.

APK signature is not designed at one time, but four layers of solutions are gradually added as the Android system evolves. Each layer solves a specific pain point, and understanding their evolutionary logic is much more important than memorizing the format.

## The essence of signature: integrity proof

The signature answers two questions: **has the APK been tampered with**, and **is it from the purported developer**.

The implementation idea is very straightforward: use the private key to encrypt the content digest, and the system uses the public key to decrypt and compare. But "what content is summarized" is the core difference between the signatures of each version.

V1 digests the entire JAR entry, V2/V3 digests the entire APK file, and V4 simply does not build the complete signature block. The schemes are different, but the verification links all follow the same pattern:
```
Content → hash digest → private-key signature → embed in APK
APK → extract signature → public-key verification → compare digests
```

## V1: Signatures that live in the JAR specification

V1 (JAR signing) is inherited from the JDK's `jarsigner` tool. APK is essentially a ZIP file. ZIP is compatible with the JAR format, and the JAR signature can be directly reused.

Each file in the APK is presented as a JAR entry, with the Base64-encoded SHA1 digest of each entry recorded in `META-INF/MANIFEST.MF`:
```
Name: res/layout/activity_main.xml
SHA1-Digest: n4x5bH3K9...base64...
```

The `CERT.SF` file performs a SHA1 digest and signature on the entire MANIFEST.MF, and also marks the digest value of each entry. `CERT.RSA` contains a digital signature in PKCS#7 format and an X.509 certificate chain.

When verifying, first verify whether the signature in CERT.RSA matches CERT.SF, then verify whether the entry digest in CERT.SF is consistent with MANIFEST.MF, and finally verify whether the digest in MANIFEST.MF matches the content of each actual file. **This is a three-level hash chain**.

V1 has three flaws: it does not protect unsigned files outside the META-INF directory, signature verification requires decompression of all entries, resulting in slow installation, and the order of ZIP entries can be rearranged to bypass some detection.

The Janus vulnerability (CVE-2017-13156) completely exposed the weakness of V1: the attacker injects a `classes.dex` into the APK, and the system only verifies the digest of the original dex, but may load a forged dex. This vulnerability directly led to the creation of V2.

## V2: Push the entire APK into a signed block

V2 (APK Signature Scheme v2) no longer cares about what files are inside the ZIP, it directly hashes the byte stream of the APK file.

APK is divided into three sections: ❶ ZIP entry content → ❷ APK Signing Block → ❸ ZIP Central Directory + EOCD. The signature block is inserted between ❶ and ❸ without destroying the ZIP structure, and older tools can still decompress the APK.

```text
[ZIP Entries (1~n)]
[APK Signing Block]
  size of block (8 bytes, excluding itself)
  [ID-value pairs]
    ID: 0x7109871a (V2 signing magic number)
    value: V2 Signature
  size of block (8 bytes)
  magic: "APK Sig Block 42" (16 bytes)
[Central Directory]
[EOCD]
```

There can be multiple ID-value pairs in the APK Signing Block, and the magic number for V2 is `0x7109871a`. This is important for later V3 to coexist in the same block.

When signing V2, the areas ❶ and ❸ in the APK and the "bytes before the V2 signature data" in the signature block are spliced ​​together for hashing to ensure that the signature block itself is also protected. The final data contains three parts:

```kotlin
// Core V2 signing structure
data class V2Signature(
    val signers: List<SignerBlock>,
    // Each signer contains:
    // - signedData: digests, certificates, and attributes
    // - signatures: signatures for one or more algorithms
    // - publicKey
)

data class SignedData(
    val digests: List<Digest>,      // Hashes of sections ❶, ②, and ③
    val certificates: List<X509Cert>,
    val attributes: List<Attribute> // Extensible attributes
)
```

During verification, the system first locates the APK Signing Block, extracts the V2 signature data, uses the public key to verify the signature of signedData, and then verifies whether the digests match the specified section of the APK. The entire process requires only a limited number of I/Os and does not require traversing ZIP entries.

V2 places the signature block near the end of the APK, but the area before the ZIP central directory is not yet protected. In addition, V2 does not support key rotation - if the certificate expires, it must be signed and reissued.

## V3: Key rotation and scalability of signature blocks

V3 (APK Signature Scheme v3) shares the same APK Signing Block with V2, but is fundamentally different in structure.

V3 introduced the **proof-of-rotation** structure. Each signer's signedData can contain a `rotation` attribute to record the change history of the signing certificate chain:

```kotlin
data class ProofOfRotation(
    val minSdkVersion: Int,           // Minimum SDK for the new certificate
    val maxSdkVersion: Int,           // Maximum SDK for the old certificate (optional)
    val newSigner: SignerBlock,       // Signer using the new key
    val previousProof: ProofOfRotation? // Recursively linked rotation history
)
```

Both the old and new signers sign signedData, and the system selects the corresponding certificate based on the device SDK version. Old devices will not be affected, and new devices will recognize the new certificate. This allows applications with the same package name to complete key migration without losing identity.

Another improvement of V3 is the use of `level` in the signature block to distinguish the signature type: in the structure of V2, `level=0` represents the direct signer, and V3 is extended to `level=1`, which represents the signature after rotation, and `level=2`, which represents a deeper rotation layer.

Supporting key rotation means that the app store's package name ownership verification no longer only recognizes a single fingerprint, but requires maintaining a trusted certificate chain. This idea has been applied more radically in Play Signing of Android App Bundle - developers sign with their own upload key, and Google Play re-signs with the release key.

## V4: Discard signature blocks, read directly from file system and ADB

The starting point of V4 (APK Signature Scheme v4) is clear: **V2/V3 verification still requires reading multiple sections of the APK. For GB-level game APKs, the I/O overhead cannot be ignored. **

V4 moves the signature data out of the APK and generates a separate `.idsig` file. Android 11+ devices read this small file directly during installation, and do not need to perform streaming calculations on the APK itself.

The magic number of the `.idsig` file is `0x6e6740d4`, and the internal structure is a flattened merkle tree:

```text
[.idsig File]
  magic: 0x6e6740d4
  [V4 Signature Block]
    hashingAlgorithm
    signingAlgorithm
    signingKeyBlock
    merkleTree
    flags
```

Merkle tree performs block hashing on APK files, with each block defaulting to 1 MB. When verifying, you only need to read the blocks that need to be verified, and use the root hash to confirm the integrity. Incremental installs (like ADB install's incremental transfer) benefit the most - only the changed blocks are transferred, while only the hashes of those blocks are verified.

V4 also introduces `merkle tree only` mode via the `flags` field. This mode does not include traditional signatures and only provides integrity hash trees. With kernel features such as fs-verity, the APK can be continuously protected from modification after installation.

## Verification priority of four schemes

When the Android system verifies the APK, it tries one by one according to the priority of V4 → V3 → V2 → V1. An APK can contain any combination of four signatures, but stops when a verifiable signature is found:
```
apkVerity(apk):
    if androidVersion >= 11 AND .idsig exists:
        verifyV4(apk, idsig) → return true/throw
    if v3Block exists in Signing Block:
        verifyV3(apk, v3Block) → return true/throw
    if v2Block exists in Signing Block:
        verifyV2(apk, v2Block) → return true/throw
    // fallback
    verifyV1(apk, CERT.RSA) → return true/throw
```

## Practical suggestions

`apksigner` generates V1+V2+V3 signatures at the same time by default, and `jarsigner` only generates V1.

In terms of certificate management, different build nodes in CI use different certificates, which will cause V2 and V1 signatures to mismatch - this is a pitfall I have stepped on. `apksigner verify --verbose` can clearly list whether each signature scheme passes or not. Running this command before going online is much more cost-effective than checking the crash log afterwards.

In terms of compatibility, if your APK is for the domestic market, do not use V2-only signature. After removing V1, devices below Android 7.0 cannot verify signatures at all. Google Play allows uploading V2-only APKs because the existing devices in the Play channel are new enough. Keep the combination of V1+V2+V3 for the most stable coverage.

The principle of multi-channel packaging has not changed due to the evolution of the signature version: find a location in the signature area that does not affect verification and insert additional data. In the V1 era, an empty file is written to META-INF, and in the V2 era, a custom ID is written to the ID-value area of ​​the Signing Block (this is what Meituan’s Walle does). V3 and V4 do not break this idea, but the signature block structure is more complex and the injection point still exists.
