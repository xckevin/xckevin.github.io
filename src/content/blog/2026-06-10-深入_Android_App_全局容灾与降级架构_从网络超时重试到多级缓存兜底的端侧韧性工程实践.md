---
title: 深入 Android App 全局容灾与降级架构：从网络超时重试到多级缓存兜底
slug: android-app-resilience-degradation-cache
translationKey: android-app-resilience-degradation-cache
excerpt: 本文从一次线上事故出发，系统梳理了 Android 端侧容灾架构的三个维度：网络层指数退避重试、数据层三级缓存兜底（内存→DataStore→Room）、以及自适应降级引擎与可观测性闭环。
publishDate: '2026-06-10'
tags:
- Android
- 容灾
- 架构设计
- 缓存
- 网络优化
seo:
  title: 深入 Android App 全局容灾与降级架构：从网络超时重试到多级缓存兜底
  description: 系统梳理 Android 端侧容灾架构：网络层条件重试与指数退避、数据层三级缓存兜底（LruCache→DataStore→Room）、自适应降级引擎及可观测性实践，打造高韧性移动应用。
---

去年双十一，我负责的电商 App 在流量峰值期间出现了一个诡异的现象：某个商品详情接口偶发超时后，整个详情页直接白屏，连缓存的旧数据都没展示。排查发现，之前的"容灾方案"只是一层 try-catch 加 Toast 提示。用户看到的不是降级内容，而是"网络异常，请重试"——这等于把问题甩给了用户。

那次事故让我意识到：全局容灾不是加几个 if-else，而是一套覆盖网络层、数据层、UI 层的系统性工程。

## 定义端侧韧性：三个核心维度

容灾架构在服务端已经很成熟，但端侧的复杂度不同。服务端可以通过多机房、限流、熔断来控制，端侧面对的是不可控的网络环境、碎片化的设备、以及随时可能被系统杀死的进程。

我把端侧韧性拆成三个维度：

- **可恢复性（Recoverability）**：请求失败后能否自动恢复，不依赖用户操作
- **可降级性（Degradability）**：核心链路中断时，非核心能力能否平稳降级
- **可观测性（Observability）**：用户端的异常能否被量化追踪，而非仅靠用户反馈

优先级是递进的——可恢复性是基础，可降级性是进阶，可观测性是持续优化的保障。

## 网络层：指数退避 + 条件重试

网络超时是最常见的故障场景。一个常见的误区是把 OkHttp 的 `retryOnConnectionFailure` 打开就以为完事了。实际上，这个参数只处理连接失败，对 DNS 解析超时、SSL 握手超时、或者服务端返回的 5xx 状态码完全无效。

我设计了一个条件重试拦截器，核心逻辑如下：

```kotlin
class ConditionalRetryInterceptor(
    private val maxRetries: Int = 3,
    private val initialDelayMs: Long = 1000L
) : Interceptor {
    
    // 只对幂等请求和特定状态码重试
    private val retryableMethods = setOf("GET", "HEAD", "OPTIONS")
    private val retryableCodes = setOf(502, 503, 504)

    override fun intercept(chain: Interceptor.Chain): Response {
        var lastException: Exception? = null
        var delayMs = initialDelayMs

        for (attempt in 0..maxRetries) {
            try {
                val request = chain.request()
                val response = chain.proceed(request)
                
                // 非重试场景直接返回
                if (response.isSuccessful || 
                    request.method !in retryableMethods ||
                    response.code !in retryableCodes) {
                    return response
                }
                response.close()
            } catch (e: IOException) {
                lastException = e
                if (e is SocketTimeoutException || e is UnknownHostException) {
                    // 可恢复的网络异常，继续重试
                } else {
                    throw e // 不可恢复异常直接抛出
                }
            }
            if (attempt < maxRetries) {
                Thread.sleep(delayMs)
                delayMs *= 2 // 指数退避
            }
        }
        throw lastException ?: IOException("Max retries exceeded")
    }
}
```

这里涉及三个关键决策：

1. **只重试幂等方法**：POST 请求重试可能导致重复下单，只让 GET/HEAD/OPTIONS 参与重试
2. **指数退避而非固定间隔**：第 1 次等 1 秒，第 2 次 2 秒，第 3 次 4 秒，避免瞬时流量冲击服务端
3. **区分可恢复异常**：`SocketTimeoutException` 和 `UnknownHostException` 在网络恢复后通常可重试成功，但 `SSLHandshakeException` 重试多少次都没用

踩过的一个坑是：重试期间没有限制并发。某个接口故障时，大量请求堆积重试，直接把线程池打满，导致正常接口也无法响应。后续加了并发重试上限和断路器逻辑才解决。

## 数据层：三级缓存兜底策略

网络层重试依赖一个前提：服务端还能恢复。如果服务端彻底挂了，或者用户完全离线，就需要本地缓存兜底。

我采用的不是简单的"先查缓存再请求"，而是一个三级降级链：

```
内存缓存 (LruCache) → DataStore/MMKV → Room/SQLite → 空状态/占位数据
```

每一级的切换条件不同：

### 内存缓存：最短路径

```kotlin
class MemoryFallback<T>(
    private val maxSize: Int = 50,
    private val expireMs: Long = 60_000L  // 1分钟过期
) {
    private val cache = object : LruCache<String, CacheEntry<T>>(maxSize) {
        override fun sizeOf(key: String, value: CacheEntry<T>) = 1
    }

    data class CacheEntry<T>(val data: T, val timestamp: Long = System.currentTimeMillis()) {
        val isExpired: Boolean get() = System.currentTimeMillis() - timestamp > expireMs
    }

    fun get(key: String): T? {
        val entry = cache.get(key) ?: return null
        // 过期数据在无网络时仍可用，有网络时标记为过期触发重新请求
        return entry.data
    }

    fun put(key: String, data: T) {
        cache.put(key, CacheEntry(data))
    }
}
```

内存缓存的核心策略是过期数据在离线时仍然可用。常规做法是过期即丢弃，但容灾场景下，一份过期的列表数据远比空白页面有用。

### DataStore/MMKV：持久化中间层

内存缓存在进程被杀后就丢失了。对于需要跨进程存活的场景，DataStore（取代 SharedPreferences）或 MMKV 更合适。

```kotlin
// Proto DataStore 存储结构化数据
val Context.bannerCache: DataStore<BannerList> by dataStore(
    fileName = "banner_cache.pb",
    serializer = BannerListSerializer
)

suspend fun fetchBannersWithFallback(api: ApiService): BannerList {
    return try {
        val fresh = api.getBanners()
        // 网络成功后异步更新本地缓存
        context.bannerCache.updateData { fresh }
        fresh
    } catch (e: Exception) {
        // 失败时读取 DataStore 缓存
        context.bannerCache.data.firstOrNull() ?: BannerList.getDefault()
    }
}
```

选 DataStore 而不是 Room 的原因是：Banner、配置项这类数据规模小、结构简单，DataStore 的异步读取和协程支持更自然。Room 留给需要查询能力的大数据集。

### Room：结构化查询的最后防线

商品列表、用户信息这类需要条件查询的数据，靠 Room 兜底。

```kotlin
@Dao
interface ProductDao {
    @Query("SELECT * FROM products WHERE category = :category ORDER BY updateTime DESC LIMIT :limit")
    suspend fun getByCategory(category: String, limit: Int = 20): List<ProductEntity>

    @Transaction
    suspend fun syncFromRemote(remote: List<Product>) {
        // 先标记旧数据，再插入新数据，最后清理
        val ids = remote.map {
            upsert(it.toEntity(timestamp = System.currentTimeMillis()))
        }
        deleteStaleExcept(ids = ids, timestamp = System.currentTimeMillis() - 7 * 24 * 3600_000L)
    }
}
```

容灾的关键细节在 `syncFromRemote` 的先写入后清理策略：不要在请求成功前清空旧数据。否则网络返回成功但写入失败时，数据库就是空的——缓存变成了数据黑洞。

## 策略编排：自适应降级引擎

各层有了降级能力后，还需要一个编排层来决定何时启用哪一级。硬编码 if-else 是最简单的方式，但用策略模式更可持续：

```kotlin
enum class AppState { ONLINE, DEGRADED, OFFLINE }

class ResilienceOrchestrator(
    private val connectivityManager: ConnectivityManager
) {
    private val consecutiveFailures = AtomicInteger(0)

    fun evaluateState(): AppState {
        val network = connectivityManager.getNetworkCapabilities(
            connectivityManager.activeNetwork
        )
        
        if (network == null) return AppState.OFFLINE

        return when {
            consecutiveFailures.get() >= 5 -> AppState.OFFLINE  // 断路
            consecutiveFailures.get() >= 3 -> AppState.DEGRADED // 部分降级
            else -> AppState.ONLINE
        }
    }

    fun onRequestSuccess() { consecutiveFailures.set(0) }
    fun onRequestFailure() { consecutiveFailures.incrementAndGet() }
}
```

这个引擎产出的状态由 UI 层消费——DEGRADED 模式下关闭实时刷新、缩小图片尺寸、隐藏非必要模块。断路器的思路借用了服务端的设计，但在端侧有特殊价值：避免持续重试耗尽电量和用户流量。

## 实践要点

缓存治理优先于缓存引入。我的原则很简单：每条缓存数据必须有明确的过期策略和清理逻辑。没有过期时间的缓存不是缓存，是数据债。

降级不等于凑合。空状态页面要告诉用户发生了什么，而不是静默显示旧数据或空白。我们设计了一套统一的降级 UI 组件：

```kotlin
@Composable
fun DegradedContent(
    state: AppState,
    data: Any?,
    onRetry: () -> Unit
) {
    when (state) {
        AppState.OFFLINE -> {
            if (data != null) {
                NormalContent(data, banner = "你正在查看离线数据")
            } else {
                EmptyState("暂无数据，请检查网络后重试")
            }
        }
        AppState.DEGRADED -> {
            NormalContent(data, banner = "网络不稳定，部分功能受限")
            // 隐藏实时排行榜等非核心模块
        }
        AppState.ONLINE -> NormalContent(data)
    }
}
```

可观测性是容灾的闭环。我们在 Firebase 上埋了三个关键指标：降级触发率、降级页面停留时长、手动刷新率。有了这些数据，才能判断容灾策略是帮了用户还是掩盖了问题。

最后一点经验：容灾架构的测试比建设更难。服务端的混沌工程已经成熟，但端侧模拟弱网、磁盘满、进程被杀仍然依赖手动操作。目前我们通过 `adb shell svc wifi enable/disable` 和 `adb shell am kill` 组合做半自动化验证，但每次发版前的回归成本不低。

容灾不是一个功能，而是一种架构习惯。每接入一个数据源时，问自己一句：如果这个数据永远拿不到了，用户看到的是什么？
