---
slug: ktor-client-kotlin-multiplatform-networking
translationKey: ktor-client-kotlin-multiplatform-networking
title: 深入 Ktor Client 全链路：从引擎抽象到 Kotlin Multiplatform 协程化网络层的工程实践
excerpt: 本文深入 Ktor Client 全链路，解析引擎抽象、拦截器管道与协程化网络层，并覆盖引擎选型、超时语义和 MockEngine 测试等落地实践。
publishDate: '2026-08-25'
tags:
- Ktor
- Kotlin Multiplatform
- Kotlin
- 协程
- 网络层
seo:
  title: 深入 Ktor Client 全链路：从引擎抽象到 Kotlin Multiplatform 协程化网络层的工程实践
  description: 深入 Ktor Client 全链路，解析引擎抽象、拦截器管道、协程化网络层，以及引擎选型、超时语义和 MockEngine 测试等落地实践。
---

## OkHttp 之外的选型空白

在一个 KMP 项目里搭共享网络层时，遇到一个绕不开的问题：OkHttp 只覆盖 Android 和 JVM，iOS 得另写一套 NSURLSession 封装。两端各写一遍，行为还不一致，出了超时问题两边对不上。

摆在面前的是两条路：用 expect/actual 各写一份，还是引入一个真正跨平台的客户端。前者工作量直接翻倍，后者让我开始认真看 Ktor Client。

Ktor Client 的价值不在某个具体引擎，而在于它把"发请求"抽象成一套统一 API，底层引擎变成可替换的配置。KMP 网络层缺的正是这层抽象。

## 引擎抽象：HttpClient 与 HttpClientEngine

HttpClient 是日常使用的门面，本身不处理任何字节流。真正建立连接、发送报文的是 HttpClientEngine 接口，各平台有各自的实现：

| 引擎 | 平台 | 特点 |
| --- | --- | --- |
| `OkHttp` | Android/JVM | 成熟稳定，HTTP/2 + 连接池 |
| `Darwin` | iOS | 封装 NSURLSession |
| `CIO` | 全平台 | 纯 Kotlin 实现，零平台依赖 |
| `Js` | JS | 封装 fetch/XHR |

选引擎只是传一个参数：

```kotlin
val client = HttpClient(OkHttp) {
    // 通用配置
}
```

在 KMP 里，我习惯用 expect/actual 把引擎选择下沉到各平台源集，common 层只依赖 HttpClient 这个公共类型：

```kotlin
// commonMain
expect fun createHttpClient(): HttpClient

// androidMain
actual fun createHttpClient() = HttpClient(OkHttp)

// iosMain
actual fun createHttpClient() = HttpClient(Darwin)
```

common 层完全不感知底层引擎是谁。iOS 打包链接 Darwin，Android 打包链接 OkHttp，互不干扰。

## 拦截器管道：请求与响应是两条流水线

引擎抽象解决"谁发请求"，拦截器管道解决"发之前和收之后做什么"。Ktor 把一次调用拆成两条流水线：

- HttpRequestPipeline：Before → State → Transform → Render → Send
- HttpResponsePipeline：Receive → Parse → Transform → State → After

内置插件挂在对应阶段上。DefaultRequest 在请求最外层追加公共参数，HttpTimeout 控制超时，ContentNegotiation 在 Transform 阶段做序列化：

```kotlin
val client = HttpClient(OkHttp) {
    install(DefaultRequest) {
        url("https://api.example.com/")
        header("X-Client-Version", BuildConfig.VERSION)
    }
    install(HttpTimeout) {
        requestTimeoutMillis = 10_000
    }
}
```

HttpSend 是请求流水线的最后一道门，紧贴引擎。要加自定义拦截逻辑，直接挂它：

```kotlin
client.plugin(HttpSend).intercept { request ->
    val start = System.currentTimeMillis()
    val response = execute(request)
    log("${request.method} ${request.url} -> ${response.status} (${System.currentTimeMillis() - start}ms)")
    response
}
```

这比写一个完整的 HttpClientPlugin 轻量，适合日志、埋点、请求改写这类横切需求。

## 协程化：suspend 与 Flow 贯穿全链路

Ktor Client 的所有请求方法都是 suspend 函数，取消、超时、并发控制都直接复用协程的能力：

```kotlin
suspend fun fetchUser(id: String): UserDto {
    return client.get("users/$id").body()
}
```

body() 配合 kotlinx.serialization 做反序列化，前提是装了 ContentNegotiation：

```kotlin
val client = HttpClient(OkHttp) {
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true })
    }
}
```

仓库层再包一层 Flow，网络数据就能以响应式的方式暴露给上层：

```kotlin
fun observeUsers(): Flow<List<User>> = flow {
    emit(client.get("users").body())
}
```

协程取消会沿调用链一路传到引擎，正在进行的 IO 被及时中断。这点比回调式网络层舒服——回调模式下页面销毁了，还得手动判断回调是否该执行。

## 落地实践：选型、超时与 MockEngine

落地阶段真正要拍板的是几个具体问题。

**引擎选型**：Android 上我倾向 OkHttp。它经过了海量设备验证，连接池和 HTTP/2 行为成熟。CIO 留给桌面应用、服务端脚本这类不想引入平台依赖的场景。iOS 没有选择，Darwin 是唯一现实解。

**超时语义**：HttpTimeout 的三个参数容易混。connectTimeoutMillis 是建连超时，socketTimeoutMillis 是字节间等待超时，requestTimeoutMillis 是整次请求的总时限。三者都配上，线上排查能省不少事。

**测试**：MockEngine 能在不碰真网络的情况下验证完整管道，包括序列化：

```kotlin
val mockEngine = MockEngine { request ->
    respond(
        content = """{"id":"1","name":"kevin"}""",
        status = HttpStatusCode.OK,
        headers = headersOf(HttpHeaders.ContentType, "application/json")
    )
}
val client = HttpClient(mockEngine) {
    install(ContentNegotiation) { json() }
}
```

我踩过的一个坑：MockEngine 返回响应时如果漏了 Content-Type: application/json，ContentNegotiation 拿不到序列化器，body() 直接抛异常。真网络环境服务器通常带这个头，Mock 里却要自己补。

客户端用完记得 close()。OkHttp 和 Darwin 引擎底层都持有连接池，KMP 里客户端常做成单例长期存活，进程级资源释放时该关还是得关。

Ktor Client 用引擎抽象换来跨平台，代价是你要理解每个引擎的边界。它不是把平台差异抹平，而是把差异挪到一个显式的位置。对我来说，这比把差异藏起来更可控。
