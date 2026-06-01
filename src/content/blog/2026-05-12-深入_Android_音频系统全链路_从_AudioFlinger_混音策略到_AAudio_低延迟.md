---
title: 深入 Android 音频系统全链路：从 AudioFlinger 混音策略到 AAudio 低延迟输出的架构解析
excerpt: 深入剖析 Android 音频系统全链路架构，从 AudioTrack 缓冲区、AudioFlinger 混音调度到 AAudio MMAP 直通模式，对比不同方案的延迟表现与适用场景。
publishDate: '2026-05-12'
tags:
- Android
- AudioFlinger
- AAudio
- 音频系统
- 性能优化
seo:
  title: "Android 音频系统原理：AudioFlinger、混音策略与 AAudio 低延迟"
  description: "解析 Android 音频链路中的 AudioFlinger、AudioTrack、AAudio、混音策略、线程模型与低延迟播放优化。"
---

去年在做一款实时语音通话应用时，遇到了一个棘手问题：同一台设备上，微信通话延迟只有 40ms，而我们的 App 稳定在 120ms 以上。同样是 Android 系统，差距从哪来？

排查过程中把 AudioTrack、AudioFlinger、HAL 三层翻了一遍，才发现低延迟音频不是调个参数就能解决的。

## AudioTrack：应用层的数据投递站

AudioTrack 是 Android Java/Kotlin 层播放音频的标准入口。应用创建 AudioTrack 实例后，通过 `write()` 方法向缓冲区投递 PCM 数据，系统负责后续的混音和输出。

```kotlin
val bufferSize = AudioTrack.getMinBufferSize(
    48000, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT
)
val audioTrack = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build())
    .setAudioFormat(AudioFormat.Builder()
        .setSampleRate(48000)
        .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build())
    .setBufferSizeInBytes(bufferSize)
    .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
    .build()
audioTrack.play()
// 投递音频数据
audioTrack.write(pcmData, 0, pcmData.size)
```

`setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)` 是关键配置。不设这个标志，AudioTrack 默认走普通通路，缓冲区大小由系统按 `getMinBufferSize()` 返回值的 2-4 倍分配。设了之后，Flinger 会分配一个更小的缓冲区，并对这条 Track 做优先调度。

但光靠这个标志不够。`getMinBufferSize()` 返回的大小在多数设备上是 4KB-16KB——对于 48kHz 立体声 16bit 来说，相当于 20ms-80ms 的数据量。加上 HAL 层的输出缓冲区，总延迟轻松超过 100ms。

### Shared Memory 与数据搬运

AudioTrack 和应用之间不是简单的内存拷贝。框架层使用 `android::MemoryHeapBase` 创建一块共享内存，应用进程和 AudioFlinger 进程都能直接访问。应用 `write()` 写入的数据被拷贝到这片共享内存的 `mCblk` 控制块中，Flinger 侧读取时不再跨进程拷贝。

这个设计避免了每次 `write()` 调用都走 Binder 传输——Binder 单次调用开销在 50-100μs，对音频这种高频数据通路来说太贵了。

`write()` 仍然是一次用户态拷贝。真正零拷贝的方案是使用 AudioTrack 的 `getBuffer()` + `releaseBuffer()` 接口，直接操作共享内存：

```cpp
// Native 层零拷贝写入
void* buffer = nullptr;
size_t size = 0;
audioTrack->getBuffer(&buffer, &size);
if (buffer && size >= dataSize) {
    memcpy(buffer, pcmData, dataSize);
    audioTrack->releaseBuffer(dataSize);
}
```

零拷贝的收益取决于 buffer 大小。对于 1-2ms 的小帧（实时通话场景），零拷贝能显著降低 CPU 抖动；对于 20ms 以上的大帧，普通 `write()` 的拷贝开销占比很小，区别不大。

## AudioFlinger：混音与调度中枢

AudioFlinger 是 SystemServer 进程中的一个守护线程服务，管理所有音频流的生命周期。它的核心数据结构是 `PlaybackThread`，每个音频输出设备（扬声器、耳机、蓝牙 A2DP）对应一个 PlaybackThread。

### 混音器的工作原理

当多个应用同时播放音频时，Flinger 需要把所有活跃的 `Track` 混音成一路数据送给 HAL。混音操作在 `ThreadLoop()` 的每个周期中执行：

```
周期 = HAL 输出缓冲区大小 / 采样率 / 通道数 / 位深
例如：240 帧 / 48000Hz = 5ms
```

每个周期内，Flinger 遍历当前 PlaybackThread 下所有活跃 Track，把它们的共享内存中的数据按采样点相加，做一次软裁剪防止溢出，然后写入 HAL 的环形缓冲区。

混音器使用 32 位浮点精度，即使输入是 16 位整型，也会先转为 float 再累加。处理多路音频时这一点很关键——8 路 16bit 音频同时叠加，16bit 精度下信噪比会明显劣化，float 混音则不存在这个问题。

```cpp
// AudioFlinger 混音器核心逻辑（简化）
for (size_t i = 0; i < frameCount; i++) {
    float sample = 0.0f;
    for (const auto& track : activeTracks) {
        sample += track->readSample(i);  // 从共享内存读取
    }
    // 软裁剪到 [-1.0, 1.0]
    sample = clamp(sample, -1.0f, 1.0f);
    outputBuffer[i] = convertToInt16(sample);
}
```

### FastMixer：低延迟的独立通路

普通 PlaybackThread 的混音循环和系统其他任务共用一个线程优先级，遇到 binder 调用或 GC 时会被抢占，产生音频卡顿（underrun）。

FastMixer 是 AudioFlinger 中一条独立的实时线程，`SCHED_FIFO` 调度策略，优先级高于所有普通线程，专门处理标记了 `PERFORMANCE_MODE_LOW_LATENCY` 的 Track。

FastMixer 的核心约束是：**不执行任何可能阻塞的操作**。它不能调用 HAL 的 `write()`（HAL 实现可能加锁），而是使用 `obtainBuffer()` / `releaseBuffer()` 的非阻塞接口，配合 HAL 驱动的回调机制。

启用 FastMixer 后，音频延迟可以从 50-100ms 降到 10-20ms。代价是 CPU 占用率略微升高——实时线程频繁唤醒，调度开销不可忽略。

## HAL 层：硬件直通与延迟瓶颈

HAL（Hardware Abstraction Layer）是 AudioFlinger 和 DSP/Codec 硬件之间的接口层。Android 8.0 后主推 HIDL Audio HAL，AIDL HAL 也在逐步落地。

HAL 层定义了输入输出流（`IStreamIn` / `IStreamOut`）的接口契约。其中 `getLatency()` 方法返回的是 HAL 层自身的延迟，不包括 Flinger 和 Track 缓冲区的延迟。

实测过几款旗舰机，HAL 层 `getLatency()` 返回值：
- Pixel 7：5ms（扬声器）
- 某国产厂商 2024 款：15-25ms（有 DSP 后处理管线）
- 低端机型：40-80ms

HAL 层延迟差异主要来自厂商的 DSP 音效处理链路。扬声器保护算法、均衡器、虚拟环绕声等后处理都会增加帧缓冲，而且这些处理往往是厂商闭源实现，应用无法绕过。

### MMAP 直通模式

传统 HAL 输出模式是应用→Flinger→HAL→ALSA→Codec，每层都有自己的缓冲区，延迟层层叠加。

AAudio 的 MMAP（Memory-Mapped）模式绕开了部分链路：应用进程通过 `mmap()` 直接映射 ALSA 驱动的 DMA 缓冲区，AudioTrack 的 `write()` 相当于直接写入硬件环形缓冲区，不再经过 Flinger 的混音器。

```
传统路径：  App → AudioTrack buffer → Flinger mixer → HAL buffer → ALSA → Codec
MMAP路径：  App → mmap'd ALSA buffer → Codec
```

MMAP 模式下延迟可以降到 3-8ms，但有两个硬性限制：一是不能混音（独占输出），二是需要 ALSA 驱动支持 `mmap` 接口。后者在低端 SoC 上经常不完整。

## AAudio：重新设计的低延迟 API

AAudio 是 Android 8.0 引入的 Native API，专为低延迟音频场景设计。和 AudioTrack 相比，两个核心差异：

**回调驱动代替主动 write**。AAudio 通过 `AAudioStream_dataCallback` 在需要数据时回调应用，而不是让应用自己去判断何时写入。这个回调直接运行在 AudioFlinger 的 PlaybackThread 上下文中，消除了应用层的轮询开销。

```cpp
aaudio_data_callback_result_t dataCallback(
    AAudioStream* stream,
    void* userData,
    void* audioData,
    int32_t numFrames) {
    // 直接在 AudioFlinger 线程上下文生成音频数据
    generatePcmData(static_cast<int16_t*>(audioData), numFrames);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

void setupAAudio() {
    AAudioStreamBuilder* builder;
    AAudio_createStreamBuilder(&builder);
    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
    AAudioStreamBuilder_setSampleRate(builder, 48000);
    AAudioStreamBuilder_setChannelCount(builder, 2);
    AAudioStreamBuilder_setPerformanceMode(
        builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setDataCallback(builder, dataCallback, nullptr);

    AAudioStream* stream;
    AAudioStreamBuilder_openStream(builder, &stream);
    AAudioStream_requestStart(stream);
}
```

回调模式配合 MMAP 通路时，从应用生成数据到 Codec 开始播放，延迟可以控制在 3ms 以内。

**容量查询替代猜测**。AAudio 提供了 `AAudioStream_getBufferCapacityInFrames()`，直接返回硬件允许的最小缓冲区帧数，不再依赖 `getMinBufferSize()` 这种估算值。

从 AudioTrack 迁移到 AAudio 时踩过一个坑：AAudio 的回调在 FastMixer 线程上执行，如果你的音频生成逻辑有锁竞争或内存分配，会直接导致 underrun。AudioTrack 的阻塞式 `write()` 虽然延迟高，但对调用者的实时性要求低——Flinger 有更多缓冲来容忍应用抖动。

迁移建议：先确保音频生成路径零锁、零分配（使用预分配的环形缓冲区），再切换到 AAudio 回调模式。

## 选型建议

三种 API 的选择可以按延迟需求来定：

**AudioTrack（普通模式）**：延迟 80-200ms，适合音乐播放器、通知音。开发最简单，容错性好。

**AudioTrack + LowLatency + FastMixer**：延迟 10-30ms，适合实时音效、乐器应用。比 AAudio 好调试，Java/Kotlin 层可操作。

**AAudio + MMAP**：延迟 3-10ms，适合 VoIP、游戏音频、专业音频 DAW。需要 Native 开发，对音频生成路径的实时性要求最高。

做语音通话那会儿，最终选择的是中间方案——AudioTrack LowLatency 模式，配合 Opus 编码的抖动缓冲做自适应调节。AAudio 的独占模式无法支持通话音效（回声消除、降噪），而这些处理又必须在应用层接入厂商的 DSP 管线。技术选型不是选延迟最低的，而是选能在约束内稳定工作的。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/2026-04-19-Android_%E5%86%B7%E5%90%AF%E5%8A%A8%E5%85%A8%E9%93%BE%E8%B7%AF%E4%BC%98%E5%8C%96%E5%B7%A5%E7%A8%8B%E5%AE%9E%E8%B7%B5_%E4%BB%8E_Zygote_fork_%E5%88%B0%E9%A6%96%E5%B8%A7%E4%B8%8A%E5%B1%8F%E7%9A%84_Systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/App%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96%E4%B8%93%E9%A1%B9/)
- [RecyclerView 缓存机制详解：四级缓存、复用与 Prefetch](/blog/2026-04-14-%E6%B7%B1%E5%85%A5_Android_RecyclerView_%E7%BC%93%E5%AD%98%E6%9C%BA%E5%88%B6_%E4%BB%8E%E5%9B%9B%E7%BA%A7%E7%BC%93%E5%AD%98%E5%88%B0_Prefetch_%E7%9A%84%E6%80%A7%E8%83%BD%E8%AE%BE%E8%AE%A1/)
- [Android Bitmap 内存模型：Java 堆、Native 堆与 Hardware Bitmap](/blog/2026-04-14-%E6%B7%B1%E5%85%A5_Android_Bitmap_%E5%86%85%E5%AD%98%E6%A8%A1%E5%9E%8B_%E4%BB%8E_Java_%E5%A0%86%E5%88%86%E9%85%8D%E5%88%B0_Hardware_Bitmap/)
<!-- /seo-internal-links -->
