---
title: 深入 Android 端侧 AI 推理的实时视频流处理全链路
excerpt: 从 CameraX 串行回调的队头阻塞、GPU 像素预处理管线到 LiteRT 推理延迟抖动治理，本文完整拆解端侧 AI 实时视频处理的三大瓶颈及优化方案，实现 1080P/30fps 端到端延迟控制在 35ms 以内。
publishDate: '2026-05-06'
tags:
- Android
- 端侧AI
- 性能优化
- CameraX
- LiteRT
seo:
  title: 深入 Android 端侧 AI 推理的实时视频流处理全链路
  description: 实战拆解 CameraX 帧拥塞、GPU 预处理绕路拷贝与 LiteRT 推理延迟抖动三大瓶颈，构建三阶段异步流水线，实现 1080P/30fps 端到端延迟 35ms、帧丢失率低于 2%。
---

## 问题：30fps 的相机，模型只吃到了 8 帧

去年做实时人像分割项目时，撞上一个让人头疼的问题：CameraX 以 30fps 稳定出帧，但模型端实际处理帧率只有 8fps 左右。logcat 里 `analyze()` 回调明明每帧都触发了——帧去哪了？

排查后锁定了三个瓶颈：

1. **帧拥塞**：YUV→RGB 转换在 CPU 上跑，单帧 4-6ms，析出的 ImageProxy 没及时 close 导致队列爆满
2. **推理抖动**：模型推理耗时在 15-40ms 间大幅波动，偶发超时帧被 CameraX 内部丢弃
3. **隐式拷贝**：GPU 纹理上传和推理的 OpenCL 内存共享没做好，存在 GPU→CPU→GPU 的绕路拷贝

三个问题彼此耦合，任何一个环节卡住都会拖慢整条管线。

## CameraX 回调的队头阻塞

`ImageAnalysis.Analyzer` 的默认行为是串行处理——上一帧的 `analyze()` 没返回，下一帧不会触发回调。如果在回调里同步跑预处理和推理，帧率直接由最慢的那一帧决定。

```kotlin
// 危险写法：回调线程里同步推理
val analyzer = ImageAnalysis.Analyzer { imageProxy ->
    val result = runInference(imageProxy)  // 耗时 15-40ms
    imageProxy.close()
}
```

`setBackpressureStrategy(STRATEGY_KEEP_ONLY_LATEST)` 只是在回调队列满时丢帧，不解决串行阻塞本身。解法是异步解耦——回调只负责入队，立刻返回。

```kotlin
val analyzer = ImageAnalysis.Analyzer { imageProxy ->
    if (!frameQueue.offer(imageProxy)) {
        imageProxy.close() // 队列满，丢弃
    }
}

// 消费者线程
while (isActive) {
    val frame = frameQueue.poll(50, TimeUnit.MILLISECONDS) ?: continue
    processFrame(frame)
}
```

CameraX 回调线程接近零开销，采集频率回到硬件水平。丢帧策略落到了消费侧，由业务逻辑决定丢弃哪些帧，而不是被系统静默吞掉。哪些帧值得保留、哪些可以跳过，你自己说了算。

## GPU 预处理：像素别离开 GPU

CameraX 的 `ImageProxy` 默认给 YUV_420_888 格式，模型需要 RGB 输入。如果走 CPU 的 `YuvImage` 或 RenderScript 转换，1080P 单帧 4-8ms，再加上 resize 和 normalize，轻松破 10ms。

我用的是 OpenGL ES fragment shader 一条龙——YUV→RGB、缩放、归一化在一个 pass 里完成。

```glsl
vec3 yuv2rgb(vec3 yuv) {
    yuv.r = 1.164 * (yuv.r - 0.0625);
    yuv.g = yuv.g - 0.5;
    yuv.b = yuv.b - 0.5;
    float r = yuv.r + 1.596 * yuv.b;
    float g = yuv.r - 0.392 * yuv.g - 0.813 * yuv.b;
    float b = yuv.r + 2.017 * yuv.g;
    return vec3(r, g, b) / 255.0;  // 直接归一化
}
```

Y 平面以 `GL_LUMINANCE` 上传，UV 平面以 `GL_LUMINANCE_ALPHA` 上传为两个独立纹理，shader 内用三个 sampler 读取。省掉了 CPU 侧的平面拆分和像素拼接。

输出到 FBO 绑定的纹理后，这个纹理的 GPU 句柄可以直接喂给 LiteRT 的 GPU Delegate——不回读 CPU，不跨进程拷贝。实测 1080P 预处理从 8ms 降到 1.5ms。

## LiteRT 推理的延迟抖动治理

模型跑起来后最头疼的是延迟抖动。同一个分割模型，推理耗时在 15-40ms 之间飘，幅度近 3 倍。原因有两个。

**GPU 频率动态调节**。Adreno GPU 空闲时会降频，推理任务提交后需要 2-5ms 爬升到高频。warmup 能解决首帧的问题：

```kotlin
interpreter.run(dummyInput, dummyOutput)  // 让 GPU 提频
// 等 1-2ms 频率稳定后进入正式推理循环
```

但 warmup 只解决首帧抖动。更棘手的来自运行时负载波动——系统调度器随时可能把 CPU 核分给其他线程，推理线程被抢占时延迟直接炸开。

踩坑记录：一开始用 `Interpreter.run()` 同步调用，推理线程被阻塞时整条管线停摆。换成 `runAsync()` 配合 listener：

```kotlin
interpreter.runAsync(inputBuffer, outputBuffer)
    .addListener({ renderCallback(outputBuffer) }, gpuExecutor)
```

推理提交后线程立即释放，GPU 结果就绪时异步通知。P99 延迟从 42ms 降到 28ms，帧处理率的波动从 ±35% 收窄到 ±12%。

## 三阶段管线编排

三阶段串起来，核心是一个带帧号的三槽位环形缓冲：

```
[采集线程] → Slot 0 → [GL 线程] → Slot 1 → [推理线程] → Slot 2 → [渲染]
```

每个槽位只存纹理句柄和帧号，不存像素数据。关键的过期判断放在渲染侧——如果推理结果的帧号比当前显示器帧号小太多，直接丢弃，显示出来反而画面回跳。

```kotlin
class FramePipeline(private val maxLag: Int = 2) {
    @Synchronized
    fun shouldRender(inferId: Long, displayId: Long): Boolean {
        return displayId - inferId <= maxLag
    }
}
```

`maxLag = 2` 是在骁龙 8 Gen 2 上调出来的经验值。设太大会有画面滞后感，设太小容易频繁丢帧。

这套方案在 1080P/30fps 人像分割场景下，端到端延迟控制在 35ms 以内，帧丢失率低于 2%。核心思路不复杂：把串行管线拆成流水线，每段独立运行、异步交接。做端侧实时 AI 处理记住三条——像素数据留在 GPU 上，CameraX 回调只入队不做处理，推理用异步接口配合帧号做过期校验而非时间戳。
