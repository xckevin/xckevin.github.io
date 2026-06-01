---
title: 深入 Android Credential Manager 全链路：从 FIDO2 无密码认证到 Passkey 跨设备同步的端侧安全架构
excerpt: 深入解析 Android Credential Manager 全链路，从 FIDO2 无密码认证、TEE 密钥保护到 Passkey 跨设备同步的端侧安全架构。
publishDate: '2026-05-19'
tags:
- Android
- Credential Manager
- FIDO2
- Passkey
- 安全架构
seo:
  title: 深入 Android Credential Manager 全链路：FIDO2 无密码认证与 Passkey 同步
  description: 解析 Android Credential Manager、FIDO2/WebAuthn、TEE 密钥保护与 Passkey 跨设备同步机制，梳理端侧无密码认证安全架构。
---

# 深入 Android Credential Manager 全链路：从 FIDO2 无密码认证到 Passkey 跨设备同步的端侧安全架构

在做登录模块改造时，产品和我说「一键登录，不要输密码」。当时第一反应是 WebAuthn，但 Android 端 API 碎片化严重——FIDO2 API 和 One Tap API 各自为战，选哪个都要填另一半的坑。

Android 14 把这个问题收拢了。**Credential Manager** 统一了所有登录凭据的入口，底层同时对接密码管理器、FIDO2 和联合身份提供商（Google、Facebook 等）。这篇文章拆一下它的架构和完整链路。

## Provider 架构：一个入口，多种凭据

Credential Manager 的核心设计是 Provider 模式。它本身不存储凭据，只做调度。

```kotlin
val credentialManager = CredentialManager.create(context)
val request = GetCredentialRequest.Builder()
    .addCredentialOption(getPasskeyOption())
    .addCredentialOption(getPasswordOption())
    .addCredentialOption(getGoogleIdTokenOption())
    .build()

val result = credentialManager.getCredential(context, request)
```

调用 `getCredential()` 后，系统向所有已注册的 Provider 广播请求。每个 Provider 返回自己匹配的凭据列表，由系统合并后统一展示。这个过程在底层走的是 AIDL 跨进程通信——每个 Provider 运行在自己的进程沙箱里，彼此隔离。

实现自定义 Provider 需要继承 `CredentialProviderService`：

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

两个核心入口：`onBeginCreateCredential()` 处理凭据创建，`onGetCredential()` 处理凭据获取。注意 `CancellationSignal`——用户在弹出层点取消时，Provider 必须响应中断，否则系统会判定为 ANR。

## FIDO2 协议链路：注册到认证的完整流程

FIDO2 包含两个子协议：**WebAuthn**——浏览器端的 JS API；**CTAP**（Client to Authenticator Protocol）——客户端到认证器的硬件通信协议。在 Android 上，Credential Manager 封装了 WebAuthn 层，TEE 侧的认证器实现 CTAP 角色。

注册流程分 5 步：

1. Relying Party（RP，你的服务端）下发 `PublicKeyCredentialCreationOptions`，包含 challenge、RP ID 和用户信息
2. Android Client 将 options 传给 Credential Manager
3. Credential Manager 调用 TEE 中的认证器生成公私钥对
4. 私钥存储在 TEE 中，**永不出片**；公钥连同签名后的 challenge 返回服务端
5. 服务端用公钥验证签名，存储公钥，注册完成

认证流程与之对称——服务端下发 challenge，客户端在 TEE 中用私钥签名返回：

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

服务端用公钥验签，匹配则通过。

关键安全设计：FIDO2 的 key 绑定到 **RP ID**。`example.com` 下注册的 Passkey，无法用于 `evil.com` 的认证——这是协议层保证的，不是靠客户端代码约束。这个设计直接堵死了中间人攻击（MITM）的场景，哪怕攻击者拿到了 challenge 和签名结果，也无法跨域使用。

## TEE 与 Keystore 的集成链路

Android 的 TEE 实现因芯片厂商而异：高通用 QTEE，三星用 TEEGRIS，Pixel 上跑 Trusty TEE OS。不管哪家，上层接口统一走 **Keymaster HAL**。

当 Credential Manager 请求生成 FIDO2 密钥对时，完整链路：

```
CredentialManager → Framework (Java)
  → KeyStore Service (Daemon)
    → Keymaster HAL (C++)
      → TEE Trusted App（硬件隔离环境）
```

在 Framework 层，关键参数配置如下：

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

`setUserAuthenticationRequired(true)` 要求每次使用私钥必须通过生物识别或锁屏验证。验证结果在内核层面由 `gatekeeper` 服务管理，通过一个带超时的 **AuthToken** 机制控制——用户解锁后 Token 在 TEE 内有效约 30 秒，超时必须重新验证。

`setIsStrongBoxBacked(true)` 要求使用独立的防篡改硬件（如 Pixel 上的 Titan M 芯片），与主 SoC 物理隔离。这里有一个实际踩过的坑：某些厂商 ROM 上 StrongBox 支持不完整，调用直接抛 `StrongBoxUnavailableException`：

```kotlin
try {
    keyInfo.isInsideSecureHardware
} catch (e: StrongBoxUnavailableException) {
    specBuilder.setIsStrongBoxBacked(false)
}
```

生产代码必须做降级处理，否则在这些设备上直接崩溃。

## Passkey 跨设备同步机制

Passkey 的跨设备同步是 FIDO2 联盟在 CTAP 2.1 版本引入的。核心思路：私钥用端到端加密（E2EE）同步到云，但解密密钥只留在用户设备上——云端存的始终是密文。

Google 的实现依赖 Google Password Manager 作为同步通道：

- **创建 Passkey**：私钥在 TEE 生成后，用设备锁屏密钥加密，上传密文到 Google 云端
- **新设备登录**：用户扫描已登录设备的二维码，完成蓝牙 BLE 握手
- **密钥传输**：已登录设备从云端拉取密文，在本地解密后通过蓝牙传输给新设备
- **落地存储**：新设备收到私钥后，立即用自己的 TEE 重新加密存储

蓝牙传输阶段走的是 CTAP 2.1 的 **hybrid transport**，BLE 通道上的数据本身就经过一层加密——即使蓝牙链路被监听，攻击者也只能拿到二次加密的数据。

对业务代码来说，跨设备同步完全透明。同一个 `getCredential()` 调用，系统自动判断能否使用同步的 Passkey，代码不需要任何改动。

不过有几个现实限制：两台设备必须登录同一个 Google 账号；必须开启屏幕锁；目标设备需安装 Google Play Services。对国内用户，目前更多依赖华为、荣耀、小米等厂商自己的同步方案，各家实现有差异，接入前需评估目标用户群体的设备分布。

## 实践建议

做 FIDO2/Passkey 接入，三个点值得提前想清楚：

**降级策略放在 Credential Manager 层**。不是所有设备支持 FIDO2，也不是所有用户会用 Passkey。在 `GetCredentialRequest` 里同时放入 Passkey、密码和联合身份选项，系统自动根据设备能力选择——比自己做分支判断靠谱得多。

**RP ID 不要随便定**。它决定 Passkey 的作用域，一旦确定迁移成本很高。如果 app 关联多个域名（`app.example.com`、`api.example.com`），用最顶层根域名 `example.com` 作为 RP ID，给后续扩展留空间。如果是原生 app，RP ID 需要与 `assetlinks.json` 中的域名一致。

**本地测试环境要配好**。FIDO2 只支持 HTTPS，本地开发用 `adb reverse` 做端口转发，并在 Android Chrome 的 `chrome://flags` 里打开 `Allow invalid certificates for resources loaded from localhost` 开关。

---

这套架构里我最欣赏的设计是——私钥不出 TEE 的原则贯穿始终，从注册、签名到同步，安全边界始终在硬件层面。不是靠应用层代码兜底，而是架构上就不存在凭据泄露的路径。
