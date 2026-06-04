---
title: Native/H5 路由灰度切换：用 RedirectRouterInterceptor 实现零风险页面迁移
excerpt: 同一入口存在 Native 和 H5 两种实现时，如何在路由层安全地灰度切换？本文介绍 RedirectRouterInterceptor 的通用设计，通过远程配置控制落点，配合稳定散列、参数映射、兜底策略和结构化监控，让 Native 新页面平滑上线，异常时快速回滚。
publishDate: '2026-06-04'
tags:
- Android
- 路由
- 灰度发布
- H5
- 架构设计
seo:
  title: Native/H5 路由灰度切换：用 RedirectRouterInterceptor 实现零风险页面迁移
  description: 在路由层使用 RedirectRouterInterceptor 实现 Native/H5 灰度切换，通过远程配置控制落点，配合稳定散列、参数映射、兜底策略和结构化监控，让页面迁移平滑且可回滚。
---

移动端页面通常会经历多个实现阶段。早期验证需求时，H5 可以快速上线；当页面访问量变大、交互复杂或需要更多端能力时，Native 改造能提供更好的性能。但 Native 和 H5 往往不会一次性完成切换，而是需要长期共存。一个活动入口可能先由 H5 承接，后续逐步迁移到 Native；一个新 Native 页面上线后，也需要先放少量用户灰度，观察崩溃率、加载耗时、转化指标，再逐步扩大范围。

如果这些切换逻辑散落在各个入口处，维护成本会很高。每个页面都写一套判断，会导致规则重复、口径不一致、回滚不及时。更好的方式是在路由链路里放置统一拦截器：所有路由请求先进入标准解析流程，再由 RedirectRouterInterceptor 查询配置并决定是否改写目标。

## 路由拦截器作为业务迁移网关

在实际项目中，路由治理集中在 `business/router` 目录下。`RouterHub.java` 负责把 App、Module、Detail、Home、User、WebContainer 等模块的 host/path 统一收口；`BusinessHandlerImpl.kt` 负责处理国家化 scheme、H5 channel 判断、URL 补全、登录态参数附加；`RedirectRouterInterceptor.java` 则是 Native/H5 灰度切换的关键落点。

这个拦截器里有几类非常有代表性的迁移场景：旧首页路由重定向到新首页；旧详情页路由重定向到新详情页；类目页、活动页根据远程配置决定走 Native 还是 Web 容器；新详情页在实验开关关闭时还能回退到旧 H5 链路。它不是在页面内部做选择，而是在路由阶段完成落点决策，这样所有入口——push、短链、H5 回跳、内容卡片点击、活动入口——都能走同一套规则。

更重要的是，它保留了 `originUrl`、Bundle 参数、afterAction，并能继续交给 `RouterManager.navigate`。这让灰度切换同时具备三个能力：URL 参数不丢、Native/H5 可双向回退、远程配置能即时止损。

## 核心设计：从拦截到执行

路由链路可以抽象为多个拦截器串行处理。RedirectRouterInterceptor 只负责一件事：在路由真正执行前，根据规则判断是否需要改写目标。

```kotlin
data class RouteRequest(
    val source: String,
    val path: String,
    val params: Map<String, String>,
    val extras: Map<String, Any> = emptyMap()
)

data class RouteTarget(
    val type: TargetType,  // NATIVE 或 H5
    val path: String,
    val params: Map<String, String>
)
```

远程配置用规则列表表达，每条规则包含匹配条件和重定向目标：

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

灰度命中使用稳定散列，而不是每次随机。否则同一个用户可能这次进 Native、下次进 H5，体验和问题排查都会变差：

```kotlin
class StableGrayMatcher {
    fun hit(rule: GrayRule, request: RouteRequest): Boolean {
        val key = request.params["userKey"] ?: request.source
        val bucket = hash("${rule.id}:$key") % 100
        return bucket < rule.grayPercent
    }
}
```

参数映射是另一个核心点。Native 和 H5 的参数要求不同，不能简单把原始 query 全量透传。可以为每个可灰度路由定义参数 schema，只允许白名单参数通过：

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

## 兜底必须避免递归循环

当 Native 打开失败时，执行器应根据规则兜底到 H5 或原始路由。但兜底容易产生循环：Native 失败后回 H5，H5 规则又命中回 Native。可以在 request extras 中记录 redirect depth 或 consumed rule id，超过阈值直接走默认落点。

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

## 三端能力对等后的职责变化

还有一个更深的背景：业务不是单端形态，而是三端长期并行且能力逐步对等。Android、iOS、Web/H5 都能承接同一类页面能力，都能接入统一配置、统一埋点、统一登录态。能力对等以后，路由层的职责就发生了变化：它不再只是"打开一个 Activity 或一个 WebView"，而是在多个等价承载端之间做动态调度。

这也是为什么灰度逻辑不能散落在页面里。路由层变成"端能力选择器"，它需要理解页面能力编号、端能力版本、远程开关、实验分组、原始 URL 和结构化参数之间的映射关系。业务入口只表达"我要打开某个能力"，而不关心最终由哪个端实现承接。

## 落地中的关键约束

远程配置要有本地默认值。首次安装、弱网启动、配置服务异常时，路由层不能依赖实时拉取。默认值通常应选择最稳定落点，并支持强制关闭灰度。

参数白名单非常重要。不要把原始参数无脑透传给 H5，也不要让 H5 专用参数污染 Native。对于跳转 URL、回调地址、脚本片段等高风险字段，应进行协议、域名、长度和编码校验。

兜底不等于静默吞错。用户可以被平滑带到稳定页面，但监控必须记录原始失败。否则灰度看似正常，实际大量请求已经在兜底，问题会被掩盖。

---

Native/H5 路由灰度切换的核心，是把发布选择放到统一路由层，而不是散落在各个业务入口。一个可靠的方案不仅要能"切"，还要能"稳"：稳定散列保证用户体验一致，参数 schema 保证数据边界清晰，兜底策略保证异常时可用，结构化监控保证灰度过程可评估。只有这些能力同时存在，Native/H5 共存才不会变成长期混乱，而会成为可治理的发布机制。