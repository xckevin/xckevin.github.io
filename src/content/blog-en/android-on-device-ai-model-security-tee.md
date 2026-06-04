---
title: "End-to-End Android On-Device AI Model Security: From Encrypted Storage to TEE Inference"
lang: en
translationKey: android-on-device-ai-model-security-tee
slug: android-on-device-ai-model-security-tee
excerpt: "A practical walkthrough of layered protection for Android on-device AI models, from encrypted storage and hardware-backed keys to TEE inference, with engineering constraints and tradeoffs."
publishDate: '2026-05-08'
tags:
- "Android"
- "TEE"
- "Model Security"
- "AI"
- "Encryption"
seo:
  title: "Android On-Device AI Model Security: Encryption, Keystore, and TEE"
  description: "Protect Android on-device AI model IP with AES-GCM encrypted storage, hardware-backed Keystore keys, and optional TEE inference."
  pageType: article
---

Last year, while working on an on-device LLM project, the security team threw a blunt question at us: the `.tflite` model file you packaged into the APK can be extracted from `res/raw` in one minute. Even worse, the model file exposes weight values directly. That is trained IP being shipped in plain sight.

The core tension in on-device AI security is this: **the model file must be on the device, but the model file must not be taken away**. There is no perfect answer, but you can build multiple layers of defense and raise the attack cost until it is not worth the effort.

## The vulnerable surface of model files

The most common deployment pattern for Android on-device models is placing them in the `assets` or `raw` directory and packaging them with the APK. Any APK unpacking tool can retrieve the original file:

```bash
apktool d app.apk -o output/
find output/res/raw -name "*.tflite"
```

Even with code obfuscation enabled, ProGuard does not process the model file itself. ONNX and TensorFlow Lite model formats can be opened directly in Netron, revealing the full model graph and weight information.

The bigger problem is that the inference engine must decrypt the model into memory before loading it, and memory dumping is not difficult. A debugging environment with Frida can capture the decrypted model at runtime.

In short, the problem has three parts: how to store the model, how to manage keys, and where inference runs.

## Layer one: encrypted storage means the model is not an asset

The first line of defense is to encrypt the model when it lands on the device, not to encrypt it before release and then package it. The difference is that the former can use a different key per device.

I use AES-256-GCM. GCM includes integrity verification, which prevents tampered ciphertext from being fed into the decryption path:

```kotlin
fun encryptModel(input: File, output: File, key: SecretKey) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val iv = cipher.iv // GCM automatically generates a 12-byte IV
    output.outputStream().use { out ->
        out.write(iv) // Write it to the file header
        input.inputStream().use { inp ->
            val buffer = ByteArray(8192)
            var len: Int
            while (inp.read(buffer).also { len = it } != -1) {
                out.write(cipher.update(buffer, 0, len))
            }
            out.write(cipher.doFinal())
        }
    }
}
```

Put the IV in the first 12 bytes of the file. During decryption, read the IV first and then initialize the cipher. Do not use a fixed IV. GCM is extremely sensitive to nonce reuse; once reused, the confidentiality of the authentication key can collapse.

I hit a mistake in algorithm selection: at first I used ECB for convenience and completely ignored the fact that repeated structures in model files leak patterns under ECB. After switching to GCM, the design was much more defensible.

## Layer two: key management with hardware-backed Keystore

Encrypting the file is only step one. The fatal question is where the key lives. Hardcoding it in code is equivalent to no encryption. Putting it in SharedPreferences leaves a back door on rooted devices.

Android Keystore's **hardware-backed** property is the key part of this defense. On devices with StrongBox support, the key is stored in an independent secure chip. Even if the system is rooted, the private key cannot be exported:

```kotlin
val keyGenSpec = KeyGenParameterSpec.Builder(
    "model_encryption_key",
    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
)
    .setKeySize(256)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setUserAuthenticationRequired(false)
    .setIsStrongBoxBacked(true)
    .build()

val keyGenerator = KeyGenerator.getInstance(
    KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
)
keyGenerator.init(keyGenSpec)
keyGenerator.generateKey()
```

`setUserAuthenticationRequired(false)` is an important tradeoff. Inference is a background task, so the app cannot ask for a fingerprint every time it loads the model. But it also means the key is available while the device is unlocked. Security and usability are always a balance.

Another common Keystore pitfall is key invalidation. Android system upgrades or lock-screen method changes may trigger `KeyPermanentlyInvalidatedException`, so you need a fallback path that recreates the key:

```kotlin
fun getOrCreateKey(): SecretKey {
    return try {
        (keyStore.getEntry("model_encryption_key", null)
            as KeyStore.SecretKeyEntry).secretKey
    } catch (e: KeyPermanentlyInvalidatedException) {
        keyStore.deleteEntry("model_encryption_key")
        generateKey() // Recreate the key and trigger model re-encryption
    }
}
```

## Layer three: TEE inference keeps plaintext inside the secure world

Even with encrypted storage and hardware-protected keys, the model is still decrypted into user-space memory during inference. A Frida hook on `Cipher.doFinal` can intercept the plaintext.

TEE, or Trusted Execution Environment, provides an execution area physically isolated from Android OS. Decryption and inference complete inside it, so the Normal World cannot access the model plaintext:

```kotlin
// Runs inside the TEE, such as Trusty or QSEE
fun teeInference(encryptedModel: ByteArray, input: FloatArray): FloatArray {
    val key = teeKeymaster.getKey("model_encryption_key")
    val model = teeCrypto.decryptAesGcm(key, encryptedModel)
    val interpreter = teeTfLiteInterpreter(model)
    return interpreter.run(input) // Only the result leaves the TEE; the model does not
}
```

Putting TF Lite directly onto a general-purpose TEE core is painfully slow. A model around 100 MB may take several seconds to run on a TEE general-purpose core, while it only takes tens of milliseconds on a DSP.

In real projects, I prefer **DSP inference plus TEE key management**. Model decryption happens in the TEE, inference compute runs on the DSP or GPU, and the key never leaves the secure world. This requires Native-layer communication with the TEE driver:

```cpp
int tee_inference(const uint8_t* encrypted_model, size_t model_len,
                  const float* input, float* output, size_t output_len) {
    struct qseecom_handle* handle = nullptr;
    qseecom_start_app(&handle, "model_inference_ta", TA_SIZE);

    struct tee_request req = { .cmd_id = CMD_INFERENCE,
        .data = encrypted_model, .data_len = model_len,
        .input = input, .input_len = input_len * sizeof(float) };
    qseecom_send_cmd(handle, &req, sizeof(req));
    qseecom_send_cmd(handle, &req, sizeof(req));

    memcpy(output, handle->sbuf, output_len * sizeof(float));
    qseecom_shutdown_app(&handle);
    return 0;
}
```

The TA, or Trusted Application, must be compiled into a standalone ELF image, signed, and preinstalled into the system partition. For ordinary app developers, this usually requires working with an OEM.

## End-to-end layered architecture

The three layers are not replacements for each other. They are defense in depth:

```text
┌─────────────────────────────────────────┐
│  Normal World                           │
│  ┌───────────────┐  ┌─────────────────┐ │
│  │ Encrypted     │  │ CA starts        │ │
│  │ model on disk │──│ inference request│ │
│  └───────────────┘  └──────┬──────────┘ │
├─────────────────────────────────────────┤
│  TEE Driver (QSEECOM / Trusty IPC)      │
├─────────────────────────────────────────┤
│  Secure World (TEE)                     │
│  ┌───────────┐  ┌─────────────────────┐ │
│  │ Keymaster │──│ TA: decrypt and      │ │
│  │ no export │  │ orchestrate inference│ │
│  └───────────┘  └─────────────────────┘ │
└─────────────────────────────────────────┘
```

Each layer has a contract: the storage layer ensures the file cannot be parsed directly, the key layer ensures the key cannot be exported, and the inference layer ensures plaintext does not leave the TEE.

## Engineering constraints and practical tradeoffs

If you try to implement all three layers completely, you will hit three hard walls.

**TEE memory limits.** Available TEE memory is usually only a few MB to a few dozen MB, while on-device LLMs are often hundreds of MB. In practice, you can only shard the model: run sensitive layers such as attention weights inside the TEE, and send non-sensitive layers to the DSP or GPU.

**Rigid TA update mechanism.** A TA preinstalled into the system partition can only be updated through OTA. Model architecture changes may be slowed down by the TA version cadence. For fast-iterating products, this becomes a recurring pain point.

**TEE world-switching overhead.** A single switch is roughly 50 to 200 microseconds. In high-frequency inference scenarios, that adds up, so batching is required.

Based on those constraints, my priority order is: **deploy the first two layers broadly, enable TEE inference only when needed**. For most apps, encrypted storage plus hardware-backed Keystore, code obfuscation, and anti-debugging already raise the attack threshold enough.

Two other defenses should be enabled together. First, set `extractNativeLibs=false` for the APK so `.so` files do not land directly on disk, which makes hooking harder. Second, add anti-debugging checks in the Native layer and crash proactively when Frida or ptrace is detected. Once environment integrity is broken, every defense above it becomes much weaker.
