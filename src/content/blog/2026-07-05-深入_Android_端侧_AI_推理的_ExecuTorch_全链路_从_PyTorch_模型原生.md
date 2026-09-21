---
slug: android-executorch-android-deployment
translationKey: android-executorch-android-deployment
title: 深入 Android 端侧 AI 推理的 ExecuTorch 全链路：从 PyTorch 模型原生导出到 Android 端部署的零转换推理引擎实践
excerpt: 本文深入分析 ExecuTorch 在 Android 端的全链路实践，从 PyTorch 模型原生导出到 .pte 文件部署，对比 LiteRT 性能表现，剖析 AOT 委托机制与常见坑点，帮助开发者做出选型判断。
publishDate: '2026-07-05'
tags:
- Android
- PyTorch
- ExecuTorch
- 端侧AI
- 模型部署
seo:
  title: Android 端侧 ExecuTorch：PyTorch 模型导出与零转换推理
  description: 深入分析 ExecuTorch 在 Android 端的全链路实践，从 PyTorch 模型原生导出到端侧部署，对比 LiteRT 性能表现，剖析 AOT 委托机制，帮助开发者做出选型判断。
  pageType: article
---

去年在做端侧图像分割时，我把一个训好的 PyTorch MobileNetV3 模型转成 TFLite，折腾了两天——算子不兼容、动态 shape 丢失、量化精度下降。当时的想法是：**为什么 PyTorch 模型非得经过 TFLite 这座桥？**

ExecuTorch 给出的答案是：不用桥。

## 绕不开的格式转换之痛

PyTorch 模型在 Android 端落地，传统路径大致是：

```
PyTorch → ONNX → TFLite / TensorFlow Lite
```

每一步转换都可能引入新问题。ONNX 导出时，`torch.onnx.export` 对动态控制流的支持有限，`if` 分支和 `for` 循环常常被展开成静态图，模型体积膨胀。到了 TFLite 这一步，算子覆盖度是主要瓶颈——PyTorch 生态里新出的 `torch.nn.functional.scaled_dot_product_attention` 在 TFLite 里根本没有对应实现。

调试更让人头疼。转换过程的错误信息通常是"某算子不支持"，你只能回退到 PyTorch 侧，用更保守的算子重写模型，再走一遍转换流程。这个循环走一次就是半天。

## ExecuTorch 的解决思路

ExecuTorch 是 PyTorch 官方推出的端侧推理引擎，核心思路是：**PyTorch 模型直接导出、直接在端侧运行，不需要跌代中间格式（如 ONNX/TFLite）作为桥接**。但这不意味着“零转换”——它需要经过 `torch.export` 图捕获、可选的量化、向后端的分区/委托（delegate/partition）以及 AOT 编译这一套完整的处理链路，只是这些步骤都发生在“PyTorch 世界”内部，不用跨过 ONNX/TFLite 这样的第三方中间格式。

它的工作流大致分为几步：

```python
# 1. 导出：PyTorch 模型 → 图捕获 → Edge 方言图 → 可选向后端委托/量化 → .pte
from executorch.exir import to_edge_transform_and_lower
import torch

exported_program = torch.export.export(model, example_inputs)
edge_program = to_edge_transform_and_lower(exported_program, partitioner=[MyBackendPartitioner()])
executorch_program = edge_program.to_executorch()
with open("model.pte", "wb") as f:
    f.write(executorch_program.buffer)

# 2. 部署：.pte 文件直接丢进 Android 项目
```

`.pte`（ExecuTorch Program）是 ExecuTorch 的序列化格式，本质上是 `torch.export` 导出的计算图经过向 Edge IR 转换、可选后端委托和 AOT 编译优化后的产物。和 ONNX 不同，它不需要跨框架的中间表示层，导出的产物就是一张可以直接被 ExecuTorch Runtime 执行的图。

### 导出时做了什么

`torch.export` 和传统 `torch.jit.trace` 的核心区别在于：前者会对 Python 控制流做静态分析并要求得到一个固定的图，而后者只是记录一次前向传播的算子序列。

但这不意味着 `torch.export` 能任意保留 Python 动态分支。对于**数据依赖的**条件分支（如 `if tensor.sum() > 0: ...`），export 默认会报错或只导出其中一条分支，必须用 `torch.cond(pred, true_fn, false_fn, operands)` 显式改写才能被完整图捕获。对于仅依赖输入 shape/常量的控制流（如 Python 级 `if` 判断静态标志位），`torch.export` 会在导出时将其展开为具体分支对应的静态图，而不是保留分支本身。实际开发中，含数据依赖分支的模型（如动态早退、条件 attention）往往需要专门用 `torch.cond` 重写才能导出成功，这一步常常比预期少一些工作量。

导出管线里还有一个关键角色：**Delegate（委托）**。导出时可以将图中某些子图标记为可委托给特定后端执行，比如 NPU、GPU、Hexagon DSP。标记后的子图会在 `.pte` 中包含对应的后端标识信息，运行时由对应的 Delegate 接管。

## Android 端集成：比想象中轻量

ExecuTorch 在 Android 上的集成不依赖 Python 运行时，纯 C++ 实现，通过 JNI 暴露给 Java/Kotlin 层。

Gradle 依赖配置：

```kotlin
dependencies {
    implementation("org.pytorch:executorch:0.3.0")
    implementation("org.pytorch:executorch_android:0.3.0")
}
```

加载模型并执行推理：

```kotlin
val module = Module.load("/data/local/tmp/model.pte")
val inputs = arrayOf(Tensor.fromBlob(floatArray, longArrayOf(1, 3, 224, 224)))
val outputs = module.forward(inputs)
val result = outputs[0].toTensor().dataAsFloatArray
```

代码量比 TFLite 的同功能实现少 1/3 左右，主要是省去了 `Interpreter` 的 `resizeInput` / `allocateTensors` 等模板代码。Runtime 在 `forward()` 调用时自动完成内存分配和算子调度。

### 线程模型

ExecuTorch 的 Runtime 默认是单线程同步执行，但预留了 `Method` 级别的并行接口：

```cpp
// C++ 层：创建多个 Method 实例并行推理
auto method1 = module->getMethod("forward");
auto method2 = module->getMethod("forward");
// 分片输入，各自 run
```

实际项目中，我更倾向于在 Kotlin 层用协程管理并行度，而不是在 C++ 层做线程池——Android 的线程调度对 Java 线程更友好，且能复用已有的协程基础设施。

## 委托机制：性能的关键

ExecuTorch 的委托（Delegate）机制是它与 LiteRT 拉开差距的地方。LiteRT 的委托（如 GPU Delegate）是在运行时动态选择后端，而 ExecuTorch 的委托是 **AOT 编译时决定的**。

### 两种委托方式

**Partitioner 委托**：在导出阶段，用 `to_backend` API 将特定子图编译为目标后端代码：

```python
from executorch.exir.backend.test_backend import TestBackend

exported_program = torch.export.export(model, example_inputs)
delegated = exported_program.to_backend(TestBackend())
```

**Composite 委托**：将多个算子融合成一个复合算子，交给后端一次性执行。这更适合 GPU 场景，能减少 CPU-GPU 之间的数据传输次数。

### 为什么 AOT 委托更优

运行时委托（LiteRT 的方式）需要在 `model.load()` 阶段做图匹配——扫描整个计算图，找到 GPU 支持的算子，插入数据传输节点。这个过程的耗时在 50-200ms 之间，对冷启动敏感的场景（如相机实时推理）是额外的开销。

AOT 委托在导出时就把这些工作做了，`.pte` 文件里已经是“分区好的图”，加载即用，运行时不需要重新扫描图做后端匹配。代价是 `.pte` 文件失去了后端无关性——一个针对 Qualcomm HTP 导出的 `.pte`，在 Mali GPU 上跑不了。但这在移动端场景下不是问题，你本来就要按设备分发不同的 ABI。

具体能获得多大的加载速度提升，取决于模型图的复杂度、委托的子图比例以及对比的运行时实现，本文不给出笼统的百分比数字，建议在自己的目标设备和模型上实测。

## 与 LiteRT 的性能对比

我在同一 ResNet-50 模型（PyTorch 导出 vs TFLite 转换）上对比过 ExecuTorch 和 LiteRT 的表现。具体数字随设备、模型、量化方案及框架版本波动很大，这里不列具体数值，只给定性结论（若需准确数据请在目标机型上自行基准测试）：

- **CPU 推理**：两边差异不大。LiteRT 依靠 XNNPACK 多年优化，在某些模型上可能略优；ExecuTorch 的 CPU 后端（XNNPACK delegate 或 portable kernels）在常见网络上基本可以打平。
- **模型加载**：由于 AOT 委托免去了运行时图匹配，ExecuTorch 在启动阶段通常能快于使用运行时委托机制的 LiteRT GPU Delegate，但具体幅度需实测。
- **内存占用**：两者差异一般不显著，与模型结构、量化方案关系更大。

GPU 推理方面，ExecuTorch 目前通过 Vulkan Delegate 支持，但成熟度还不如 LiteRT 的 GPU Delegate，算子覆盖度和调优程度上仍有差距。ExecuTorch 团队正在补这块，但现阶段如果 GPU 推理是刚需，LiteRT 还是更稳的选择。

## 实践中的几个坑

**第一个坑：动态 shape 支持有限**。`torch.export` 要求导出时 shape 固定，动态 batch 需要手动用 `dynamic_shapes` 参数声明。但端侧 ExecuTorch Runtime 目前对动态 shape 的支持还不完整，建议导出时固定所有维度。

**第二个坑：算子覆盖度**。ExecuTorch 的算子库（`kernels/portable`）覆盖了大部分常用算子，但 `torch.fft`、`torch.linalg` 等高级算子还没移植。遇到不支持的算子会直接 crash，不会降级到 CPU 实现。建议在导出阶段用 `executorch.exir.verification` 做一遍算子校验。

**第三个坑：多模型管理**。当前 ExecuTorch 的 `Module` 实例互不共享 Runtime，每个模型独立加载自己的算子注册表。跑 3 个模型就是 3 份算子注册表的内存开销。对于端侧多模型场景，建议用 `Program` API 将多个模型打包到一个 `.pte` 文件里，共用一份 Runtime。

## 选型判断

如果你的场景是「PyTorch 训练、端侧部署、模型迭代快」，ExecuTorch 省掉的格式转换时间就值回票价。尤其是模型里有自定义算子或动态结构时，TFLite 转换链路经常需要手写 custom op 甚至改模型，而 ExecuTorch 直接导出就能跑。

如果你的场景是「GPU 推理性能优先、模型结构稳定」，LiteRT 的 GPU Delegate 在成熟度和性能上目前还是领先的。等 ExecuTorch 的 Vulkan 和 Qualcomm HTP 委托成熟后，这个差距会缩小——但那是半年后的事。

不要为了用 ExecuTorch 而用 ExecuTorch。如果当前的 TFLite 转换链路跑得顺畅，没有算子兼容性问题，就没必要迁移。ExecuTorch 的价值在于消除转换链路本身，而不是取代一个已经正常工作的链路。
