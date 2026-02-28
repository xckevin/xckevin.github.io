---
title: "Android应用安全加固与攻防（3）：网络安全强化"
excerpt: "「Android应用安全加固与攻防」系列第 3/3 篇：网络安全强化"
publishDate: 2024-12-13
displayInBlog: false
tags:
  - Android
  - 安全
  - 加固
  - 逆向防护
series:
  name: "Android应用安全加固与攻防"
  part: 3
  total: 3
seo:
  title: "Android应用安全加固与攻防（3）：网络安全强化"
  description: "「Android应用安全加固与攻防」系列第 3/3 篇：网络安全强化"
---
> 本文是「Android应用安全加固与攻防」系列的第 3 篇，共 3 篇。在上一篇中，我们探讨了「代码保护：提升逆向工程门槛」的相关内容。

## 五、网络安全强化

保护应用与服务器之间的通信信道。

### 强制 HTTPS（基本要求）

- 使用 TLS/SSL 加密所有网络通信；
- 通过 `res/xml/network_security_config.xml` 配置网络安全策略，**禁止明文传输**（`<domain-config cleartextTrafficPermitted="false">`）。

**配置示例：**

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

在 `AndroidManifest.xml` 的 `<application>` 标签中引用：`android:networkSecurityConfig="@xml/network_security_config"`。

### 证书锁定（Certificate Pinning / Public Key Pinning）（高级防御手段）

**目的：** 防御针对 TLS/SSL 的中间人攻击（Man-in-the-Middle，MitM），特别是当攻击者能够获取到设备信任的 CA 证书（如企业内部网络、用户主动安装的抓包工具证书）时。

**机制：** 应用内置（硬编码或安全下发）服务器端证书的公钥信息（或整个证书的哈希值）。在 TLS 握手完成后，客户端额外校验服务器提供的证书链中是否包含预期的公钥/证书。如果不匹配，则中断连接。

**OkHttp 实现：** 使用 `CertificatePinner.Builder()` 配置需要锁定的域名和对应的公钥哈希值（sha256/BASE64 格式）。

```kotlin
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // Replace with actual SHA-256 hash of public key
    .add("backup.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")
    .build()

val okHttpClient = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

**巨大风险与挑战：**

- **证书更新 = 灾难：** 如果服务器更换了证书（即使是合法的续期），而已发布的、锁定了旧证书的应用版本将**无法**与服务器建立连接，导致应用**完全瘫痪**；
- **运维复杂度：** 需要建立极其严格、可靠的证书管理和应用更新流程。必须提前部署好备用密钥（Backup Pins），并有机制在新证书上线前强制用户更新应用；
- **动态配置：** 一种缓解策略是应用启动时从一个**绝对可信**的端点（这个端点自身可能也需要被锁定或有其他校验机制）动态获取最新的 Pinning 配置，但这又引入了新的安全依赖。

**谨慎使用！** 仅在面临高风险 MitM 威胁且能够承担并有效管理其运维复杂性和风险时才考虑。对于绝大多数应用，强制 HTTPS 并信任系统 CA 是足够的。

### API 安全

不要在客户端进行敏感操作的最终授权判断。所有涉及权限、付费、数据修改的操作，都应由服务器端进行严格的身份认证和权限校验。客户端校验可以被轻易绕过。

---

## 六、数据存储安全

保护应用存储在本地的敏感数据。

**原则：** **不存储非必要的敏感数据；必须存储时，务必加密。**

### Android Keystore 系统（安全密钥管理的基石）

**特性：**

- 提供一个安全的容器来生成和存储加密密钥（对称密钥 AES，非对称密钥 RSA/EC）；
- **硬件支持：** 在支持 TEE（Trusted Execution Environment）或 SE（Secure Element）的设备上，密钥的生成、存储和使用（加解密、签名）都可以在**硬件安全模块**内完成，密钥本身**永远不会**离开硬件，极大提高了安全性。可以通过 `KeyGenParameterSpec.Builder.setIsStrongBoxBacked(true)` 请求使用 SE；
- **访问控制：** 可以为密钥设置使用条件，如：仅用于加密/解密或签名/验签；需要用户身份验证（指纹、人脸、锁屏密码）后才能使用（`setUserAuthenticationRequired(true)`）；
- **密钥防提取：** 设计上防止密钥被操作系统或其他应用提取出来。

**用法：**

1. 获取 KeyStore 实例（`KeyStore.getInstance("AndroidKeyStore")`）；
2. 使用 KeyGenerator（AES）或 KeyPairGenerator（RSA/EC）并配合 KeyGenParameterSpec 生成密钥，指定别名（alias）和参数，密钥会自动存入 Keystore；
3. 通过别名从 Keystore 获取密钥（`keyStore.getKey(alias, null)`、`keyStore.getCertificate(alias).getPublicKey()`）；
4. 使用获取到的密钥配合 Cipher 进行数据的加解密。

### Jetpack Security（androidx.security:security-crypto）（推荐使用的便捷封装）

**目的：** 简化使用 Android Keystore 进行文件和 SharedPreferences 加密的操作。

**核心类：**

- **EncryptedSharedPreferences：** 创建一个加密的 SharedPreferences 实例，其内部自动使用 Keystore 生成的密钥对 Key 和 Value 进行加密，API 与普通 SP 类似；
- **EncryptedFile：** 提供加密的文件读写流（`openFileInput()`、`openFileOutput()`），内部使用 Keystore 密钥进行流式加密。

**优点：** 极大降低了安全存储的使用门槛，隐藏了 Keystore 和 Cipher 的复杂细节。

### 数据库加密

- **SQLCipher for Android：** 一个流行的开源库，提供对整个 SQLite 数据库文件的透明加密，需要引入依赖并进行配置；
- **Room + 自定义加密：** 结合 Room 使用 `SupportSQLiteOpenHelper.Factory`，在数据写入/读取时，使用从 Keystore 获取的密钥对特定字段或整个数据库页进行加解密。复杂度较高，需要仔细处理性能影响。

---

## 七、安全编码实践回顾

许多安全问题源于编码阶段的疏忽。

- **输入验证：** 对所有外部输入（UI、Intent 参数、网络响应、文件内容）进行合法性、边界检查，防止注入、溢出等。

**安全 IPC：**

- **保护导出组件：** 明确设置 `android:exported="false"`，除非确实需要外部调用。如果导出，必须设置严格的 `android:permission`，并在代码中进行权限检查；
- **校验 Intent：** 处理接收到的 Intent 时，校验其 Action、Data、Component、Extras 是否符合预期，防止恶意构造的 Intent 攻击；
- **PendingIntent：** 创建 PendingIntent 时，如果包含敏感数据，考虑设置 `FLAG_IMMUTABLE`（推荐）或明确指定目标 Component；
- **Broadcast：** 应用内通信优先使用 LiveData、Flow 等可观察模式替代广播（`LocalBroadcastManager` 已废弃）。发送系统广播时，考虑设置接收权限。接收广播时，校验发送者身份（如果可能）。避免在广播中传递敏感信息；
- **Content Provider：** 控制 URI 权限（`android:grantUriPermissions`），在 query/insert/update/delete 中进行权限检查。防止 SQL 注入（使用参数化查询，Room 默认如此）。

**WebView 安全（重灾区）：**

- **限制 JSBridge：** 如果必须使用 `addJavascriptInterface`，确保接口方法不暴露敏感功能，并对传入参数严格校验。考虑使用 `@JavascriptInterface` 注解。Android O+ 有更安全的 `WebViewCompat.addWebMessageListener` API。或者更常见的方式是使用 prompt 方式通信；
- **URL 校验：** 拦截 `shouldOverrideUrlLoading`，通过动态下发规则，只允许加载可信的 URL；
- **禁止文件域访问：** `setAllowFileAccess(false)`；
- **混合内容：** 避免在 HTTPS 页面加载 HTTP 资源；
- **及时更新：** WebView 实现（通常是设备上的 Chrome 或 WebView 组件）可能存在安全漏洞，应用本身无法直接控制，但应提醒用户更新系统 WebView。

**依赖安全：** 定期更新第三方库，关注其安全公告。使用工具扫描依赖库是否存在已知漏洞（CVE）。

---

## 八、安全思维：攻防的持续性与权衡

- **没有绝对安全：** 必须认识到，任何加固措施都可能被更有经验、更有资源的攻击者绕过。安全是一个**持续对抗、提高门槛**的过程；
- **分层防御（Defense in Depth）：** 不要依赖单一的安全措施。组合使用代码混淆、运行时检测、数据加密、网络安全、后台校验等多层防护；
- **风险评估与成本效益：** 根据应用的具体业务、面临的威胁、受保护资产的价值，来决定投入多少资源进行安全加固。并非所有应用都需要银行级别的防护。过度加固可能带来不必要的性能损耗、兼容性问题和开发成本；
- **保持更新与学习：** 安全领域的技术和攻防手段日新月异，需要持续关注最新的安全漏洞、攻击技术、防御方法和工具。

---

## 九、结论：安全加固，任重道远

在开放的 Android 生态中，应用安全加固是保护应用自身及其用户的重要手段。它并非一劳永逸的解决方案，而是一个需要综合运用**代码混淆与加密、资源保护、运行时自我防护（RASP）、网络通信安全、数据存储加密以及遵循安全编码规范**的系统工程。

我们需要具备全面的安全视野，不仅要理解各种攻击向量和防御技术的原理，更要能够**权衡利弊，根据实际风险选择恰当的加固策略组合，并有效管理这些策略带来的性能、兼容性和维护成本**。同时，将安全意识融入开发流程，推动团队实践安全编码，并持续关注安全动态，是保障应用长期安全的关键。

安全加固是一场没有终点的博弈。通过不断提高攻击门槛，我们可以最大程度地保护应用的核心价值，维护用户信任，为业务的稳定发展保驾护航。

---

**「Android应用安全加固与攻防」系列目录**

1. 引言：开放生态下的安全博弈
2. 代码保护：提升逆向工程门槛
3. **网络安全强化**（本文）
