---
title: "Android Network Stack Optimization: DNS, TLS 1.3, HTTP/3, and QUIC"
lang: en
translationKey: android-network-stack-dns-http3-quic
slug: android-network-stack-dns-http3-quic
excerpt: "A practical guide to Android network stack optimization, covering DNS resolution, DoH and HttpDNS, TLS 1.3 handshakes, HTTP/3, QUIC, and 0-RTT."
publishDate: '2025-05-06'
tags:
- "Android"
- "Network Optimization"
- "HTTP/3"
- "DNS"
- "TLS"
seo:
  title: "Android Network Optimization: DNS, TLS 1.3, HTTP/3, and QUIC"
  description: "Learn how to optimize Android networking from DNS and DoH to TLS 1.3, HTTP/3, QUIC, 0-RTT, connection pools, and rollout priorities."
  pageType: article
---

While optimizing networking for an overseas app last year, I stared at packet captures for a long time. A simple API request spent 200 ms on DNS resolution, 150 ms on the TCP handshake, and another 300 ms on the TLS handshake. Connection setup alone cost 650 ms, and that was on Wi-Fi. On 4G, the number doubled.

The problem was obvious, but day-to-day development rarely exposes this latency. OkHttp connection pooling and HTTP/2 multiplexing hide most of the details. Once you need aggressive optimization, those hidden details become the bottleneck.

## DNS resolution: the first overlooked source of latency

Standard DNS resolution uses UDP port 53 and depends on the carrier's LocalDNS server. This path has three unstable factors:

**Carrier DNS hijacking** can return the wrong IP and route requests to ad pages or cache servers. **DNS pollution** can resolve some domains to unrelated addresses. **Imprecise scheduling** happens when the LocalDNS egress IP does not match the device's real network location, preventing the CDN from assigning the right edge node.

OkHttp uses the system DNS resolver by default, which calls `InetAddress.getAllByName()` underneath. On weak networks, UDP packet loss can trigger timeout retries, and a single resolution can easily exceed 500 ms.

```kotlin
// Custom OkHttp DNS implementation using HttpDNS.
val client = OkHttpClient.Builder()
    .dns { hostname ->
        // Fetch the IP list from an HTTP DNS service.
        val ips = httpDnsService.resolve(hostname)
        ips.map { InetAddress.getByName(it) }
    }
    .build()
```

In real projects, I prefer **DNS over HTTPS**, or DoH, over a self-built HttpDNS service. DoH uses HTTPS on port 443, is naturally resistant to hijacking, and cloud DNS providers usually have much better scheduling accuracy than carrier LocalDNS. Google's `dns.google` and Cloudflare's `1.1.1.1` both provide public DoH endpoints.

But DoH itself needs DNS to resolve `dns.google`, which creates a bootstrapping problem. The solution is **built-in IP fallback**. Hardcode a copy of the DoH server IPs and use those IPs for the first HTTPS request, bypassing DNS. Later lookups can use the normal DoH flow.

For core domains, you can also do **DNS pre-resolution**:

```kotlin
// Warm up at app startup or after network changes.
OkHttpClient.dns.resolve("api.example.com")
```

Combined with connection-pool warmup, such as issuing one `client.newCall(Request.Builder().url(url).build()).execute()`, this can reduce the first cold-start request from more than 600 ms to under 100 ms.

## TLS 1.3: reducing two RTTs to one

After DNS, the next latency source is the TLS handshake. TLS 1.2 requires 2 RTTs: ClientHello, then ServerHello plus Certificate, then ClientKeyExchange plus Finished, then Server Finished. Add the 1 RTT TCP three-way handshake and connection setup costs 3 RTTs in total.

TLS 1.3 compresses the process to 1 RTT. The client sends key-agreement parameters directly in ClientHello, and the server can complete negotiation in one round trip.

Starting with Android 10, API 29, OkHttp enables TLS 1.3 by default. If your `minSdk` is 21 or higher, OkHttp automatically negotiates TLS 1.3 on supported devices. No extra client configuration is needed, which is better than many documents suggest.

```kotlin
// OkHttp does not need manual TLS 1.3 configuration.
// It negotiates through ALPN and uses TLS 1.3 automatically when supported.
val client = OkHttpClient.Builder()
    .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
    .build()
```

In testing, TLS 1.3 reduced HTTPS handshakes from about 300 ms to about 100 ms in a 60 ms RTT environment. With **TLS Session Resumption**, later connections can approach 0-RTT behavior: the client includes the previous session ticket in ClientHello, and the server resumes the session key directly.

OkHttp's `ConnectionPool` keeps 5 idle connections alive for 5 minutes by default. For frequently accessed domains, that pool is usually enough. If your app talks to many domains, such as multiple CDN origins, increasing the pool size can pay off:

```kotlin
OkHttpClient.Builder()
    .connectionPool(ConnectionPool(10, 10, TimeUnit.MINUTES))
```

## HTTP/3 and QUIC: TCP's head-of-line blocking finally has an answer

TCP has a long-standing problem: **Head-of-Line Blocking**. TCP requires packets to be delivered in strict order. If the packet with sequence number 3 is lost, packets 4 and 5 must wait even if they already arrived. HTTP/2 moved the problem from the request level to the connection level, but it still cannot avoid it when packet loss occurs.

QUIC uses UDP and implements independent streams at the transport layer. Each stream has its own sequence numbers and retransmission mechanism. Packet loss in stream A does not block stream B. Multiplexing no longer shares one blocking queue.

The benefit is especially large on mobile. Packet loss spikes during 4G and 5G handoff, and the same happens when Wi-Fi signal quality drops. TCP performance falls sharply in those scenarios, while QUIC can tolerate 3% to 5% packet loss without obvious latency degradation.

OkHttp has supported QUIC since 4.0, but it requires integrating Cronet, Chromium's network stack:

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.android.gms:play-services-cronet:18.0.1")
}
```

```kotlin
val cronetEngine = CronetEngine.Builder(context).build()
val client = OkHttpClient.Builder()
    .addInterceptor(CronetInterceptor.newBuilder(cronetEngine).build())
    .build()
```

Frankly, the OkHttp plus Cronet approach is not especially clean. It introduces a Google Play Services dependency, which is acceptable for overseas builds but often unsuitable for domestic builds that need a self-compiled Cronet shared library. I am still waiting for a standalone QUIC implementation in a future OkHttp release.

## 0-RTT: taking connection latency to the floor

QUIC 0-RTT is currently the ceiling for mobile connection setup optimization. The principle is straightforward: the client caches the server's configuration parameters, similar to TLS Session Resumption but more complete, and sends application data in the first packet on the next connection.

The cost is weaker security. 0-RTT data is vulnerable to replay attacks. The server must implement idempotency protection or mark replayable data with the `Early-Data` header. That means 0-RTT is appropriate for idempotent GET requests. Do not use it for POST, PUT, or DELETE.

On Android, enabling 0-RTT requires server support. Nginx 1.25+ and Caddy both support QUIC 0-RTT, and the configuration is just one line:

```nginx
server {
    listen 443 quic reuseport;
    ssl_early_data on;
}
```

On the client side, Cronet enables 0-RTT by default, so no extra configuration is needed. Combined with DNS pre-resolution and connection warmup, the first request after a warm app start can come in under 50 ms, close to local cache latency.

**One hard-earned lesson**: some carriers apply QoS policies that severely limit QUIC traffic over UDP, or even drop it outright. When rolling out QUIC, bucket success rates by carrier and network type. My rollout strategy was to enable QUIC on Wi-Fi first, fall back to HTTP/2 on mobile data, and use an A/B experiment before full rollout.

## Engineering rollout priorities

Network stack optimization can easily turn into chasing the newest protocol. Ranked by practical return, the priorities look like this:

1. **DNS layer**: a few lines of code can save 200 to 500 ms. DoH plus built-in IP fallback is the standard answer.
2. **Connection-pool tuning**: nearly free. More keep-alive connections can avoid repeated handshakes.
3. **TLS 1.3**: Android 10+ supports it by default. Just make sure the server enables it. No client-side change is required.
4. **QUIC/HTTP/3**: the largest gain on weak networks, but also the highest engineering complexity. Start rollout with Wi-Fi scenarios.

The deeper you go, the thinner the incremental gain and the higher the cost. Decide how far to go based on your users' network distribution. That is much more practical than chasing an all-in HTTP/3 stack from day one.
