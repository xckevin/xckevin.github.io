---
title: 深入 Android Play Integrity API 全链路：从 Nonce 验证到设备级风险评分的端侧安全认证架构
slug: android-play-integrity-api-device-risk
translationKey: android-play-integrity-api-device-risk
excerpt: 本文详解 Google Play Integrity API 的完整接入链路，涵盖设备完整性、应用完整性和账号完整性三大判定维度，以及 Nonce 防重放、服务端验签、重试策略和风险分级决策，帮助开发者从 SafetyNet 平滑迁移到更精细的设备可信度评估体系。
publishDate: '2026-06-05'
tags:
- Android
- Play Integrity
- 安全认证
- 风控
- API 迁移
seo:
  title: 深入 Android Play Integrity API 全链路：从 Nonce 验证到设备级风险评分的端侧安全认证架构
  description: 详解 Play Integrity API 三大判定维度、Nonce 防重放机制、服务端验签流程与分级决策策略，助力从 SafetyNet 平滑迁移。
---

去年年初，Google 正式宣布 SafetyNet Attestation API 进入废弃倒计时。团队当时正在维护一个金融 App 的根检测模块，需要评估迁移成本和收益。改造过程中踩了不少坑，这篇文章把完整链路梳理一遍。

## SafetyNet 为什么被淘汰

SafetyNet Attestation 本质上只回答一个问题："设备是否通过了 CTS 认证"。它返回一个 JWS 签名令牌，服务端解密后拿到 `ctsProfileMatch` 和 `basicIntegrity` 两个布尔值。

问题在于粒度太粗。一台 Bootloader 已解锁但跑着官方 ROM 的手机，和一台已经被 Magisk 注入了 Zygisk 模块的手机，在 SafetyNet 的视角里可能都是 `ctsProfileMatch=false, basicIntegrity=true`。服务端无法区分"用户自己刷了 AOSP"和"恶意环境"，只能一刀切地拒绝。

Play Integrity API 把判断维度拆得更细，同时引入了设备信号强度评分，让服务端做分级决策。

## 三大判定维度

Play Integrity 返回的核心字段有三类：

### 设备完整性（Device Integrity）

这是 SafetyNet 的等价升级，分三个级别：

- **MEETS_BASIC_INTEGRITY**：设备环境没有被篡改，虚拟机里的模拟器就能拿到
- **MEETS_DEVICE_INTEGRITY**：设备通过了 Android 兼容性测试，且没有已知的提权漏洞利用迹象。对大多数非金融 App 足够
- **MEETS_STRONG_INTEGRITY**：硬件支持的密钥证明，需要 TEE 级别的可信执行环境。只开放给少数合作方

在实际项目中我发现，MEETS_DEVICE_INTEGRITY 是最常用的门槛。超过 90% 的正常设备能通过，而已经 Root 并安装了 Xposed/LSPosed 的设备基本过不了。

### 应用完整性（App Integrity）

检测安装来源和包签名。如果你的 App 被重新签名后分发到第三方渠道，`appRecognitionVerdict` 字段会直接暴露。字段值包括：

- `PLAY_RECOGNIZED`：来自 Google Play 正版安装
- `UNRECOGNIZED_VERSION`：签名或包名不匹配
- `UNEVALUATED`：设备不支持或请求超时

这个维度对防破解重打包很有用。Google Play 在后台维护了每个已发布 App 的签名指纹数据库，比对发生在 Google 服务端而非客户端，比本地签名校验难绕过得多。

### 账号完整性（Account Integrity）

只有在你同时使用 Google 登录时才有意义，检测当前设备登录的 Google 账号合法性。可以拿到 `LICENSED`、`UNLICENSED` 等许可状态。

## 客户端请求：Nonce 防重放是关键

标准请求流程如下：

```kotlin
val nonce = generateRandomNonce() // 服务端下发的一次性随机数

val integrityManager = IntegrityManagerFactory.create(context)
val request = IntegrityTokenRequest.builder()
    .setNonce(nonce)
    .setCloudProjectNumber(123456789L) // Google Cloud 项目编号
    .build()

val response: Task<IntegrityTokenResponse> = integrityManager.requestIntegrityToken(request)
response.addOnSuccessListener { tokenResponse ->
    val integrityToken = tokenResponse.token()
    // 把 token 发送到自己的服务端验证
}
```

Nonce 的生成策略需要自己把控。Google 文档推荐的方案：服务端生成 Nonce，用 `currentTimeMillis + 随机字符串` 组合，前端请求时带上，服务端验证后立即标记为已使用。

我见过一个反面案例：客户端本地生成 Nonce 然后发给服务端验证。这个方案形同虚设，攻击者完全可以伪造请求重放。Nonce 必须由服务端生成并绑定当前会话。

`setCloudProjectNumber` 是在 Google Cloud Console 中启用 Play Integrity API 后获得的项目编号，用于关联配额和日志。

## 服务端验签：Token 解密与决策链路

客户端拿到的 token 是一个 JWS（JSON Web Signature）格式的字符串，分为 Header、Payload、Signature 三部分。

服务端验证步骤：

**第一步：调用 Google API 解密**

```bash
curl -X POST "https://playintegrity.googleapis.com/v1/deviceRecall:decodeIntegrityToken" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"integrity_token": "'$TOKEN'"}'
```

返回的 JSON 结构（精简版）：

```json
{
  "tokenPayloadExternal": {
    "requestDetails": {
      "requestPackageName": "com.example.app",
      "nonce": "xxx",
      "timestampMillis": "1717600000000"
    },
    "appIntegrity": {
      "appRecognitionVerdict": "PLAY_RECOGNIZED",
      "certificateSha256Digest": ["abc123..."]
    },
    "deviceIntegrity": {
      "deviceRecognitionVerdict": ["MEETS_DEVICE_INTEGRITY"]
    },
    "accountDetails": {
      "appLicensingVerdict": "LICENSED"
    }
  }
}
```

**第二步：验证 Nonce**

把返回的 `requestDetails.nonce` 和服务端存储的进行比对，检查 `timestampMillis` 是否在允许的时间窗口内（通常设为 60 秒）。

**第三步：分级决策**

我线上用的决策矩阵，按场景组合处置：

| 场景 | 设备完整性 | 应用完整性 | 处理策略 |
|------|-----------|-----------|---------|
| 金融交易 | STRONG | PLAY_RECOGNIZED | 放行 |
| 普通功能 | DEVICE | PLAY_RECOGNIZED | 放行 |
| 风险设备 | BASIC | PLAY_RECOGNIZED | 限制功能 + 告警 |
| 破解版 | DEVICE | UNRECOGNIZED | 阻止 + 记录 |

客户端拿到的 token 是原始 JWS，只有服务端解密后才有可信的明文信息。不要在前端做任何安全性判断——攻击者可以直接篡改客户端逻辑，绕过本地校验。

## 重试策略与异常处理

Play Integrity API 的可用性不是 100%。Google Play Services 可能未安装、版本过旧，或者设备在离线状态。常见的错误码：

- `INTEGRITY_TOKEN_PROVIDER_INVALID`：Play Services 版本问题
- `NETWORK_ERROR`：网络不可用，建议重试
- `TOO_MANY_REQUESTS`：触发了限流，指数退避后重试
- `INTERNAL_ERROR`：Google 侧故障，同样指数退避

一个生产级的重试策略：

```kotlin
suspend fun fetchIntegrityTokenWithRetry(nonce: String): IntegrityTokenResponse {
    var delayMs = 1000L
    repeat(3) { attempt ->
        try {
            return integrityManager.requestIntegrityToken(
                IntegrityTokenRequest.builder()
                    .setNonce(nonce)
                    .setCloudProjectNumber(PROJECT_NUMBER)
                    .build()
            ).await()
        } catch (e: IntegrityServiceException) {
            when (e.errorCode) {
                IntegrityErrorCode.NETWORK_ERROR,
                IntegrityErrorCode.INTERNAL_ERROR -> {
                    if (attempt < 2) {
                        delay(delayMs)
                        delayMs *= 2
                    } else throw e
                }
                else -> throw e // 不可重试的错误直接抛
            }
        }
    }
    throw IntegrityServiceException(IntegrityErrorCode.INTERNAL_ERROR, null)
}
```

还有一个容易忽视的点：不要在应用启动时同步调用 API。Play Integrity 的首次请求可能需要几百毫秒甚至更久，应该在后台协程中预先获取 token 并缓存，用户触发关键操作时直接用。

## 风险信号与组合策略

除了三大判定维度，Play Integrity 还提供 `deviceIntegrity.deviceRecognitionVerdict` 数组——这是一个数组，可能同时包含多个判定结果。进阶用法需要关注 `recentDeviceActivity` 字段：

- `LEVEL_1`：近期无异常行为
- `LEVEL_2`：检测到少量可疑活动
- `LEVEL_3`：高频可疑行为，大概率是群控设备
- `LEVEL_4`：明确的风险设备

按风险级别区分处置：

- LEVEL 1-2 的设备降级服务权限，比如限制单日转账额度
- LEVEL 3-4 直接阻止敏感操作，并记录设备指纹加入风控黑名单

我的实际经验是，不要仅依赖 Play Integrity 做安全判断。它应该作为设备可信度的一层信号，和其他风控指标（设备指纹、行为序列、IP 风险度）叠加使用。单一信号源总有盲区。

## 接入时容易踩的三个坑

**一是 Nonce 的长度和有效期。** 太短容易被暴力碰撞，太长增加服务端存储开销。建议 32 字节随机数 + Base64 编码，有效期 60 秒。

**二是 `MEETS_STRONG_INTEGRITY` 的门槛。** 这个级别需要硬件密钥证明，目前只有少数旗舰机型支持。如果你的 App 强制要求 STRONG，大部分用户会直接被拒。除非你确认是银行级安全场景，否则用 DEVICE 就够了。

**三是 Google Cloud 项目的配额管理。** Play Integrity API 的免费配额是每天 10,000 次请求，按项目计。如果你的 App DAU 超过这个量，提前在 Google Cloud Console 申请扩容，不然高峰期会直接被 429 打回来，用户体验就是"突然用不了"。

---

迁移 Play Integrity 的核心价值不在于它比 SafetyNet 更难绕过，而在于它把设备风险的判定从"是与否"变成了"有多可信"。这个粒度变化让服务端可以做得更精细——不是把 Root 用户一棍子打死，而是根据风险等级调整权限。对用户体验和风控策略，这都是正向收益。
