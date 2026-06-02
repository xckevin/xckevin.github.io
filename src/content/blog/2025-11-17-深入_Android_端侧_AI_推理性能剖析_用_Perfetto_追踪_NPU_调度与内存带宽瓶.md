---
title: 深入 Android 端侧 AI 推理性能剖析：用 Perfetto 追踪 NPU 调度与内存带宽瓶颈
excerpt: 基于 Perfetto 追踪端侧 AI 推理的 NPU 调度与内存带宽瓶颈，通过权重常驻、推理渲染隔离和算子融合将 token 生成速度从 18 提升至 35 token/s。
publishDate: '2025-11-17'
tags:
- Android
- Perfetto
- 端侧AI
- 性能优化
- NPU
seo:
  title: 深入 Android 端侧 AI 推理性能剖析：用 Perfetto 追踪 NPU 调度与内存带宽瓶颈
  description: 用 Perfetto 系统性追踪 Android 端侧 AI 推理性能，从 NPU 调度延迟到内存带宽瓶颈，将 token 生成速度提升近一倍——本文分享一套可复用的分析方法论。
---

去年做端侧 Stable Diffusion 推理优化时，碰到一个让人头疼的问题：同一张图片、同一个模型，推理延迟在 200ms 到 800ms 之间剧烈抖动。GPU 占用率显示才 60%，延迟就是降不下去。折腾了好几天才发现——端侧 AI 推理的瓶颈不在算力，在调度和带宽。

下面是我排查过程中建立的一套 Perfetto 追踪方法论，核心思路是把 Systrace 时代的性能分析经验，适配到 GPU/NPU 推理场景。

## 端侧推理为什么不能用 CPU Profiler 分析

Simpleperf、Android Studio Profiler 这类 CPU 性能分析工具，在端侧推理场景基本失灵。推理的计算发生在 GPU 或 NPU 上，CPU 侧只能看到一个短暂的驱动调用。

以骁龙 8 Gen 3 上跑 QNN 推理为例，CPU 侧的调用栈长这样：

```
qnn_model_execute()          // 耗时 3ms，CPU 侧看到的
  └─ qnn_driver_ioctl()     // 下发命令到 NPU
```

实际 NPU 计算耗时 200ms。CPU Profiler 记录的那 3ms 是驱动 ioctl 的时间，跟真实推理延迟完全不搭边。

不同推理框架对 NPU 的利用策略也差异很大：TFLite 通过 NNAPI 委托，QNN 直接走私有驱动，MediaPipe 有自己的调度层。每个路径需要追踪的节点完全不同，没法套用同一套 CPU profiling 模板。

这种情况只能上 Perfetto。它能同时采集 CPU 调度、GPU 计数器、DRM 事件和内核 ftrace 事件，是目前端侧推理性能分析唯一可行的统一入口。

## 用 Perfetto 建立推理延迟的可观测性体系

### 第一步：埋入自定义 Trace 标记

推理 Pipeline 由多个阶段串联：预处理、模型推理、后处理。我在每个阶段的入口和出口插入 `ATrace` 标记：

```cpp
#include <android/trace.h>

bool InferencePipeline::run(const cv::Mat& input, Result& output) {
    ATrace_beginSection("preprocess");
    auto tensor = preprocess(input);
    ATrace_endSection();

    ATrace_beginSection("model_inference");
    auto logits = interpreter_->Invoke(tensor);  // 核心推理
    ATrace_endSection();

    ATrace_beginSection("postprocess");
    output = postprocess(logits);
    ATrace_endSection();
    return true;
}
```

这套标记在 Perfetto UI 里会展开成清晰的层级结构，直接看到「预处理 15ms → 推理 450ms → 后处理 8ms」这样的时间分布。

一个实际踩过的坑：`ATrace` 标记本身有约 5μs 开销。1ms 以内的短任务上不要加标记，否则标记开销会扭曲测量结果。这里只标记阶段边界，不在内部循环打点。

### 第二步：解析 NPU 调度切片

录制 Perfetto trace 时，Data Source 选择是关键。进入录制设置界面（`record_android_trace`），确保勾选：

- **ftrace**：`sched/sched_switch`、`drm/*`、`kgsl/*`（高通 GPU）
- **GPU counter**：`gpu.counters`，采样频率 100ms
- **Atrace userspace annotations**：`*` 通配即可

等价命令行：

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

trace 拉回来后，重点看三个维度：

**调度间隙**。在 `sched_switch` 事件里找 NPU 驱动线程（通常叫 `kgsl_worker_thread` 或 `mnn_worker`），看它从 Ready 到 Running 的间隔。实测中发现，系统负载高时 NPU 驱动线程的调度延迟能从 50μs 飙到 15ms——这部分延迟直接叠加到推理总耗时上，框架层完全无感知。

**GPU 频率爬升**。`gpu.counters` 数据里看推理期间的 GPU 频率曲线。很多设备上，GPU 从 300MHz 爬到 680MHz 需要 50-100ms。推理任务本身如果只有 100ms，前一半时间都在低频跑。

**DRM 冲突**。`drm_vblank_event` 能揭示 GPU 资源争抢。当渲染线程和推理线程同时抢占 GPU 时，Perfetto 上会出现交替的 GPU 活跃块，推理延迟直接翻倍。

## 内存带宽：拖延推理的真正瓶颈

调度优化做完后，延迟稳住了，但绝对值还是偏高。跟 iPhone 15 Pro（ANeuralEngine）上同一模型的数据对比，Android 侧慢了近 40%。这时候我把注意力转向了内存带宽。

端侧推理的内存行为有一个绕不开的事实：模型权重需要从 DDR 搬运到 NPU 的片上 SRAM，每次推理都是一次全量搬运。1.5B 参数的 INT4 量化模型，权重约 750MB，而高通 NPU 的 SRAM 通常只有 2-8MB。一次推理要拆成上百次 DMA 传输，搬运开销远大于计算开销。

Perfetto 里可以用 `kgsl_mem_alloc` 和 `kgsl_mem_map` 事件追踪内存分配和映射，但真正的带宽瓶颈需要从 `kgsl_gpu_freq` 和内存控制器（DDR）频率的对比中推断。我的方法：在 trace 中并排看 GPU 频率曲线和 DDR 频率曲线，找推理期间「GPU 高频 + 低利用率」的窗口——这就是典型的带宽等待。

```bash
# 提取 GPU 频率和 DDR 频率数据
trace_processor_shell --run-metrics android_gpu_frequency trace.perfetto-trace
trace_processor_shell --run-metrics android_memory_frequency trace.perfetto-trace
```

骁龙 8 Gen 3 上的实测数据：GPU 跑在 680MHz 时，理论算力约 3.5 TOPS（INT4），但受限于 44.8 GB/s 的 DDR 带宽，实际吞吐只有约 35 token/s。带宽利用率接近 90%，算力利用率不到 30%。换句话说，GPU 大部分时间在等数据，而不是在算。

## 三条优化路径

定位到瓶颈后，方向就很明确了。

**权重常驻**。模型规模允许的话（200MB 以内的量化模型），用 `ION` 或 `DMA-BUF` 把权重锁定在 NPU 可直访的内存区域，避免每次推理都重新映射。高通平台上通过 `QNN_MEM_HANDLE` 指定内存策略可以实现，但前提是推理框架支持外部内存注入——TFLite 不支持，QNN 原生 SDK 支持。选框架时如果推理延迟是关键指标，这一点足够成为选择 QNN 而非 TFLite 的理由。

**推理与渲染隔离**。在同时有 UI 渲染和推理的场景（比如实时滤镜），把推理线程绑定到独立的大核 CPU 集群，并在 `android.gpu.counters` 里监控 GPU 利用率。理想情况下，渲染和推理用不同的 GPU 命令队列，创建 EGL context 时显式指定 `EGL_CONTEXT_PRIORITY_LEVEL_IMG`：

```cpp
const EGLint ctx_attribs[] = {
    EGL_CONTEXT_CLIENT_VERSION, 3,
    EGL_CONTEXT_PRIORITY_LEVEL_IMG, EGL_CONTEXT_PRIORITY_LOW_IMG,
    EGL_NONE
};
// 推理用低优先级 context，渲染用高优先级
```

**算子融合减少搬运**。这一步花的时间最多，收效也最明显。通过 Perfetto trace 确认，模型中 Conv + BatchNorm + ReLU 这类连续算子分开执行时，会产生 3 次 DMA 往返。用 `QNN Graph Optimizer` 做算子融合后，3 次搬运变 1 次，推理延迟降低约 22%。这个优化的代价是模型需要重新导出，不能在线做，但收益足够覆盖成本。

## 把性能分析变成可复用的流程

做完这套下来，形成了一个固定的分析套路，后续几个项目反复用：

1. `ATrace` 打点拆解推理 Pipeline 各阶段耗时
2. Perfetto ftrace 看 NPU 驱动线程的调度延迟
3. GPU counter 看频率爬升速度与利用率缺口
4. 对比 GPU/DDR 频宽找带宽瓶颈
5. 针对最严重的瓶颈定向优化，**一次只改一个变量**

最后一点尤为重要。端侧 AI 推理的性能调优变量太多——量化精度、内存布局、线程亲和性、GPU 频率策略。一次改多个，trace 数据没法归因到具体优化措施，调参变成玄学。

目前在骁龙 8 Gen 3 上跑 1.5B 模型，经过这套优化后 token 生成速度从 18 token/s 提升到 35 token/s，首 token 延迟从 680ms 降到 280ms。数字本身不是重点，重点是手里有了一套可以度量、归因、迭代的分析体系——代码跑得快不是玄学，trace 里全写着。
