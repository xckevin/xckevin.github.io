---
title: "Route Prefetching and Request Merging for Faster First-Screen Data"
lang: en
translationKey: route-prefetch-request-merging-first-screen-data
slug: route-prefetch-request-merging-first-screen-data
excerpt: "Page speed depends not only on API latency, but also on whether requests start early enough and whether duplicate calls are suppressed. This article combines PrefetchRouterInterceptor at the routing layer with MergeHolder at the network layer."
publishDate: '2026-06-04'
tags:
- "Android"
- "Routing"
- "Performance Optimization"
- "Network Optimization"
- "Cache Strategy"
seo:
  title: "Android Route Prefetching and Request Merging"
  description: "Use PrefetchRouterInterceptor and MergeHolder to start first-screen requests earlier and merge duplicate calls across key page types."
  pageType: article
---

When a user clicks an entry point, the router parses the request, the page instance is created, initial components mount, and *then* data requests are triggered. There are often visible gaps in that lifecycle. If we wait until a detail page's `ViewModel` is initialized before making the request, we may lose tens or even hundreds of milliseconds. State pages, search results, and Web containers follow similar patterns: navigation parameters usually already contain the search query, landing URL, or business identifier, which means we can often prepare data earlier.

The routing layer naturally sits between "user intent" and "page execution." It can see the destination and parameters without intruding on page implementation. Attaching prefetching to a router interceptor gives us a single place to manage prefetch rules, feature toggles, A/B testing, analytics, and parameter validation. It also decouples prefetching from actual navigation: if navigation fails, the task can be canceled or allowed to expire naturally.

Prefetching also introduces a new problem: the page itself will still make requests, and other components may make the same requests concurrently. Without request merging, prefetching can increase concurrency pressure instead of improving performance. Router prefetching and request merging should therefore be treated as one pipeline: one starts likely requests earlier, and the other absorbs duplicate calls.

## Gaining "Head Start" at the Routing Stage

In real-world projects, prefetching isn't scattered across every Activity; it's centralized within the `PrefetchRouterInterceptor`. This interceptor covers several high-value page types: detail pages, activity/category lists, state pages, text search, and Web containers.

Detail page prefetching extracts content IDs, preview times, experiment statuses, and other details from the route parameters, then selects the appropriate domain API based on experiment flags. If the route carries a video preloading address, it will also pre-warm the video resource. State page prefetching is more conservative: it won't re-prefetch if the page already exists, otherwise, it only prefetches the initial segment of data. Search and category pages are handled by dedicated helpers, and the Web container uses a general prewarming utility. The interceptor itself doesn't handle complex business logic; it acts as a "route identifier + strategy dispatcher."

```kotlin
data class RouteContext(
    val target: String,
    val params: Map<String, String>,
    val userKey: String?,
    val network: NetworkState,
    val routeSessionId: String
)

interface PrefetchRule {
    fun match(context: RouteContext): Boolean
    fun buildTask(context: RouteContext): PrefetchTask?
}

class PrefetchRouterInterceptor(
    private val rules: List<PrefetchRule>,
    private val scheduler: PrefetchScheduler
) : RouterInterceptor {

    override fun intercept(request: RouteRequest, chain: RouterChain): RouteResult {
        val context = request.toRouteContext()
        rules.firstOrNull { rule -> rule.match(context) }
            ?.buildTask(context)
            ?.let { task ->
                scheduler.submit(
                    task = task,
                    priority = Priority.LOW,
                    owner = context.routeSessionId
                )
            }
        return chain.proceed(request)
    }
}
```

## Prefetch Rules: Restraint is More Important Than Aggression

More prefetching isn't always better; incorrect prefetching wastes bandwidth, battery, and server resources. Rule design must satisfy three conditions: stable and early navigation parameters, high proportion of first-screen APIs, and low probability of user cancellation.

Using the detail page as an example, the rule only cares about the minimum necessary parameters:

```kotlin
class DetailPrefetchRule : PrefetchRule {
    override fun match(context: RouteContext): Boolean {
        return context.target == "product_detail" &&
            context.params["item_id"].isNullOrBlank().not() &&
            context.network.canPrefetch
    }

    override fun buildTask(context: RouteContext): PrefetchTask {
        val itemId = context.params.getValue("item_id")
        val cacheKey = PrefetchKey(
            scene = "detail_first_screen",
            identity = itemId,
            userKey = context.userKey
        )
        return PrefetchTask(
            key = cacheKey,
            ttlMillis = 15_000,
            request = { DataSource.fetchDetailFirstScreen(itemId) }
        )
    }
}
```

Web container prefetching requires extra filtering for sensitive parameters to prevent using one-time credentials or authorization URLs as reusable cache objects:

```kotlin
class WebContainerPrefetchRule : PrefetchRule {
    override fun match(context: RouteContext): Boolean {
        val url = context.params["target_url"] ?: return false
        return context.target == "web_container" &&
            UrlPolicy.isPublicCacheable(url) &&
            !UrlPolicy.containsOneTimeCredential(url)
    }
}
```

## Request Merging: Making Prefetch Truly Transparent Acceleration

Prefetch requests, page first-screen requests, and component refresh requests might hit the same API within a very short timeframe. If they are sent independently, it increases server load and client queue pressure; if they are merged too aggressively, they might pass incorrect or user-state data to other callers that shouldn't receive it.

The merging layer must simultaneously check for HTTP success, business code success, consistent request context, API idempotency, and complete parameters. We implemented a `ResponseJudge` to standardize the rule for "shareability":

```kotlin
class RequestMergeInterceptor(
    private val inFlight: InFlightRequestPool,
    private val responseJudge: ResponseJudge
) : NetworkInterceptor {

    override fun intercept(chain: NetworkChain): NetworkResponse {
        val request = chain.request()
        if (!request.isIdempotent || request.hasSideEffect) {
            return chain.proceed(request)
        }
        val key = request.toMergeKey()
        return inFlight.awaitOrStart(key) {
            val response = chain.proceed(request)
            if (responseJudge.canShare(response)) response
            else throw NonShareableResponse(response)
        }
    }
}

class ResponseJudge {
    fun canShare(response: NetworkResponse): Boolean {
        if (!response.httpSuccess) return false
        val body = response.parseAsEnvelopeOrNull() ?: return response.bodyIsEmpty
        return body.businessSuccess
    }
}
```

HTTP success is only the first layer; business success is the second. Only when both layers pass is it safe to share results between prefetch requests and page requests.

## How Landing Pages Consume Prefetched Results

The page data layer only needs to add an entry point that prioritizes reading prefetch results, without caring whether the data came from prefetching or was initiated locally:

```kotlin
class DetailRepository(
    private val prefetchStore: PrefetchStore,
    private val remote: DetailRemoteDataSource
) {
    suspend fun loadFirstScreen(itemId: String, userKey: String?): DetailData {
        val key = PrefetchKey("detail_first_screen", itemId, userKey)
        prefetchStore.takeIfFresh<DetailData>(key)?.let { cached ->
            Metrics.markPrefetchHit(key)
            return cached
        }
        Metrics.markPrefetchMiss(key)
        return remote.fetchFirstScreen(itemId)
    }
}
```

This keeps the page logic consistent; prefetching is just a transparent acceleration path. The prefetching layer is responsible for generating "earlier requests," and the merging layer is responsible for absorbing "later, redundant requests." If the page request arrives at the network layer before the prefetch, the prefetch can conversely reuse the page request. As long as the request signature matches, the order of initiation doesn't matter.

## Key Constraints in Practice

The cache key must be sufficiently complete. Using only the page name as a key is dangerous; it must include at least the target type, core parameters, user context, and request version. It is better to miss than to hit incorrectly.

TTL must be short. Router prefetching deals with data that is "potentially needed immediately," not general cache data. For most scenarios, TTL can be designed in seconds, and the data should be removed from the prefetch cache after the page consumes it to prevent misuse by subsequent pages.

Pages must not depend on prefetch success. Prefetching is merely an acceleration path, not the source of data truth. Pages must retain full loading, error, retry, and empty state handling. This ensures that if the prefetch toggle, A/B testing, or fallback logic changes, the page functionality remains intact.

---

`PrefetchRouterInterceptor` turns deterministic routing intent into an early network task. It should not replace page data loading or contain complex business decisions; it should act as a performance coordination point close to navigation. The goal is not to prefetch every page, but to build a controllable mechanism: configurable rules, cancellable tasks, isolated results, expiring caches, and measurable benefits. A mature prefetching system is not "the earlier the request, the better." It is "prefetch only when value is likely, and fail without affecting the user."
