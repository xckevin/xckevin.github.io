---
title: "Android On-device AI Memory Bandwidth: GPU Shared Memory to NPU Zero-copy"
lang: en
translationKey: android-on-device-ai-memory-bandwidth
slug: android-on-device-ai-memory-bandwidth
excerpt: "A practical guide to Android on-device AI memory-bandwidth optimization, from camera-to-GPU data movement to AHardwareBuffer, ION reuse, and NPU zero-copy paths."
publishDate: '2025-11-20'
tags:
- "Android"
- "On-device AI"
- "Performance Optimization"
- "Memory Optimization"
- "NPU"
seo:
  title: "Android On-device AI Memory Bandwidth and NPU Zero-copy"
  description: "Optimize Android on-device AI memory bandwidth with AHardwareBuffer shared memory, ION buffer reuse, NPU zero-copy, and heterogeneous data-transfer design."
  pageType: article
---

Last year, while building real-time on-device image segmentation, I ran into a counterintuitive problem: the Snapdragon 8 Gen 3 NPU had twice the theoretical compute of the previous generation, but inference latency dropped by only 15%. The bottleneck was not the compute unit. The time was being spent on data movement.

A 224x224x3 input frame goes from Camera HAL to the app process and then to GPU/NPU, with four memory copies along the way. In real-time inference, compute often waits for data. Memory bandwidth is the real ceiling.

## The memory problem in on-device inference

A typical Android inference data flow looks like this:

```
Camera HAL -> Gralloc Buffer -> App Buffer -> GPU Buffer -> inference result -> App Buffer
```

Each copy consumes bandwidth and adds latency. Take a 1080p YUV frame as an example: a single frame is about 3 MB, so 30 fps means 90 MB/s of sustained bandwidth. Add intermediate tensor transfers, and actual memory traffic is far above the model's theoretical requirement.

Android's process isolation naturally creates this problem. Memory allocated by the HAL layer, usually Gralloc, and memory in the app heap live in different virtual address spaces. Cross-process sharing requires Binder transfer or ashmem mapping, and these paths carry copy overhead.

On a Pixel 8 Pro, I captured an inference path with Android Studio Memory Profiler:

```bash
# Simplified systrace snippet, with buffer-transfer costs highlighted
hal_camera_stream::request_buffer  ->  2.3ms
ION_alloc                          ->  1.8ms
AHardwareBuffer_lock               ->  4.1ms  # The painful part
gpu_memcpy_h2d                     ->  1.5ms
model_inference                    ->  3.2ms  # Actually the smallest part
```

The inference itself took only 3.2 ms, while data preparation and transfer consumed almost 10 ms. The main battlefield for on-device AI optimization should not be the model structure. It should be the data path.

## GPU path: shared memory as the first line of defense

Google introduced `AHardwareBuffer` in Android 10. It is essentially a unified abstraction over Gralloc buffers. It lets the GPU, CPU, and HAL access the same physical memory through a shared handle, avoiding explicit copies.

The basic idea is to describe the Camera HAL output buffer with `AHardwareBuffer` and pass it to the GPU inference engine without copying. EGL Image or Vulkan External Memory can bind it directly:

```cpp
// Key path: bind a Gralloc buffer to the GPU without copying
AHardwareBuffer_Desc desc = {
    .width = 224,
    .height = 224,
    .format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM,
    .usage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE |
             AHARDWAREBUFFER_USAGE_CPU_READ_OCCASIONALLY,
};
AHardwareBuffer* buffer;
AHardwareBuffer_allocate(&desc, &buffer);

// Create Vulkan external memory directly, without a CPU copy
VkImportAndroidHardwareBufferInfoANDROID importInfo = {
    .buffer = buffer,
};
VkMemoryAllocateInfo allocInfo = {
    .pNext = &importInfo,
};
vkAllocateMemory(device, &allocInfo, nullptr, &memory);
```

This approach compresses the Camera-to-GPU path from three copies to zero copies and reduces latency by about 40%.

However, one problem is hard to avoid: after the GPU produces the result, postprocessing on the CPU requires calling `AHardwareBuffer_lock`. That operation triggers a CPU cache flush and a GPU pipeline stall. Under high-frequency calls, it remains a major cost.

## Using shared memory as an inference intermediate layer

The internal Android implementation of the TFLite GPU Delegate is interesting. It does not operate directly on AHardwareBuffer. Instead, it uses ION at the lower layer to allocate physically contiguous memory and maps that memory to Vulkan through the `VK_ANDROID_external_memory_android_hardware_buffer` extension.

In one project, I optimized this by placing model input and output in different offsets of the same ION buffer. Intermediate feature maps also reused the same memory. The simplified code looks like this:

```cpp
// One ION buffer carries data for the full path
ion_user_handle_t handle = ion_alloc(fd, total_size, align);
void* mapped = mmap(nullptr, total_size, PROT_READ | PROT_WRITE,
                    MAP_SHARED, handle, 0);

// Data offsets for each stage
float* input_tensor  = (float*)(mapped + INPUT_OFFSET);
float* conv1_output  = (float*)(mapped + CONV1_OFFSET);
float* conv2_output  = (float*)(mapped + CONV2_OFFSET);

// On the GPU side, Vulkan uses the same physical memory
vkBindImageMemory(device, image, memory, CONV1_OFFSET);
```

The benefit is direct: multiple GPU kernels do not need any host-side memory movement between them. Texture objects and buffer objects share the same physical pages, which is especially friendly to unified-memory architectures such as Mali GPUs.

The tradeoff is that the CPU must explicitly manage offsets and synchronization. Maintenance cost is not low, and the approach does not directly adapt to NPU paths.

## NPU zero-copy: the final path around the CPU

The NPU's core advantage is not just compute density. It has an independent memory subsystem. Qualcomm Hexagon and MediaTek APU both have on-chip SRAM and DMA engines. The ideal data flow is:

```
Camera ISP -> DDR -> NPU SRAM, direct DMA transfer with no CPU involvement
```

Qualcomm's NeuroPilot SDK provides this path. The key API is the FastRPC mechanism for HTP, or Hexagon Tensor Processor, which allows allocation directly in the DSP address space:

```cpp
// Qualcomm NPU zero-copy path
rpcmem_init();
void* dsp_buffer = rpcmem_alloc(RPCMEM_HEAP_ID_SYSTEM,
                                 size, RPCMEM_DEFAULT_FLAGS);

// Map the physical pages of the camera buffer directly to the DSP
rpcmem_to_fd(dsp_buffer);

// NPU inference, without involving the APPS CPU
hexagon_nn_prepare_input_from_fd(nn_id, dsp_buffer_fd, offset);
hexagon_nn_execute(nn_id);
```

This path pushed total inference latency for a 224x224 input frame from 13 ms to under 5 ms. The data-transfer time was almost eliminated.

There are two real-world issues, though. First, NPU SDK APIs are completely different across vendors. Qualcomm `rpcmem` and MediaTek `Neuron` are separate systems, so changing chips can mean rewriting the implementation. Second, debugging is extremely difficult. DSP-side crashes do not appear in logcat. You need a dedicated tracer to locate them, and integration debugging often takes three times as long as writing the inference logic itself.

## Unified memory architecture: the promise and the reality of AHAL

Starting with Android 15, the `AHardwareBuffer` 2.0 specification attempts to unify this problem. The idea is to introduce `AHARDWAREBUFFER_USAGE_NPU_READ` and `AHARDWAREBUFFER_USAGE_NPU_WRITE` flags so the NPU becomes a first-class buffer participant.

Ideally, a Camera HAL buffer allocated with NPU usage flags would allow the NPU driver to read it directly through DMA without triggering CPU page faults. Today, only a small number of flagship chips support this. Adoption depends on OEM willingness to adapt drivers, and that work is usually a low priority.

## Selection advice

In practice, my decision logic is:

For models under 50 MB where latency is not extreme, above 10 ms, TFLite GPU Delegate plus the AHardwareBuffer zero-copy path is enough. It has the best maintainability and strong cross-chip compatibility.

For on-device large models or real-time video streams that need sub-5 ms latency, a vendor-specific NPU path is required. Be prepared: DSP integration can take three times as long as writing the inference logic.

One more lesson from production: power budget matters. The NPU zero-copy path is not only faster; it also consumes less power. In continuous inference for 30 minutes, the Qualcomm NPU path consumed about 40% less power than the GPU path because it avoided frequent DDR reads and writes. For mobile battery life, that gap matters more than the latency gap.

At this point, on-device AI hardware compute is largely good enough. Moving data to the right place, and moving it fewer times, is where engineering still creates the biggest difference.
