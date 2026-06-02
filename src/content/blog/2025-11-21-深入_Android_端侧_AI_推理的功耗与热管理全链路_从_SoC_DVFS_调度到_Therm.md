---
title: 深入 Android 端侧 AI 推理的功耗与热管理全链路：从 SoC DVFS 调度到 Thermal Throttling 的性能稳定性工程实践
excerpt: 本文从端侧 LLM 持续推理的性能退化问题出发，剖析 GPU 功耗画像、DVFS 调度与 Thermal Throttling 机制，提出双层温控感知的负载调度方案，将长时间推理的 P99 延迟从 890ms 压至 380ms。
publishDate: '2025-11-21'
tags:
- Android
- 端侧AI
- 性能优化
- 功耗管理
- Thermal Throttling
seo:
  title: 深入 Android 端侧 AI 推理的功耗与热管理全链路：从 SoC DVFS 调度到 Thermal Throttling 的性能稳定性工程实践
  description: 端侧 AI 推理持续几分钟后延迟暴涨？本文剖析 SoC DVFS 调度与 Thermal Throttling 机制，从功耗画像到双层温控感知负载调度，分享将 P99 延迟从 890ms 优化到 380ms 的工程实践。
---

去年做一个端侧 LLM 实时翻译应用时，遇到了一个很头疼的问题：前 3 分钟推理延迟稳定在 120ms，之后开始跳到 300ms、500ms，甚至偶发 2 秒以上的卡顿。Logcat 里 ThermalService 频繁报 `CPU Mitigation`，设备表面温度早就过了 45°C。

性能不是写在 benchmark 里的数字，它是烧出来的。

## 端侧推理的功耗画像：GPU 成了新热点

传统移动 App 的功耗压力集中在 CPU 和屏幕。端侧 AI 推理把这个格局翻了个面。

在 Snapdragon 8 Gen 3 上跑一个 3B 参数的量化模型，持续推理时的功耗分布大致是这样：

| 组件 | 峰值功耗 | 持续推理占比 |
|------|---------|------------|
| GPU/NPU | 3.8W | 52% |
| CPU (调度+前后处理) | 1.5W | 21% |
| DRAM | 1.2W | 17% |
| 其他 (总线/编解码) | 0.7W | 10% |

GPU 吃掉了超过一半的功耗预算。这和跑 benchmark 完全是两回事——benchmark 通常一轮结束，热量来不及积累。持续推理场景下，**稳态功耗才是真正的约束**，峰值性能更多是纸面数字。

实际项目中我做过一组对比：同一模型在室温 25°C 下，短跑（5 次推理取均值）延迟 85ms；连续推理 5 分钟后延迟爬到 220ms。性能退化 158%，全是温控降频造成的。

## SoC 热管理的第一道防线：DVFS 调度

Android 的 DVFS（Dynamic Voltage and Frequency Scaling）是温控响应链路的起点。原理很直接：温度升高 → 降低频率和电压 → 减少发热 → 等待温度回落。

DVFS 的问题在于粒度。SoC 内部不同 IP 核——大核、中核、小核、GPU——各自有独立的频率档位和温控阈值。Android 框架层通过 Power HAL 把这些物理频率抽象为性能档位：

```cpp
// Power HAL 中定义的性能档位枚举
enum class PowerHint {
  SUSTAINED_PERFORMANCE,  // 持续性能：GPU 中等频率
  VR,                      // VR 场景：固定高帧率
  INTERACTION,             // 触控交互：CPU 快速提频
  // 端侧 AI 推理的新增档位
  ML_INFERENCE_LOW_LATENCY,    // 低延迟推理
  ML_INFERENCE_ENERGY_EFFICIENT // 能效优先推理
};
```

实际开发中，调用 Power HAL 只需要几行代码：

```kotlin
// 推理前请求高性能档位
val powerManager = context.getSystemService<PowerManager>()
val lowLatencyHint = powerManager.createPowerHint(
  PowerHint.ML_INFERENCE_LOW_LATENCY
)

try {
  lowLatencyHint.acquire()
  // 执行模型推理
  interpreter.run(input, output)
} finally {
  lowLatencyHint.release() // 推理结束立即释放
}
```

这套 API 在 Android 14 中引入，本质是对底层 CPUFreq Governor 的上层封装。但它的作用范围有限——**Power HAL 只能建议调度器调频，绕不过 Thermal HAL 的硬限频。**

## Thermal Throttling：DVFS 不够用的时候

DVFS 是柔性的，渐进降频。Thermal Throttling 是硬性的，直接关核或强制最低频。触发路径如下：

```
SoC 温度传感器 → Thermal Core (内核驱动)
  ├─ 轻度：通知 DVFS Governor 降低频率
  ├─ 中度：CPU/GPU Migration (大核任务迁移到小核)
  └─ 重度：CPU Hotplug (关闭大核)、GPU 强制最低频
```

在 Pixel 8 Pro 上实测，持续推理大约 4 分钟后 GPU 温度到 48°C，触发 `GPU_MITIGATION`。此时 GPU 频率从 900MHz 被硬拉到 315MHz，推理延迟从 130ms 飙到 410ms。

恢复曲线更麻烦。温度降到安全线以下后，频率不会立刻回升——Thermal Service 有一个退避（hysteresis）机制，需要温度持续低于阈值 10 到 15 秒才逐步恢复。延迟曲线呈现"过山车"形态：先爬升、再骤降、又慢慢回弹。

## 双层温控感知的负载调度

单靠系统调度不够。我在应用层做了一套温控感知的调度方案，思路很简单：**在温度恶化之前主动调整负载分布，而不是等系统硬降频后再被动响应。**

### 第一层：模型级负载拆分

端侧推理的负载粒度可以在模型级别拆分：

```python
# 推理引擎侧的温控感知负载策略
class ThermalAwareScheduler:
    def __init__(self, threshold_warn=40.0, threshold_critical=46.0):
        self.threshold_warn = threshold_warn      # 警告温度
        self.threshold_critical = threshold_critical  # 严重温度
    
    def select_delegate(self, current_temp: float):
        if current_temp < self.threshold_warn:
            # 正常：GPU + FP16
            return "GPU_FP16"
        elif current_temp < self.threshold_critical:
            # 警告：混合执行，大算子走 GPU，小算子走 CPU
            return "HYBRID_INT8"
        else:
            # 严重：全部切 CPU + INT8，GPU 只做小负载
            return "CPU_INT8"
```

用精度换温度。温度正常时跑 FP16 保质量，温度升高后切 INT8 降计算密度，持续升温则完全放弃 GPU。

### 第二层：帧间散热窗口

持续推理场景下，每一帧之间天然存在间隔——这个间隔就是散热的黄金窗口：

```kotlin
// 推理循环中加入主动散热调度
var lastInferenceEnd = 0L
val minInterval = when (thermalState) {
  ThermalStatus.STATUS_NONE -> 0L       // 温度正常，不插入间隔
  ThermalStatus.STATUS_LIGHT -> 50L    // 轻微升温，插入 50ms
  ThermalStatus.STATUS_MODERATE -> 150L // 中度升温，插入 150ms
  ThermalStatus.STATUS_SEVERE -> 500L   // 严重升温，大幅降帧率
  else -> 0L
}

if (SystemClock.elapsedRealtime() - lastInferenceEnd < minInterval) {
  delay(minInterval) // 等温度降下来再跑下一帧
}
```

Android 10 引入的 Thermal API 可以直接拿温控等级，省去自己读传感器的麻烦：

```kotlin
val thermalManager = context.getSystemService<ThermalManager>()
thermalManager.addThermalStatusListener { status ->
  // status: STATUS_NONE / LIGHT / MODERATE / SEVERE / CRITICAL / EMERGENCY
  this.thermalState = status
  adjustInferenceStrategy(status)
}
```

这套组合拳上去后，同一设备 10 分钟持续推理的 P99 延迟从 890ms 压到了 380ms，2 秒以上的极端卡顿没有再出现过。

## 踩过一个坑：频率锁的正确用法

早期方案里我直接用 `PowerManager` 的 `acquire` 锁定高频，企图跟温控降频硬刚。结果不但没用，还触发了更激进的降频——系统检测到持续功耗异常，直接关掉一个大核。

**频率锁不是用来对抗温控的。** 它的正确用法是：在温度安全区间内，防止调度器主动降频导致推理延迟抖动。一旦温度进入警告区间，主动释放锁、降低负载，而不是死扛。

更实用的做法是结合系统提供的 CPU 频率信息做决策：

```kotlin
// 读取各核心当前频率来判断真实的调度状态
fun getCpuFrequencies(): List<Int> {
  val freqs = mutableListOf<Int>()
  for (cpu in 0 until Runtime.getRuntime().availableProcessors()) {
    val freqFile = File("/sys/devices/system/cpu/cpu$cpu/cpufreq/scaling_cur_freq")
    freqs.add(freqFile.readText().trim().toIntOrNull() ?: 0)
  }
  return freqs
}
```

当大核频率低于中核频率时，说明系统已经进入温控降频状态。这时候再持有频率锁没用，应该立刻切到轻量推理模式。

## 三条实战经验

**把温控测试写进 CI。** 跑一遍 benchmark 看不出问题。在温箱环境里跑 30 分钟持续推理，记录完整的延迟-温度-频率曲线。很多性能回归要到 10 分钟后才暴露。

**模型量化不要只盯着精度看。** INT8 量化的收益不光是模型变小，更关键的是降低了推理时的发热密度。在温控严格的设备上，INT8 模型的稳定态延迟经常优于 FP16。

**监控频率，不是只看延迟。** 延迟上升是结果，频率下降才是原因。性能面板里同时展示各核心和 GPU 的实时频率，出问题一眼就能判断是温控降频还是其他原因。
