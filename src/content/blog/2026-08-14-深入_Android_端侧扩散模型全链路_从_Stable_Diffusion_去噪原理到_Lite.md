---
slug: android-on-device-stable-diffusion-litert
translationKey: android-on-device-stable-diffusion-litert
title: 深入 Android 端侧扩散模型全链路：从 Stable Diffusion 去噪原理到 LiteRT 移动端图像生成的工程实践
excerpt: 从 Stable Diffusion 去噪原理出发，拆解 LiteRT 移动端部署链路，通过 FP16 量化、LCM 蒸馏与按需加载把 Pixel 8 单图生成从 40 秒压到 3 秒以内。
publishDate: '2026-08-14'
tags:
- Android
- LiteRT
- Stable Diffusion
- 性能优化
- 移动端部署
seo:
  title: Android 端侧扩散模型：Stable Diffusion 去噪与 LiteRT 图像生成
  description: 从潜在扩散模型去噪原理到 LiteRT 移动端部署，拆解 Stable Diffusion 端侧优化全链路：FP16 量化、GPU Delegate、LCM 蒸馏与内存策略，将 Pixel 8 单图生成从 40 秒压到 3 秒。
  pageType: article
---

在 Pixel 8 上第一次跑通 Stable Diffusion 1.5 时，一张 512×512 图花了 40 秒，内存峰值 2.1GB。能跑，但离"可用"还有距离。优化过程中我逐渐摸到一个规律：如果不理解去噪循环里每一步在算什么，就很难分清哪些耗时是算法固有的、哪些是工程浪费。顺着「原理 → 部署 → 调优」的顺序，把这条链路拆开。

## 潜在空间：SD 能上手机的前提

Stable Diffusion 属于「潜在扩散模型（Latent Diffusion Model, LDM）」。它不在 512×512 像素空间里做扩散，而是先用「变分自编码器（VAE）」把图像压缩到 64×64×4 的潜在空间（Latent Space）。以 SD 1.5 的典型配置（512×512×3 图像、8 倍下采样、4 通道潜在表示）计算，空间尺寸压缩 64 倍，考虑通道数变化后张量元素总量约缩小到原图的 1/48——这是 SD 1.x/2.x 常见配置下的典型压缩比，不同模型版本或潜在通道数设置下具体数值会变化。这层压缩决定了端侧可行性：去噪计算全部发生在低维空间，UNet 每次处理的张量规模大幅缩小。

完整模型由三个独立网络组成：**Text Encoder**（CLIP ViT-L/14）把 prompt 编码成 77×768 的文本向量；**UNet** 负责迭代去噪，参数约 860M，是计算和内存的大头；**VAE Decoder** 把去噪后的 latent 还原成图像。三者只在推理时按序组合，这为端侧按需加载留出了空间。

前向扩散过程是逐步加噪：给真实图像的 latent `z0` 反复加入高斯噪声，T 步后逼近纯噪声 `zT`。反向过程则训练 UNet 预测每一步加进去的噪声，从 `zT` 一步步还原到 `z0`。生成图像，就是把这个反向去噪过程完整跑一遍。

## 去噪循环：每一步在算什么

推理时从随机高斯噪声出发，循环 T 步。单步逻辑可以概括为：

```python
# 伪代码：单次去噪步骤
def denoise_step(unet, z, t, text_emb, guidance_scale=7.5):
    eps_uncond = unet(z, t, null_emb)      # 无条件预测
    eps_cond = unet(z, t, text_emb)        # 有条件预测
    # CFG：放大条件预测相对无条件预测的偏移
    eps = eps_uncond + guidance_scale * (eps_cond - eps_uncond)
    return scheduler.step(eps, t, z)       # 调度器算出 z_{t-1}
```

这一步里有两个容易被忽略的端侧成本。**Classifier-Free Guidance（CFG）** 每一步要做两次 UNet 前向：一次带文本条件、一次带空条件。`guidance_scale=7.5` 意味着无条件预测的权重被压到负值区间，靠两次前向的差值把生成结果"拉向" prompt 描述的分布。每步计算量因此翻倍。

调度器（Scheduler）决定 T 取多少。DDPM 原始设定是 1000 步，DDIM 和 DPM-Solver 把步数降到 20~50 步且质量可接受。移动端通常从 20 步起步，再往下压要靠蒸馏模型。

## LiteRT 部署：量化、Delegate 与内存

「LiteRT」是 Google 2024 年启用的运行时品牌，前身是 TensorFlow Lite。部署链路通常是：PyTorch 权重 → ONNX → TensorFlow SavedModel → `.tflite`，全程用 `ai-edge-torch` 或 `onnx2tf` 这类工具完成转换。

量化要按网络分开看。UNet 对 INT8 敏感，权重级 per-channel 量化可行但需要校准数据集，生成质量会有可见下降。我的选择是**全程 FP16**：模型体积减半，精度损失可忽略，手机 GPU 原生支持 FP16 计算。实际项目中 FP16 的 SD 1.5 UNet 约 1.7GB，CLIP 文本编码器约 246MB，VAE 约 168MB，加起来超过 2GB——这就是前面内存峰值 2.1GB 的来源。

LiteRT 目前提供两套 Android 推理 API：面向新项目、支持 CPU/GPU/NPU 统一调度的 `CompiledModel` API，以及为兼容旧代码保留的 `Interpreter` API（`org.tensorflow.lite.Interpreter`）。用 `CompiledModel` API 加载 UNet 大致是这样：

```kotlin
// 加载模型并指定加速器（此处选 GPU）
val compiledModel = CompiledModel.create(
    unetModelPath,
    CompiledModel.Options(Accelerator.GPU)
)

// 预分配输入输出 buffer
val inputBuffers = compiledModel.createInputBuffers()
val outputBuffers = compiledModel.createOutputBuffers()

// 写入 latent / timestep / text embedding 等输入
inputBuffers.get(0).writeFloat(latentBuffer)          // [1,4,64,64] FP16
inputBuffers.get(1).writeFloat(tBuffer)               // 标量
inputBuffers.get(2).writeFloat(textEmb)               // [1,77,768] FP16

// 执行推理
compiledModel.run(inputBuffers, outputBuffers)

// 读取输出
val noise = outputBuffers.get(0).readFloat()
```

GPU 加速跑 FP16 最快，但受纹理/显存限制，UNet 单层超过一定尺寸时部分算子可能回落到 CPU。旧版 `Interpreter` API 搭配 `GpuDelegate`（`org.tensorflow.lite.gpu.GpuDelegate`）也能实现类似效果，但 Google 目前建议新项目直接用 `CompiledModel`，它会根据设备情况在 CPU/GPU/NPU 间自动选择。我的建议是：**主用 GPU/NPU 加速，保留 CPU 回退路径**，低端机至少能出图。

## 工程调优：步数、解码器与内存策略

纯靠 20 步去噪，Pixel 8 上单图耗时约 12~18 秒（示意性数据，实际表现因设备和优化程度而异），UNet 占 85% 以上。第一个优化点是**换蒸馏模型**。「潜在一致性模型（Latent Consistency Model, LCM）」把去噪步数从 20 压到 4 步，配合 LCM 专用调度器，质量损失可控。LCM 的 `guidance_scale` 要压到 1~2——训练过程已经内化了引导信号，取 1.0 时 CFG 的第二次前向可以直接省掉。这一步能把总耗时砍到原来的三分之一以下。

第二个优化点是 VAE Decoder。标准 VAE 解码 512×512 图要 1~2 秒，换成「Tiny AutoEncoder（TAESD）」后降到 200ms 以内，代价是细节略有损失。移动端预览场景下，这个取舍很划算。

内存上最实用的策略是**按需加载与释放**：文本编码器只跑一次，跑完立即卸载；VAE Decoder 在去噪完成后再加载。峰值内存从"三者同时驻留"降到"同一时刻只驻留一个模型"，实测可省出约 400MB。

整条链路最终形态是：prompt → 分词器 → 文本编码（一次性）→ 4 步 LCM 去噪（UNet 反复前向）→ TAESD 解码。在 Pixel 8 上实测单图耗时可以压到 3 秒以内，内存峰值 1.7GB 左右（示意性数据，实际耗时和内存占用因设备型号、模型版本、量化精度和优化程度而异，仅供参考）。

## 三个可以带走的具体思路

第一，**先确认计算量归属，再动手优化**。去噪总耗时 ≈ 单步 UNet 耗时 × 步数 × CFG 系数，三个因子分别对应换 delegate、换蒸馏模型、调 guidance 三条路径，方向不同，别混着调。

第二，**量化策略按网络角色分档**。文本编码器和 VAE 对精度相对不敏感，可以尝试 INT8；UNet 老老实实上 FP16，省内存的期望放在加载策略上，而不是量化上。

第三，**把"可用"定义为时间预算，而不是质量上限**。移动端图像生成的正确姿势是 4 步 LCM + TAESD 快速出图，别拿它跟云端 SDXL 比细节。端侧的价值在延迟和隐私，不在画质极限。
