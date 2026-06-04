---
title: "Android On-device AI Power and Thermal Management: From SoC DVFS to Thermal Throttling"
lang: en
translationKey: android-on-device-ai-power-thermal-management
slug: android-on-device-ai-power-thermal-management
excerpt: "A practical look at sustained on-device LLM inference, GPU power profiles, DVFS scheduling, thermal throttling, and thermal-aware load scheduling that reduced P99 latency from 890ms to 380ms."
publishDate: '2025-11-21'
tags:
- "Android"
- "On-device AI"
- "Performance Optimization"
- "Power Management"
- "Thermal Throttling"
seo:
  title: "Android On-device AI Power and Thermal Management"
  description: "Explore SoC DVFS, thermal throttling, GPU power profiles, and thermal-aware scheduling for stable Android on-device AI inference latency."
  pageType: article
---

Last year, while building a real-time translation app with an on-device LLM, I ran into a painful issue: inference latency stayed around 120ms for the first three minutes, then started jumping to 300ms, 500ms, and occasionally more than two seconds. Logcat kept printing `CPU Mitigation` from ThermalService, and the device surface temperature had already passed 45°C.

Performance is not the number written in a benchmark. It is the number you get after the device has heated up.

## The power profile of on-device inference: GPU becomes the new hot spot

Traditional mobile apps put most of their power pressure on the CPU and display. On-device AI inference changes that balance.

When running a quantized 3B-parameter model on Snapdragon 8 Gen 3, the sustained inference power profile looked roughly like this:

| Component | Peak Power | Share During Sustained Inference |
|------|---------|------------|
| GPU/NPU | 3.8W | 52% |
| CPU (scheduling + pre/post-processing) | 1.5W | 21% |
| DRAM | 1.2W | 17% |
| Other (bus/codec) | 0.7W | 10% |

The GPU consumes more than half of the power budget. This is very different from running a benchmark, where a single pass usually ends before heat has time to accumulate. In sustained inference, **steady-state power is the real constraint**. Peak performance is often just a paper number.

In one project, I ran a comparison on the same model at 25°C room temperature. Short-run latency, measured as the average of five inferences, was 85ms. After five minutes of continuous inference, latency climbed to 220ms. That 158% regression came entirely from thermal frequency throttling.

## The first line of SoC thermal defense: DVFS scheduling

Android DVFS, or Dynamic Voltage and Frequency Scaling, is the starting point of the thermal response path. The idea is direct: temperature rises, frequency and voltage are reduced, heat generation drops, and the system waits for temperature to fall back.

The problem with DVFS is granularity. Different IP blocks inside the SoC, including big CPU cores, mid cores, little cores, and the GPU, each have independent frequency levels and thermal thresholds. At the Android framework layer, Power HAL abstracts those physical frequencies into performance modes:

```cpp
// Performance mode enum defined in Power HAL
enum class PowerHint {
  SUSTAINED_PERFORMANCE,  // Sustained performance: medium GPU frequency
  VR,                      // VR workload: fixed high frame rate
  INTERACTION,             // Touch interaction: fast CPU boost
  // New mode for on-device AI inference
  ML_INFERENCE_LOW_LATENCY,    // Low-latency inference
  ML_INFERENCE_ENERGY_EFFICIENT // Energy-efficient inference
};
```

In application code, calling Power HAL only takes a few lines:

```kotlin
// Request a high-performance mode before inference
val powerManager = context.getSystemService<PowerManager>()
val lowLatencyHint = powerManager.createPowerHint(
  PowerHint.ML_INFERENCE_LOW_LATENCY
)

try {
  lowLatencyHint.acquire()
  // Run model inference
  interpreter.run(input, output)
} finally {
  lowLatencyHint.release() // Release immediately after inference
}
```

This API was introduced in Android 14. Fundamentally, it is a framework-level wrapper around the lower-level CPUFreq governor. But its scope is limited: **Power HAL can only suggest frequency behavior to the scheduler. It cannot bypass hard limits from Thermal HAL.**

## Thermal throttling: when DVFS is no longer enough

DVFS is flexible and gradual. Thermal throttling is hard enforcement: it can directly shut down cores or force minimum frequency. The trigger path looks like this:

```
SoC temperature sensor -> Thermal Core (kernel driver)
  |- Light: notify DVFS Governor to reduce frequency
  |- Moderate: CPU/GPU migration (move big-core work to little cores)
  `- Severe: CPU hotplug (disable big cores), force GPU to minimum frequency
```

On a Pixel 8 Pro, sustained inference triggered `GPU_MITIGATION` after roughly four minutes, when GPU temperature reached 48°C. At that point, GPU frequency was forced from 900MHz down to 315MHz, and inference latency jumped from 130ms to 410ms.

The recovery curve is even trickier. After temperature falls below the safe line, frequency does not immediately return. Thermal Service has a hysteresis mechanism: temperature must stay below the threshold for 10 to 15 seconds before frequency is restored step by step. The latency curve looks like a roller coaster: it climbs, drops sharply, then slowly rebounds.

## Two-layer thermal-aware load scheduling

System scheduling alone is not enough. At the application layer, I added a thermal-aware scheduling strategy with a simple principle: **adjust the workload before temperature gets worse, instead of waiting for the system to hard-throttle and then reacting passively.**

### Layer 1: model-level load splitting

On-device inference load can be split at the model level:

```python
# Thermal-aware load strategy in the inference engine
class ThermalAwareScheduler:
    def __init__(self, threshold_warn=40.0, threshold_critical=46.0):
        self.threshold_warn = threshold_warn      # Warning temperature
        self.threshold_critical = threshold_critical  # Critical temperature
    
    def select_delegate(self, current_temp: float):
        if current_temp < self.threshold_warn:
            # Normal: GPU + FP16
            return "GPU_FP16"
        elif current_temp < self.threshold_critical:
            # Warning: hybrid execution, large ops on GPU, small ops on CPU
            return "HYBRID_INT8"
        else:
            # Critical: switch fully to CPU + INT8, keep GPU for tiny work only
            return "CPU_INT8"
```

Trade precision for temperature. When temperature is normal, run FP16 to preserve quality. When temperature rises, switch to INT8 to reduce compute density. If the device continues heating up, give up on GPU execution entirely.

### Layer 2: cooling windows between frames

In sustained inference, there is naturally a gap between frames. That gap is the best cooling window:

```kotlin
// Add active cooling scheduling inside the inference loop
var lastInferenceEnd = 0L
val minInterval = when (thermalState) {
  ThermalStatus.STATUS_NONE -> 0L       // Normal temperature, no gap
  ThermalStatus.STATUS_LIGHT -> 50L    // Slight heating, insert 50ms
  ThermalStatus.STATUS_MODERATE -> 150L // Moderate heating, insert 150ms
  ThermalStatus.STATUS_SEVERE -> 500L   // Severe heating, reduce frame rate heavily
  else -> 0L
}

if (SystemClock.elapsedRealtime() - lastInferenceEnd < minInterval) {
  delay(minInterval) // Wait for temperature to drop before the next frame
}
```

Android 10 introduced Thermal API, which gives direct access to thermal status without reading sensors manually:

```kotlin
val thermalManager = context.getSystemService<ThermalManager>()
thermalManager.addThermalStatusListener { status ->
  // status: STATUS_NONE / LIGHT / MODERATE / SEVERE / CRITICAL / EMERGENCY
  this.thermalState = status
  adjustInferenceStrategy(status)
}
```

After applying this combined strategy, P99 latency during 10 minutes of sustained inference on the same device dropped from 890ms to 380ms. Extreme stalls longer than two seconds disappeared.

## A pitfall: how to use frequency locks correctly

In an early version, I directly used a `PowerManager` lock to hold high frequency and tried to fight thermal throttling. It did not help. Worse, it triggered more aggressive throttling: the system detected sustained abnormal power draw and disabled one big core.

**Frequency locks are not for fighting thermal control.** Their correct use is to prevent the scheduler from lowering frequency inside a safe temperature range and causing inference latency jitter. Once temperature enters the warning range, release the lock proactively and reduce load instead of pushing through it.

A more practical approach is to combine decisions with CPU frequency information from the system:

```kotlin
// Read current frequency for each core to infer the real scheduling state
fun getCpuFrequencies(): List<Int> {
  val freqs = mutableListOf<Int>()
  for (cpu in 0 until Runtime.getRuntime().availableProcessors()) {
    val freqFile = File("/sys/devices/system/cpu/cpu$cpu/cpufreq/scaling_cur_freq")
    freqs.add(freqFile.readText().trim().toIntOrNull() ?: 0)
  }
  return freqs
}
```

When big-core frequency falls below mid-core frequency, the system is already in thermal throttling. At that point, holding a frequency lock is useless. The app should immediately switch to a lighter inference mode.

## Three lessons from production

**Put thermal tests into CI.** A single benchmark run will not expose these issues. Run sustained inference for 30 minutes in a thermal chamber, and record the full latency, temperature, and frequency curve. Many performance regressions only appear after 10 minutes.

**Do not judge model quantization only by accuracy.** INT8 quantization does not just shrink the model; more importantly, it reduces heat density during inference. On thermally constrained devices, the steady-state latency of an INT8 model is often better than FP16.

**Monitor frequency, not just latency.** Rising latency is the symptom. Falling frequency is the cause. Show real-time CPU core and GPU frequencies in the performance panel, and you can immediately tell whether a problem comes from thermal throttling or something else.
