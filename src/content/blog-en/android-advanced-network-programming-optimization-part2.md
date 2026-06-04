---
title: "Advanced Android Network Programming and Optimization (2): OkHttp Internals"
lang: en
translationKey: android-advanced-network-programming-optimization-part2
slug: android-advanced-network-programming-optimization-part2
excerpt: "Part 2 of Advanced Android Network Programming and Optimization: OkHttpClient, Dispatcher, ConnectionPool, interceptors, EventListener, DNS, and TLS."
publishDate: '2025-03-17'
tags:
- "Android"
- "Networking"
- "OkHttp"
- "Performance Optimization"
series:
  name: "Advanced Android Network Programming and Optimization"
  part: 2
  total: 3
seo:
  title: "Advanced Android Networking (2): OkHttp Internals and Tuning"
  description: "Understand OkHttpClient, Dispatcher, ConnectionPool, interceptors, EventListener, custom DNS, and TLS settings for Android networking."
  pageType: article
---
> This is part 2 of the three-part "Advanced Android Network Programming and Optimization" series. In the previous article, we covered "Networking as the app's lifeline."

## 2. OkHttp internals: the networking Swiss army knife

OkHttp is the de facto standard for Android networking, and Retrofit and many other libraries build on top of it. Mastering OkHttp is essential for network optimization.

### 1. Core components

**OkHttpClient**

- **Configuration center:** holds all network-related configuration, including connect/read/write timeouts, retry policy, interceptors, connection pool, Dispatcher, proxies, authenticators, DNS resolver, cache, supported protocols such as HTTP/1.1, HTTP/2, h2c, HTTP/3 over QUIC, and event listeners.
- **Instance sharing:** extremely important. OkHttpClient internally manages shared resources such as the connection pool and thread pool. Share one OkHttpClient instance across the app, typically through DI or a singleton. Otherwise, resource waste and performance degradation are likely. Use `.newBuilder()` to create a modified client based on an existing instance.

**Dispatcher**

- **Asynchronous request scheduler:** manages async requests submitted through `call.enqueue()`.
- **Queues:** maintains two deques: `readyAsyncCalls`, waiting to execute, and `runningAsyncCalls`, currently executing.
- **Concurrency control:** `setMaxRequests(int)` limits total concurrent requests, default 64. `setMaxRequestsPerHost(int)` limits concurrent requests per host, default 5. These prevent local resource exhaustion and excessive server pressure.
- **ExecutorService:** internally uses a cached ThreadPoolExecutor to execute network requests. A custom ExecutorService is possible, but usually not recommended unless there is a specific need and the consequences are well understood.

**ConnectionPool**

- **Connection reuse core:** manages reuse of TCP/TLS connections based on HTTP Keep-Alive or persistent connection features of HTTP/2 and HTTP/3.
- **Parameters:** `maxIdleConnections`, default 5, and `keepAliveDuration`, default 5 minutes.
- **Value:** greatly reduces request latency. Reusing connections avoids expensive TCP and TLS handshakes, especially for HTTPS.
- **Monitoring:** use `connectionPool.connectionCount()` and `idleConnectionCount()` to monitor pool state, or use EventListener for more detailed connection setup and release events.

**Interceptors**

OkHttp's most powerful extension mechanism, implemented as a chain of responsibility.

- **Types**
  - **Application interceptors** with `addInterceptor()`: run first and receive the final response last. They operate on the original Request and final Response, do not care about redirects or retries, and execute once. **Use cases:** add common headers such as auth tokens or User-Agent, log requests and responses, encrypt requests, decrypt responses, mock responses, and similar app-level behavior.
  - **Network interceptors** with `addNetworkInterceptor()`: run after application interceptors and before actual network I/O. They can observe **intermediate** requests and responses during redirects or retries and can access the underlying Connection. **Use cases:** gzip compression or decompression, network traffic metrics, cache policy decisions, and headers related to the network connection.
- **Built-in interceptor chain:** simplified order: RetryAndFollowUpInterceptor handles retries and redirects, BridgeInterceptor adds required HTTP headers, CacheInterceptor handles cache, ConnectInterceptor establishes the connection, and CallServerInterceptor performs actual network reads and writes.
- **Practice:** custom interceptors are the right place for non-standard requirements such as dynamic signing, custom caching, special error handling, request tagging, and traffic coloring. Understanding chain order is critical for correct interceptor logic.

**EventListener**

- **Fine-grained monitoring:** provides callbacks for the full request lifecycle: DNS lookup, TCP connection, TLS handshake, request headers/body sent, response headers/body received, connection release, call end, call failure, and more.
- **Use cases:** precise performance monitoring and diagnosis. Collect timing data, find network bottlenecks such as slow DNS, slow TLS, slow server handling, or slow transfer, and report to an APM system.

**Custom Dns**

Implement the `Dns` interface to replace the default system DNS resolver.

- **Use cases:** implement HTTPDNS to avoid carrier DNS hijacking or pollution and possibly improve speed; customize DNS caching; pre-resolve domains; or choose the best DNS server for the network environment.

**CertificatePinner, SSLSocketFactory, and HostnameVerifier**

These APIs customize TLS/SSL behavior, implement certificate pinning for stronger security, or trust a custom certificate authority.

**OkHttp Interceptor chain:**

```plain
Application Code -> client.newCall(request).enqueue() / execute()
         |
         V
+-------------------------+
| Application Interceptor 1| Request ->
+-------------------------+
         |
         V
+-------------------------+
| Application Interceptor 2| Request ->
+-------------------------+
         |
         V
+---------------------------+
| RetryAndFollowUpInterceptor| (Handles retries and redirects)
+---------------------------+
         |
         V
+-------------------------+
|    BridgeInterceptor    | (Adds standard headers such as Content-Type)
+-------------------------+
         |
         V
+-------------------------+
|    CacheInterceptor     | (Checks and updates cache)
+-------------------------+
         |
         V
+-------------------------+
| Network Interceptor 1   | Request -> (Closer to network)
+-------------------------+
         |
         V
+-------------------------+
| Network Interceptor 2   | Request ->
+-------------------------+
         |
         V
+-------------------------+
|    ConnectInterceptor   | (Finds or establishes connection)
+-------------------------+
         |
         V
+-------------------------+
|   CallServerInterceptor | <-----> Network I/O
+-------------------------+             |
         |                              V Response from network
         | Response <-
+-------------------------+
| Network Interceptor 2   | Response <-
+-------------------------+
         |
         V
+-------------------------+
| Network Interceptor 1   | Response <-
+-------------------------+
         |
         V
+-------------------------+
|    CacheInterceptor     | (Updates cache if needed)
+-------------------------+
         |
         V
+-------------------------+
|    BridgeInterceptor    | (Processes headers such as Content-Encoding)
+-------------------------+
         |
         V
+---------------------------+
| RetryAndFollowUpInterceptor| (Processes response for retry/redirect)
+---------------------------+
         |
         V
+-------------------------+
| Application Interceptor 2| Response <-
+-------------------------+
         |
         V
+-------------------------+
| Application Interceptor 1| Response <- Final response to app code
+-------------------------+
```

---

> In the next article, we will cover "Advanced Retrofit usage: defining APIs cleanly."

**Advanced Android Network Programming and Optimization series**

1. Networking as the app's lifeline
2. **OkHttp internals: the networking Swiss army knife** (this article)
3. Advanced Retrofit usage: defining APIs cleanly
