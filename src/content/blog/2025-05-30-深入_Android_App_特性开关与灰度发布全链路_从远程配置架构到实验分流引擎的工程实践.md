---
title: 深入 Android App 特性开关与灰度发布全链路：从远程配置架构到实验分流引擎的工程实践
excerpt: 深入探讨 Android App 特性开关系统的自研实践，涵盖三层架构设计、哈希分桶实验分流、灰度发布全链路及容灾兜底策略，并给出自研与 Firebase Remote Config 的选型建议。
publishDate: '2025-05-30'
tags:
- Android
- Kotlin
- 特性开关
- 灰度发布
- A/B测试
seo:
  title: 深入 Android App 特性开关与灰度发布全链路：从远程配置架构到实验分流引擎的工程实践
  description: 本文分享从 Firebase Remote Config 到自研 Android 特性开关系统的工程实践，涵盖三层架构设计、哈希分桶实验分流、灰度发布流程及容灾兜底策略。
---

去年做某电商 App 的首页改版，PM 提了一个要求：新版首页先对 5% 用户放开，观察三天数据再全量。我用 Firebase Remote Config 配了一个条件参数，灰度当天就出了问题——部分用户切换网络后配置丢失，展示回了旧版，数据直接对不上。

这就是我决定自研开关系统的起点。

## Firebase Remote Config 够用，但不一定够好

Firebase Remote Config（FRC）的优势很明显：免费、零部署、条件规则拿来就用。但生产环境用深了之后，几个问题会扎堆出现。

**缓存时效不可控。** FRC 默认缓存 12 小时，虽然能调，但最小值也有 5 分钟。对于需要紧急下线的功能开关，5 分钟足够让线上炸一轮。`fetchAndActivate()` 拉配置的时机依赖 App 生命周期，冷启动场景尤其不可靠。

**条件规则有限。** FRC 支持按版本、地区、用户属性分流，但如果你要做「新用户且近 7 天活跃且未付费」这种复合条件，只能在上层拼凑，规则一多就不可维护。

**实验测量粗糙。** FRC 自带的 A/B Testing 只能对 Firebase Analytics 的预置事件做对比，自定义指标的方差分析和置信度计算完全不支持，数据团队根本不认这个结果。

FRC 适合「配置下发」，不适合做「开关系统」——两者的核心差异在于实时性要求和决策复杂度。

## 自研开关系统的三层架构

我设计的开关系统分三层：

```
┌─────────────────────────────────┐
│  业务层：@FeatureFlag 注解       │
├─────────────────────────────────┤
│  引擎层：分流 + 策略评估         │
├─────────────────────────────────┤
│  数据层：本地缓存 + 配置拉取     │
└─────────────────────────────────┘
```

**数据层**负责拉取和缓存。配置从服务端 API 下发，本地用 MMKV 做持久化，内存缓存用 LruCache 做热数据加速。配置格式如下：

```json
{
  "flag_key": "homepage_v2",
  "status": "staged_rollout",
  "strategy": {
    "type": "percentage",
    "value": 5,
    "salt": "user_id"
  },
  "fallback": false
}
```

每条开关携带 `status`（状态）、`strategy`（分流策略）和 `fallback`（本地兜底值），结构自描述，服务端和客户端共用同一份 Schema。

**引擎层**是核心，负责根据 `strategy` 做分流计算、缓存开关结果、处理兜底逻辑。`FeatureFlagEngine` 暴露两个关键方法：

```kotlin
class FeatureFlagEngine(
    private val configRepo: ConfigRepository,
    private val tracker: ExperimentTracker
) {
    fun isEnabled(key: String, userId: String): Boolean {
        val flag = configRepo.getFlag(key) ?: return localFallback(key)
        return when (flag.strategy.type) {
            "percentage" -> evaluatePercentage(flag, userId)
            "whitelist"  -> flag.strategy.whitelist.contains(userId)
            "condition"  -> evaluateCondition(flag, userId)
            else         -> flag.strategy.defaultValue
        }
    }

    private fun evaluatePercentage(flag: FlagConfig, userId: String): Boolean {
        val hash = MurmurHash3.hash32("$userId:${flag.key}")
        return (hash % 100) < flag.strategy.value
    }
}
```

**业务层**通过注解声明依赖的开关：

```kotlin
@FeatureFlag("homepage_v2", fallback = false)
var showHomepageV2: Boolean = false
```

编译期用 KSP 生成代码，运行时读取注解绑定的值，业务代码零感知。

## 实验分流：从百分比到哈希分桶

简单的百分比分流（`hash % 100 < N`）解决不了实验隔离问题。多个实验并行时，同一用户可能被分到不同实验组，数据交叉污染。

我用**哈希分桶**解决这个问题。预分配 0-99 共 100 个桶，每个实验独占一个桶区间：

```kotlin
data class BucketStrategy(
    val experimentId: String,
    val startBucket: Int,
    val endBucket: Int  // inclusive
)

fun assignBucket(userId: String): Int {
    return MurmurHash3.hash32("$userId:$globalSalt") % 100
}
```

`globalSalt` 是跟用户无关的固定值，保证同一用户在不同实验间桶位一致。每个实验分配独立桶区间后，同一用户要么进实验组、要么不进，不存在「既在实验 A 又在实验 B 对照组」的情况。

## 开关生命周期与容灾兜底

一个开关从创建到销毁经历四个阶段：

**全量关闭 → 灰度放量 → 全量开启 → 固化移除**

灰度阶段最关键。我的做法是「先白名单、再百分比」：先在团队内部白名单验证，确认无回归后按 1%→5%→20%→50%→100% 逐级放量，每级观察至少 30 分钟。

容灾方面，本地兜底值的设计原则是：**宁可关、不可炸**。新功能开关的 `fallback` 默认 `false`，紧急情况下服务端直接把 `status` 置为 `killed`，客户端发现这个状态后就地降级：

```kotlin
fun getFlag(key: String): FlagConfig? {
    val remote = remoteConfig[key]
    return when {
        remote == null -> null  // 触发本地兜底
        remote.status == "killed" -> null  // 已被 kill
        remote.expired() -> null  // TTL 过期
        else -> remote
    }
}
```

灰度过程中踩过一个坑：百分比从 5% 调到 10% 的瞬间，部分已命中用户会因为哈希结果变化而掉出实验组，体验上就是「新版看着看着变回了旧版」。解决方案是给百分比增加粘性控制——用户首次命中实验后，本地记录 `experiment_v1:enrolled` 标记，后续查询直接返回实验组，不受比例调整影响，直到实验结束或用户清除数据。

## 要不要自研？我的判断

做了这个系统后回头看，并不是所有团队都需要自研。

如果你的场景是：团队小于 20 人、月活百万以内、实验频率低、不需要自定义指标分析——Firebase Remote Config 完全够用，不要过度设计。

但如果满足以下三个条件中的两个：有专职数据团队要求置信度分析、需要 5 分钟内生效的紧急 kill switch、实验并行数量超过 5 个——自研的投入会在半年内收回成本。

还有一个容易被低估的问题：**开关治理。** 系统上线后最大的坑不是技术，而是没人清理死开关。我们定了两个规则：每个开关必须绑定 TTL（默认 30 天），到期自动发送清理提醒到代码仓库；灰度结束并全量开启超过 14 天的开关，强制提交移除开关的代码 PR。

说到底，开关系统的难点不在「怎么下发一个 Boolean」，而在「怎么安全地管理成百上千个 Boolean 的生命周期」。
