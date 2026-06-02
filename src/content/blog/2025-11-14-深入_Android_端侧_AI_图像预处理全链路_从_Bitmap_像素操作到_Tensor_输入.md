---
title: 深入 Android 端侧 AI 图像预处理全链路：从 Bitmap 像素操作到 Tensor 输入的高性能数据管道
excerpt: 端侧 AI 推理中，数据预处理常占 30%-50% 耗时。本文梳理从 Bitmap 像素到 Tensor 输入的完整链路，涵盖内存模型、像素格式转换、Resize 策略、标准化及零拷贝优化，帮助开发者将预处理延迟压到毫秒级。
publishDate: '2025-11-14'
tags:
- Android
- 端侧AI
- TFLite
- 性能优化
- 图像预处理
seo:
  title: 深入 Android 端侧 AI 图像预处理全链路：从 Bitmap 像素操作到 Tensor 输入的高性能数据管道
  description: 详解 Android 端侧 AI 图像预处理全链路优化：从 Hardware Bitmap 内存模型到 NV21 转 RGB、Resize 选型、Tensor 标准化，再到零拷贝策略，把端到端延迟从 3 倍差距压到毫秒级。
---

在做端侧图像分类模型落地时，我遇到过一个反直觉的问题：同一张图、同一个 TFLite 模型，Java 层的推理耗时比 Native 层慢了近 3 倍。排查下来，80% 的时间没有花在推理上，而是花在了 Bitmap 到 Tensor 的格式转换里。

这不是个别现象。端侧 AI 推理的端到端耗时中，数据预处理往往占据 30%-50%。这篇文章梳理从 Bitmap 像素到模型 Tensor 输入的整条链路，分析每一步的成本和优化策略。

## Bitmap 内存模型：数据在哪，决定了怎么读

处理图像预处理之前，先要搞清楚 Bitmap 的像素到底存在哪里。

Android 8.0 之前，像素数据存储在 Java 堆上，通过 `Bitmap.getPixels()` 就能拿到 `int[]` 数组。但 8.0 之后引入 **Hardware Bitmap**，像素数据直接存放在 GPU 显存或 Gralloc 分配的 native 内存中，Java 层拿到的是个引用。

```kotlin
val bitmap = BitmapFactory.decodeStream(inputStream)
// Android 8.0+ 默认返回 Hardware Bitmap
// bitmap.isHardware 大概率是 true
```

Hardware Bitmap 的问题是：读像素必须走 GPU→CPU 的拷贝，这个操作叫做 **staging**，耗时通常在 10-30ms，对于 30fps 的实时推理是致命的。

解决方案有两种：

**方案一：强制软件 Bitmap。** 解码时设置 `inPreferredConfig` 和 `inMutable`，禁止框架自动使用硬件加速：

```kotlin
val opts = BitmapFactory.Options().apply {
    inPreferredConfig = Bitmap.Config.ARGB_8888
    inMutable = true // 关键：阻止生成 Hardware Bitmap
}
```

代价是放弃了 GPU 渲染加速，渲染会多一次 CPU→GPU 上传。如果你的 Bitmap 只用于推理而不上屏，这个代价为零。

**方案二：直接用 ImageReader 拿 YUV 数据。** 相机预览场景下更推荐这种方式，直接从 HAL 层拿 NV21/YUV420 数据，完全绕过 Bitmap：

```kotlin
val reader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 2)
reader.setOnImageAvailableListener({ reader ->
    val image = reader.acquireNextImage()
    processYUVToTensor(image) // 直接处理 YUV planes
    image.close()
}, handler)
```

## 像素格式转换：把 2MB 的 NV21 变成 4KB 的模型输入

数据拿到后，第一件事是把图像转换成模型期望的格式。常见模型输入要求：

- 尺寸：224×224、320×320 等固定分辨率
- 格式：RGB/BGR planar 或 interleaved
- 数据类型：float32 [0,1] 或 uint8 [0,255]

相机输出的 NV21 是 YUV 4:2:0，Y 平面全分辨率，UV 平面各为 1/4。直接转 RGB 要做 YUV→RGB 颜色空间转换，每个像素要算 3 次乘加操作。

传统的 Java `Color.colorToHSV()` 没法用，一个像素一调，224×224 就要 5 万次 JNI 调用，实测耗时超过 200ms。正确的做法是走 Native 层批量处理。

这里放一段 C++ 实现，用 SIMD 加速 NV21 到 RGB 的转换：

```cpp
// NV21 → float RGB, 利用 NEON 一次处理 8 个像素
void nv21_to_rgb_float(const uint8_t* y_plane, const uint8_t* uv_plane,
                       int width, int height, float* output) {
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x += 8) {
            uint8x8_t y8 = vld1_u8(y_plane + y * width + x);
            // UV 每两个像素共享一组
            uint8x8_t u8 = vld1_u8(uv_plane + (y/2) * width + (x & ~1));
            uint8x8_t v8 = vld1_u8(uv_plane + (y/2) * width + (x | 1));
            // ITU-R BT.601 转换矩阵
            int16x8_t r = ...; int16x8_t g = ...; int16x8_t b = ...;
            vst1q_f32(output + (y * width + x) * 3, ...); // RGB interleaved
        }
    }
}
```

一个关键的工程决策：**在转换的同时完成 resize**，避免产生中间的大尺寸 RGB buffer。用双线性插值将 NV21 直接采样到目标尺寸，内存占用可以从原始 1920×1080×3 ≈ 6MB 降到 224×224×3 ≈ 600KB。

## Resize 选择：没有银弹，只有场景适配

模型输入通常是固定尺寸的。Android 上可用的 resize 路径有三条：

| 方案 | 耗时(1080p→224) | 内存开销 | 适用场景 |
|------|----------------|---------|---------|
| `Bitmap.createScaledBitmap` | ~8ms | 产生新 Bitmap | 单图推理 |
| `RenderScript IntrinsicResize` | ~3ms | GPU buffer | Android 11 以下，已废弃 |
| Native bilinear/bicubic | ~1ms | 可控 | 高性能场景 |
| GPU（OpenGL ES shader） | <1ms | GPU 纹理 | 配合 GPU 推理 |

`Bitmap.createScaledBitmap` 内部默认用双线性插值，效果够用但会产生一张新 Bitmap，GC 压力大。在高帧率视频推理中（15-30fps），频繁创建和回收 Bitmap 会触发频繁 GC。

我目前在项目里用的是自实现的 **area-resize**，在 Native 层用一个快速下采样函数，舍弃了少量精度换取速度。3 倍以上下采样时面积插值比双线性明显更锐利，5 倍以上时优势更大：

```cpp
// 面积插值的核心思路：目标像素 = 源区域像素均值
float area_sample(const uint8_t* src, int src_w, int src_h,
                  int dst_x, int dst_y, float scale_x, float scale_y) {
    int x0 = dst_x * scale_x, x1 = (dst_x + 1) * scale_x;
    int y0 = dst_y * scale_y, y1 = (dst_y + 1) * scale_y;
    float sum = 0;
    for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++)
            sum += src[y * src_w + x];
    return sum / ((x1 - x0) * (y1 - y0));
}
```

这个实现没有 NEON 优化，单通道灰度图 1080p→224 耗时约 3ms。加了 NEON 向量化后（同时计算 4 个 float32），能降到 0.8ms 以内。

## Tensor 标准化：均值方差和通道序的坑

Resize 完成后得到的是 uint8 RGB 数据，模型通常需要 float32 输入并且标准化到特定分布。

标准化公式：`output = (input / 255.0 - mean) / std`

不同模型的 mean/std 差异很大：

- MobileNet 系列：mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
- EfficientNet-Lite：mean=[127, 127, 127], std=[128, 128, 128] ← 用整数实现，省除法
- YOLO-NAS：mean=[0, 0, 0], std=[255, 255, 255] ← 只做归一化不做标准化

有一个常被忽略的坑：**模型期望的通道顺序**。TFLite 默认 NHWC（HWC 排布），但 ONNX 和部分 PyTorch Mobile 模型是 NCHW。如果通道序不对，推理不会报错，但输出完全错误。

查模型的 metadata：

```python
# TensorFlow SavedModel 转 TFLite 时查看输入格式
import tensorflow as tf
interpreter = tf.lite.Interpreter(model_path="model.tflite")
input_details = interpreter.get_input_details()
print(input_details[0]['shape'])  # [1, 224, 224, 3] → NHWC
```

确定了通道序后，标准化在 Native 层一锅端：resize + 格式转换 + 标准化合并为一次 pixel shader 或一个 NEON kernel，数据只读写一次。

```cpp
// 合并操作：uint8 RGB → float32 normalized [NHWC]
void preprocess_pixel(int r, int g, int b, float* out) {
    out[0] = (r / 255.0f - 0.485f) / 0.229f;
    out[1] = (g / 255.0f - 0.456f) / 0.224f;
    out[2] = (b / 255.0f - 0.406f) / 0.225f;
}
```

三个通道各做一次除法加一次减法，224×224 要算 15 万次。实测 NEON 向量化后耗时从 6ms 降到 0.5ms。

## 零拷贝策略：把拷贝次数从 4 次压到 0 次

回到开头的问题——端到端耗时为什么差 3 倍？数一下链路上的拷贝次数：

```
传统路径（Java 为主）：
相机 HAL → Java Image → Bitmap copy → Resize Bitmap → int[] array → float[] buffer → TFLite tensor
      ①           ②            ③            ④            ⑤             ⑥

优化路径（Native + zero-copy）：
相机 HAL → AHardwareBuffer → TFLite GPU delegate tensor
      ①（唯一的一次）
```

每一次拷贝都在消耗内存带宽。Android 10 引入的 **AHardwareBuffer** 是打通零拷贝的关键：它允许 CPU、GPU、NPU 共享同一块物理内存。

实战中用 MediaPipe 或 TFLite GPU Delegate 时，可以这样配：

```kotlin
val gpuDelegate = GpuDelegate() // 内部使用 OpenGL ES 3.1 SSBO
val interpreter = Interpreter(modelBuffer, Interpreter.Options().apply {
    addDelegate(gpuDelegate)
})

// 输入用 ByteBuffer，保证 direct memory
val inputBuffer = ByteBuffer.allocateDirect(224 * 224 * 3 * 4)
    .order(ByteOrder.nativeOrder())
// ... 填充数据 ...
interpreter.run(inputBuffer, outputBuffer)
```

`allocateDirect` 在 native heap 上分配内存，TFLite 直接拿指针用，不经过 JNI 拷贝。

如果你的预处理在 GPU 上完成（用 OpenGL ES shader 做 resize+normalize），可以直接把 GL 纹理绑定给 TFLite GPU delegate，整条链路零拷贝。不过这个方案的工程复杂度较高，shader 写法和纹理格式需要与模型输入端严格对齐，适合对延迟极度敏感的场景（如 AR 实时滤镜）。

## 落地建议

实际项目中我按照场景做了分层选择：

**单图推理（相册分类、OCR）**：`Bitmap.createScaledBitmap` + TFLite Java API + `allocateDirect`。代码量最少，可维护性好，200ms 内的延迟完全可接受。

**实时视频推理（30fps）**：`ImageReader(YUV_420_888)` + Native NEON 预处理 + TFLite NNAPI delegate。绕过 Bitmap 全链路，NNAPI 能利用 DSP/NPU 做推理，帧率稳定在 25-30fps。

**极致低延迟（AR/实时滤镜）**：OpenGL ES shader 预处理 + GPU delegate 推理，Camera2 的 SurfaceTexture 直接喂纹理，全链路 GPU 零拷贝。工程量大，但延迟能压到 5ms 以内。

通用的优化思路：先减少拷贝次数，再优化单次拷贝的速度，最后考虑异构计算的组合。不要一上来就上 GPU pipeline，多数场景下 Native 层做好 NEON 优化已经足够。
