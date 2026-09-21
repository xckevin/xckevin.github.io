---
title: 'Android On-Device Stable Diffusion: From Denoising Principles to LiteRT Mobile Image Generation'
lang: en
translationKey: android-on-device-stable-diffusion-litert
slug: android-on-device-stable-diffusion-litert
excerpt: 'From Stable Diffusion denoising to LiteRT mobile deployment: FP16 quantization, LCM distillation, and on-demand loading cut single-image generation on Pixel 8 from 40 seconds to under 3 seconds.'
publishDate: '2026-08-14'
tags:
- Android
- LiteRT
- Stable Diffusion
- Performance Optimization
- Mobile Deployment
- On-Device ML
seo:
  title: 'Android On-Device Stable Diffusion: Denoising to LiteRT Image Generation'
  description: 'From latent diffusion denoising to LiteRT on-device deployment: FP16 quantization, GPU Delegate, LCM distillation, and memory strategy on Android.'
  pageType: article
---

When I first got Stable Diffusion 1.5 running on a Pixel 8, a single 512×512 image took 40 seconds and peak memory hit 2.1GB. It ran, but it was still some distance from "usable." During optimization I gradually noticed a pattern: if you don't understand what each step of the denoising loop is actually computing, it's hard to tell which costs are intrinsic to the algorithm and which are engineering waste. Following the order of "principles → deployment → tuning," I broke the whole chain apart.

## The Latent Space: The Prerequisite for Running SD on Phones

Stable Diffusion belongs to the family of latent diffusion models (LDM). It does not perform diffusion in 512×512 pixel space; instead, it first uses a variational autoencoder (VAE) to compress the image into a 64×64×4 latent space. For SD 1.5's typical configuration (512×512×3 image, 8× downsampling, 4-channel latent representation), the spatial size is compressed 64×, and after accounting for the channel change the total number of tensor elements shrinks to roughly 1/48 of the original image—this is a typical compression ratio for the common SD 1.x/2.x configuration, and the exact figure varies across model versions or latent channel settings. This compression is what makes on-device inference feasible: all denoising happens in the low-dimensional space, and the tensor scale the UNet processes each time shrinks dramatically.

The full model consists of three independent networks: the **Text Encoder** (CLIP ViT-L/14) encodes the prompt into a 77×768 text vector; the **UNet** handles iterative denoising with roughly 860M parameters and dominates both compute and memory; and the **VAE Decoder** turns the denoised latent back into an image. The three are combined only sequentially at inference time, which leaves room for on-demand loading on device.

The forward diffusion process adds noise step by step: Gaussian noise is repeatedly added to the real image's latent `z0`, approaching pure noise `zT` after T steps. The reverse process trains the UNet to predict the noise added at each step, reconstructing `z0` from `zT` step by step. Generating an image is simply running this reverse denoising process in full.

## The Denoising Loop: What Each Step Computes

At inference time, we start from random Gaussian noise and loop for T steps. The per-step logic can be summarized as:

```python
# 伪代码：单次去噪步骤
def denoise_step(unet, z, t, text_emb, guidance_scale=7.5):
    eps_uncond = unet(z, t, null_emb)      # 无条件预测
    eps_cond = unet(z, t, text_emb)        # 有条件预测
    # CFG：放大条件预测相对无条件预测的偏移
    eps = eps_uncond + guidance_scale * (eps_cond - eps_uncond)
    return scheduler.step(eps, t, z)       # 调度器算出 z_{t-1}
```

Inside this step there are two on-device costs that are easy to overlook. **Classifier-Free Guidance (CFG)** runs the UNet forward twice per step: once with text conditioning and once with null conditioning. A `guidance_scale` of 7.5 means the unconditional prediction's weight is pushed into negative territory, and the difference between the two forward passes "pulls" the result toward the distribution described by the prompt. Compute per step therefore doubles.

The scheduler decides how large T should be. DDPM's original setting is 1000 steps; DDIM and DPM-Solver bring the count down to 20–50 steps with acceptable quality. On mobile, you typically start at 20 steps, and going lower requires distilled models.

## LiteRT Deployment: Quantization, Delegates, and Memory

"LiteRT" is the runtime brand Google introduced in 2024, formerly known as TensorFlow Lite. The deployment pipeline is usually: PyTorch weights → ONNX → TensorFlow SavedModel → `.tflite`, with tools like `ai-edge-torch` or `onnx2tf` handling the conversion end to end.

Quantization has to be considered per network. The UNet is sensitive to INT8; weight-level per-channel quantization is feasible but requires a calibration dataset, and generation quality drops visibly. My choice is **FP16 end to end**: model size halves, precision loss is negligible, and phone GPUs natively support FP16 computation. In the actual project, the FP16 SD 1.5 UNet is about 1.7GB, the CLIP text encoder about 246MB, and the VAE about 168MB—more than 2GB combined, which is exactly where the earlier 2.1GB peak memory came from.

LiteRT currently provides two Android inference APIs: the `CompiledModel` API, aimed at new projects with unified CPU/GPU/NPU scheduling, and the legacy `Interpreter` API (`org.tensorflow.lite.Interpreter`), kept for compatibility with old code. Loading the UNet with the `CompiledModel` API looks roughly like this:

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

GPU acceleration is fastest for FP16, but due to texture/VRAM limits, when a single UNet layer exceeds a certain size some operators may fall back to the CPU. The older `Interpreter` API with `GpuDelegate` (`org.tensorflow.lite.gpu.GpuDelegate`) achieves a similar effect, but Google currently recommends using `CompiledModel` directly for new projects, since it automatically selects among CPU/GPU/NPU based on the device. My advice: **use GPU/NPU acceleration as the primary path and keep a CPU fallback**, so low-end devices can at least produce an image.

## Engineering Tuning: Step Count, Decoder, and Memory Strategy

With 20-step denoising alone, a single image on the Pixel 8 takes about 12–18 seconds (illustrative figures; actual performance varies by device and degree of optimization), with the UNet accounting for over 85%. The first optimization is **switching to a distilled model**. The Latent Consistency Model (LCM) compresses denoising from 20 steps to 4, and with an LCM-specific scheduler the quality loss is controllable. LCM's `guidance_scale` should be pushed down to 1–2—the guidance signal is already internalized during training, and at 1.0 the second CFG forward pass can be skipped entirely. This step cuts total latency to less than a third of the original.

The second optimization is the VAE Decoder. The standard VAE takes 1–2 seconds to decode a 512×512 image; switching to the Tiny AutoEncoder (TAESD) brings it under 200ms at the cost of slightly reduced detail. In mobile preview scenarios, that trade-off is well worth it.

The most practical memory strategy is **on-demand loading and release**: the text encoder runs only once and is unloaded immediately afterward; the VAE Decoder is loaded only after denoising completes. Peak memory drops from "all three resident at once" to "only one model resident at any moment," which in practice frees up roughly 400MB.

The final form of the whole pipeline is: prompt → tokenizer → text encoding (one-time) → 4-step LCM denoising (repeated UNet forward passes) → TAESD decoding. On the Pixel 8, measured single-image latency can be squeezed under 3 seconds, with peak memory around 1.7GB (illustrative figures; actual latency and memory usage vary by device model, model version, quantization precision, and degree of optimization, and are for reference only).

## Three Concrete Takeaways You Can Apply

First, **confirm where the compute actually belongs before optimizing**. Total denoising latency ≈ per-step UNet latency × step count × CFG coefficient. The three factors correspond to three different paths—swapping the delegate, switching to a distilled model, and tuning guidance—so don't mix them up.

Second, **tier your quantization strategy by each network's role**. The text encoder and VAE are relatively insensitive to precision and can try INT8; keep the UNet on FP16, and put your memory-saving expectations on the loading strategy rather than on quantization.

Third, **define "usable" as a time budget, not a quality ceiling**. The right posture for mobile image generation is 4-step LCM + TAESD for fast output; don't compare its detail against cloud SDXL. The value of on-device generation is latency and privacy, not pushing image quality to the limit.
