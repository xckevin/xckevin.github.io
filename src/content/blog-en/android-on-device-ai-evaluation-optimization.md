---
title: "Evaluating and Optimizing On-Device AI on Android: From Offline Benchmarks to Production Experiments"
lang: en
translationKey: android-on-device-ai-evaluation-optimization
slug: android-on-device-ai-evaluation-optimization
excerpt: "A from-scratch evaluation system for on-device AI: offline benchmarks for initial filtering, production confidence-distribution monitoring, and A/B experiments to drive decisions — cutting iteration cycles from 3 weeks to 1.5."
publishDate: '2026-06-23'
tags:
- "Android"
- "On-Device AI"
- "Model Evaluation"
- "A/B Testing"
- "Performance Optimization"
seo:
  title: "On-Device AI Evaluation: Benchmarks, Monitoring & A/B Tests"
  description: "On-device AI evaluation: offline benchmarks, production confidence monitoring, and A/B experiments with Kotlin code and real pitfalls."
  pageType: article
---

Last year, while working on on-device OCR, we went through three model versions. Each time, we eyeballed a few images and shipped. During staged rollout, users reported a 3-point accuracy drop. We rolled back. In the postmortem, we realized the team had no reliable evaluation mechanism — "feels about right" was our launch bar.

Quality assurance for on-device AI is harder than server-side. The model runs on user devices; when something breaks, you cannot hot-fix it the way you would on a server, and there is no ready-made log pipeline sending data back. Plenty of teams obsess over model training and compression, then rely on manual spot-checks for evaluation. I spent over half a year building an evaluation system from scratch. The approach: **offline benchmarks for initial filtering, production experiments for validation, and a feedback loop for continuous iteration**.

## Offline Evaluation: Backing the Model Into a Corner

Engineering-side offline evaluation is not the same as academic benchmarking. It must answer three questions: how does this model perform **in my scenario**? Does it **collapse under extreme conditions**? Is it **better or worse than the current production version**? If you cannot answer all three, the offline evaluation is decorative.

### Build a Domain-Specific Dataset

Academic datasets cannot be used directly. We did mobile document scanning — a high ImageNet score meant nothing. I sampled 2,000 images uploaded by real users from production logs, covering 7 lighting conditions, 15 tilt angles, and 4 document types.

Dataset structure:

```
benchmark_dataset/
├── easy/        # flat, even lighting, expected high accuracy
├── medium/      # slight tilt, shadows, common online scenarios
├── hard/        # severe distortion, low light, blur, extreme conditions
└── ground_truth/ # labeled results for each image
```

Difficulty tiers matter. A model that gains 5% on easy but drops 10% on hard is not shippable — most online user scenarios actually land in the medium-to-hard range.

### Quantitative Metric Design

For OCR, character-level accuracy alone is not enough. I defined metrics across three dimensions:

- **Field-level accuracy**: measured per business field (name, amount, ID number) to prevent the model from excelling at one field and failing others
- **End-to-end latency**: P50/P95/P99, **measured off the main thread** — otherwise UI rendering frames pollute the data
- **Model stability**: run inference on the same image 100 times, compute output variance, detect random crashes

```kotlin
data class BenchmarkResult(
    val fieldAccuracy: Map<String, Float>,  // field-level accuracy
    val latencyP50: Long,                    // milliseconds
    val latencyP95: Long,
    val stabilityScore: Float               // 0-1, higher is more stable
)
```

### Automated Benchmark Pipeline

I wired up a Gradle task. Every time a new model file is committed, CI runs the full benchmark and generates a comparison report:

```bash
./gradlew runBenchmark \
  -PmodelPath=./models/ocr_v3.tflite \
  -PdatasetPath=./benchmark_dataset \
  -PbaselineModel=./models/ocr_v2.tflite
```

If the new model underperforms the baseline by more than 5% on any dimension, CI turns red and blocks the merge. This gate caught at least 4 regressions during later iterations.

## Online Metrics: Users Do Not Follow Your Benchmark Script

No offline evaluation reproduces the diversity of the real world. Running models on phones introduces many variables: SoC model, OS version, background processes competing for CPU, GC stalls under memory pressure, even thermal throttling when the device gets hot.

### On-Device Telemetry

The approach is **lightweight instrumentation plus sampled reporting**. Full reporting would crush user traffic and battery, so only 5% of users get detailed logging.

```kotlin
data class InferenceTrace(
    val modelVersion: String,
    val deviceInfo: DeviceInfo,       // SoC model, RAM, Android version
    val inputSize: Int,               // input image pixel count
    val preprocessMs: Long,           // preprocessing time
    val inferenceMs: Long,            // pure inference time
    val postprocessMs: Long,          // post-processing time
    val confidenceScore: Float,       // model output confidence
    val batteryTemp: Int,             // battery temperature at inference
    val isCharging: Boolean
)
```

In practice, **confidence distribution** reflects model quality better than single-inference results. If a large share of online requests clusters in the 0.5-0.6 confidence range, the model is guessing across many scenarios — even if final accuracy looks acceptable, it is being propped up by post-processing logic.

### Tiered Monitoring Dashboard

Online metrics fall into three tiers:

**L1 - Business metrics** (daily): feature success rate, user complaint rate. The most direct signal — you feel problems here immediately.

**L2 - Model quality metrics** (weekly): confidence distribution and P95 latency grouped by device model and Android version. Surfaces issues like "confidence is systematically low on Samsung S22."

**L3 - Engineering metrics** (on demand): model load failure rate, OOM rate, per-stage latency breakdown. For specific issue investigation.

A trap I hit: the initial confidence threshold was too low, letting many low-quality results through to the business layer. I later added a **dynamic threshold** — adaptively adjusting the confidence bar based on the current device performance tier and input complexity. On low-end devices, prefer no recognition over a wrong result.

## A/B Experiments: Turning Gut Calls Into Data Decisions

Offline evaluation says model A is better. The product manager thinks model B is more accurate. The argument is pointless — run an online A/B test.

### Experiment Design

A/B tests for on-device AI differ from regular feature experiments in one key way: **model distribution is constrained by package size**. You cannot bundle both models into the APK, so use **on-demand download** — when a user enters the experiment group, the corresponding model file is fetched from CDN on first use.

```kotlin
object ModelExperiment {
    fun getModelConfig(userId: String): ModelConfig {
        val bucket = userId.hashCode() % 100
        return when {
            bucket < 50 -> ModelConfig("ocr_v2", downloadUrlV2)  // control
            else       -> ModelConfig("ocr_v3", downloadUrlV3)  // experiment
        }
    }
}
```

Hash the userId for bucketing rather than using a random number, so the same user is consistently assigned across sessions and does not experience jumps.

### Core Observation Metrics

An A/B test is not just about accuracy. I defined a **composite quality score**:

```
quality_score = feature_success_rate * 0.4 + user_retention * 0.3 + (1 - complaint_rate) * 0.3
```

Weights came from regression analysis on historical data — feature success rate has the largest impact on retention, so it carries the highest weight. Users will not tell you whether the model is good, but they vote with their feet.

In practice, a model that improved 8% on the offline benchmark delivered only a 1.2% composite quality score lift in the A/B test. The benchmark dataset lacked the many "user takes a photo and gives up on recognition" scenarios — those extremely low-quality images that the model still cannot handle.

## Closing the Loop: From Problem to Verified Fix

With offline evaluation, production monitoring, and A/B experiments in place, the three form a feedback loop:

1. **A/B test discovers**: confidence distribution is abnormal on a device model
2. **Offline benchmark reproduces**: run the benchmark on a device with the same SoC, pinpoint a specific operator (for example, Conv2D) with anomalous latency on Snapdragon 7-series
3. **Targeted optimization**: adjust model structure or quantization strategy, retrain
4. **Re-launch after offline validation passes**: CI benchmark green → staged rollout → full release

Once the loop runs, the team moves from "ship on gut feel" to "iterate on data." Model iteration cycles dropped from 3 weeks to 1.5.

## Practical Recommendations

**Do not blindly trust the benchmark dataset.** Online data is always dirtier, messier, and more diverse than what you have on hand. Sample a batch of new images from production every month and supplement the benchmark dataset.

**Monitor P95, not the average.** Averages hide the tail. A model that runs in 50ms on a flagship and 2s on a low-end device might average 200ms — but 5% of users have a terrible experience. P95 surfaces those users.

**Wire model quality alerts into the on-call system.** On-device model failures do not trigger server-side alarms — you have to monitor proactively. My rule: P95 confidence below 0.55 on any device model for over 30 minutes triggers an alert. This rule caught a widespread recognition failure caused by a corrupted model file in our second week online.
