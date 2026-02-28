---
title: "Android 高级网络编程与优化（2）：OkHttp 深度解析：网络请求的瑞士军刀"
excerpt: "「Android 高级网络编程与优化」系列第 2/3 篇：OkHttp 深度解析：网络请求的瑞士军刀"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 网络
  - OkHttp
  - 性能优化
series:
  name: "Android 高级网络编程与优化"
  part: 2
  total: 3
seo:
  title: "Android 高级网络编程与优化（2）：OkHttp 深度解析：网络请求的瑞士军刀"
  description: "「Android 高级网络编程与优化」系列第 2/3 篇：OkHttp 深度解析：网络请求的瑞士军刀"
---
# Android 高级网络编程与优化（2）：OkHttp 深度解析：网络请求的瑞士军刀

> 本文是「Android 高级网络编程与优化」系列的第 2 篇，共 3 篇。在上一篇中，我们探讨了「引言：应用的生命线——网络通信」的相关内容。

## 二、OkHttp 深度解析：网络请求的瑞士军刀

OkHttp 是 Android 网络编程的事实标准，Retrofit 等库都基于它构建。精通 OkHttp 对于网络优化至关重要。

### 1. 核心组件

**OkHttpClient**

- **配置中心**：包含所有网络相关配置，如连接/读/写超时、重试策略、拦截器、连接池、Dispatcher、代理、认证器、DNS 解析器、缓存、支持的协议（HTTP/1.1、HTTP/2、h2c、HTTP/3 via QUIC）、事件监听器等；
- **实例共享**：极其重要。OkHttpClient 内部管理着连接池和线程池等共享资源，必须在应用中共享同一个 OkHttpClient 实例（可通过 DI 或单例实现），否则会造成资源浪费和性能下降。可通过 `.newBuilder()` 基于现有实例创建修改了部分配置的新实例。

**Dispatcher**

- **异步请求调度器**：管理通过 `call.enqueue()` 提交的异步请求；
- **队列**：维护 `readyAsyncCalls`（等待执行）和 `runningAsyncCalls`（正在执行）两个双端队列；
- **并发控制**：通过 `setMaxRequests(int)`（同时执行的最大请求数，默认 64）和 `setMaxRequestsPerHost(int)`（同一域名同时执行的最大请求数，默认 5）来限制并发，防止耗尽本地资源或对服务器造成过大压力；
- **ExecutorService**：内部使用可缓存的线程池（ThreadPoolExecutor）来实际执行网络请求。可自定义此 ExecutorService，但通常不建议，除非有特殊需求且非常清楚后果。

**ConnectionPool**

- **连接复用核心**：管理 TCP/TLS 连接的复用（基于 HTTP Keep-Alive 或 HTTP/2、HTTP/3 的持久连接特性）；
- **参数**：`maxIdleConnections`（连接池中保持的最大空闲连接数，默认 5）和 `keepAliveDuration`（空闲连接在被回收前保持的时间，默认 5 分钟）；
- **价值**：极大降低请求延迟。复用连接避免了昂贵的 TCP 三次握手和 TLS 握手开销，对 HTTPS 请求尤其重要；
- **监控**：可通过 `connectionPool.connectionCount()` 和 `idleConnectionCount()` 监控连接池状态，或使用 EventListener 获取更详细的连接建立/释放事件。

**拦截器（Interceptors）**

OkHttp 最强大的扩展机制，采用责任链模式。

- **类型**
  - **应用拦截器**（`addInterceptor()`）：最先执行，最后收到响应。操作的是最原始的 Request 和最终的 Response，不关心重定向、重试等中间过程，只执行一次。**用途**：添加通用 Header（如 Auth Token、User-Agent）、请求/响应日志记录、请求加密/响应解密、Mock 响应等；
  - **网络拦截器**（`addNetworkInterceptor()`）：在应用拦截器之后、实际网络 I/O 之前执行。可观察到重定向、重试等过程中的**中间**请求和响应，并可访问底层的 Connection 对象。**用途**：Gzip 压缩/解压、网络流量统计、缓存策略判断（虽然 OkHttp 内置了）、添加/修改与网络连接相关的 Header。
- **OkHttp 内置拦截器链**（顺序很重要）：（简化）RetryAndFollowUpInterceptor（重试和重定向）→ BridgeInterceptor（添加必要 HTTP 头）→ CacheInterceptor（处理缓存）→ ConnectInterceptor（建立连接）→ CallServerInterceptor（实际网络读写）；
- **实践**：熟练编写自定义拦截器来实现各种非标准需求（如动态加签、自定义缓存逻辑、特殊错误处理、请求染色等）。理解拦截器链的顺序对于正确实现拦截器逻辑至关重要。

**EventListener**

- **细粒度监控**：提供一系列回调方法，覆盖网络请求的完整生命周期——DNS 解析、TCP 连接、TLS 握手、请求头/体发送、响应头/体接收、连接释放、调用结束/失败等各阶段的开始和结束，并提供耗时信息；
- **用途**：精密的性能监控和诊断。可收集详细的耗时数据，分析网络瓶颈（DNS 慢？TLS 握手慢？服务器处理慢？数据传输慢？），上报给 APM 系统。

**自定义 Dns**

实现 `Dns` 接口替换默认的系统 DNS 解析。

- **用途**：实现 HTTPDNS（避免运营商 DNS 劫持和污染，可能更快）、自定义 DNS 缓存策略、DNS 预解析、根据网络环境选择最优 DNS 服务器。

**CertificatePinner、SSLSocketFactory、HostnameVerifier**

用于自定义 TLS/SSL 配置，实现证书锁定（Certificate Pinning）增强安全性，或信任自定义证书颁发机构（CA）。

**（图示：OkHttp Interceptor 链）**

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
| RetryAndFollowUpInterceptor| (Handles Retries & Redirects)
+---------------------------+
         |
         V
+-------------------------+
|    BridgeInterceptor    | (Adds std headers like Content-Type)
+-------------------------+
         |
         V
+-------------------------+
|    CacheInterceptor     | (Checks/Updates Cache)
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
|    ConnectInterceptor   | (Finds/Establishes Connection)
+-------------------------+
         |
         V
+-------------------------+
|   CallServerInterceptor | <-----> Network I/O
+-------------------------+             |
         |                              V Response from Network
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
|    CacheInterceptor     | (Updates Cache if needed)
+-------------------------+
         |
         V
+-------------------------+
|    BridgeInterceptor    | (Processes headers like Content-Encoding)
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
| Application Interceptor 1| Response <- Final Response to App Code
+-------------------------+
```

---

> 下一篇我们将探讨「Retrofit 高级用法：优雅定义 API」，敬请关注本系列。

**「Android 高级网络编程与优化」系列目录**

1. 引言：应用的生命线——网络通信
2. **OkHttp 深度解析：网络请求的瑞士军刀**（本文）
3. Retrofit 高级用法：优雅定义 API
