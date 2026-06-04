---
title: "Android On-device AI Benchmarking: Latency, Throughput, Power, and Thermal Degradation"
lang: en
translationKey: android-on-device-ai-benchmark
slug: android-on-device-ai-benchmark
excerpt: "A practical benchmark methodology for Android on-device AI inference across latency, throughput, power, thermal throttling, long-tail metrics, GPU sync, and automated test reports."
publishDate: '2026-04-17'
tags:
- "Android"
- "AI Inference"
- "Benchmark"
- "Performance Optimization"
- "Power Optimization"
seo:
  title: "Android On-device AI Benchmarking for Latency, Power, and Thermals"
  description: "Benchmark Android on-device AI inference with latency, throughput, power, GPU sync, thermal throttling, cold and hot runs, and automated reports."
  pageType: article
---

Last year, while optimizing on-device LLM inference, the same model on the same device produced latency numbers almost 40% apart between morning and afternoon runs. Background processes were not the issue. Device temperature was: it rose from 32°C to 45°C, and the SoC automatically throttled down.

That experience made one thing clear: benchmarking on-device AI inference is much more complex than benchmarking on a server. Running `benchmark_model` once and copying the number is almost useless in real-world scenarios.

## Latency, throughput, and power: three dimensions in tension

Server-side evaluation can often focus on throughput because GPU clusters are billed by the second. On-device inference is different. A user waiting in a chat UI cares about **time to first token**, or TTFT. Background speech-to-text cares about **throughput**. Power affects both battery life and heat. If any one dimension is missing, the benchmark conclusion can be misleading.

The three dimensions constrain each other:

- Lower latency requires higher CPU or GPU frequency, and power rises immediately
- Higher throughput requires more parallel inference, heat accumulates quickly, and after thermal limits are hit latency can become worse; P99 can increase two or three times
- Limiting frequency to save power degrades both latency and throughput

So the real question is: how do we get stable, credible measurements for all three dimensions in one test framework?

## Latency measurement: avoid Android-specific traps

The formula for latency is simple: output time minus input time. Accurate latency measurement on Android, however, has several details that are easy to get wrong.

### SystemClock or currentTimeMillis

```kotlin
val startNanos = System.nanoTime()
val output = interpreter.run(inputs)
val endNanos = System.nanoTime()
val latencyUs = (endNanos - startNanos) / 1000
```

Use `System.nanoTime()` or `SystemClock.elapsedRealtimeNanos()`. Do not use `currentTimeMillis()`, which is affected by wall-clock adjustments. NTP sync or a user changing system time can make the data unreliable.

### Cold start versus warm start

On first load, the runtime performs operator compilation, memory allocation, and weight-layout optimization. The second inference is usually 20-50% faster than the first. I usually separate them like this:

```kotlin
// Warm-up: exclude the first three inferences from statistics
repeat(3) { interpreter.run(inputs) }
// Actual measurement
val latencies = mutableListOf<Long>()
repeat(50) {
    val start = System.nanoTime()
    interpreter.run(inputs)
    latencies.add((System.nanoTime() - start) / 1000)
}
```

### P50 and P99: why long tail matters more than average

Averages hide occasional high latency. On-device inference is affected by CPU scheduling and memory collection, so P99 being far above P50 is common. I usually record P50, P90, and P99 together. When P99 is more than 3x P50, you can usually assume there is scheduling jitter that needs deeper investigation.

### Hidden GPU latency

When `run()` returns, GPU commands may still be waiting in the command queue. A direct stopwatch can miss the real compute time. The correct approach is to insert a synchronization wait after inference:

```kotlin
// GPU Delegate requires waitOnSync
interpreter.runForMultipleInputsOutputs(inputs, outputs)
gpuDelegate.waitOnSync()
val latency = (System.nanoTime() - start) / 1000
```

Qualcomm SNPE and MediaTek NeuroPilot have the same issue. Their runtime APIs provide fence or sync mechanisms. If you skip this step, GPU latency will be systematically underreported.

## Throughput measurement: control power state

Throughput is highly sensitive to system state. On the same device, different battery or temperature conditions can change throughput by more than 30%. To get reproducible data, I use several hard constraints.

**Fix the performance mode.** Before testing, lock the display behavior through WindowManager to reduce dynamic-frequency interference:

```kotlin
val window = activity.window
window.attributes = window.attributes.apply {
    preferredRefreshRate = 60f // Fixed refresh rate
}
```

A lower-level approach is to set `/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor` to `performance`, but that requires root.

**Batch inference strategy.** Throughput tests should keep the inference pipeline saturated. I use a producer-consumer model and keep the queue non-empty:

```kotlin
val executor = Executors.newFixedThreadPool(4)
val results = ConcurrentLinkedQueue<Long>()
// Four concurrent threads, each running 200 consecutive inferences
repeat(4) {
    executor.submit {
        repeat(200) {
            val start = System.nanoTime()
            interpreter.run(inputs)
            results.add((System.nanoTime() - start) / 1000)
        }
    }
}
executor.shutdown()
executor.awaitTermination(5, TimeUnit.MINUTES)
val totalTime = results.sum() / 1000 // Microseconds
val throughput = (4 * 200) / (totalTime / 1_000_000.0) // Inferences per second
```

**Control variables.** Turn off Bluetooth, Wi-Fi scanning, and background sync before the test. Run in airplane mode. These conditions look strict, but without them, throughput swings between runs can become too large to compare.

## Power measurement: three precision levels

For Android on-device power measurement, there are three options from coarse to precise.

**BatteryManager estimate** is the roughest. It can only provide whole-device milliamp-hour deltas and cannot separate module-level power. It is fine for a quick comparison but unreliable for detailed analysis.

**`dumpsys batterystats`** can break power estimates down into CPU, GPU, modem, and other modules. The data comes from PowerProfile, and vendor PowerProfile.xml accuracy varies. Pixel devices are relatively reliable; many domestic mid-range and low-end devices show noticeable deviation.

**Hardware power monitor** is the most precise. A Monsoon or Yokogawa power monitor measures whole-device current directly at milliamp precision. When aligned with Perfetto, it can calculate energy for each inference:

```bash
# Mark inference ranges with Perfetto trace points
atrace --async_start -b 4096 gfx input view
# Insert trace markers in the inference code
Trace.beginSection("Inference")
interpreter.run(inputs)
Trace.endSection()
```

Integrate the power monitor's current data over the timeline to compute per-inference energy, in mAh or mJ. For comparing quantized models, this is the standard workflow. Sometimes the power difference before and after quantization is below 5%, which software estimation cannot reliably distinguish.

## Thermal impact: the root of benchmark non-reproducibility

Returning to the opening issue: on-device SoCs have strict thermal policies. Using Qualcomm Snapdragon as an example:

| Temperature range | CPU prime-core frequency | GPU frequency | Policy |
|----------|-------------|----------|------|
| < 40°C | Full frequency | Full frequency | No limit |
| 40-45°C | Down to 2.0 GHz | Full frequency | CPU starts throttling |
| 45-50°C | Down to 1.5 GHz | Down to 400 MHz | CPU + GPU throttling |
| > 50°C | Down to 1.0 GHz | Down to 200 MHz | Severe throttling, forced cooldown |

I measured one representative case: after 5 minutes of continuous inference, device temperature rose from 32°C to 48°C, and latency degraded from 85 ms to 230 ms, a 2.7x increase. Without controlling temperature, two benchmark runs can lead to completely opposite conclusions.

### Engineering measurement for thermal degradation

I split the test into four stages:

1. **Cold-device stage**: let the device sleep for 30 minutes before testing, keeping the temperature baseline around 30-32°C
2. **Warm-up stage**: continuously push inference requests while sampling latency and temperature every second
3. **Thermal steady stage**: after temperature reaches 45°C or above, keep running and record the performance-degradation curve
4. **Throttle recovery**: stop inference and observe how long performance takes to recover after the temperature drops

Read thermal state in real time with `ThermalManager`:

```kotlin
val thermalManager = getSystemService(ThermalManager::class.java)
thermalManager.addThermalStatusListener { status ->
    when (status) {
        ThermalManager.THERMAL_STATUS_NONE -> "normal"
        ThermalManager.THERMAL_STATUS_LIGHT -> "light throttling"
        ThermalManager.THERMAL_STATUS_MODERATE -> "moderate throttling"
        ThermalManager.THERMAL_STATUS_SEVERE -> "severe throttling"
        ThermalManager.THERMAL_STATUS_CRITICAL -> "critical throttling"
        else -> "unknown"
    }.let { Log.d("Thermal", "status changed: $it") }
}
```

On one Snapdragon 8 Gen 2 device, when the status changed from `THERMAL_STATUS_NONE` to `MODERATE`, median inference latency rose from 45 ms to 88 ms, while P99 rose from 62 ms to 190 ms. The interesting detail is that **latency degrades fastest not in the high-temperature zone, but in the 40-45°C transition zone**. The scheduler is deciding whether to throttle, and frequencies bounce around in that range.

### Benchmark rules under thermal impact

Based on measured data, I use these rules:

- **Report both cold-device and hot-device data**, with the initial temperature for each
- **Long-running tests longer than 2 minutes must include a latency-temperature curve**, not just a single average
- **When comparing models, initial temperature must be within +/-1°C**
- Power data should also be collected separately for cold and hot runs; hot-device power is usually 15-25% higher than cold-device power

## Automated benchmark framework

Putting these dimensions together, the automated report should look like this:

```
=== Inference Benchmark Report ===
Device: Google Pixel 8 Pro
Model: MobileLLM-1.5B (fp16, GPU delegate)
Temperature: 32°C (cold) / 46°C (hot)

[Latency]
  P50: 45.2ms / 88.6ms
  P90: 52.1ms / 132.4ms
  P99: 61.8ms / 190.3ms
  TTFT: 42.3ms / 85.1ms

[Throughput]
  Peak: 22.3 req/s / 11.4 req/s
  Sustained(5min): 18.7 req/s / 8.2 req/s

[Power]
  Avg: 2.3W / 3.1W
  Peak: 4.1W / 4.8W
  Energy/token: 0.12mJ / 0.28mJ

[Thermal]
  Max temp: 32°C / 46°C
  Throttle ratio: 0% / 48%
  Recovery time: N/A / 180s
```

The toolchain I recommend is **Perfetto for timeline tracing, Monsoon Power Monitor for power markers, and a custom Runner for latency and throughput collection**. Align all three data sources on `SystemClock.elapsedRealtimeNanos()` so later analysis can correlate them directly.

The core value of this framework is not producing pretty numbers. It is answering two questions: **when performance degradation starts and how severe it is**. A model that looks good on a cold device may become unusable after the user chats for three minutes. Benchmarking should tell you that truth.
