---
title: 深入 Android NNAPI 全链路：从 HAL 硬件抽象到 Qualcomm/MTK NPU 厂商驱动的端侧 AI 推理加速架构
excerpt: 深入剖析 Android NNAPI 的全链路架构，从 HAL 硬件抽象层到 QNN/Neuron 厂商驱动，结合图分区、算子回退与真实踩坑经验，系统讲解端侧 AI 推理的加速原理、性能调优与选型决策。
publishDate: '2025-08-07'
tags:
- Android
- NNAPI
- 端侧AI推理
- 性能优化
- 硬件加速
seo:
  title: 深入 Android NNAPI 全链路：从 HAL 硬件抽象到 Qualcomm/MTK NPU 厂商驱动的端侧 AI 推理加速架构
  description: 深入剖析 Android NNAPI 全链路架构，从 HAL 硬件抽象到 QNN/Neuron 厂商驱动，详解图分区、算子回退与端侧 AI 推理性能调优实践。
---

## 一个 10 倍的性能差距

去年做端侧 OCR 项目时踩过一个坑：同一个 MobileNetV3 模型，Pixel 6 上跑 8ms，换到一台 MTK 中端机却要 85ms。排查后发现 Pixel 上 NNAPI 走了 GPU 加速，MTK 那台设备虽然内置了 APU，NNAPI 却没匹配到对应驱动，所有算子回退到了 CPU。

Android 生态的设备碎片化在 NNAPI 这个场景下尤为突出——同一套 API，不同 SoC 的执行路径完全不同。不搞清楚完整链路，端侧推理的性能调优基本靠猜。

## NNAPI 在 Android AI 栈中的生态位

NNAPI 不是推理框架，是一层**硬件加速抽象**。它在 Android AI 栈中的位置：

```
LiteRT / MediaPipe / AICore     ← 上层推理框架
        ↓
  NNAPI Runtime (libneuralnetworks.so)  ← 系统级服务
        ↓
  NNAPI HAL (AIDL / HIDL)       ← 硬件抽象层
        ↓
  厂商驱动 (.so)  ← QNN / Neuron / ENN
        ↓
  DSP / NPU / GPU / CPU         ← 物理硬件
```

上层框架不需要关心底层是 Hexagon DSP 还是 MTK APU，只需把模型交给 NNAPI Runtime，由它匹配可用的加速设备。这套架构从 Android 8.1 引入，到 Android 15 迭代了 7 个大版本，HAL 接口已经稳定。

## HAL 层的三个核心接口

NNAPI HAL 定义了驱动必须实现的接口，对应模型的生命周期：

```cpp
// AIDL 定义（Android 11+）
interface IDevice {
    // 1. 能力查询：返回支持的算子列表和性能等级
    Capabilities getCapabilities();

    // 2. 模型编译：将计算图转换为设备可执行格式
    IPreparedModel prepareModel(in Model model, ...);

    // 3. 创建执行上下文，绑定输入输出
    IExecution createExecution(in IPreparedModel preparedModel, ...);
}
```

`getCapabilities()` 返回的算子支持表是整个链路的第一道关卡。Runtime 据此做**图分区（Graph Partitioning）**——把模型拆成多个子图，分配给不同设备。

容易被忽略的是**内存路径**。NNAPI 支持用 `AHardwareBuffer` 在不同设备间共享张量，省掉 CPU-GPU-NPU 之间的数据拷贝。但前提是驱动实现了 `BURST` 模式和 `MemoryDomain` 扩展——很多早期驱动只做简单的 `mmap`，零拷贝优化根本没生效。

## 图分区与算子回退

Android 官方定义了 100+ 标准算子，每个设备只支持一个子集。Runtime 的处理流程：

1. 遍历模型所有算子
2. 查询每个算子被哪些设备支持
3. 按「最少跨设备传输」策略划分子图
4. 无加速器支持的算子归入 CPU 回退子图

分区默认用贪心算法——优先把连续算子分给第一个支持它们的设备。结果 GPU 子图 → NPU 子图 → CPU 子图交替出现，每次切换都触发显式内存拷贝：

```
// 典型分区日志
Subgraph 0: [Conv2D, ReLU, MaxPool] → QTI NPU
Subgraph 1: [Reshape] → CPU        ← 一个算子就切一次
Subgraph 2: [Conv2D, Softmax] → QTI NPU
```

这种「单算子回退」是性能杀手。更好的做法是在模型转换阶段用 **Delegate 白名单**控制分区：

```kotlin
val options = Interpreter.Options().apply {
    useNNAPI = true
    // 禁止 CPU fallback，不支持则直接报错
    setNnapiAllowFp16PrecisionForFp32(true)
}
```

`allowFp16PrecisionForFp32` 只是精度选项。要彻底关闭 CPU 回退，需设置 `ExecutionPreference::FAST_SINGLE_ANSWER` 并确认所有算子都有加速支持——做不到的话，这个模型不适合纯 NNAPI 路径。

## 厂商驱动：QNN 与 Neuron

### Qualcomm QNN（原 SNPE）

Qualcomm 的 AI 引擎栈从 SNPE 演进到 QNN，核心优势在**离线编译（Offline Compilation）**：

```bash
# QNN 离线编译
qnn-onnx-converter -i model.onnx -o model.cpp
qnn-model-lib-generator -c model.cpp \
  -b qnn_model.bin -t aarch64-android
```

编译后的 `.bin` 直接跑在 Hexagon DSP 上，跳过 Runtime 在线编译。Snapdragon 8 Gen 2 的 Hexagon 支持 INT4 精度和**微切片推理（Micro-Tile Inferencing）**，Transformer 类模型效率提升明显。

QNN 的版本管理是个坑：每个 SoC 平台绑定特定 SDK 版本，跨平台部署要维护多套编译产物。

### MTK Neuron Delegate

MediaTek 直接走 TFLite Delegate 路线，不依赖 NNAPI HAL：

```kotlin
val delegate = NeuronDelegate.create(
    NeuronDelegate.Options().apply {
        setPlatform(NeuronDelegate.Platform.MT6983)  // Dimensity 9000
        setOptimization(NeuronDelegate.Optimization.PREFER_FP16)
    }
)
val interpreter = Interpreter(model, options.addDelegate(delegate))
```

Neuron 绕过 NNAPI Runtime 的分区逻辑，直接接管整图推理。好处是避免了跨设备切换开销，代价是失去了算子兼容性保障——APU 不支持的算子直接崩溃。

实际项目中我更倾向用 Neuron 而非通用 NNAPI。MTK 平台上的 NNAPI HAL 实现往往滞后于 Neuron SDK 的功能更新，新 APU 的能力要等系统 OTA 才能通过 NNAPI 调用。

## 三个真实踩坑记录

**坑 1：动态 Shape 支持不一致**

NNAPI 1.3 引入动态 Shape，厂商实现参差不齐。同一个含 `tf.while_loop` 的模型，三星设备跑通，OPPO 设备卡死。最终方案：模型导出时固定所有维度，放弃动态 batch。

**坑 2：INT8 量化精度不互通**

Qualcomm 用对称量化，MTK 用非对称量化。模型在转换时没对齐量化方案，输出结果偏差超过 5%。我的做法是在 CI 中加精度校验节点，用余弦相似度对比 FP32 和 INT8 输出。

**坑 3：驱动版本不匹配导致静默降级**

Android 14 上 AIDL HAL 到了 V4，某些厂商仍用 V2。Runtime 检测到版本不匹配后**静默回退到 CPU**，logcat 里只有一条不起眼的 `W/NativeAllocationRegistry` 警告，不抓日志根本发现不了。

## 选型决策框架

端侧推理的技术选型，我按这个顺序做决策：

1. **模型算子集是否在目标 NPU 覆盖范围内？** 用 `getSupportedOperationsForDevices()` 先验证，别直接跑
2. **能否走离线编译？** QNN/Neuron 的离线路径比在线编译快 3-5 倍，优先考虑
3. **接不接受 CPU 回退？** 不接受就关 Fallback 且确保算子全支持；接受就把回退耗时纳入性能预算

NNAPI 的本质是各厂商驱动的统一入口，真正的加速效果取决于驱动质量。理解全链路不是为了用它的默认行为，而是为了在它出问题时知道往哪看。
