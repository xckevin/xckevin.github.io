---
title: 深入 Android 端侧 AI 推理的 ONNX Runtime 全链路：从 ONNX 模型导出到移动端推理引擎实战
slug: android-onnx-runtime-android-inference
translationKey: android-onnx-runtime-android-inference
excerpt: 本文梳理 ONNX Runtime 在 Android 端侧 AI 推理的完整链路，涵盖模型导出、集成配置、INT8 量化加速与算子兼容性踩坑实践。
publishDate: '2026-07-07'
tags:
- Android
- ONNX Runtime
- 端侧推理
- 模型量化
- 推理优化
seo:
  title: 深入 Android 端侧 AI 推理的 ONNX Runtime 全链路：从 ONNX 模型导出到移动端推理引擎实战
  description: 深入 Android 端侧 AI 推理全链路：从 ONNX 模型导出、Android 集成、INT8 动态量化到 XNNPACK 加速，详解 ONNX Runtime 在移动端的实战经验与踩坑记录。
---

半年前在做端侧图像分类，模型组给的是一份 PyTorch 导出的 `.pt` 文件。Android 端能直接跑吗？不能。当时的方案是上 PyTorch Mobile，但很快另一个场景的检测模型换成了 TensorFlow 训练的。

两台引擎、两套 API、两套优化策略——维护成本直接翻倍。

ONNX（Open Neural Network Exchange）解决的就是这件事：它是一套模型中间表示规范，让 PyTorch、TensorFlow、Keras 各框架的模型统一导出为 `.onnx` 格式，移动端用 ONNX Runtime 一套推理引擎执行就够了。

Android 端侧推理引擎矩阵里，NCNN、MNN、TFLite 各有优势，但 ONNX Runtime 的独特价值在于跨框架兼容——模型团队用什么框架训练，你都能兜底。

## 模型导出

PyTorch 导 ONNX 的代码：

```python
import torch

model = torch.load("model.pt", map_location="cpu")
model.eval()

dummy_input = torch.randn(1, 3, 224, 224)

torch.onnx.export(
    model,
    dummy_input,
    "model.onnx",
    input_names=["input"],
    output_names=["output"],
    dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
    opset_version=13
)
```

`dynamic_axes` 让 batch 维度可变。移动端推理通常 batch=1，但调试阶段可能批量跑验证，加上动态轴能免去重新导出的麻烦。

`opset_version` 决定算子集版本。版本越高支持的算子越新，但 ONNX Runtime 移动端不一定全兼容。实测下来 13 的覆盖度和兼容性平衡得最好，我一直定在这个版本。

TensorFlow 转 ONNX 用 `tf2onnx`：

```bash
python -m tf2onnx.convert \
  --saved-model ./tf_model \
  --output model.onnx \
  --opset 13
```

导出后务必用 Netron 打开 `.onnx` 文件检查计算图。偶尔能看到框架自动插入的冗余 Cast 或 Transpose 节点——用 `onnxsim` 工具精简掉，推理时就少了这些无效开销。

## Android 端集成

### 依赖配置

AAR 直接引入，不用折腾 NDK 编译：

```groovy
dependencies {
    implementation 'com.microsoft.onnxruntime:onnxruntime-android:1.17.1'
}
```

对包体积敏感的项目可以换 `onnxruntime-mobile`，裁掉了训练相关算子，体积小 40%，纯推理场景完全够用。

### 模型加载与推理

```kotlin
import ai.onnxruntime.*

class OnnxRunner(context: Context) {
    private val env = OrtEnvironment.getEnvironment()
    private var session: OrtSession? = null

    fun loadModel(modelPath: String) {
        session = env.createSession(modelPath)
    }

    fun run(floatInput: FloatArray): FloatArray {
        val session = session ?: throw IllegalStateException("model not loaded")
        val tensor = OnnxTensor.createTensor(env, floatInput, longArrayOf(1, 3, 224, 224))
        val outputs = session.run(mapOf("input" to tensor))
        val result = outputs.get("output").get().value as Array<FloatArray>
        return result[0]
    }
}
```

从 assets 加载模型不能直接传路径，需要先拷贝到内部存储：

```kotlin
fun copyFromAssets(ctx: Context, name: String): String {
    val file = File(ctx.filesDir, name)
    if (!file.exists()) {
        ctx.assets.open(name).use { input ->
            FileOutputStream(file).use { out -> input.copyTo(out) }
        }
    }
    return file.absolutePath
}
```

### Execution Provider

ONNX Runtime 支持多种计算后端。Android 上主要用 XNNPACK（CPU 优化库）和 NNAPI（硬件加速通道）：

```kotlin
val options = OrtSession.SessionOptions().apply {
    addCPU(true) // 启用 XNNPACK，浮点模型有 2~3 倍加速
    // addNnapi()  // 谨慎开启
}
session = env.createSession(modelPath, options)
```

NNAPI 这里有个坑：启用后部分设备推理结果直接全为零，关掉走 XNNPACK 立刻正常。NNAPI 的算子覆盖度和各厂商的设备兼容性目前还差一口气。线上默认只开 XNNPACK，NNAPI 做成可选项让用户手动开启，更务实。

## 量化与加速

### INT8 动态量化

浮点模型体积大、推理慢。ONNX Runtime 内置了量化工具：

```bash
python -m onnxruntime.quantization.quantize_dynamic \
  --input model.onnx \
  --output model_int8.onnx \
  --weight_type QUInt8
```

静态量化效果更好但需要校准数据集；动态量化不需要校准，精度损失控制在 1% 以内。骁龙 8 Gen1 上的实测：

| 指标 | FP32 | INT8 |
|------|------|------|
| 体积 | 46.8 MB | 13.2 MB |
| 推理耗时 | 18.7 ms | 8.3 ms |
| Top1 精度 | 69.8% | 69.2% |

精度掉 0.6 个百分点，换来体积缩减 70%、速度翻倍——值。

### 多线程调参

ONNX Runtime 默认单线程。移动端合理配置能再压榨一些性能：

```kotlin
val options = OrtSession.SessionOptions().apply {
    val cores = Runtime.getRuntime().availableProcessors()
    setIntraOpNumThreads((cores - 1).coerceAtLeast(1))
    setInterOpNumThreads(1)
    addCPU(true)
}
```

`intra_op_num_threads` 控制单个算子内部的并行度，`inter_op_num_threads` 控制算子之间的并行度。移动端计算图大多是串行链，inter 设 1、intra 设为核心数减一即可——留一个核给 UI 线程。

## 踩坑实录

切换引擎时最让我头疼的不是性能，而是算子兼容性。

一个图像模型用了 `GridSample` 算子，导出的 ONNX 在移动端直接报 `Unsupported Op`。ONNX Runtime mobile 裁剪了大量低频算子，遇到不支持的只能用等价操作重写模型。

另一个坑是输入格式。PyTorch 默认 NCHW 通道序，Android Bitmap 出来的数据是 HWC 或 NHWC。ONNX 模型不会自动帮你转，预处理阶段必须手动 transpose。这个问题排查了半天——推理结果数值全乱、但没报任何错误，所有数字看起来都"正常"，这种无声的错最要命。

还有一次，量化的 INT8 模型在部分中低端设备上直接崩溃，日志显示触发了 `std::bad_alloc`。量化工具的默认配置下，某些节点分配的内存超出了预期。解决方案是切到 per-channel 量化，牺牲一点速度换稳定性。

## 实践建议

导出用 opset 13。导出后用 Netron 检查计算图，确认没有框架插入的冗余节点，必要时跑一遍 `onnxsim` 简化。这个习惯能省掉推理时很多莫名其妙的问题。

默认开 XNNPACK，NNAPI 做成开关。NNAPI 的覆盖度还不够稳，线上直接开容易在冷门低端机上翻车。等 Google 再迭代几版 NNAPI 适配，情况应该会好转。

优先做动态 INT8 量化。不需校准集、精度损失可控、体积和速度收益显著——对大多数分类和检测场景，这是成本最低的优化路径。

输入预处理放在模型外部。归一化、通道转换这些逻辑用 Kotlin 写，出了问题一眼能看到，不用重新导出模型。这条适用所有端侧推理引擎，不止 ONNX Runtime。
