---
title: 自研缓存策略体系：用 FirstCache/FirstNet/OnlyNet/Timeout 终结混乱的缓存代码
excerpt: 缓存策略看起来只是"先读缓存还是先请求网络"的选择，实际落地却会影响页面速度、弱网体验、数据一致性和代码复杂度。本文介绍一种自研缓存策略体系，用统一策略枚举、CacheManager 读写和 Flow 数据流封装，让页面只订阅状态，不拼装缓存细节。
publishDate: '2026-06-04'
tags:
- Android
- 缓存策略
- Kotlin
- Flow
- 架构设计
seo:
  title: 自研缓存策略体系：用 FirstCache/FirstNet/OnlyNet/Timeout 终结混乱的缓存代码
  description: 自研缓存策略体系设计，通过 FirstCache、FirstNet、OnlyNet、Timeout 等策略枚举，配合 CacheManager 统一读写和 Flow 数据流封装，让页面只订阅状态而不拼装缓存细节。
---

移动端页面对数据加载有几个典型诉求。打开页面要快，最好能先展示本地已有数据；用户下拉刷新时要尽量拿到最新结果；弱网情况下不能一直白屏；接口失败时如果有旧数据可以兜底；一些强一致场景又不能使用缓存。如果没有统一策略，每个业务会自行实现：列表页可能先查数据库再请求接口，详情页可能直接请求网络，配置页可能读内存缓存，搜索页可能完全不缓存。短期看灵活，长期看问题很多——缓存 key 规则不一致，过期时间散落在各处，错误处理口径不同，刷新状态难以统一。

我们项目里把缓存体系集中在 `common/cache` 下，不是某个页面临时写的 SharedPreferences。这里有完整分层：`cache` 包提供内存/磁盘 LRU 持有能力，`core` 包提供 CacheManager 和底层读写，`strategy` 包定义策略，`ktx` 和 `rxjava` 分别给 Flow 与 RxJava 调用方提供适配。老业务大量使用 RxJava，新领域模块开始使用 Flow/协程，缓存系统如果只支持一种异步模型，会逼迫业务重写。当前做法是让缓存策略先成为领域无关的能力，再用不同 helper 包给不同调用方。

## 策略枚举：让意图显式化

很多代码只有一个 `useCache` 布尔值，但"使用缓存"可能代表完全不同的行为。我们定义了五种策略：

- **FirstCache**：优先读缓存，缓存存在时先发射缓存数据，再发起网络刷新。适合首页、列表、频道信息等用户可接受短暂旧数据的场景。
- **FirstNet**：优先请求网络，网络成功写入缓存并返回新数据；网络失败时如果允许 fallback，返回可用缓存并标记 stale。适合详情页刷新、配置更新等需要尽量新的场景。
- **OnlyNet**：只请求网络，不读取也不写入缓存。适合强一致、一次性提交、状态确认等场景。
- **OnlyCache**：只读缓存，不发起网络请求。适合离线模式、预览、启动阶段读取本地配置等场景。
- **Timeout**：网络请求有较短等待窗口，窗口内网络返回就用网络结果，超时且本地有缓存就先返回缓存，网络请求在后台继续完成并更新缓存。适合对首屏敏感又希望最终更新的场景。

## 用 LoadState 表达过程，而不是单点结果

缓存加载不是一次性动作，而是一段过程。以 FirstCache 为例，可能先发射 `Loading(source=cache)`，随后 `Success(source=cache, stale=true)`，接着 `Loading(source=network, refreshing=true)`，最后 `Success(source=network)`。

统一 LoadState 可以让 UI 层变简单：

```kotlin
sealed class LoadState<out T> {
    data class Loading(val source: String, val refreshing: Boolean) : LoadState<Nothing>()
    data class Success<T>(val data: T, val source: String, val stale: Boolean) : LoadState<T>()
    data class Error(val message: String, val source: String, val hasFallback: Boolean) : LoadState<Nothing>()
}
```

页面只根据状态渲染：首次 Loading 显示骨架屏；有缓存数据时展示内容和刷新标记；网络失败但有旧数据时显示轻提示；完全无数据失败时显示错误页。

## CacheManager 只管理缓存事实

CacheManager 不应该知道页面业务，也不应该直接决定 UI。它负责几个基础动作：生成 key、读取条目、判断是否过期、写入条目、删除条目、清理命名空间。key 生成器是重点，由 namespace、resourceName、userScope、locale、paramsHash 组成，不直接把完整 URL 或敏感参数作为 key：

```kotlin
class CacheManager(private val store: KeyValueStore, private val clock: Clock) {
    fun <T> read(key: CacheKey, decoder: Decoder<T>): CacheEntry<T>? {
        val raw = store.get(key.toStableString()) ?: return null
        return decoder.decodeEntry(raw)
    }

    fun <T> write(key: CacheKey, entry: CacheEntry<T>, encoder: Encoder<T>) {
        val raw = encoder.encodeEntry(entry)
        store.put(key.toStableString(), raw)
    }

    fun isUsable(entry: CacheEntry<*>?): Boolean {
        return entry != null && !entry.isHardExpired(clock.now())
    }
}
```

## Repository 组合缓存与网络

Repository 是策略执行层。它接收 CachePolicy、CacheKey、网络请求函数，返回 Flow<LoadState<T>>。这样业务只需要声明"这个资源怎么取"，不需要手写读缓存、判断过期、请求网络、写缓存、异常兜底这一整套流程。

以 Timeout 策略为例，核心是首屏窗口，而不是取消刷新：

```kotlin
fun <T> loadWithTimeoutFallback(
    key: CacheKey, request: suspend () -> T, ttl: TtlConfig
): Flow<LoadState<T>> = flow {
    val cached = cacheManager.read(key, decoder)
    val networkJob = async { request() }

    val result = withTimeoutOrNull(FAST_WINDOW_MS) { networkJob.await() }

    if (result != null) {
        cacheManager.write(key, result.toEntry(ttl), encoder)
        emit(LoadState.Success(result, source = "network", stale = false))
    } else if (cacheManager.isUsable(cached)) {
        emit(LoadState.Success(cached.value, source = "cache", stale = true))
        networkJob.onSuccessInBackground { fresh ->
            cacheManager.write(key, fresh.toEntry(ttl), encoder)
        }
    } else {
        emit(LoadState.Loading(source = "network", refreshing = false))
        val fresh = networkJob.await()
        cacheManager.write(key, fresh.toEntry(ttl), encoder)
        emit(LoadState.Success(fresh, source = "network", stale = false))
    }
}
```

## 落地中的几个坑

不要把业务判断塞进 CacheManager。比如"业务记录已关键流程就不读缓存"属于业务规则，应在 Repository 或 UseCase 层声明。CacheManager 只关心条目是否存在、是否过期、是否可解析。

缓存过期不等于不能展示。对很多信息流或配置数据来说，过期只代表"需要刷新"，不代表"不能使用"。可以把 TTL 拆成 softTtl 和 hardTtl：超过 softTtl 的数据可以展示但标记 stale，并触发刷新；超过 hardTtl 的数据不再用于主展示。

缓存清理要有命名空间。用户退出登录、语言切换、地区切换、实验切换时，可能需要清理部分缓存。没有 namespace 和 scope，后续只能全量清理，体验和性能都会受影响。

TimeoutFallback 要避免竞态。网络请求超时后如果继续在后台写缓存，需要确保不会用旧请求覆盖新请求。可以在 CacheEntry 中加入 version 或 requestStartedAt。

---

自研缓存策略体系的关键，是把"缓存"从页面里的零散技巧提升为可声明、可观测、可测试的基础设施。工程上最容易踩坑的是把所有逻辑写在一起：页面既判断缓存，又发请求，又写本地，又处理刷新和错误。更稳妥的方式是让页面声明意图，让 Repository 执行策略，让 CacheManager 管理存储，让 LoadState 表达过程。好的缓存体系不是让所有数据都缓存，而是让每类数据使用合适的策略。