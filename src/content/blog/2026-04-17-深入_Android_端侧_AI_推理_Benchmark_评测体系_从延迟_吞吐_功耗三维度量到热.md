---
title: 深入 Android 端侧 AI 推理 Benchmark 评测体系：从延迟/吞吐/功耗三维度量到热影响下的性能退化分析
excerpt: 本文介绍 Android 端侧 AI 推理的 Benchmark 评测体系，从延迟、吞吐、功耗三维度出发，深入分析热影响下的性能退化问题，并提供自动化评测框架。
publishDate: '2026-04-17'
tags:
- Android
- AI推理
- Benchmark
- 性能优化
- 功耗优化
seo:
  title: 深入 Android 端侧 AI 推理 Benchmark 评测体系：从延迟/吞吐/功耗三维度量到热影响下的性能退化分析
  description: 深度解析 Android 端侧 AI 推理 Benchmark 评测方法论，涵盖延迟/吞吐/功耗三维度量、温控降频对性能的影响分析，以及自动化评测框架的设计与实现。
---

去年做端侧 LLM 推理优化时，同一个模型、同一台设备，上午和下午跑出的延迟差了近 40%。查了一圈，后台进程没问题——原因出在设备温度上，从 32°C 升到 45°C，SoC 自动降频了。

这件事让我意识到，端侧 AI 推理的评测远比服务器端复杂。跑一遍 `benchmark_model` 拿到的数字，在真实场景中几乎没参考价值。

## 延迟、吞吐、功耗：三个维度的相互制约

服务端评测盯住吞吐量就够了，GPU 集群按秒计费。但端侧完全不同：有人在聊天界面等回复，**首 Token 延迟（TTFT）** 决定体验；后台语音转文字持续跑，**吞吐量** 影响处理速度；功耗直接关联续航和发热——缺少任何一个维度，评测结论都会跑偏。

这三个维度互相约束：

- 压低延迟就得拉高 CPU/GPU 频率，功耗立刻飙上去
- 追求吞吐量要做大规模并行推理，热量迅速累积，触到温控线后延迟反而恶化——P99 能翻两三倍
- 限制频率来省电，延迟和吞吐一起退化

问题来了：怎么在一个测试框架里，稳定地拿到这三个维度的可信数据？

## 延迟测量：绕过 Android 的几个坑

延迟的公式很简单——输入到输出的时间差。但 Android 上实现准确的延迟测量，有几个细节不注意就会踩坑。

### SystemClock 还是 currentTimeMillis

```kotlin
val startNanos = System.nanoTime()
val output = interpreter.run(inputs)
val endNanos = System.nanoTime()
val latencyUs = (endNanos - startNanos) / 1000
```

必须用 `System.nanoTime()` 或 `SystemClock.elapsedRealtimeNanos()`。`currentTimeMillis()` 受系统时间调整影响——NTP 同步或用户手动改时间都会让数据变得不可靠。

### 冷启动和热启动差了多少

模型首次加载时，Runtime 要做算子编译、内存分配和权重布局优化。第二次推理通常比第一次快 20%–50%。我习惯这样区分：

```kotlin
// warm-up: 前 3 次推理不计入统计
repeat(3) { interpreter.run(inputs) }
// 实际测量
val latencies = mutableListOf<Long>()
repeat(50) {
    val start = System.nanoTime()
    interpreter.run(inputs)
    latencies.add((System.nanoTime() - start) / 1000)
}
```

### P50 和 P99：为什么长尾比均值重要

均值会掩盖偶发的高延迟。端侧推理受 CPU 调度和内存回收影响，P99 远超 P50 很常见。我通常同时记 P50 / P90 / P99——当 P99 超过 P50 的 3 倍时，基本可以断定存在调度抖动，需要进一步排查。

### GPU 延迟的隐蔽问题

`run()` 调用返回时，GPU 指令可能还在命令队列里没执行完。直接掐表会漏掉真正的计算耗时。正确做法是推理后插一个同步等待：

```kotlin
// GPU delegate 需要 waitOnSync
interpreter.runForMultipleInputsOutputs(inputs, outputs)
gpuDelegate.waitOnSync()
val latency = (System.nanoTime() - start) / 1000
```

Qualcomm SNPE 和 MediaTek NeuroPilot 同理，各自的 runtime API 都提供了 fence/sync 机制。忽略这一步，GPU 延迟数据会系统性偏低。

## 吞吐量测量：控制功耗状态

吞吐量对系统状态非常敏感。同一设备在不同电量或温度下，吞吐量差异可以超过 30%。为了拿到可复现的数据，我定了几个硬性约束。

**固定性能模式**。测试前通过 WindowManager 锁定性能模式，避免动态调频干扰：

```kotlin
val window = activity.window
window.attributes = window.attributes.apply {
    preferredRefreshRate = 60f // 固定刷新率
}
```

更底层的做法是改 `/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor` 为 `performance`，不过需要 root。

**批量推理策略**。吞吐量测试的核心是让推理管线始终满载。我用生产者-消费者模型，保持队列不空：

```kotlin
val executor = Executors.newFixedThreadPool(4)
val results = ConcurrentLinkedQueue<Long>()
// 4 线程并发，每线程连续执行 200 次
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
val totalTime = results.sum() / 1000 // 微秒
val throughput = (4 * 200) / (totalTime / 1_000_000.0) // 次/秒
```

**控制变量**。测试前关闭蓝牙、WiFi 扫描和后台同步，用飞行模式跑。这些条件看起来苛刻，但不做的话，不同轮次的吞吐量波动大到没法对比。

## 功耗测量：三个精度层级

Android 端侧功耗测量，从粗到细有三个选择。

**BatteryManager 估算**，精度最粗。只能拿到整机毫安时增量，分不出模块功耗。快速对比够用，精细分析靠不住。

**`dumpsys batterystats`**，能拆分出 CPU/GPU/Modem 各模块的功耗估算。数据来自 PowerProfile，各家厂商的 PowerProfile.xml 准确度参差不齐——Pixel 相对可靠，国产中低端机型偏差明显。

**硬件功耗仪**，精度最高。Monsoon 或 Yokogawa 功耗仪直接测整机电流，精度到毫安级。配合 Perfetto 做时间对齐，可以精确到每次推理的能耗：

```bash
# 用 Perfetto 打点标记推理区间
atrace --async_start -b 4096 gfx input view
# 推理代码中插入 trace marker
Trace.beginSection("Inference")
interpreter.run(inputs)
Trace.endSection()
```

把功耗仪的电流数据按时间轴积分，算出单次推理能耗（mAh 或 mJ）。做量化模型对比时这是标准流程——量化前后功耗差有时不到 5%，软件估算根本分辨不出来。

## 热影响：Benchmark 不可复现的根源

回到开头那个问题。端侧 SoC 都有严格的温控策略，以高通骁龙为例：

| 温度区间 | CPU 大核频率 | GPU 频率 | 策略 |
|----------|-------------|----------|------|
| < 40°C | 满频 | 满频 | 无限制 |
| 40-45°C | 降至 2.0GHz | 满频 | CPU 开始降频 |
| 45-50°C | 降至 1.5GHz | 降至 400MHz | CPU+GPU 降频 |
| > 50°C | 降至 1.0GHz | 降至 200MHz | 严重降频，强制冷却 |

我实测过一组数据：连续跑 5 分钟推理，设备温度从 32°C 升到 48°C，延迟从 85ms 退化到 230ms——2.7 倍。不控制温度变量，两次测试的结论可能完全相反。

### 热退化的工程化测量

我设计的测试分四个阶段：

1. **冷机阶段**：设备休眠 30 分钟后开始测试，温度基线统一在 30-32°C
2. **升温阶段**：持续推推理请求，每秒采样延迟和温度
3. **热稳定阶段**：温度达到 45°C 以上，持续运行并记录性能退化曲线
4. **降频恢复**：停止推理，观察温度回落后性能多久恢复

用 `ThermalManager` 实时读取温度状态：

```kotlin
val thermalManager = getSystemService(ThermalManager::class.java)
thermalManager.addThermalStatusListener { status ->
    when (status) {
        ThermalManager.THERMAL_STATUS_NONE -> "正常"
        ThermalManager.THERMAL_STATUS_LIGHT -> "轻度温控"
        ThermalManager.THERMAL_STATUS_MODERATE -> "中度温控"
        ThermalManager.THERMAL_STATUS_SEVERE -> "重度温控"
        ThermalManager.THERMAL_STATUS_CRITICAL -> "紧急温控"
        else -> "未知"
    }.let { Log.d("Thermal", "状态变化: $it") }
}
```

某款骁龙 8 Gen 2 设备上，从 `THERMAL_STATUS_NONE` 进入 `MODERATE` 时，推理延迟中位数从 45ms 涨到 88ms，P99 从 62ms 涨到 190ms。有意思的是，**延迟退化最快的不是高温区，而是 40-45°C 这个过渡带**——调度器在犹豫是否降频，频率在这段区间反复抖动。

### 热影响下的评测规范

基于实测数据，我定的规则：

- **报告冷机/热机两套数据**，标注各自的初始温度
- **长时测试（> 2 分钟）必须绘制延迟-温度曲线**，不能只给一个单点均值
- **对比不同模型时，初始温度偏差不超过 ±1°C**
- 功耗数据也分冷/热两段采集——热机功耗通常比冷机高 15%–25%

## 自动化评测框架

把上述维度整合成自动化流程，输出格式如下：

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

工具链推荐这套组合：**Perfetto（时序追踪）+ Monsoon Power Monitor（功耗打点）+ 自建 Runner（延迟/吞吐采集）**。三个工具的数据按 `SystemClock.elapsedRealtimeNanos()` 统一时间轴，后续分析可以直接关联。

这套框架的核心价值不是跑出漂亮的数字，而是回答两个问题：**性能退化什么时候发生、退化了多少**。一个冷机状态下看起来不错的模型，用户聊了三分钟后可能已经卡到不可用——Benchmark 就该在这时候告诉你真相。
