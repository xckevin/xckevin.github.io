---
title: 深入 Android 音频采集全链路：从 AudioRecord 低延迟输入到回声消除与端侧语音识别的协同
excerpt: 本文完整梳理 Android 音频采集链路：从 AudioRecord 缓冲区权衡到 AAudio 低延迟输入，再到回声消除与端侧 ASR 的数据适配，并给出边播边听场景的可落地参考架构。
publishDate: '2026-08-28'
tags:
- Android
- AudioRecord
- AAudio
- 回声消除
- 端侧语音识别
seo:
  title: 深入 Android 音频采集全链路：从 AudioRecord 低延迟输入到回声消除与端侧语音识别的协同
  description: 系统梳理 Android 音频采集全链路，从 AudioRecord 缓冲区与 AAudio 低延迟到回声消除、重采样与 VAD，再到端侧 ASR 适配，附可落地参考架构。
---

在端侧语音助手项目里，我遇到过一个挺尴尬的场景：TTS 正在播报时用户插话打断，麦克风把喇叭刚说出去的话又录了回来，ASR 把机器自己的台词转成了文字。排查发现，网上讲 Android 音频的文章基本都在聊播放链路，采集这条线要么一笔带过，要么默认"照着官方 demo 抄就行"。

这篇文章把采集这条线完整走一遍：AudioRecord 怎么选缓冲、AAudio 怎么压延迟、回声消除为什么同时依赖播放和采集、端侧 ASR 到底要什么格式。看完你在"边播边听"这类场景里不用再拼零散经验。

## 采集链路的起点：AudioRecord 与缓冲区权衡

Android 采集的入门 API 是「AudioRecord」，它把麦克风数据以 PCM 字节流的形式交给你。创建时最容易被忽略的是 `getMinBufferSize()` 的语义——它返回的是系统保证不丢数据的最小缓冲，不等于推荐值，更不等于低延迟值。

```kotlin
val min = AudioRecord.getMinBufferSize(
    16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)

val recorder = AudioRecord.Builder()
    .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
    .setAudioFormat(AudioFormat.Builder()
        .setSampleRate(16000)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build())
    .setBufferSizeInBytes(min * 2)
    .build()
```

缓冲设成 `min` 的 2 到 4 倍是常见实践，但代价是延迟上升。16 kHz、16 bit、单声道下，`min` 通常对应几十毫秒数据，翻倍后输入延迟可能到 100 ms 以上。对按键唤醒这类场景无所谓，对实时对话就有感知了。

`setAudioSource` 的选择直接决定后续处理路径。「VOICE_RECOGNITION」会走厂商针对识别的调优，可能带内置降噪和 AGC；「UNPROCESSED」则绕过所有预处理，拿到最原始的音频，适合你有自己的前端算法时使用，但需要设备支持，而且部分厂商实现得很敷衍。

## AAudio：低延迟是硬指标时的选择

如果目标是 20 ms 以内的输入延迟，Java 层的 AudioRecord 基本到不了。它内部经过 Binder 控制面与 AudioFlinger 交互，数据还要在 Java 层缓冲里倒腾，来回一趟就把延迟预算吃光了。Android 8.0 引入的「AAudio」走 native 直通路径，部分设备上能拿到 mmap 共享内存甚至独占模式。

```cpp
AAudioStreamBuilder *builder;
AAudio_createStreamBuilder(&builder);
AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_INPUT);
AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
AAudioStreamBuilder_setSampleRate(builder, 16000);
AAudioStreamBuilder_setChannelCount(builder, 1);

AAudioStream *stream;
AAudioStreamBuilder_openStream(builder, &stream);
int32_t burst = AAudioStream_getFramesPerBurst(stream);
```

关键在最后一行：`getFramesPerBurst()` 返回设备的 burst 大小，这是硬件一次传输的帧数。**你的读取循环要以 burst 为最小单位**，而不是自己随便定个 1024。按 burst 读，AAudio 才能最大化利用共享内存路径，否则它内部还要做一次拼接拆包。

实际项目里我更倾向用 Google 的「Oboe」包装 AAudio 和 OpenSL ES。它把两个 API 的差异抹平，低延迟设备走 AAudio，老设备自动回退 OpenSL ES，还帮你处理了设备热插拔和误差校正。自己裸写 AAudio 的收益，大多数团队不划算。

## 回声消除：播放与采集的交汇点

回到开头的问题。用户插话时，喇叭播报的内容会经空气传到麦克风，形成「回声（Echo）」。ASR 分不清这是用户说的还是机器说的，识别结果整段被污染。解决思路是给采集信号做「回声消除（Acoustic Echo Cancellation，AEC）」，核心是拿播放信号做参考，估计出回声路径，再从采集信号里减掉。

Android 提供了硬件 AEC 的封装「AcousticEchoCanceler」：

```kotlin
val sessionId = recorder.audioSessionId
if (AcousticEchoCanceler.isAvailable()) {
    val aec = AcousticEchoCanceler.create(sessionId)
    aec.enabled = true
}
```

这段代码能跑通，但需要纳入一个容易误解的点：`AcousticEchoCanceler.create(sessionId)` 只绑定到采集端的 AudioRecord session，**并不要求 AudioTrack 和 AudioRecord 显式共用同一个 session id**。Android 平台提供的这层 AEC 是硬件/驱动层的黑盒处理：只要设备支持，开启后会自动参照设备当前正在播放的声道信号，开发者不需要也无法显式向它传入参考 PCM。还要记得声明 `MODIFY_AUDIO_SETTINGS` 权限，不然 `create` 直接返回 null。这一层硬件 AEC 和下一段要说的 WebRTC 软件 AEC 工作机制完全不同，不能混为一谈。

硬件 AEC 的效果受厂商驱动质量影响，中低端设备上经常消不干净，尤其大音量播放时。做严肃的远场或全双工场景，我更推荐软件 AEC，比如 WebRTC 的 AEC3。软件 AEC 与平台硬件 AEC 的根本区别在于：**它需要你显式地把播放前的 PCM 和采集后的 PCM 按帧对齐喂进去**，作为远端参考信号供算法估计回声路径——因为软件 AEC 跑在应用层，拿不到设备驱动层的内部播放信号，必须依赖你自己提交。它自带的延迟估计算法能处理几十到几百毫秒的偏差，鲁棒性比硬件那层强得多，代价是开发难度和计算量都更高。

## 端侧 ASR 的数据要求与适配

采集信号经过 AEC 后，还不能直接进识别引擎。端侧 ASR 对输入格式非常挑剔：主流引擎（whisper.cpp、Vosk、Sherpa）几乎都要求 **16 kHz、单声道、16 bit PCM**。如果你的采集链路为了低延迟跑在 48 kHz 上，就得做一次重采样。

重采样别自己写线性插值。48k 到 16k 是 3:1 的整数倍关系，简单抽取就能应付一部分场景，但更稳妥的做法是用专门的 resampler 避免高频混叠。实际项目里我直接复用 WebRTC 的 PushResampler，质量稳定且没有额外依赖负担。

重采样之后通常还要接一级「语音活动检测（Voice Activity Detection，VAD）」。VAD 的作用是切出真正有人声的片段，把静音和纯回声残留挡在 ASR 之外。这不仅省算力，更重要的是避免 ASR 在无语音时输出幻觉文本。WebRTC 的 VAD 或 Silero VAD 都是可直接落地的选择，后者在中文噪声环境下表现更好，我用下来主观感受是误触发更少。

## 把链路串起来：一个可落地的参考架构

整条链路最终是一个典型的「生产者-消费者」模型。采集线程生产音频帧，处理线程消费并做 AEC、重采样、VAD，最后喂给 ASR 的流式接口。中间的队列用无锁环形缓冲，帧大小统一成 20 ms，避免各处各用各的帧长导致频繁拷贝。

```kotlin
val frame = ByteArray(320 * 2) // 16k * 16bit * 20ms = 640 bytes
while (running.get()) {
    val n = recorder.read(frame, 0, frame.size)
    if (n > 0) queue.offer(frame.copyOf(n))
}
```

采集线程只做一件事：读数据塞进队列。AEC 和重采样放在同一个处理线程里做，因为它俩都依赖帧对齐，拆开反而要处理跨线程同步。ASR 如果支持流式回调，直接挂在处理线程尾部；不支持就把识别结果通过回调抛回主线程更新 UI。

延迟预算要提前算清。采集缓冲 + AEC 帧对齐 + VAD 帧长 + ASR 解码，加起来就是"用户说完到出文字"的总延迟。实时对话场景把它控制在 300 ms 以内体验才不崩，其中 AEC 的延迟估计窗口通常是最大头，调参时优先关注这里。

## 三条落地的实践建议

一，先确定延迟预算再选 API。实时对话走 AAudio + 软件 AEC，异步录音走 AudioRecord 就够，别一上来就上重武器。

二，硬件 AEC 和软件 AEC 的排查思路要分开。硬件 AEC 消不掉回声时，先确认采集端 session 是否正确、设备是否真支持；软件 AEC 消不掉时，先确认喂给它的参考 PCM 是不是播放前的那份、是不是按帧对齐。

三，把采集、处理、识别三层解耦成独立线程加环形队列。链路一旦跑通，后续换 ASR 引擎或加降噪模块，都只需要动单个环节，不用推倒重来。
