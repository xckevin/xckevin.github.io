---
title: "Android Feature Flags and Gradual Rollouts"
lang: en
translationKey: android-feature-flags-gradual-rollout
slug: android-feature-flags-gradual-rollout
excerpt: "A practical Android feature flag architecture covering remote config, local cache, hash buckets, staged rollout, kill switches, sticky enrollment, and Firebase tradeoffs."
publishDate: '2025-05-30'
tags:
- "Android"
- "Kotlin"
- "Feature Flags"
- "Gradual Rollout"
- "A/B Testing"
seo:
  title: "Android Feature Flags: Remote Config, Rollouts, and Experiment Buckets"
  description: "Design Android feature flags with remote config, hash buckets, staged rollout, sticky enrollment, kill switches, and Firebase Remote Config tradeoffs."
  pageType: article
---

Last year, while rebuilding the home page of an ecommerce app, the PM asked for a simple rollout: enable the new home page for 5% of users, observe the data for three days, then ramp to everyone. I configured a conditional parameter in Firebase Remote Config. On rollout day, some users lost the config after switching networks, fell back to the old home page, and made the metrics impossible to reconcile.

That was the point where I decided to build our own flag system.

## Firebase Remote Config is useful, but not always enough

Firebase Remote Config (FRC) has obvious strengths: it is free, requires no deployment, and gives you condition rules out of the box. But after deeper production use, several problems tend to pile up.

**Cache freshness is hard to control.** FRC caches values for 12 hours by default. You can tune this, but the minimum is still five minutes. For an emergency kill switch, five minutes is enough time for a production incident to spread. `fetchAndActivate()` also depends on app lifecycle timing, which is especially unreliable during cold start.

**Condition rules are limited.** FRC supports targeting by app version, region, and user properties. But if you need a compound rule like "new users who were active in the last seven days and have not paid," you end up composing logic above FRC. As rules grow, maintenance gets ugly.

**Experiment measurement is rough.** FRC's built-in A/B Testing can compare predefined Firebase Analytics events, but it does not support variance analysis or confidence calculations for custom metrics. Data teams usually will not accept those results as experiment evidence.

FRC is good for "delivering config." It is not necessarily a complete "feature flag system." The difference is real-time control and decision complexity.

## A three-layer custom flag architecture

The flag system I designed has three layers:

```text
+---------------------------------+
| Business layer: @FeatureFlag    |
+---------------------------------+
| Engine layer: routing + rules   |
+---------------------------------+
| Data layer: local cache + fetch |
+---------------------------------+
```

The **data layer** fetches and caches configuration. Config is delivered from a server API, persisted locally with MMKV, and accelerated in memory with `LruCache`. A config entry looks like this:

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

Each flag carries `status`, `strategy`, and `fallback`. The structure is self-describing, and server and client share the same schema.

The **engine layer** is the core. It evaluates `strategy`, caches flag results, and handles fallback behavior. `FeatureFlagEngine` exposes two key methods:

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

The **business layer** declares flag dependencies through annotations:

```kotlin
@FeatureFlag("homepage_v2", fallback = false)
var showHomepageV2: Boolean = false
```

KSP generates the binding code at compile time. At runtime, the app reads the value associated with the annotation, so business code does not need to know how the flag system works.

## Experiment routing: from percentages to hash buckets

Simple percentage routing, such as `hash % 100 < N`, does not solve experiment isolation. When multiple experiments run in parallel, the same user may land in different experiment groups, contaminating the data.

I solve this with **hash buckets**. Preallocate 100 buckets from 0 to 99, and give each experiment an exclusive bucket range:

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

`globalSalt` is a fixed value independent of the user. It keeps the same user in the same bucket across experiments. After each experiment receives its own bucket range, a user is either in that experiment or out of it; they cannot simultaneously be in experiment A and the control group for experiment B.

## Flag lifecycle and failure fallback

A flag goes through four stages from creation to removal:

**Fully off -> staged rollout -> fully on -> harden and remove**

The rollout stage is the most important. My usual sequence is "whitelist first, then percentage": validate internally through a team whitelist, then ramp by 1%, 5%, 20%, 50%, and 100%, observing each step for at least 30 minutes.

For failure handling, the local fallback principle is: **better off than broken**. New feature flags default `fallback` to `false`. In an emergency, the server sets `status` to `killed`, and the client downgrades locally when it sees that state:

```kotlin
fun getFlag(key: String): FlagConfig? {
    val remote = remoteConfig[key]
    return when {
        remote == null -> null  // Trigger local fallback
        remote.status == "killed" -> null  // Killed remotely
        remote.expired() -> null  // TTL expired
        else -> remote
    }
}
```

One rollout trap I hit: when increasing a percentage from 5% to 10%, some already-enrolled users fell out of the experiment because the hash result changed relative to the threshold. From the user's view, the new experience suddenly reverted to the old one. The fix is sticky enrollment. Once a user first qualifies for the experiment, write a local `experiment_v1:enrolled` marker. Future checks return the experiment group directly, regardless of percentage changes, until the experiment ends or the user clears app data.

## Should you build your own?

Looking back after building this system, not every team needs a custom implementation.

If your team has fewer than 20 people, monthly active users are under one million, experiment frequency is low, and custom metric analysis is not required, Firebase Remote Config is enough. Do not over-engineer it.

But if at least two of the following are true, the investment usually pays back within six months: a dedicated data team requires confidence analysis, emergency kill switches must take effect within five minutes, or more than five experiments run in parallel.

Another easily underestimated issue is **flag governance**. After launch, the biggest problem is not technical. It is that nobody cleans up dead flags. We set two rules. First, every flag must have a TTL, defaulting to 30 days, and expiration automatically sends a cleanup reminder to the code repository. Second, after a rollout has reached 100% and stayed fully enabled for more than 14 days, a PR to remove the flag is required.

In the end, the hard part of a flag system is not "how to deliver a Boolean." It is "how to safely manage the lifecycle of hundreds or thousands of Booleans."
