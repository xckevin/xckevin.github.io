---
title: 深入 Android MediaCodec 视频编解码全链路：从 MediaExtractor 解封装到异步模式输入输出缓冲区的硬件加速编码实战
excerpt: 深入剖析 Android MediaCodec 视频编解码全链路，涵盖解封装、状态机、异步缓冲区管理、硬解码兼容性处理及 MediaMuxer 封装，分享实际项目中的避坑经验与取舍策略。
publishDate: '2026-05-18'
tags:
- Android
- MediaCodec
- 视频编解码
- 硬解码
- 性能优化
seo:
  title: 深入 Android MediaCodec 视频编解码全链路：从 MediaExtractor 解封装到异步模式输入输出缓冲区的硬件加速编码实战
  description: 深入剖析 Android MediaCodec 视频编解码全链路：从 MediaExtractor 解封装、Codec 状态机与异步模式陷阱，到缓冲区管理与硬件兼容性处理，附完整 Kotlin 实战代码与避坑指南。
---

在做视频转码工具时，我遇到了一个诡异的问题：同一段 H.264 视频，同步模式编解码一切正常，切换到异步模式后频繁丢帧，输出画面出现绿条花屏。排查了两天才定位到根因——**没有正确处理 MediaCodec 输入缓冲区的 IllegalStateException**。这篇文章把排查过程和梳理的 Codec 全链路知识串起来讲一遍。

## 解封装：MediaExtractor 到底做了什么

MediaExtractor 的核心工作是解析容器格式（Container Format）。MP4、MKV、WebM 都是容器，视频和音频轨道用不同编码格式压缩后封装在里面，"读文件"只是表象。

```kotlin
val extractor = MediaExtractor()
extractor.setDataSource(filePath)

// 遍历轨道，找到视频轨
val videoTrackIndex = (0 until extractor.trackCount).first { index ->
    val format = extractor.getTrackFormat(index)
    format.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
}

extractor.selectTrack(videoTrackIndex)
val format = extractor.getTrackFormat(videoTrackIndex)
```

`MediaFormat` 里有两个关键信息：MIME 类型（如 `video/avc`）和 **csd-0/csd-1**。csd 是 Codec-Specific Data，对 H.264 来说就是 SPS（Sequence Parameter Set）和 PPS（Picture Parameter Set）——解码器没这两段元数据根本没法初始化。

把 csd 传给 `MediaCodec.configure()`，Codec 才能正确解析后续帧。不传 csd 直接送帧数据，Codec **可能** 能从码流中自行解析，生产环境不要赌这个。

## Codec 状态机：异步模式的陷阱

MediaCodec 有三个核心状态：**Stopped → Executing → Released**。Executing 阶段又细分为 Configured、Started（以前叫 Running）、Flushed 三个子状态。

异步模式的回调时序和同步模式完全不同。同步模式下你手动控制 `dequeueInputBuffer`/`dequeueOutputBuffer` 的调用时机，调用顺序由你保证。异步模式通过 `MediaCodec.Callback` 回调驱动：

```kotlin
codec.setCallback(object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
        // 拿到输入缓冲区索引，填充数据后 queueInputBuffer
    }

    override fun onOutputBufferAvailable(
        codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo
    ) {
        // 拿到解码后的数据，处理完 releaseOutputBuffer
    }

    override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
        // 硬解特有的错误，如不支持的 profile
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
        // 输出格式变化，比如分辨率改变
    }
}, handler) // 注意这里的 Handler
```

`Handler` 参数决定回调在哪个线程执行。我踩的坑就在这里：传了 `null` 让回调跑在 Codec 内部线程上，在处理输出缓冲区时做了耗时操作（把数据写入文件），导致后续 `onInputBufferAvailable` 被阻塞——Codec 内部队列满后不再回调，死锁。

解决办法：显式传一个后台线程的 Handler，回调里只做轻量操作。

```kotlin
val handlerThread = HandlerThread("CodecCallback")
handlerThread.start()
val handler = Handler(handlerThread.looper)
codec.setCallback(callback, handler)
```

## 缓冲区管理：输入输出不对称

输入缓冲区和输出缓冲区的工作机制并不对称，这很容易出错。

**输入侧**：`dequeueInputBuffer` 或 `onInputBufferAvailable` 拿到的是空缓冲区引用，需要填入压缩数据。超时参数 `timeoutUs` 设为 `-1` 表示无限等待，但在异步模式里这个参数不生效——回调本身就是"有缓冲区可用时才通知你"。

**输出侧**：拿到的是已解码数据。处理后 **必须** 调用 `releaseOutputBuffer(index, render)` 释放缓冲区。不释放会导致 Codec 缓冲区耗尽，后续帧全部丢弃——我的花屏问题，就是因为某个异常路径里直接 return 了，没调 release。

解码场景下，`releaseOutputBuffer` 的第二个参数 `render` 设为 `true` 会把数据交给 Surface 渲染；编码场景下这个参数无效，直接恢复缓冲区即可。

H.264 编码器的输出不是逐帧的——B 帧的存在导致解码顺序和显示顺序不一致。需要通过 `BufferInfo.presentationTimeUs` 排序后再写入文件。我在编码时用 `TreeMap` 做时间戳排序：

```kotlin
private val pendingFrames = TreeMap<Long, Pair<ByteBuffer, MediaCodec.BufferInfo>>()

// 在 onOutputBufferAvailable 中
pendingFrames[info.presentationTimeUs] = outputBuffer to info.clone()

// 按 PTS 顺序写入
while (pendingFrames.isNotEmpty()) {
    val first = pendingFrames.firstEntry()
    if (first.key < lastWrittenPts) {
        pendingFrames.remove(first.key)
        continue
    }
    muxer.writeSampleData(trackIndex, first.value.first, first.value.second)
    pendingFrames.remove(first.key)
}
```

## 硬解与硬编码的兼容性处理

硬解效率高，但兼容性一言难尽。不同厂商的 Codec 实现差异大，同一个 H.264 profile 在三星正常、小米绿屏的情况很常见。

几条实际验证过的经验：

**1. 兜底方案**：创建 Codec 时优先硬件，但要保留软件解码 fallback：

```kotlin
val codecName = try {
    MediaCodecList(MediaCodecList.REGULAR_CODECS)
        .findDecoderForFormat(format) // 硬件优先
} catch (e: Exception) {
    "c2.android.avc.decoder" // Google 软件解码器
}
MediaCodec.createByCodecName(codecName)
```

**2. 色彩格式协商**：硬件解码器输出的色彩格式往往是厂商私有的（如 `COLOR_QCOM_FormatYUV420PackedSemiPlanar32m`），直接读 ByteBuffer 可能拿不到标准 YUV。我的做法是配置 Surface 输出，让 Codec 把数据渲染到 OpenGL 纹理上，再通过 FBO 读回标准格式。比直接操作 ByteBuffer 多一步 copy，但避免了兼容性噩梦。

**3. 编码器码率控制**：硬编码器的 VBR（Variable BitRate）模式在不同机型上表现差异很大。我碰到过某机型无视 `KEY_BITRATE_MODE` 设置、始终以 CBR 编码的情况。现在的做法是先用 CBR 做首帧测试，确认输出帧大小符合预期再切 VBR。

## MediaMuxer：封装不只是写文件

解码→处理→编码完成后，用 `MediaMuxer` 重新封装。`addTrack` 必须在 `start` 之前调用，一旦 `start` 了就不能再添加新轨道。

```kotlin
val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
val trackIndex = muxer.addTrack(encoderOutputFormat) // 用编码器的输出格式
muxer.start()

// 写数据时注意时间戳连续性
muxer.writeSampleData(trackIndex, buffer, bufferInfo)

muxer.stop()
muxer.release()
```

MP4 要求 `writeSampleData` 的时间戳连续递增。中间丢弃了某些帧，要手动调整后续帧的 `presentationTimeUs`，否则 muxer 会抛异常。

## 实际项目中的取舍

做视频处理这类系统级编程，没有银弹，全在 trade-off 里找平衡。

**异步模式 vs 同步模式**：我现在默认异步模式，代码更简洁。但如果要做精确的帧级控制（根据解码结果动态决定编码参数），同步模式更灵活。同步模式唯一需要注意的是 `dequeueInputBuffer(-1)` 可能永久阻塞——加个超时重试机制更稳妥。

**Surface 输入 vs ByteBuffer 输入**：编码器用 Surface 输入（`createInputSurface`）可以把 OpenGL 渲染结果直接送入编码器，零拷贝。代价是失去对输入帧时机的精确控制。我的转码场景需要精确控制每一帧处理，选了 ByteBuffer 模式。

**错误恢复策略**：MediaCodec 一旦进入 Error 状态就必须 release 重建，无法恢复。编码器对输入数据的格式要求很严格——分辨率变化、SPS/PPS 更新都要通过 `BUFFER_FLAG_CODEC_CONFIG` 标志重新配置。检测到 `INFO_OUTPUT_FORMAT_CHANGED` 后必须重建 muxer，否则输出的 MP4 文件会损坏。

`BufferInfo.flags` 里的 `BUFFER_FLAG_END_OF_STREAM` 是通知 Codec 数据已送完的信号。发送 EOS 后 Codec 还会继续吐出缓冲区中剩余帧，直到输出侧也收到 EOS。忘记在输入侧发 EOS，`dequeueOutputBuffer` 会一直等下去，看起来像卡死了。
