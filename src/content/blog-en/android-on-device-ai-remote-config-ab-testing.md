---
title: "On-Device AI Remote Configuration and A/B Testing for Android"
lang: en
translationKey: android-on-device-ai-remote-config-ab-testing
slug: android-on-device-ai-remote-config-ab-testing
excerpt: "A production approach to lightweight remote config, deterministic on-device A/B experiments, and safe rollback for on-device AI inference."
publishDate: '2026-07-30'
tags:
- "Android"
- "On-Device AI"
- "Remote Config"
- "A/B Testing"
seo:
  title: "On-Device AI Remote Config & A/B Testing"
  description: "How to design lightweight remote configuration, deterministic A/B experiments, cross-platform hashing, and safe rollback for on-device AI inference."
  pageType: article
---

Last year, while productionizing an on-device AI inference framework, our team hit a dilemma: the model was already shipped inside the APK, but inference parameters such as thresholds, sampling strategy, and prompt templates still needed frequent tuning. Every change required a release, stretching iteration cycles to more than two weeks.

That pushed us to build an on-device remote configuration and experimentation system.

## Why On-Device Inference Needs Remote Configuration

**The model file is static, but inference behavior is dynamic.** In an on-device inference pipeline, model weights are only one variable. What actually determines output quality also includes a large number of tunable parameters:

- The temperature coefficient controls generation randomness.
- Top-K and Top-P sampling thresholds filter low-probability tokens.
- The wording of the system prompt in prompt templates can be adjusted.
- Post-processing stages have filtering thresholds and classification confidence cutoffs.

These parameters affect product experience no less than the model itself. Changing Top-P from 0.9 to 0.85 can make a conversation style go from divergent to precise. But if these values are hardcoded, changing one of them means shipping a release.

Beyond iteration speed, experiment validation is another hard requirement. Take prompt optimization as an example: among three different system prompts, which one best matches user expectations? Internal evaluation samples are limited and not objective enough, so validation must be done through traffic splitting in production.

## A Lightweight Configuration Center Design

The server side reuses the company's existing configuration center, such as Apollo or Nacos, while the on-device side focuses on encapsulating three stages: **pull, cache, and inject**.

The core data model:

```kotlin
data class InferenceConfig(
    val version: Long,
    val modelParams: ModelParams,
    val promptTemplates: Map<String, String>,
    val postProcess: PostProcessParams
)

data class ModelParams(
    val temperature: Float = 0.7f,
    val topP: Float = 0.9f,
    val topK: Int = 50,
    val maxTokens: Int = 2048
)
```

On startup, the device pulls config from the configuration center and persists it locally with MMKV for offline availability. The core mechanism is **version-driven updates**: every config change carries an incremented `version` field, and the device compares it before deciding whether to overwrite the local cache.

```kotlin
class ConfigManager(private val kv: MMKV) {
    
    fun syncConfig(remote: InferenceConfig) {
        val localVersion = kv.decodeLong(KEY_VERSION, 0L)
        if (remote.version <= localVersion) return
        
        kv.encode(KEY_VERSION, remote.version)
        kv.encode(KEY_CONFIG, Json.encodeToString(remote))
        notifyListeners(remote) // 通知推理引擎热更新
    }
    
    fun getConfig(): InferenceConfig {
        val cached = kv.decodeString(KEY_CONFIG) ?: DEFAULT_CONFIG
        return Json.decodeFromString(cached)
    }
}
```

`notifyListeners` is the key to hot updates. The inference engine holds a reference to `ConfigManager`; after a config change, it directly updates the in-memory parameter object without restarting the process.

On cold start, the locally cached config is returned before the network request completes, ensuring first-frame inference never waits on the network. This mechanism means **the local cache is the fallback strategy**: the default config must guarantee normal operation even in the worst case.

## A/B Experiment Traffic Splitting: What Makes On-Device Special

Server-side A/B experiments rely on real-time traffic splitting: requests hit the server, the user ID hash assigns an experiment group, and the server returns the corresponding config. On-device, this is impossible because the model runs locally and there is no request to anchor the split.

Our approach is **pre-splitting plus local decision-making**. The configuration center no longer sends a single config, but a collection of experiment configs:

```kotlin
data class ExperimentConfig(
    val baseConfig: InferenceConfig,           // 对照组
    val experiments: List<ExperimentGroup>     // 实验组
)

data class ExperimentGroup(
    val id: String,
    val trafficPercent: Int,    // 流量比例，0-100
    val config: InferenceConfig
)
```

When the device first loads the config, it determines which experiment group the user belongs to based on the user ID hash and a traffic-allocation algorithm, then keeps that assignment stable across subsequent sessions.

```kotlin
fun assignGroup(userId: String, groups: List<ExperimentGroup>): InferenceConfig {
    val hash = userId.hashCode().toLong() and 0x7FFFFFFF
    val bucket = (hash % 100).toInt()
    
    var accumulated = 0
    for (group in groups) {
        accumulated += group.trafficPercent
        if (bucket < accumulated) return group.config
    }
    return baseConfig // 兜底到对照组
}
```

Hash-modulo bucketing is a classic on-device experiment approach. Its advantages are **no network dependency and deterministic splitting**: the same user always computes the same bucket, so they never bounce between experiment groups.

We hit one pitfall here: initially we used `kotlin.random.Random` for splitting, and users landed in different groups on every cold start, making the experiment data completely unusable. Determinism is the first principle of on-device experiments.

## The Challenge of Consistency Across Three Platforms

On-device AI inference usually covers Android, iOS, and sometimes even PC. When distributing configs, **cross-platform hash consistency** is a hidden pitfall.

Java/Kotlin's `String.hashCode()` algorithm differs from Swift's `hashValue`, not to mention C++. Using each language's built-in hash directly would assign the same user to different experiment groups on different platforms.

The solution is a unified hash algorithm:

```kotlin
// 所有端统一使用同一哈希实现
object ConsistentHash {
    fun hash(input: String): Int {
        var h = 0
        for (c in input) {
            h = 31 * h + c.code
        }
        return h
    }
}
```

This algorithm is simple enough to hand-write in any language, keeping Android, iOS, and the backend consistent without extra effort.

Prompt template experiments are another high-frequency scenario. Prompts are text, so they change far more often than model parameters. We distribute them as a key-value structure, and the device indexes by key:

```json
{
  "prompt_templates": {
    "chat_default": "你是一个有帮助的助手...",
    "chat_exp_v2": "你是一个专业的技术顾问，回答时请...",
    "summary_short": "用一句话总结以下内容："
  }
}
```

Experiment groups reference different keys, so template content can iterate independently without changing client code.

## Safety Fallbacks and Rollback

One risk remote configuration must guard against is **a bad config taking down on-device inference directly**. For example, `maxTokens` may be mistakenly set to 0, or a prompt template may exceed the context window.

Protection has three layers.

**Layer 1: validation.** When deserializing the config, the device performs field-level legality checks. Unreasonable values are discarded and fall back to defaults.

```kotlin
fun validate(config: ModelParams): ModelParams {
    return config.copy(
        temperature = config.temperature.coerceIn(0f, 2f),
        topP = config.topP.coerceIn(0f, 1f),
        topK = config.topK.coerceIn(1, 200),
        maxTokens = config.maxTokens.coerceIn(1, 4096)
    )
}
```

**Layer 2: local fallback.** If config fetching fails or validation does not pass, immediately fall back to the last valid locally cached config. If no local config exists, use the default config bundled in the APK.

**Layer 3: remote circuit breaking.** Set up a gradual rollout window on the config platform: first push to 5% of traffic and observe the crash rate and inference failure rate, then roll out fully after confirming there are no anomalies. The device reports the config version and error codes, and the platform can roll back to the previous version with one click when something goes wrong.

These three fallback layers have run for more than half a year with only one incident: a prompt template exceeded the token limit and triggered the circuit breaker, and it was rolled back within five minutes.

## Key Tradeoffs

**We do not recommend putting the model file itself into the remote configuration system.** A quantized model is easily hundreds of MB, and incremental updates are far more complex than parameter config. For model A/B experiments, it is better to keep multiple models locally and use config to specify which file to load, rather than downloading hot updates.

**We also do not recommend overly complex on-device experiment orchestration.** Multi-layer orthogonal experiments and dynamic traffic adjustment are too costly and risky to implement on-device. Keep on-device experiments to a simple model of assign once and stay stable within the session, and leave complex orthogonal experiments to the server request path.
