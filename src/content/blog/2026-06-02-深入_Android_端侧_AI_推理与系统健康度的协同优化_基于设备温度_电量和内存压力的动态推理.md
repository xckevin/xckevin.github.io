---
title: 端侧 AI 推理稳不住？温度、电量、内存三维协同降级策略
excerpt: 本文提出端侧AI推理的温度、电量、内存三维协同降级策略，通过归一化评分与木桶原理实现多维度仲裁，配合模型预加载与状态迁移，确保推理在资源受限设备上稳定运行。
publishDate: '2026-06-02'
tags:
- Android
- 端侧AI推理
- 性能优化
- 内存管理
- 降级策略
seo:
  title: 端侧AI推理稳不住？温度、电量、内存三维协同降级策略
  description: 端侧AI推理落地的三维协同降级策略详解：从温度、电量、内存三个维度建模，通过木桶原理实现自适应降级，结合模型预加载与状态迁移，在骁龙7系列设备上稳定运行30分钟以上。
---

做端侧 AI 推理落地时，我遇到一个经典场景：模型在实验室跑得流畅丝滑，一到真机上跑几分钟就崩。Logcat 刷出 `OOM` 和 `thermal throttle`，用户直接杀进程。

端侧推理和云端的根本区别在于：**设备不是无限资源池**。CPU 过热降频、内存吃紧杀进程、电量低了系统限制后台计算——这三件事在模型部署阶段很少被认真对待，上线后全是坑。

## 三维度建模

### 温度——最早预警、最常被忽略

Android Thermal 机制有六个等级，从 `STATUS_NONE` 到 `STATUS_CRITICAL`。多数开发者只在 `STATUS_CRITICAL` 时做处理，但 `STATUS_MODERATE` 阶段 SoC 已经开始降频了——等收到严重告警再反应，已经晚了。

通过 `PowerManager.addThermalStatusListener` 获取实时回调，而不是轮询：

```kotlin
powerManager.addThermalStatusListener { status ->
    when (status) {
        PowerManager.THERMAL_STATUS_MODERATE -> adjustFps(8)
        PowerManager.THERMAL_STATUS_SEVERE -> adjustFps(3)
        PowerManager.THERMAL_STATUS_CRITICAL -> suspendInference()
    }
}
```

在 MODERATE 就降级。降低推理帧率（正常 15fps → 8fps → 3fps）比直接卡死或闪退的体验好得多。帧率下降用户可能只是觉得"稍微有点不流畅"，而崩溃会让用户直接放弃使用。

### 电量——省电模式的隐性约束

省电模式开启后，系统不只是降低 CPU 频率，还会延迟 JobScheduler、对前台 Service 施加执行窗口限制。很多推理引擎的线程优先级会被系统静默调整，你根本感知不到。

```kotlin
val batteryPct = batteryManager.getIntProperty(
    BatteryManager.BATTERY_PROPERTY_CAPACITY)
val isSaverOn = powerManager.isPowerSaveMode

if (isSaverOn || batteryPct < 15) {
    switchToLiteModel()
}
```

踩过一个坑：`isPowerSaveMode` 在部分定制 ROM 上返回值不准。生产环境必须配合 `ACTION_POWER_SAVE_MODE_CHANGED` 广播做双重校验，否则某米某 OV 的机型上省电模式开了你的代码还以为没开。

电量维度的降级顺序有讲究：**先关非必要后处理**（美颜、超分）→ **再切小模型** → **最后降帧率**。先砍附加值低的计算，再动核心推理体验，这个顺序搞反了用户体感会很差。

### 内存——最棘手的无声杀手

模型加载几百 MB，推理时中间张量再分配几百 MB，在 6GB RAM 的设备上轻轻松松触发 LMK。Android 的 LMK 不区分"重要的推理任务"和"可回收的后台页面"——在它眼里都是可以杀的。

判断内存压力，我不用系统级的 `lowMemory` 信号，滞后性太强：

```kotlin
val runtime = Runtime.getRuntime()
val usedMem = runtime.totalMemory() - runtime.freeMemory()
val availMem = runtime.maxMemory() - usedMem

if (availMem < 200 * 1024 * 1024L) {
    triggerMemoryDegradation()
}
```

用运行时可用堆内存做判断，阈值设为模型峰值内存的 1.5 倍。`lowMemory` 收到时往往已经 OOM 了，主动监控可以在内存逼近警戒线之前就开始降级——这个时机差可能就几十秒，但足够救一命。

## 策略引擎——多维度优先级仲裁

单独看每个维度都不复杂，但温度和内存同时告警时，按谁的策略执行？需要一个仲裁层。

```kotlin
data class InferenceConfig(
    val modelType: ModelType,     // FULL / LITE / TINY
    val targetFps: Int,
    val postEffects: Set<String>  // 后处理开关
)

fun evaluate(dims: Map<String, Float>): InferenceConfig {
    val minScore = dims.values.minOrNull() ?: 1.0f
    return when {
        minScore >= 0.8f -> fullConfig()
        minScore >= 0.5f -> balancedConfig()
        minScore >= 0.2f -> lowPowerConfig()
        else -> minimalConfig()
    }
}
```

每个维度输出 0-1 的归一化分数，**取最小值决定全局策略**。木桶原理在这里直接适用——任何一个维度成为瓶颈，整个推理链路都应该降级。否则就会出现"内存已到警戒线但温度还正常于是继续跑大模型"的尴尬局面。

实测效果：骁龙 7 系列 + 6GB RAM 设备上，不加策略 8-12 分钟必 OOM；加入三级降级后稳定运行 30 分钟以上，温度控制在 42°C 以下。

## 模型切换的工程细节

降级路径需要准备多个模型——全量（FP16）、量化（INT8）、蒸馏版。切换时有两个容易忽视的点。

**预加载，别临时从磁盘读。** 收到 Thermal 告警后再加载模型本身就很耗 CPU，反而加剧发热：

```kotlin
val models = mapOf(
    ModelType.FULL  to Interpreter(loadBuffer("full.tflite")),
    ModelType.LITE  to Interpreter(loadBuffer("lite.tflite")),
    ModelType.TINY to Interpreter(loadBuffer("tiny.tflite"))
)
```

代价是额外 50-80MB 常驻内存。6GB 以上设备完全可接受，4GB 设备可以用 mmap 加载做折中——系统在内存紧张时自动回收物理页，访问时再缺页加载回来。

**状态迁移不能丢。** 视频流推理场景中，切换模型时上一帧的检测框历史、追踪 ID 等时序状态不能直接丢弃。我在切换过渡帧用上一帧结果做平滑插值，避免画面跳变。几行代码的事，不做的话用户会看到明显的闪烁，比帧率下降的体感糟糕得多。

## 落地后的几点判断

1. **降级阶梯三个等级够用。** 搞五六个等级意义不大——维护成本高，切换频繁反而引入不稳定性。full / balanced / minimal 覆盖了 95% 的场景。

2. **线上监控比调参重要。** 花了大量精力调阈值，最后发现最缺的是知道线上设备实际跑了什么策略。每次降级事件把触发原因、当前设备状态一并上报，否则优化永远没闭环——你不知道用户是真的跑了 minimal 还是根本没触发降级就崩了。

3. **给用户留一个手动开关。** 有些场景（录重要视频、直播），用户宁可发烫也不接受降级。一个"性能优先 / 功耗优先"的开关比策略引擎自己猜更准确。机器做默认决策，人做最终决策。

端侧 AI 推理的瓶颈往往不是模型精度，而是能不能稳定跑下来。三维协同降级本质上是**可用性工程**——先保证不崩，再追求好。
