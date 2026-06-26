---
title: 深入 Android 网络安全配置全链路：从 Network Security Config 到 SSL Pinning 与证书透明度验证的端侧安全工程实践
excerpt: 从 Network Security Config 证书信任管理到 SSL Pinning 固定与证书透明度验证，介绍 Android 端侧网络安全三层防御体系的工程实践与线上监控方案。
publishDate: '2026-06-23'
tags:
- Android
- 网络安全
- SSL Pinning
- 证书透明度
- Network Security Config
seo:
  title: 深入 Android 网络安全配置全链路：从 Network Security Config 到 SSL Pinning 与证书透明度验证的端侧安全工程实践
  description: 详解 Android Network Security Config、SSL Pinning 与证书透明度三层防御体系，从配置陷阱到线上监控，构建端侧网络安全工程实践。
---

做安全审计时，Burp Suite 抓包居然抓不到我们 App 的 HTTPS 请求。安全团队问我是不是加了证书固定，我翻遍代码没找到 OkHttp 的 CertificatePinner 配置。最后发现是 Android 7.0+ 的默认行为——系统只信任预装 CA，用户安装的证书（包括 Charles 和 Burp 的根证书）对 App 默认不生效。

这个"安全默认值"背后的机制，就是 Network Security Config。

## Network Security Config：声明式证书信任管理

Network Security Config 是 Android 7.0 引入的 XML 配置框架，在 `AndroidManifest.xml` 中声明应用的证书信任策略。它把证书信任逻辑从代码中抽离，变成静态可审计的配置。

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/debug_ca" />
        </trust-anchors>
    </base-config>
    
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.0.0.1</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
```

几点关键行为：

- `base-config` 作用于所有未单独声明的域名；`domain-config` 可按域名粒度覆盖
- `cleartextTrafficPermitted="false"` 直接阻断 HTTP 明文请求，报错 `Cleartext HTTP traffic not permitted`。这和 `NetworkOnMainThreadException` 是两类独立的失败路径——前者是安全策略拦截，后者是线程限制
- `src="user"` 只应该在 debug 构建中用，**release 包加上这个等于自废武功**

踩过一个坑：在 `base-config` 里配置了 `src="system"` 和 `src="@raw/our_ca"`，但测试环境的后端用了自签名证书、且该证书不是由 `our_ca` 签发。结果 `domain-config` 没覆盖测试域名，请求直接失败，错误信息是 `Trust anchor for certification path not found`。排查思路是：别只看 OkHttp 日志，**先确认系统层面的证书校验是否已经报错**，因为 Network Security Config 的校验发生在 TLS 握手阶段，比 OkHttp 拦截器更早。

## SSL Pinning：从系统信任降到单证书信任

系统信任锚点（trust anchor）本质上是信任一个包含数百个 CA 的列表。证书固定（SSL Pinning）把这个信任范围缩小到 1-2 个特定证书或公钥，让中间人即使拿到合法 CA 签发的伪造证书也无法通过校验。

OkHttp 提供了两种固定方式：

```kotlin
// 方式一：CertificatePinner — 按 SHA-256 哈希固定
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .add("api.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=") // 备用
    .build()

val client = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

```kotlin
// 方式二：自定义 TrustManager — 直接比对证书链
val customTrustManager = object : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val expectedPublicKey = loadPublicKeyFromRaw(R.raw.server_cert)
        if (!Arrays.equals(chain[0].publicKey.encoded, expectedPublicKey.encoded)) {
            throw CertificateException("Public key mismatch")
        }
    }
    // 省略 getAcceptedIssuers 实现
}
```

方式一适合多数场景，配置简单、一条链搞定。方式二给了更大的灵活性，比如在证书过期前按时间窗口平滑切换。我经历过一次线上事故：后端在半夜更换了证书，新证书的 SHA-256 哈希没更新到 `CertificatePinner`，导致全量客户端请求失败。事后的教训是：**永远配置至少两个 pin，一个当前证书、一个备用证书**，并且把固定失败事件上报到监控系统。

## 证书透明度：让伪造证书无处藏身

SSL Pinning 的问题是它是**静态的**——证书到期就要发版更新。证书透明度（Certificate Transparency，CT）换了一个思路：不直接验证证书内容，而是验证证书是否被公开记录在 CT 日志中。

Google 从 2018 年开始要求所有 Symantec 体系 CA 签发的证书必须附带 SCT（Signed Certificate Timestamp）。如果攻击者伪造了一张证书，它不太可能出现在公开的 CT 日志中——伪造证书大概率不会去提交 SCT。

端侧验证 CT 的实现：

```kotlin
class CertificateTransparencyInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val handshake = chain.connection()?.handshake() as? Handshake
        val certificates = handshake?.peerCertificates ?: emptyList()
        
        // 检查证书是否包含 SCT 扩展 (OID 1.3.6.1.4.1.11129.2.4.2)
        for (cert in certificates) {
            val sctExtension = (cert as? X509Certificate)?.getExtensionValue("1.3.6.1.4.1.11129.2.4.2")
            if (sctExtension == null) {
                // 生产环境应抛出异常或上报，而非静默放行
                reportToMonitoring("Missing SCT for ${cert.subjectDN}")
            }
        }
        return chain.proceed(chain.request())
    }
}
```

这个方案在实际落地时有一个妥协点：**国内很多 CA 签发的证书不包含 SCT 扩展**，尤其是非 Symantec 体系的 CA。如果一刀切拦截，大量合法请求会被误杀。我当时的做法是分阶段推进——先只上报不拦截，观察 2 周数据后，对国际业务域名开启拦截，国内域名继续只做监控。

## 构建多层防御：三者的配合关系

Network Security Config、SSL Pinning 和 CT 验证不是互斥的替代方案，而是三层递进：

1. **Network Security Config**：守住信任锚点的入口，决定"哪些 CA 可以签发我信任的证书"
2. **SSL Pinning**：在系统信任的基础上再缩窄，决定"我只信任这几张证书"
3. **CT 验证**：动态验证证书的合法性，弥补静态固定的滞后性

实际项目中，release 配置通常是这样的：

```
Network Security Config: 只信任 system CA
  └── OkHttp CertificatePinner: 对核心 API 域名固定 2 个 pin
       └── CTInterceptor: 对非核心域名做 SCT 存在性检查
```

debug 构建则通过 `src="user"` 放行抓包工具的证书。debug 的 `CertificatePinner` 直接移除或用 debug 覆盖——不然你连 Charles 的请求都发不出去。

## 线上监控比加密本身更重要

证书固定最大的风险不是被破解，而是**自己把自己锁在外面**。证书过期、服务端更换证书忘记同步客户端、CDN 回源证书配置错误，这些都能导致大面积用户无法使用。

监控层面我建议至少关注三个指标：

- **SSL 握手失败率**：按域名和错误码聚合，`SSLPeerUnverifiedException` 突然飙升大概率是证书问题
- **CertificatePinner 失败次数**：直接反映固定配置和服务端证书的匹配状态
- **CT 验证缺失率**：按 CA 颁发者分组，追踪哪些 CA 颁发的证书不带 SCT

证书固定的安全收益和你为此付出的运维成本成正比。如果团队没有成熟的证书变更流程和灰度发布机制，**先用 Network Security Config 就够了**，别急着上 SSL Pinning。NSC 配合 Android 系统的 CA 信任机制，已经能挡住大部分使用用户安装证书的中间人攻击。
