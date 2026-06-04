---
title: 图片加载稳定性实战：自定义 SSL 确认与 DoH DNS 双管齐下
excerpt: 移动端图片加载看似简单，但用户看到的头像不显示、内容图片灰块、首屏瀑布流空白，背后往往是证书链校验失败、DNS 被污染、运营商局部解析异常等问题。本文介绍图片网络层的两项稳定性增强：自定义 SSL 确认和 DoH DNS 解析。
publishDate: '2026-06-04'
tags:
- Android
- 图片加载
- 网络安全
- DNS
- 稳定性
seo:
  title: 图片加载稳定性实战：自定义 SSL 确认与 DoH DNS 双管齐下
  description: 图片加载网络层稳定性增强方案，通过自定义 SSL trust manager 做更明确的证书校验边界，同时为图片域名引入 DoH DNS 解析，降低系统 DNS 抖动对图片加载成功率的影响。
---

图片请求和普通 API 请求有几个显著差异。第一，图片数量大，且经常发生在首屏、列表滑动和页面切换的高压场景中。第二，图片失败通常不会打断主流程，所以异常容易被忽略，直到用户反馈页面"看起来不完整"。第三，图片请求常由图片库内部接管，业务代码只负责设置地址，网络配置、证书策略、DNS 策略如果没有统一封装，就会分散在多个入口里。

在 Android 环境中，系统网络栈和设备厂商差异会放大这些问题。某些系统版本的证书存储不完整，某些代理或公共 Wi-Fi 会替换证书，某些地区的本地 DNS 会把同一个图片域名解析到不可达节点。最理想的状态不是"绕过所有校验让图片尽量显示"，而是在安全边界内提高可用性，并让失败原因可观测、可回退、可灰度。

我们项目里把图片链路稳定性放在 `common/imageloader/ssl` 和 `common/imageloader/glide/progress/doh` 两条线上治理。SSL 部分有自定义 handler、trust manager 和用户确认处理；DoH 部分有 DNS 记录编解码和 OkHttp DNS 接入能力。这意味着项目没有把图片当作普通 HTTP URL 直接扔给 Glide，而是把"图片域名解析、证书异常、用户确认、降级策略"纳入统一门面。

## DoH DNS：不是炫技，是兜底

DoH 不建议对所有域名全量启用。图片域名通常数量可控，可以通过白名单方式管理。解析结果要区分 A 和 AAAA 记录，并结合客户端网络能力决定排序策略。在 IPv6 支持不稳定的环境中，可以先尝试历史成功率更高的地址族，而不是盲目相信返回顺序。缓存 TTL 也不能过长，因为移动网络频繁切换，过期地址会造成连接超时；但也不能完全无缓存，否则列表大量图片会放大 DoH 请求量。

```kotlin
class ImageDnsResolver(
    private val dohClient: DohClient,
    private val systemDns: Dns,
    private val cache: DnsCache,
    private val enabledHosts: Set<String>
) : Dns {
    override fun lookup(host: String): List<InetAddress> {
        if (host !in enabledHosts) {
            return systemDns.lookup(host)
        }

        cache.get(host)?.let { cached -> return cached.addresses }

        val dohResult = runCatching { dohClient.query(host) }.getOrNull()

        if (dohResult != null && dohResult.addresses.isNotEmpty()) {
            val sorted = AddressPolicy.sortByNetworkQuality(dohResult.addresses)
            cache.put(host, sorted, ttl = dohResult.safeTtl())
            return sorted
        }

        return systemDns.lookup(host)
    }
}
```

DoH 本身也有失败可能。DoH 服务不可达时必须快速回退系统 DNS，不能让图片请求卡在额外解析链路上。DoH 超时时间应明显短于图片总体连接超时，并且要设置并发控制，避免弱网下大量图片同时触发解析请求。

## 自定义 SSL 确认：更明确的安全边界

自定义 SSL 确认采用"系统默认校验加额外约束"的模式。先由系统 trust manager 完成基础证书链校验，再检查域名匹配、公钥指纹或业务允许的证书属性。这样既不破坏平台安全模型，又能在异常时产生更明确的错误分类：

```kotlin
class ImageTrustManager(
    private val platformTrustManager: X509TrustManager,
    private val pinStore: CertificatePinStore,
    private val reporter: TlsReporter
) : X509TrustManager {

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        platformTrustManager.checkServerTrusted(chain, authType)

        val leaf = chain.firstOrNull() ?: error("empty certificate chain")
        val pinMatched = pinStore.matches(leaf.publicKey)
        if (!pinMatched) {
            reporter.reportPinMismatch(leaf.subject())
            throw CertificateException("image certificate pin mismatch")
        }
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    override fun getAcceptedIssuers(): Array<X509Certificate> =
        platformTrustManager.acceptedIssuers
}
```

最终在图片网络客户端中组合 DNS 和 SSL 配置：

```kotlin
fun buildImageHttpClient(config: ImageNetworkConfig): HttpClient {
    val dns = ImageDnsResolver(
        dohClient = config.dohClient,
        systemDns = SystemDns,
        cache = MemoryDnsCache(),
        enabledHosts = config.imageHosts
    )

    val trustManager = ImageTrustManager(
        platformTrustManager = PlatformTrustManager.create(),
        pinStore = config.pinStore,
        reporter = config.tlsReporter
    )

    return HttpClient.Builder()
        .dns(dns)
        .sslSocketFactory(SslFactory.from(trustManager), trustManager)
        .eventListener(ImageRequestEventListener())
        .connectTimeout(config.connectTimeout)
        .readTimeout(config.readTimeout)
        .build()
}
```

## 结构化错误：让失败分类更清晰

错误对象要尽量结构化，不要只记录一段异常字符串：

```kotlin
enum class ImageFailureStage {
    DNS_LOOKUP, TCP_CONNECT, TLS_HANDSHAKE,
    HTTP_RESPONSE, DECODE, UNKNOWN
}

data class ImageFailure(
    val stage: ImageFailureStage,
    val safeReason: String,
    val fallbackUsed: Boolean
)
```

这样的设计让后续分析更直接。如果某个版本 TLS_HANDSHAKE 错误上升，优先检查证书策略；如果 DNS_LOOKUP 超时集中在某网络类型，优先检查 DoH 可用性和系统 DNS 回退；如果 DECODE 错误上升，问题可能在图片格式或解码库。

## 落地中的关键约束

严禁正式环境信任所有证书。开发阶段为了抓包方便可以使用独立调试配置，但必须通过构建类型、运行环境或安全开关隔离。

证书固定要考虑轮换。只固定单个叶子证书风险很高，一旦服务端更新证书，旧客户端可能无法加载图片。更稳妥的做法是固定公钥或固定一组可接受指纹，并提前发布包含新指纹的客户端版本。

灰度要按域名和客户端版本推进。先选择少量图片域名观察成功率、延迟、TLS 错误率和回退率，再扩展到更多域名。不要把 API、WebView、下载和图片全部复用同一套激进 DNS 策略，因为它们的失败成本和流量特征不同。

---

图片加载稳定性不是简单调大超时，也不是把失败都交给占位图处理。真正有效的方案需要把 DNS、TLS、HTTP、解码和 UI 展示放在一条可观测链路里。自定义 trust manager 的价值在于明确安全策略和错误分类，DoH DNS 的价值在于降低本地解析环境的不确定性。两者结合时，必须坚持"安全默认、按域名启用、失败快速回退、全程可观测"的原则。上线后不要只看整体成功率，还要看失败阶段分布、不同网络类型差异、DoH 命中率、系统 DNS 回退率和证书错误趋势。只有这些指标稳定，图片体验才算真正稳定。