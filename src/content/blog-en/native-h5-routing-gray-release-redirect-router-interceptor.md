---
title: "Native/Web Route Rollouts: Low-Risk Page Migration with RedirectRouterInterceptor"
lang: en
translationKey: native-h5-routing-gray-release-redirect-router-interceptor
slug: native-h5-routing-gray-release-redirect-router-interceptor
excerpt: "When the same entry point has both Native and Web/H5 implementations, a route-level staged rollout is often the safest migration layer. This article explains how RedirectRouterInterceptor uses remote config, stable hashing, parameter mapping, fallback behavior, and structured monitoring to ship Native pages smoothly and roll back quickly."
publishDate: '2026-06-04'
tags:
- "Android"
- "Routing"
- "Staged Rollout"
- "H5"
- "Architecture"
seo:
  title: "Native/Web Route Rollouts with RedirectRouterInterceptor"
  description: "Use RedirectRouterInterceptor for Native/Web staged rollouts with remote config, stable hashing, parameter mapping, fallback, and monitoring."
  pageType: article
---

Mobile pages often go through multiple implementation phases. When initially validating a feature, Web/H5 can be deployed quickly. As page traffic grows, interactions become more complex, or more native capabilities are required, a native implementation usually offers better performance and user experience. Native and Web/H5 rarely switch over all at once; they require long-term coexistence. An activity entry point might initially be handled by Web/H5 and gradually migrated to Native. Similarly, after a new native page launches, it should first be rolled out to a small subset of users so the team can monitor crash rates, loading time, and conversion metrics before expanding the rollout.

If this switching logic is scattered across entry points, maintenance cost becomes very high. Separate checks for every page lead to duplicated rules, inconsistent definitions, and slow rollback. A better approach is to place a unified interceptor in the routing pipeline: all route requests first pass through a standard parsing process, and then the `RedirectRouterInterceptor` queries configuration to decide whether the target should be rewritten.

## The Router Interceptor as a Business Migration Gateway

In real-world projects, routing control is centralized in the `business/router` directory. `RouterHub.java` is responsible for unifying host and path definitions for modules like App, Module, Detail, Home, User, and WebContainer; `BusinessHandlerImpl.kt` handles country-specific schemes, H5 channel detection, URL completion, and login-status parameters; and `RedirectRouterInterceptor.java` is the key point for Native/Web staged rollouts.

This interceptor showcases several representative migration scenarios: redirecting old home page routes to the new home page; redirecting old detail page routes to the new detail page; determining whether a category or activity page should use Native or the Web container based on remote configuration; and allowing the new detail page to fall back to the old H5 link when the experiment switch is off. The decision is made at the routing stage, not within the page itself. This ensures that all entry points—push notifications, short links, H5 callbacks, content card clicks, and activity entry points—follow the same set of rules.

More importantly, it preserves the `originUrl`, Bundle parameters, and `afterAction`, allowing them to be passed on to `RouterManager.navigate`. This gives the rollout mechanism three properties at the same time: URL parameters are not lost, Native and Web/H5 can fall back to each other, and remote configuration can be used for immediate rollback.

## Core Design: From Interception to Execution

The routing pipeline can be abstracted as multiple interceptors processing requests sequentially. `RedirectRouterInterceptor` is responsible for only one thing: determining, before the route is actually executed, whether the target needs to be rewritten based on the rules.

```kotlin
data class RouteRequest(
    val source: String,
    val path: String,
    val params: Map<String, String>,
    val extras: Map<String, Any> = emptyMap()
)

data class RouteTarget(
    val type: TargetType,  // NATIVE or H5
    val path: String,
    val params: Map<String, String>
)
```

Remote configurations are expressed as a list of rules, with each rule containing matching conditions and a redirection target:

```json
{
  "rules": [
    {
      "id": "record_detail_native_gray",
      "matchPath": "/record/detail",
      "enabled": true,
      "target": "native",
      "targetPath": "/native/record/detail",
      "grayPercent": 20,
      "minAppVersion": "5.0.0",
      "fallback": "h5"
    }
  ]
}
```

Rollout percentage uses stable hashing, not random chance. Otherwise, the same user might enter Native one time and Web/H5 the next, degrading both the experience and the ability to debug issues:

```kotlin
class StableGrayMatcher {
    fun hit(rule: GrayRule, request: RouteRequest): Boolean {
        val key = request.params["userKey"] ?: request.source
        val bucket = hash("${rule.id}:$key") % 100
        return bucket < rule.grayPercent
    }
}
```

Parameter mapping is another core point. Native and Web/H5 have different parameter requirements; you cannot simply pass all original query parameters. A parameter schema can be defined for each rollout route, allowing only whitelisted parameters through:

```kotlin
class RouteParamMapper {
    fun map(request: RouteRequest, rule: GrayRule): RouteTarget {
        val allowed = rule.allowedParams
        val mapped = allowed.associateWith { key ->
            request.params[key] ?: rule.defaultParams[key].orEmpty()
        }
        return RouteTarget(type = rule.targetType, path = rule.targetPath, params = mapped)
    }
}
```

## Fallback Must Avoid Recursive Loops

When Native fails to open, the executor should fall back to H5 or the original route based on the rules. However, fallbacks can easily create loops: Native fails and falls back to H5, and the H5 rule then redirects back to Native. You can record the redirect depth or the consumed rule ID in the request extras and, if it exceeds a threshold, proceed directly to the default target.

```kotlin
class RouteExecutor(
    private val nativeLauncher: NativeLauncher,
    private val h5Launcher: H5Launcher
) {
    fun open(target: RouteTarget, fallback: RouteTarget?): RouteResult {
        if (target.redirectDepth > MAX_REDIRECT) {
            return fallback?.let { open(it, null) } ?: RouteResult.Failed
        }
        val result = when (target.type) {
            TargetType.NATIVE -> nativeLauncher.open(target)
            TargetType.H5 -> h5Launcher.open(target)
        }
        if (result.success) return result
        return fallback?.let { open(it.copy(redirectDepth = target.redirectDepth + 1), null) }
            ?: result
    }
}
```

## Responsibility Changes After Platform Capability Parity

The broader context is that the business is not single-platform. Android, iOS, and Web/H5 run in parallel, and their capabilities gradually reach parity. All three can handle the same types of page capabilities while sharing unified configuration, tracking, and login state. Once capabilities are equivalent, the routing layer is no longer just about "opening an Activity or a WebView"; it becomes a scheduler among multiple interchangeable implementations.

This is why staged-rollout logic cannot be scattered inside pages. The routing layer becomes the "capability implementation selector"; it needs to understand the mapping between page capability IDs, implementation versions, remote switches, experiment groups, original URLs, and structured parameters. Business entry points only express "I want to open this capability," without caring which implementation ultimately hosts it.

## Key Constraints in Implementation

Remote configurations must have local default values. The routing layer cannot rely on real-time fetching during first installation, weak network startup, or configuration service failure. Default values should typically point to the most stable fallback and must support force-disabling staged rollouts.

Parameter whitelisting is crucial. Do not blindly pass all original parameters to H5, nor should H5-specific parameters pollute the Native side. For high-risk fields like redirect URLs, callback addresses, and script snippets, protocol, domain, length, and encoding validation must be performed.

Fallback does not equal silently swallowing errors. Users can be smoothly directed to a stable page, but monitoring must record the original failure. Otherwise, the rollout might appear normal, while in reality, a large volume of requests is falling back and masking the problem.

---

The core of Native/Web route rollout is placing the release decision in a unified routing layer instead of scattering it across business entry points. A reliable solution must not only be able to switch targets, but also keep the system stable: stable hashing gives users a consistent experience, parameter schemas define clear data boundaries, fallback strategies preserve availability during failures, and structured monitoring makes the rollout measurable. Only when these capabilities coexist can Native/Web coexistence become a manageable release mechanism instead of long-term routing chaos.
