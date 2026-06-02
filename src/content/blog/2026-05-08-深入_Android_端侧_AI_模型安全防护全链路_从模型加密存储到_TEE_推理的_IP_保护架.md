---
title: 深入 Android 端侧 AI 模型安全防护全链路：从模型加密存储到 TEE 推理的 IP 保护架构
excerpt: 系统阐述 Android 端侧 AI 模型的多层安全防护方案：从加密存储、硬件密钥管理到 TEE 推理的纵深防御体系，并结合工程实践分析现实约束与取舍。
publishDate: '2026-05-08'
tags:
- Android
- TEE
- 模型安全
- AI
- 加密
seo:
  title: 深入 Android 端侧 AI 模型安全防护全链路：从模型加密存储到 TEE 推理的 IP 保护架构
  description: 深入探讨 Android 端侧 AI 模型的 IP 保护架构，覆盖 AES-GCM 加密存储、Keystore 硬件绑定密钥管理及 TEE 推理三层纵深防御，分析工程约束与实践取舍。
---

去年在做端侧 LLM 项目时，安全团队丢过来一个问题：你们打包进 APK 的 .tflite 模型文件，我一分钟就能从 res/raw 里解出来。更让人头皮发麻的是，模型文件里能直接看到权重数值——这就是把训练好的 IP 裸奔着发布。

端侧 AI 的安全防护，核心矛盾在于：**模型文件必须在设备上，但模型文件不能被人拿走**。这个问题没有完美答案，但可以架设多层防线，让攻击成本高到不值得。

## 模型文件的脆弱面

Android 端侧模型最常见的部署方式是放在 assets 或 raw 目录，随 APK 打包。随便一个 APK 解包工具就能拿到原文件：

```bash
apktool d app.apk -o output/
find output/res/raw -name "*.tflite"
```

即使开了代码混淆，ProGuard 也不会处理模型文件本身。ONNX、TensorFlow Lite 格式的模型，直接用 Netron 打开就能看到完整的模型结构图和权重信息。

更大的问题是，推理引擎加载模型时必须解密到内存中，而内存 dump 的门槛并不高。一个加了 Frida 的调试环境就能在运行时把解密后的模型抓出来。

总结下来就三个问题：模型怎么存、密钥怎么管、推理在哪跑。

## 第一层：加密存储——模型文件不是 assets

第一道防线是模型文件落地即加密，而非发布前加密再打包——区别在于，前者可以做到每个设备密钥不同。

我选 AES-256-GCM，GCM 模式自带完整性校验，能防止密文被篡改后喂给解密逻辑：

```kotlin
fun encryptModel(input: File, output: File, key: SecretKey) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val iv = cipher.iv // GCM 自动生成 12 字节 IV
    output.outputStream().use { out ->
        out.write(iv) // 写入文件头部
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

IV 放在文件头 12 字节，解密时先读 IV 再初始化 cipher。不要用固定 IV——GCM 模式最怕 nonce 重用，一旦重用，认证密钥的机密性直接崩溃。

加密算法选型上我踩过坑：最初图省事用了 ECB 模式，完全没考虑到模型文件中大量重复结构在 ECB 下会产生规律性泄漏。换成 GCM 后才踏实。

## 第二层：密钥管理——Keystore 的硬件绑定

加密文件只是第一步，真正致命的是密钥放哪。硬编码到代码里等于没加密；放 SharedPreferences 等于给 root 设备留后门。

Android Keystore 的 **硬件绑定（Hardware-Backed）** 特性是这道防线的关键。在支持 StrongBox 的设备上，密钥存储在独立安全芯片中，即使系统被 root 也无法导出私钥：

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

`setUserAuthenticationRequired(false)` 是个关键取舍——推理是后台任务，不能每次加载模型都弹指纹，但这也意味着设备解锁状态下密钥可用。安全性和可用性永远是跷跷板。

Keystore 另一个容易踩的坑是密钥失效。Android 系统升级或锁屏方式切换可能触发 `KeyPermanentlyInvalidatedException`，必须兜底重建：

```kotlin
fun getOrCreateKey(): SecretKey {
    return try {
        (keyStore.getEntry("model_encryption_key", null)
            as KeyStore.SecretKeyEntry).secretKey
    } catch (e: KeyPermanentlyInvalidatedException) {
        keyStore.deleteEntry("model_encryption_key")
        generateKey() // 重建密钥并触发模型重加密
    }
}
```

## 第三层：TEE 推理——明文不离开安全域

即使加密存储、密钥硬件保护，推理时模型仍会解密到用户态内存——Frida hook `Cipher.doFinal` 就能截获明文。

TEE（Trusted Execution Environment）提供了一块与 Android OS 物理隔离的执行区域。解密和推理都在里面完成，Normal World 拿不到模型明文：

```kotlin
// 运行在 TEE 内部（Trusty / QSEE）
fun teeInference(encryptedModel: ByteArray, input: FloatArray): FloatArray {
    val key = teeKeymaster.getKey("model_encryption_key")
    val model = teeCrypto.decryptAesGcm(key, encryptedModel)
    val interpreter = teeTfLiteInterpreter(model)
    return interpreter.run(input) // 仅结果出 TEE，模型不出
}
```

纯把 TF Lite 塞进 TEE 通用核上跑，性能惨不忍睹。一个 100MB 级别的模型，在 TEE 通用核上推理可能耗时数秒，而 DSP 上只需几十毫秒。

实际项目中我更倾向的方案是 **DSP 推理 + TEE 密钥管理**：模型解密在 TEE 中完成，推理计算放到 DSP/GPU 上，密钥不离开安全域。这需要在 Native 层与 TEE Driver 通信：

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

TA（Trusted Application）需要编译成独立 ELF 镜像并签名，预置到系统分区。对普通应用开发者，这通常需要和 OEM 合作。

## 全链路分层架构

三层方案不是平替关系，而是纵深防御：

```
┌─────────────────────────────────────────┐
│  Normal World                           │
│  ┌──────────┐  ┌─────────────────┐     │
│  │ 加密模型  │  │ CA 发起推理请求   │     │
│  │ (磁盘)    │──│ 传入密文+输入     │     │
│  └──────────┘  └──────┬──────────┘     │
├─────────────────────────────────────────┤
│  TEE Driver (QSEECOM / Trusty IPC)     │
├─────────────────────────────────────────┤
│  Secure World (TEE)                     │
│  ┌──────────┐  ┌──────────────────┐    │
│  │ Keymaster │──│ TA: 解密+推理编排  │    │
│  │ 密钥不导出 │  │ 明文仅 TEE 可见    │    │
│  └──────────┘  └──────────────────┘    │
└─────────────────────────────────────────┘
```

每层的契约：存储层保证文件不可直接解析，密钥层保证密钥不可导出，推理层保证明文不出 TEE。

## 工程约束与现实取舍

完整落地三层方案，你会撞上三个硬墙：

**TEE 内存限制**。TEE 可用内存通常只有几 MB 到几十 MB，端侧 LLM 动辄数百兆。实践中只能对模型分片——敏感层（attention 权重）在 TEE 中跑，非敏感层扔到 DSP/GPU。

**TA 更新机制僵化**。预置到系统分区的 TA 只能随 OTA 更新，模型架构调整可能被 TA 的版本节奏拖住。对于迭代频繁的产品，这是个持续痛点。

**TEE 世界切换开销**。单次切换约 50-200μs，高频推理场景下累积可观，必须做批处理。

基于这些约束，我的优先级排序是：**前两层全量部署，TEE 推理按需启用**。对大多数应用，加密存储 + Keystore 硬件绑定 + 代码混淆 + 反调试，攻击门槛已经足够高。

还有两个必须一起上的防御措施：一是 APK 开启 `extractNativeLibs=false`，避免 .so 文件落地，增加 hook 难度；二是在 Native 层做反调试检测，发现 Frida 或 ptrace 时主动 crash——环境完整性一旦被破，上面所有防线都形同虚设。
