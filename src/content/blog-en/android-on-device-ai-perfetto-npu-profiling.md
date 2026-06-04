---
title: "Android On-device AI Profiling with Perfetto: NPU Scheduling and Memory Bandwidth"
lang: en
translationKey: android-on-device-ai-perfetto-npu-profiling
slug: android-on-device-ai-perfetto-npu-profiling
excerpt: "A Perfetto-based profiling method for Android on-device AI inference, tracing NPU scheduling, GPU counters, DRM contention, and memory bandwidth bottlenecks."
publishDate: '2025-11-17'
tags:
- "Android"
- "Perfetto"
- "On-device AI"
- "Performance Optimization"
- "NPU"
seo:
  title: "Perfetto Profiling for Android On-device AI and NPU Bottlenecks"
  description: "Use Perfetto to trace Android on-device AI inference, diagnose NPU scheduling delay and memory bandwidth limits, and improve token throughput."
  pageType: article
---

Last year, while optimizing on-device Stable Diffusion inference, I hit a painful issue: with the same image and the same model, inference latency fluctuated wildly between 200 ms and 800 ms. GPU utilization showed only 60%, but latency would not come down. After several days of digging, the answer became clear: the bottleneck in on-device AI inference was not compute. It was scheduling and bandwidth.

The following is a Perfetto tracing methodology I built during that investigation. The core idea is to adapt the performance-analysis habits from the Systrace era to GPU/NPU inference workloads.

## Why CPU profilers do not work for on-device inference

CPU profilers such as Simpleperf and Android Studio Profiler mostly fail in on-device inference scenarios. The computation happens on the GPU or NPU. On the CPU side, you only see a short driver call.

For example, when running QNN inference on a Snapdragon 8 Gen 3, the CPU-side call stack looks like this:

```
qnn_model_execute()          // 3 ms visible on the CPU side
  └─ qnn_driver_ioctl()     // Submit command to the NPU
```

The real NPU computation takes 200 ms. The 3 ms recorded by the CPU profiler is only the driver ioctl time, and it has little relationship to actual inference latency.

Different inference frameworks also use the NPU in very different ways. TFLite goes through the NNAPI delegate, QNN talks directly to a private driver, and MediaPipe has its own scheduling layer. Each path has different nodes that need tracing, so a single CPU-profiling template does not apply.

This is where Perfetto is necessary. It can collect CPU scheduling, GPU counters, DRM events, and kernel ftrace events at the same time. Today, it is the only practical unified entry point for on-device inference performance analysis.

## Building inference-latency observability with Perfetto

### Step 1: add custom trace markers

An inference pipeline is composed of multiple stages: preprocessing, model inference, and postprocessing. I insert `ATrace` markers at the entrance and exit of each stage:

```cpp
#include <android/trace.h>

bool InferencePipeline::run(const cv::Mat& input, Result& output) {
    ATrace_beginSection("preprocess");
    auto tensor = preprocess(input);
    ATrace_endSection();

    ATrace_beginSection("model_inference");
    auto logits = interpreter_->Invoke(tensor);  // Core inference
    ATrace_endSection();

    ATrace_beginSection("postprocess");
    output = postprocess(logits);
    ATrace_endSection();
    return true;
}
```

In the Perfetto UI, these markers expand into a clear hierarchy, making it easy to see a distribution such as "preprocessing 15 ms -> inference 450 ms -> postprocessing 8 ms."

One pitfall from production: `ATrace` markers themselves cost about 5 us. Do not add markers to tasks shorter than 1 ms, or the marker overhead will distort the measurement. Here, only stage boundaries are marked; inner loops are not instrumented.

### Step 2: parse NPU scheduling slices

When recording a Perfetto trace, data-source selection is critical. In the recording UI, `record_android_trace`, make sure these are enabled:

- **ftrace**: `sched/sched_switch`, `drm/*`, `kgsl/*` for Qualcomm GPU
- **GPU counter**: `gpu.counters`, sampled every 100 ms
- **Atrace userspace annotations**: `*` is enough

The equivalent command line is:

```bash
adb shell perfetto \
  -c - --txt \
  -o /data/misc/perfetto-traces/trace.perfetto-trace <<EOF
buffers: { size_kb: 65536 }
data_sources: {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "drm/drm_vblank_event"
      ftrace_events: "kgsl/kgsl_work_submit"
    }
  }
}
data_sources: {
  config {
    name: "android.gpu.counters"
    gpu_counter_config {
      counter_period_ns: 100000000
    }
  }
}
duration_ms: 10000
EOF
```

After pulling the trace back, focus on three dimensions.

**Scheduling gaps.** In `sched_switch` events, find the NPU driver thread, usually named `kgsl_worker_thread` or `mnn_worker`, and look at the interval from Ready to Running. In real measurements, when system load was high, NPU driver-thread scheduling delay jumped from 50 us to 15 ms. That delay is added directly to total inference latency, while the framework layer has no visibility into it.

**GPU frequency ramp-up.** In `gpu.counters`, inspect the GPU frequency curve during inference. On many devices, the GPU needs 50-100 ms to climb from 300 MHz to 680 MHz. If the inference task itself is only 100 ms, half of it runs at a low frequency.

**DRM contention.** `drm_vblank_event` reveals GPU resource contention. When the rendering thread and inference thread compete for the GPU, Perfetto shows alternating GPU-active blocks, and inference latency can double.

## Memory bandwidth: the real bottleneck delaying inference

After scheduling optimization, latency became stable, but the absolute value was still high. Compared with the same model on an iPhone 15 Pro with the Apple Neural Engine, the Android side was nearly 40% slower. At that point, I turned to memory bandwidth.

On-device inference has one unavoidable memory behavior: model weights must be moved from DDR into the NPU's on-chip SRAM. Every inference is a full transfer. A 1.5B-parameter INT4 quantized model has roughly 750 MB of weights, while Qualcomm NPU SRAM is usually only 2-8 MB. One inference has to be split into hundreds of DMA transfers, and the transfer cost can dominate compute.

Perfetto can trace memory allocation and mapping with `kgsl_mem_alloc` and `kgsl_mem_map`, but the real bandwidth bottleneck must be inferred from the comparison between `kgsl_gpu_freq` and memory-controller, or DDR, frequency. My method is to place the GPU frequency curve and DDR frequency curve side by side in the trace and look for windows where the GPU is high-frequency but low-utilization during inference. That pattern indicates bandwidth wait.

```bash
# Extract GPU-frequency and DDR-frequency data
trace_processor_shell --run-metrics android_gpu_frequency trace.perfetto-trace
trace_processor_shell --run-metrics android_memory_frequency trace.perfetto-trace
```

Measured on Snapdragon 8 Gen 3: with the GPU running at 680 MHz, theoretical compute is about 3.5 TOPS for INT4, but limited by 44.8 GB/s of DDR bandwidth, actual throughput is only about 35 token/s. Bandwidth utilization is close to 90%, while compute utilization is below 30%. In other words, the GPU spends most of its time waiting for data, not computing.

## Three optimization paths

Once the bottleneck is identified, the direction is clear.

**Keep weights resident.** If the model size allows it, for example a quantized model under 200 MB, use `ION` or `DMA-BUF` to pin weights in memory that the NPU can access directly and avoid remapping on every inference. On Qualcomm platforms, this can be implemented with `QNN_MEM_HANDLE` to specify a memory strategy, but only if the inference framework supports external memory injection. TFLite does not; the native QNN SDK does. If inference latency is a key metric, this alone can justify choosing QNN over TFLite.

**Isolate inference from rendering.** In scenarios with both UI rendering and inference, such as real-time filters, bind the inference thread to a separate big-core CPU cluster and monitor GPU utilization through `android.gpu.counters`. Ideally, rendering and inference use different GPU command queues. When creating an EGL context, explicitly set `EGL_CONTEXT_PRIORITY_LEVEL_IMG`:

```cpp
const EGLint ctx_attribs[] = {
    EGL_CONTEXT_CLIENT_VERSION, 3,
    EGL_CONTEXT_PRIORITY_LEVEL_IMG, EGL_CONTEXT_PRIORITY_LOW_IMG,
    EGL_NONE
};
// Use a low-priority context for inference and a high-priority context for rendering.
```

**Fuse operators to reduce transfers.** This took the most time and produced the most visible gain. The Perfetto trace confirmed that when consecutive operators such as Conv + BatchNorm + ReLU ran separately, they caused three DMA round trips. After operator fusion with `QNN Graph Optimizer`, three transfers became one, and inference latency dropped by about 22%. The cost is that the model must be re-exported, so it cannot be done online, but the return is worth it.

## Turning performance analysis into a reusable process

After this work, I settled on a repeatable analysis flow and reused it across several later projects:

1. Add `ATrace` markers to break down latency across inference-pipeline stages
2. Use Perfetto ftrace to inspect NPU driver-thread scheduling delay
3. Use GPU counters to inspect frequency ramp-up and utilization gaps
4. Compare GPU and DDR frequency to find bandwidth bottlenecks
5. Optimize the most severe bottleneck, **changing only one variable at a time**

The last point is especially important. On-device AI performance tuning has too many variables: quantization precision, memory layout, thread affinity, and GPU frequency strategy. If you change several at once, the trace data cannot attribute gains to a specific optimization. Tuning becomes guesswork.

On a Snapdragon 8 Gen 3 running a 1.5B model, this optimization flow improved token generation from 18 token/s to 35 token/s and reduced first-token latency from 680 ms to 280 ms. The numbers themselves are not the main point. The main point is having a measurable, attributable, iterative analysis system. Fast code is not guesswork; it is all written in the trace.
