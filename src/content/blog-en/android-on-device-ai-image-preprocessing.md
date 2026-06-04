---
title: "Android On-device AI Image Preprocessing: From Bitmap Pixels to Tensor Input"
lang: en
translationKey: android-on-device-ai-image-preprocessing
slug: android-on-device-ai-image-preprocessing
excerpt: "A full Android on-device AI preprocessing pipeline from Bitmap pixels to tensor input, covering memory layout, pixel conversion, resize choices, normalization, and zero-copy optimization."
publishDate: '2025-11-14'
tags:
- "Android"
- "On-device AI"
- "TFLite"
- "Performance Optimization"
- "Image Preprocessing"
seo:
  title: "Android Image Preprocessing for On-device AI: Bitmap to Tensor"
  description: "Optimize Android on-device AI preprocessing from Hardware Bitmap and YUV conversion to resize, tensor normalization, direct buffers, and zero-copy paths."
  pageType: article
---

While landing an on-device image classification model, I ran into a counterintuitive issue: with the same image and the same TFLite model, Java-side inference was almost three times slower than the native path. After investigation, 80% of the time was not spent on inference. It was spent converting a Bitmap into a tensor.

This is not an isolated case. In end-to-end on-device AI latency, preprocessing often accounts for 30%-50%. This article walks through the full path from Bitmap pixels to model tensor input and analyzes the cost and optimization strategy at each step.

## Bitmap memory model: where the data lives determines how you read it

Before optimizing image preprocessing, you need to know where Bitmap pixels actually live.

Before Android 8.0, pixel data was stored on the Java heap, and `Bitmap.getPixels()` could return an `int[]` array. Android 8.0 introduced **Hardware Bitmap**, where pixel data is stored directly in GPU memory or native memory allocated by Gralloc. The Java layer only holds a reference.

```kotlin
val bitmap = BitmapFactory.decodeStream(inputStream)
// Android 8.0+ returns a Hardware Bitmap by default.
// bitmap.isHardware is likely true.
```

The problem with Hardware Bitmap is that reading pixels requires a GPU-to-CPU copy. This operation is called **staging**, and it usually costs 10-30 ms. For 30 fps real-time inference, that is fatal.

There are two practical solutions.

**Option 1: force a software Bitmap.** Set `inPreferredConfig` and `inMutable` during decoding to prevent the framework from using hardware acceleration automatically:

```kotlin
val opts = BitmapFactory.Options().apply {
    inPreferredConfig = Bitmap.Config.ARGB_8888
    inMutable = true // Key point: prevent Hardware Bitmap creation
}
```

The tradeoff is giving up GPU rendering acceleration, so rendering adds one CPU-to-GPU upload. If the Bitmap is only used for inference and never displayed, that cost is zero.

**Option 2: read YUV data directly through ImageReader.** This is the preferred path for camera preview scenarios. You can get NV21/YUV420 data directly from the HAL layer and bypass Bitmap entirely:

```kotlin
val reader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 2)
reader.setOnImageAvailableListener({ reader ->
    val image = reader.acquireNextImage()
    processYUVToTensor(image) // Process YUV planes directly
    image.close()
}, handler)
```

## Pixel format conversion: turning a 2 MB NV21 frame into a 4 KB model input

After acquiring the data, the first step is converting the image into the format expected by the model. Common model input requirements are:

- Size: fixed resolutions such as 224x224 or 320x320
- Format: RGB/BGR, planar or interleaved
- Data type: float32 [0,1] or uint8 [0,255]

Camera output in NV21 is YUV 4:2:0: the Y plane is full resolution, and each UV plane is one quarter of the size. Converting directly to RGB requires a YUV-to-RGB color-space transform, with three multiply-add operations per pixel.

The traditional Java `Color.colorToHSV()` path is unusable here. Calling it once per pixel means 50,000 JNI calls for a 224x224 image, and measured latency exceeds 200 ms. The correct approach is batched processing in native code.

Here is a C++ implementation that uses SIMD to accelerate NV21-to-RGB conversion:

```cpp
// NV21 -> float RGB, using NEON to process 8 pixels at a time
void nv21_to_rgb_float(const uint8_t* y_plane, const uint8_t* uv_plane,
                       int width, int height, float* output) {
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x += 8) {
            uint8x8_t y8 = vld1_u8(y_plane + y * width + x);
            // UV is shared by every two pixels
            uint8x8_t u8 = vld1_u8(uv_plane + (y/2) * width + (x & ~1));
            uint8x8_t v8 = vld1_u8(uv_plane + (y/2) * width + (x | 1));
            // ITU-R BT.601 conversion matrix
            int16x8_t r = ...; int16x8_t g = ...; int16x8_t b = ...;
            vst1q_f32(output + (y * width + x) * 3, ...); // RGB interleaved
        }
    }
}
```

One key engineering decision: **perform resize during conversion** to avoid producing a large intermediate RGB buffer. Bilinear interpolation can sample NV21 directly into the target size, reducing memory use from the original 1920x1080x3, about 6 MB, to 224x224x3, about 600 KB.

## Resize choices: no silver bullet, only scenario fit

Model input is usually a fixed size. On Android, there are three common resize paths:

| Option | Latency (1080p -> 224) | Memory cost | Best fit |
|------|-------------------------|-------------|----------|
| `Bitmap.createScaledBitmap` | ~8 ms | Creates a new Bitmap | Single-image inference |
| `RenderScript IntrinsicResize` | ~3 ms | GPU buffer | Android 11 and below, now deprecated |
| Native bilinear/bicubic | ~1 ms | Controllable | High-performance scenarios |
| GPU (OpenGL ES shader) | <1 ms | GPU texture | Paired with GPU inference |

`Bitmap.createScaledBitmap` uses bilinear interpolation internally by default. The quality is good enough, but it creates a new Bitmap and adds GC pressure. In high-frame-rate video inference at 15-30 fps, frequent Bitmap allocation and recycling will trigger frequent GC.

In my current projects, I use a custom **area-resize** implementation. It runs in native code with a fast downsampling function, trading a small amount of precision for speed. When downsampling by more than 3x, area interpolation is noticeably sharper than bilinear interpolation. Above 5x, the advantage is even larger:

```cpp
// Core idea of area interpolation: target pixel = average of source-region pixels
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

This version has no NEON optimization, yet a single-channel grayscale resize from 1080p to 224 takes about 3 ms. After NEON vectorization, computing four float32 values at once, it drops below 0.8 ms.

## Tensor normalization: mean, standard deviation, and channel-order traps

After resize, you have uint8 RGB data. Most models require float32 input normalized to a specific distribution.

Normalization formula: `output = (input / 255.0 - mean) / std`

Different models use very different mean and std values:

- MobileNet family: mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
- EfficientNet-Lite: mean=[127, 127, 127], std=[128, 128, 128], suitable for integer implementation that avoids division
- YOLO-NAS: mean=[0, 0, 0], std=[255, 255, 255], normalization only, no standardization

One common trap is **the channel order expected by the model**. TFLite defaults to NHWC, or HWC layout, while ONNX and some PyTorch Mobile models use NCHW. If the channel order is wrong, inference does not fail, but the output is completely wrong.

Inspect the model metadata:

```python
# Check input format after converting a TensorFlow SavedModel to TFLite
import tensorflow as tf
interpreter = tf.lite.Interpreter(model_path="model.tflite")
input_details = interpreter.get_input_details()
print(input_details[0]['shape'])  # [1, 224, 224, 3] -> NHWC
```

Once the channel order is known, handle normalization in native code in one pass: merge resize, format conversion, and normalization into a single pixel shader or NEON kernel. The data is read and written only once.

```cpp
// Fused operation: uint8 RGB -> float32 normalized [NHWC]
void preprocess_pixel(int r, int g, int b, float* out) {
    out[0] = (r / 255.0f - 0.485f) / 0.229f;
    out[1] = (g / 255.0f - 0.456f) / 0.224f;
    out[2] = (b / 255.0f - 0.406f) / 0.225f;
}
```

Each channel does one division and one subtraction. For a 224x224 image, that is 150,000 operations. With NEON vectorization, measured latency dropped from 6 ms to 0.5 ms.

## Zero-copy strategy: reducing copies from four to zero

Returning to the opening issue, why was end-to-end latency three times worse? Count the copies along the path:

```
Traditional path, mostly Java:
Camera HAL -> Java Image -> Bitmap copy -> Resize Bitmap -> int[] array -> float[] buffer -> TFLite tensor
      1             2              3              4              5              6

Optimized path, native plus zero-copy:
Camera HAL -> AHardwareBuffer -> TFLite GPU delegate tensor
      1, the only copy
```

Every copy consumes memory bandwidth. **AHardwareBuffer**, introduced in Android 10, is the key to zero-copy because it lets the CPU, GPU, and NPU share the same physical memory.

In practice, when using MediaPipe or the TFLite GPU Delegate, you can configure the pipeline like this:

```kotlin
val gpuDelegate = GpuDelegate() // Internally uses OpenGL ES 3.1 SSBO
val interpreter = Interpreter(modelBuffer, Interpreter.Options().apply {
    addDelegate(gpuDelegate)
})

// Use ByteBuffer as input and guarantee direct memory
val inputBuffer = ByteBuffer.allocateDirect(224 * 224 * 3 * 4)
    .order(ByteOrder.nativeOrder())
// ... Fill data ...
interpreter.run(inputBuffer, outputBuffer)
```

`allocateDirect` allocates memory on the native heap, so TFLite can use the pointer directly without a JNI copy.

If preprocessing is done on the GPU, for example with an OpenGL ES shader that performs resize and normalize, you can bind the GL texture directly to the TFLite GPU Delegate and make the full path zero-copy. This is more complex: shader code and texture format must match the model input exactly. It is best reserved for latency-sensitive cases such as real-time AR filters.

## Practical recommendations

In real projects, I choose the pipeline by scenario:

**Single-image inference, such as album classification or OCR**: `Bitmap.createScaledBitmap` plus the TFLite Java API plus `allocateDirect`. It has the least code, good maintainability, and latency under 200 ms is usually acceptable.

**Real-time video inference at 30 fps**: `ImageReader(YUV_420_888)` plus native NEON preprocessing plus the TFLite NNAPI delegate. This bypasses Bitmap across the full path, and NNAPI can use DSP/NPU for inference. Frame rate stays stable at 25-30 fps.

**Extreme low latency, such as AR or real-time filters**: OpenGL ES shader preprocessing plus GPU Delegate inference, with Camera2 `SurfaceTexture` feeding textures directly. The engineering cost is high, but latency can be pushed below 5 ms.

The general optimization order is: reduce the number of copies first, then optimize the speed of each remaining copy, and only then combine heterogeneous compute paths. Do not start with a GPU pipeline by default. In most scenarios, a native preprocessing path with good NEON optimization is already enough.
