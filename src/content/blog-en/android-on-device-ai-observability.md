---
title: "Observability for Android On-Device AI Inference"
lang: en
translationKey: android-on-device-ai-observability
slug: android-on-device-ai-observability
excerpt: "Trace each on-device inference, build multi-dimensional performance profiles, and detect production regressions across fragmented Android hardware."
publishDate: '2026-07-13'
tags:
- "Android"
- "On-device Inference"
- "Observability"
- "Performance Monitoring"
seo:
  title: "Observability for Android On-Device AI"
  description: "Trace Android on-device AI inference and detect production performance regressions."
  pageType: article
---

In Q3 last year, our app's end-side image segmentation model experienced more than 3 times the inference delay degradation on a certain brand of mid-range machines. The embarrassing thing is: the crash rate has not changed, the ANR has not increased, and there is no feedback from users. It was not until we compared the buried data of two versions of the same model that we found that the degradation had continued for 6 weeks.

The back-end service has a mature APM system, including Prometheus + Grafana + distributed Tracing. When it comes to end-side AI inference, the approach of most teams is to “make a few logs to see how long it takes”, and then revise the code if there is a problem. This kind of post-mortem investigation is impossible to predict in the Android ecosystem with frequent model iterations and serious device fragmentation.

I have implemented a set of end-side AI inference observability solutions. The core idea is: Use Trace to structurally record the complete link of each inference, build a performance portrait based on Trace data, and then detect online degradation through drift detection of the portrait. **

## Observation blind spots of end-side AI reasoning

The end-side inference link is much shorter than the back-end service call, but it is more difficult to observe.

**Cross-layer calls are compressed within a single process. ** A backend request passes through the gateway, service, cache, and database, and naturally has RPC boundaries as a burying point. Device-side inference runs from input preprocessing to model running to post-processing, all in one process. The call boundaries are blurred and spans must be explicitly divided at the code level.

**Performance is drastically affected by device heterogeneity. ** Also running MobileNetV3’s FP16 inference, Snapdragon 8 Gen 3 may only need 3ms using QNN Delegate, and a certain MediaTek mid-range machine needs to run 25ms using XNNPACK to fall back to CPU inference. The back end can cover up performance differences through capacity expansion, but the end side cannot be expanded - the device in the user's hand is whatever it is.

**Model file distribution and loading are additional variables. ** After the model is updated, the user may still be using the old version, the file download is incomplete, and the Delegate initialization fails and silently falls back to the CPU - these problems are difficult to correlate to specific inference quality degradation in pure point statistics.

The superposition of three blind spots often leads to the performance degradation of end-side AI, which is often like "boiling a frog in warm water": a single inference is 5ms slow.No one realizes it, but coupled with model updates, system upgrades, and temperature reductions, the cumulative effect will suddenly explode one day.

## Build a tracking system for inference Trace

Treat each inference request as a Trace, and treat the three stages of preprocessing, inference, and postprocessing as three spans. The data structure refers to the Span model of OpenTelemetry and is simplified on the end side.

```kotlin
data class InferenceSpan(
    val traceId: String,
    val spanName: String,
    val startTimeNanos: Long,
    val endTimeNanos: Long,
    val attributes: Map<String, String>,
    val events: List<SpanEvent>,
    val status: SpanStatus
)

data class SpanEvent(
    val name: String,
    val timestampNanos: Long,
    val attributes: Map<String, String>
)
```

The attributes field of Span carries the context dimension, and the reasoning time is only basic information:

- **Model dimensions**: model_name, model_version, model_format (.tflite / .ort / .pte)
- **Runtime dimensions**: delegate_type (GPU/NNAPI/XNNPACK), delegate_status, thread_count
- **Input dimensions**: input_shape, input_dtype, preprocessing_ms
- **Device dimensions**: soc_model, api_level, thermal_status

Each Span can also carry events, such as delegate initialization failure and model loading rollback—these key events are much more useful than average time-consuming when troubleshooting online problems.

In terms of buried point access method, I do not recommend using AOP aspects. The calling path of the inference code is short and fixed, and the flexibility brought by AOP has no benefits on the client side, but increases the cost of troubleshooting. It is more controllable to explicitly bury the point directly in the Interpreter encapsulation layer:

```kotlin
class TracedInterpreter(
    private val delegate: Delegate,
    private val tracer: InferenceTracer
) {
    fun infer(input: ByteBuffer): Result<FloatArray> {
        val traceId = tracer.startTrace("image_seg")
        
        val preSpan = tracer.startSpan(traceId, "preprocess")
        val tensor = preprocess(input)
        tracer.endSpan(preSpan, mapOf("input_shape" to tensor.shape.toString()))
        
        val inferSpan = tracer.startSpan(traceId, "model_infer")
        val output = runModel(tensor)
        tracer.endSpan(inferSpan, mapOf(
            "delegate" to delegate.name,
            "inference_ms" to inferSpan.durationMs().toString()
        ))
        
        val postSpan = tracer.startSpan(traceId, "postprocess")
        val result = postprocess(output)
        tracer.endSpan(postSpan)
        
        tracer.endTrace(traceId)
        return Result.success(result)
    }
}
```

The client performs local aggregation of Trace data: grouped by model + version + device gear, and reports the aggregated statistical values ​​(P50, P90, P99, success rate, and time-consuming proportion of each Span) every 100 inferences or every 5 minutes. The full data of a single Trace is not reported, and the complete link is only retained for troubleshooting when the sampling policy is triggered (for example, P99 exceeds 2 times the threshold).

## Performance portrait: from statistical values to distribution characteristics

After the aggregated data is reported to the backend, the performance of a single model is described by a multi-dimensional vector. I call it "Performance Profile":
```
Profile = {
    model: "segmentation_v3",
    version: "20260701",
    soc_bucket: "mid_range_snapdragon",
    percentiles: { p50: 45ms, p90: 72ms, p99: 130ms },
    span_ratio: { preprocess: 0.15, infer: 0.70, postprocess: 0.15 },
    success_rate: 0.997,
    delegate_distribution: { GPU: 0.92, CPU: 0.08 },
    sample_size: 2840
}
```

The core value of a portrait is not in a single value, but in the **distribution form**. P50 is 45ms but P99 is 130ms, a span of nearly 3x, indicating a significant long tail of latency. Further grouping the devices by temperature status, we found that P99 soared to 200ms when the frequency was reduced at high temperature - this information provides a grouping baseline for subsequent degradation detection.

Two lessons learned when building a portrait.

**SOC bucketing strategy is more effective than model grouping. ** There are thousands of Android device models, and building portraits based on models will lead to sparse data. My approach is to divide it into 6-8 buckets by SOC model + performance level (based on GeekBench benchmark data). The difference in inference performance of devices within the same bucket is usually within 15%, which is enough for degradation detection.

**Portraits require versioned storage. ** A new portrait ID should be generated for every model update, inference engine version change, or even system WebView version change (which affects NNAPI behavior). The most recent 10 versions of portrait data are retained for baseline comparison during degradation detection.

## Degradation detection: automatic detection of image drift

With continuously updated performance portraits, degradation detection becomes anomaly detection of time series data. There is no complex ML model used here, but a three-layer progressive rule engine:

**Level 1: Single indicator threshold alarm. ** P99 inference time exceeds 150% of the baseline, the success rate is less than 99%, and the CPU regression rate exceeds 20% - an alarm will occur when any condition is triggered. The most sensitive, but also has the highest false alarm rate.

**Second layer: Portrait vector distance. ** Calculate the cosine similarity after normalizing multiple dimensions (P50/P90/P99/success rate/Span proportion) of the current portrait and the baseline portrait. If the similarity is lower than 0.85 and lasts for 3 reporting cycles, it is determined to be effective degradation. This layer filters out most of the transient jitter.

```kotlin
fun cosineSimilarity(current: Profile, baseline: Profile): Double {
    val cur = current.toNormalizedVector()
    val base = baseline.toNormalizedVector()
    val dot = cur.zip(base).sumOf { (a, b) -> a * b }
    val normCur = sqrt(cur.sumOf { it * it })
    val normBase = sqrt(base.sumOf { it * it })
    return dot / (normCur * normBase)
}
```

**Level 3: Drill down equipment into groups. ** After detecting degradation in the second layer, it automatically divides the devices into groups according to device manufacturers, Android versions, and temperature status to find the subgroup with the most severe degradation. In practice, it has been found that manufacturers' system updates often change the NNAPI driver behavior, leading to concentrated degradation of specific brand models. The root cause of this problem has nothing to do with the App code, but it requires quick positioning to push manufacturers to repair or downgrade.

The actual benefit brought by the three-layer progression is that alarms have their own context. Receiving "P99 delay of segmentation_v3 degraded from 80ms to 150ms" is much more actionable than "Inference time-consuming alarm". Adding "Affected devices are concentrated in Xiaomi HyperOS 2.0 Snapdragon 7+ Gen 2 models" can directly locate the specific driver version.

## Balance sampling rate and storage cost

It is not practical to report all trace data in the device-side scenario. For an app with a DAU of tens of millions, each person triggers 50 inferences per day, and the full report is 500 million traces per day. The storage and transmission costs are unbearable.

My strategy is three-layer sampling:

- **Statistical Sampling**: 100% reporting of aggregate statistics (P50/P90/P99 for each model + device group, etc.), with the smallest amount of data and the highest value.
- **Abnormal Sampling**: When a single inference takes more than 2.5 times the P99 baseline, keep the complete Trace and report it. This part of the data accounts for about 1% of the total, but covers most of the abnormal cases that need to be investigated.
- **Random Sampling**: Randomly retain complete Traces with a probability of 0.1% for offline analysis and new indicator exploration.

A ring buffer is used for end-side storage, and the most recent 200 Traces are retained in the memory. Only when abnormal sampling is triggered, they are serialized and written to disk and reported. Normal Trace is discarded after aggregation is completed in the memory without being dropped to disk.

This solution has been running for half a year. The average daily reported data volume is controlled within 200MB, and the peak disk cache does not exceed 50MB. It has covered 3 model degradation events and 2 manufacturer driver compatibility issues - the ROI is in line with expectations.

## Trampling on the pit record

**NNAPI’s delegate status is unreliable. ** `The successful call of Interpreter.Options.addDelegate` does not mean that the model is actually running on the GPU. NNAPI will perform silent rollback internally based on operator support. Solution: Record the `nnapi_fallback` event in Span's events, and indirectly determine the fallback behavior through the changes in TFLite's `Interpreter.getInputTensor` and `index()` of `getOutputTensor`.

**SystemClock.elapsedRealtimeNanos drifts on some devices. ** A single inference takes 10-100ms, and clock drift has little impact, but the aggregated timestamp may be inaccurate after a long run. The solution is to regularly use `System.currentTimeMillis` for calibration. When the difference exceeds 5%, an alarm is triggered but does not affect the inference itself.

**Portrait cold start requires 3-5 days of data accumulation. ** After the new model was launched, the insufficient amount of portrait data caused the baseline to be unstable. The "warm-up period" strategy is adopted online: only data is collected in the first 3 days without triggering alarms. On the 4th day, a sliding window is used to calculate the baseline, and thereafter it is updated daily.

End-side observability is not a simple transplant of the back-end system. Its core challenge lies in the lightweighting of data collection and the automation of degradation detection - the former determines how much data you can collect, and the latter determines whether you can find problems before users perceive them. It took about 3 man-weeks to build this system, but it found 5 online problems for me that were impossible to locate through manual troubleshooting, and the subsequent maintenance costs were almost zero.
