---
title: 深入 Android APK 签名机制全链路：从 V1 JAR 签名到 V4 流式签名的演进与验证原理
slug: android-apk-signing-schemes
translationKey: android-apk-signing-schemes
excerpt: 梳理 Android APK 签名从 V1 JAR 签名到 V4 流式签名的完整演进链路，深入分析各版本签名结构、验证原理、安全漏洞及实践建议。
publishDate: '2026-07-03'
tags:
- Android
- APK签名
- 安全
- 签名验证
- 应用打包
seo:
  title: 深入 Android APK 签名机制全链路：从 V1 JAR 签名到 V4 流式签名的演进与验证原理
  description: 梳理 Android APK 签名从 V1 到 V4 的完整演进链路，涵盖 JAR 签名、APK Signing Block、密钥轮转、流式签名及验证优先级，附实践建议。
---

去年帮团队排查一个线上崩溃：用户从应用商店下载的 APK 安装时提示"签名不一致"。排查后发现是 CI 流程中 V2 签名和 V1 签名用了不同证书。这个问题让我把四种签名方案从头到尾捋了一遍，发现很多细节在日常开发中容易被忽略。

APK 签名不是一次性设计出来的，而是随着 Android 系统演进逐步叠加了四层方案。每一层都解决了一个具体痛点，理解它们的演化逻辑比死记硬背格式重要得多。

## 签名的本质：完整性证明

签名要回答两个问题：**这个 APK 有没有被篡改**，以及**它是否来自声称的开发者**。

实现思路很直接：用私钥对内容摘要加密，系统用公钥解密比对。但"对什么内容做摘要"才是各版本签名的核心差异。

V1 对整个 JAR 条目做摘要，V2/V3 对整个 APK 文件做摘要，V4 干脆不构建完整的签名块。方案不同，但验证链路都遵循同一模式：

```
内容 → 哈希摘要 → 私钥签名 → 嵌入 APK
APK → 提取签名 → 公钥验签 → 比对摘要
```

## V1：活在 JAR 规范里的签名

V1（JAR 签名）从 JDK 的 `jarsigner` 工具继承而来。APK 本质上是 ZIP 文件，ZIP 兼容 JAR 格式，JAR 签名可以直接复用。

APK 中每个文件作为一个 JAR 条目，在 `META-INF/MANIFEST.MF` 中记录每个条目的 Base64 编码 SHA1 摘要：

```
Name: res/layout/activity_main.xml
SHA1-Digest: n4x5bH3K9...base64...
```

`CERT.SF` 文件对 MANIFEST.MF 整体做 SHA1 摘要并签名，同时标注每个条目的摘要值。`CERT.RSA` 包含 PKCS#7 格式的数字签名和 X.509 证书链。

验证时先校验 CERT.RSA 中的签名是否与 CERT.SF 匹配，再校验 CERT.SF 中的条目摘要是否与 MANIFEST.MF 一致，最后验证 MANIFEST.MF 中的摘要与每个实际文件内容是否吻合。**这是一个三级哈希链**。

V1 有三个硬伤：不保护 META-INF 目录之外的未签名文件、签名验证需要解压全部条目导致安装缓慢、以及 ZIP 条目顺序可被重排绕过部分检测。

Janus 漏洞（CVE-2017-13156）把 V1 的弱点暴露得很彻底：攻击者在 APK 中注入一个 `classes.dex`，系统只校验原始 dex 的摘要，却可能加载伪造的 dex。这个漏洞直接催生了 V2。

## V2：把整个 APK 压进一个签名块

V2（APK Signature Scheme v2）不再关心 ZIP 内部有什么文件，它直接对 APK 文件的字节流做哈希。

APK 被划分为三个区段：❶ ZIP 条目内容 → ❷ APK Signing Block → ❸ ZIP 中央目录（Central Directory）+ EOCD。签名块插入在 ❶ 和 ❸ 之间，不破坏 ZIP 结构，旧工具仍能解压 APK。

```binary
[ZIP Entries (1~n)]
[APK Signing Block]
  size of block (8 bytes, 不含自身)
  [ID-value pairs]
    ID: 0x7109871a (V2签名魔数)
    value: V2 Signature
  size of block (8 bytes)
  magic: "APK Sig Block 42" (16 bytes)
[Central Directory]
[EOCD]
```

APK Signing Block 中可以有多个 ID-value 对，V2 的魔数是 `0x7109871a`。这对后面 V3 在同一块里共存很重要。

V2 签名时，将 APK 中区域 ❶、❸ 以及签名块中"V2 签名数据之前的字节"拼接起来做哈希，保证签名块自身也被保护在内。最终数据包含三个部分：

```kotlin
// V2 签名核心结构
data class V2Signature(
    val signers: List<SignerBlock>,
    // 每个 signer 包含：
    // - signedData: 由 digests + certificates + attributes 组成
    // - signatures: 多种算法签名（至少一种）
    // - publicKey
)

data class SignedData(
    val digests: List<Digest>,      // 对❶+②+③部分的哈希
    val certificates: List<X509Cert>,
    val attributes: List<Attribute> // 可扩展属性
)
```

验证时系统先定位 APK Signing Block，提取 V2 签名数据，用公钥验证 signedData 的签名，再验证 digests 与 APK 指定区段是否匹配。整个过程只需要有限次 I/O，不需要遍历 ZIP 条目。

V2 把签名块放在 APK 末尾附近，但 ZIP 中央目录之前的区域还没有被保护。另外 V2 不支持密钥轮转——证书过期就得换签名重新发布。

## V3：密钥轮转与签名块的可扩展性

V3（APK Signature Scheme v3）与 V2 共享同一个 APK Signing Block，但结构上有本质区别。

V3 引入了 **proof-of-rotation** 结构。每个 signer 的 signedData 里可以包含一个 `rotation` 属性，记录签名证书链的变更历史：

```kotlin
data class ProofOfRotation(
    val minSdkVersion: Int,           // 新证书的最低 SDK
    val maxSdkVersion: Int,           // 旧证书的最高 SDK（可选）
    val newSigner: SignerBlock,       // 新密钥签名的 signer
    val previousProof: ProofOfRotation? // 递归链接的历史记录
)
```

新旧两个 signer 都对 signedData 签名，系统根据设备 SDK 版本选择对应证书。旧设备不受影响，新设备认新证书。这让同一个包名的应用可以在不丢失身份的前提下完成密钥迁移。

V3 的另一个改进是签名块中用 `level` 区分签名类型：V2 的结构里 `level=0` 表示直接签名者，V3 扩展为 `level=1` 表示轮转后的签名、`level=2` 表示更深的轮转层。

支持密钥轮转意味着应用商店的包名归属校验不再只认单一指纹，需要维护一个可信证书链。这个思路在 Android App Bundle 的 Play Signing 中得到了更激进的应用——开发者用自己的 upload key 签名，Google Play 用 release key 重签名。

## V4：丢掉签名块，直接从文件系统和 ADB 读

V4（APK Signature Scheme v4）的出发点很明确：**V2/V3 验证仍然需要读取 APK 的多个区段，对于 GB 级别的游戏 APK，I/O 开销不可忽略。**

V4 把签名数据从 APK 内部移出，生成一个独立的 `.idsig` 文件。Android 11+ 设备安装时直接读这个小文件，不需要对 APK 本身做流式计算。

`.idsig` 文件的魔数是 `0x6e6740d4`，内部结构是一个扁平化的 merkle tree：

```binary
[.idsig File]
  magic: 0x6e6740d4
  [V4 Signature Block]
    hashingAlgorithm
    signingAlgorithm
    signingKeyBlock
    merkleTree
    flags
```

merkle tree 对 APK 文件做分块哈希，每块默认 1 MB。验证时只需要读取需要校验的块，配合树根哈希即可确认完整性。增量安装（如 ADB install 的增量传输）受益最大——只传输变化的块，同时只验证那些块的哈希。

V4 还通过 `flags` 字段引入了 `merkle tree only` 模式。这种模式下不包含传统签名，只提供完整性哈希树。配合 fs-verity 等内核特性，可以在安装后持续保护 APK 不被修改。

## 四种方案的验证优先级

Android 系统验证 APK 时，按 V4 → V3 → V2 → V1 的优先级逐个尝试。一个 APK 可以同时包含四种签名的任意组合，但只要找到一种可验证的签名就停止：

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

## 实践建议

`apksigner` 默认同时生成 V1+V2+V3 签名，`jarsigner` 只生成 V1。

证书管理方面，CI 中不同构建节点用了不同证书，会导致 V2 和 V1 签名不匹配——这是我踩过的坑。`apksigner verify --verbose` 可以明确列出每种签名方案是否通过，上线前跑一遍这个命令比事后查崩溃日志划算得多。

兼容性方面，如果你的 APK 面向国内市场，不要用 V2-only 签名。去掉 V1 后，Android 7.0 以下设备完全无法验证签名。Google Play 允许上传 V2-only APK 是因为 Play 渠道的存量设备已经足够新。保持 V1+V2+V3 的组合，覆盖率最稳。

多渠道打包的原理并没有因为签名版本演进而改变：找到签名区域中一个不影响验证的位置插入额外数据。V1 时代往 META-INF 写空文件，V2 时代往 Signing Block 的 ID-value 区域写入自定义 ID（美团的 Walle 就是这样做的）。V3 和 V4 没打破这个思路，只是签名块结构更复杂了，注入点仍然存在。
