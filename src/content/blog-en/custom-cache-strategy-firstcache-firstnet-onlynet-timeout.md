---
title: "Custom Android Cache Strategies: FirstCache, FirstNet, OnlyNet, and Timeout"
lang: en
translationKey: custom-cache-strategy-firstcache-firstnet-onlynet-timeout
slug: custom-cache-strategy-firstcache-firstnet-onlynet-timeout
excerpt: "Cache strategy is more than choosing whether to read cache or network first. It affects screen speed, weak-network behavior, data consistency, and code complexity. This article presents a unified strategy enum, CacheManager layer, and Flow-based state model."
publishDate: '2026-06-04'
tags:
- "Android"
- "Cache Strategy"
- "Kotlin"
- "Flow"
- "Architecture"
seo:
  title: "Custom Android Cache Strategies with FirstCache and FirstNet"
  description: "Build a custom Android cache strategy system with FirstCache, FirstNet, OnlyNet, Timeout, CacheManager read/write operations, and Flow-based state delivery."
  pageType: article
---

Mobile screens have several common data-loading needs. They should load quickly, ideally showing existing local data first. Pull-to-refresh should fetch the latest result. Under weak network conditions, the screen should not remain blank forever. If an API call fails, stale-but-usable data is often better than nothing. At the same time, some scenarios require strong consistency and must not use cache at all. Without a unified strategy, every feature implements its own flow: a list screen checks the database before calling the API, a detail screen fetches directly from the network, a settings screen reads memory cache, and a search screen caches nothing. This flexibility is convenient at first, but over time it creates inconsistent cache keys, scattered expiration rules, different error handling, and hard-to-unify refresh states.

In our project, caching is centralized in `common/cache` instead of being implemented as ad hoc `SharedPreferences` logic in individual pages. The structure is layered: `cache` provides in-memory and disk LRU storage, `core` provides `CacheManager` and read/write primitives, `strategy` defines policies, and `ktx` and `rxjava` provide adapters for Flow and RxJava consumers. Legacy modules still use RxJava heavily, while newer feature modules use Flow and coroutines. Supporting only one async model would force product code to rewrite itself, so the cache strategy remains domain-agnostic and exposes helpers for different consumers.

## Strategy Enums: Making Intent Explicit

Many pieces of code only have a `useCache` boolean, but "using cache" can represent vastly different behaviors. We defined five strategies:

- **FirstCache**: Prioritize reading from cache. If cache exists, emit the cached data first, then initiate a network refresh. Suitable for scenarios like home screens, lists, or channel feeds where users can tolerate slightly stale data.
- **FirstNet**: Prioritize network requests. If the network succeeds, write to cache and return new data; if the network fails and fallback is allowed, return available cache data and mark it as stale. Suitable for scenarios like detail page refreshes or configuration updates where the freshest data is critical.
- **OnlyNet**: Request from the network only; neither read nor write to cache. Suitable for scenarios requiring strong consistency, one-time submissions, or status confirmations.
- **OnlyCache**: Read from cache only; no network requests are made. Suitable for offline modes, previews, or reading local configurations during startup.
- **Timeout**: The network request has a short waiting window. If the network returns within this window, use the network result; if it times out but local cache exists, return the cache first, while the network request continues in the background to update the cache. Suitable for scenarios sensitive to initial load time but requiring eventual consistency.

## Using LoadState to Express Process, Not Just a Single Result

Cache loading is not a single action; it's a process. Using `FirstCache` as an example, the flow might first emit `Loading(source=cache)`, followed by `Success(source=cache, stale=true)`, then `Loading(source=network, refreshing=true)`, and finally `Success(source=network)`.

A unified `LoadState` simplifies the UI layer:

```kotlin
sealed class LoadState<out T> {
    data class Loading(val source: String, val refreshing: Boolean) : LoadState<Nothing>()
    data class Success<T>(val data: T, val source: String, val stale: Boolean) : LoadState<T>()
    data class Error(val message: String, val source: String, val hasFallback: Boolean) : LoadState<Nothing>()
}
```

The page only renders based on the state: show a skeleton screen on initial `Loading`; display content with a refresh indicator if cache data is present; show a subtle hint if the network fails but old data exists; and display an error page if no data is available at all.

## CacheManager Only Manages Cache Facts

`CacheManager` should not know about page business logic, nor should it dictate the UI. It is responsible for basic operations: key generation, reading entries, checking expiration, writing entries, deleting entries, and cleaning namespaces. The key generator is crucial, composed of `namespace`, `resourceName`, `userScope`, `locale`, and `paramsHash`. It should never use the full URL or sensitive parameters directly as the key:

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

## Repository Composes Cache and Network

The Repository is the policy execution layer. It accepts a `CachePolicy`, `CacheKey`, and a network request function, returning `Flow<LoadState<T>>`. This way, the business logic only needs to declare "how this resource should be fetched," without manually writing the entire sequence of reading cache, checking expiration, requesting network, writing cache, and handling fallbacks.

Using `Timeout` strategy as an example, the core focus is the initial screen window, not canceling the refresh.

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

## Pitfalls in Implementation

Do not embed business logic decisions into `CacheManager`. For instance, "if the business record has completed a critical flow, do not read from cache" is a business rule and belongs in the Repository or UseCase layer. `CacheManager` should only care about whether an entry exists, if it has expired, or if it can be decoded.

Cache expiration does not mean the data cannot be displayed. For many data streams or configuration settings, expiration only means "needs refreshing," not "cannot be used." You can split TTL into `softTtl` and `hardTtl`: data exceeding `softTtl` can be displayed but marked as stale, triggering a refresh; data exceeding `hardTtl` should no longer be used for primary display.

Cache cleanup must use namespaces. When a user logs out, switches languages, or changes regions, certain caches might need clearing. Without namespaces and scopes, the only option is a full clear, which impacts both user experience and performance.

`TimeoutFallback` must avoid race conditions. If the network request times out but continues writing to the cache in the background, you must ensure it doesn't overwrite newer data with older requests. This can be achieved by adding a `version` or `requestStartedAt` timestamp to `CacheEntry`.

---

The key to a custom caching strategy system is turning caching from scattered screen-level tricks into declarative, observable, and testable infrastructure. The common pitfall is bundling everything together: the screen decides whether to use cache, makes the network call, writes locally, and handles refresh and errors in one place. A stronger design lets the screen declare its *intent*, the Repository execute the *strategy*, `CacheManager` manage the *storage*, and `LoadState` express the *process*. A good caching system is not about caching everything; it is about choosing the right strategy for each type of data.
