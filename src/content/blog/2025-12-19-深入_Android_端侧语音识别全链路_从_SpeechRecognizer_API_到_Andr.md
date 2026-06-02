---
title: 深入 Android 端侧语音识别全链路：从 SpeechRecognizer API 到 Android 16 设备端 ASR 引擎
excerpt: 梳理 Android 端侧语音识别完整链路，从 AudioRecord 音频采集到 Android 16 内置 ASR 引擎的架构设计与工程实践。
publishDate: '2025-12-19'
tags:
- Android
- 语音识别
- ASR
- 端侧AI
- 性能优化
seo:
  title: 深入 Android 端侧语音识别全链路：从 SpeechRecognizer API 到 Android 16 设备端 ASR 引擎
  description: 深入 Android 端侧语音识别全链路：从 AudioRecord 音频采集、SpeechRecognizer API 到 Android 16 内置 OnDeviceAsrEngine，涵盖双缓冲设计、VAD 前置优化及离线优先兜底策略的完整工程实践。
---

去年做车载导航项目时，产品提了一个需求：隧道里没网也要能语音搜索地址。我当时的第一反应是——Android 的语音识别不是一直依赖云端服务吗？

查了一圈发现，Android 16 把设备端 ASR（Automatic Speech Recognition）引擎正式内置了。离线转写不再是第三方 SDK 的专属能力。这篇文章顺着 AudioRecord 采集到 RecognitionService 转写的完整链路，梳理端侧语音识别的架构和工程要点。

## AudioRecord：不只是录个音

语音识别的第一步是获取原始音频数据。Android 提供了 `AudioRecord` 和 `MediaRecorder` 两条路，端侧 ASR 场景必须走前者——你需要的是 PCM 裸流，而不是编码后的文件。

```kotlin
val bufferSize = AudioRecord.getMinBufferSize(
    16000, // 采样率，ASR 通常用 16kHz
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT
)
val audioRecord = AudioRecord(
    MediaRecorder.AudioSource.MIC, // 或 VOICE_RECOGNITION
    16000,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT,
    bufferSize * 2 // 实际 buffer 略大于最小值，避免丢帧
)
audioRecord.startRecording()

val buffer = ShortArray(bufferSize)
while (isRecording) {
    val readSize = audioRecord.read(buffer, 0, bufferSize)
    if (readSize > 0) {
        recognizer.write(buffer.copyOf(readSize)) // 喂给识别引擎
    }
}
```

几个容易踩坑的点：

**采样率一致性**是第一个坑。AudioRecord 和 ASR 引擎的采样率必须对齐，不匹配会导致识别率断崖式下降。16kHz 是主流 ASR 模型的标准输入，16bit 位深、单声道也是默认配置。别想着用 44.1kHz 录了再重采样——重采样的计算开销在移动端不划算，引入的量化误差还会拖累 VAD（Voice Activity Detection）的精度。

**音频源选择**也直接影响识别效果。`MIC` 和 `VOICE_RECOGNITION` 的区别在于后者会启用硬件级的回声消除和噪声抑制。实际测下来，`VOICE_RECOGNITION` 在嘈杂环境下的识别率比 `MIC` 高出约 15%-20%，代价是首帧延迟多了约 50ms。车内场景我更倾向用 `VOICE_RECOGNITION`，用延迟换准确率是值得的。

**权限绕不过去**。`RECORD_AUDIO` 是运行时权限，Android 14+ 还需要在 Manifest 里声明 `foregroundServiceType="microphone"` 才能在前台 Service 中录音。这个细节很容易在升级 targetSdk 时被忽略。

## SpeechRecognizer：意图与服务的桥接

有了音频流，接下来把它送给识别引擎。Android 的标准入口是 `SpeechRecognizer`：

```kotlin
val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)

recognizer.setRecognitionListener(object : RecognitionListener {
    override fun onResults(results: Bundle) {
        val matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        // matches[0] 是置信度最高的转写结果
    }

    override fun onPartialResults(partialResults: Bundle) {
        // 实时部分结果，用于流式展示
    }

    override fun onError(error: Int) { /* 处理错误 */ }
    override fun onReadyForSpeech(params: Bundle?) { /* 准备就绪 */ }
    // ... 其他回调
})

val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true) // 开启流式返回
recognizer.startListening(intent)
```

但 `SpeechRecognizer` 本身不做识别——它只是一个客户端代理，通过 Binder 把音频数据和识别意图转发给系统级的 `RecognitionService`。Google 预置的 `RecognitionService` 在 Android 15 及之前版本默认走云端，断网状态下 `createOnDeviceSpeechRecognizer` 返回的实例会直接报 `ERROR_NETWORK`。

很多开发者对端侧 ASR 的印象就停在这里：API 是有了，但离线根本跑不起来。

## RecognitionService 的模型分发机制

`RecognitionService` 是语音识别的真正执行者，运行在 `com.android.systemui` 或专用的系统进程中。它的工作流：

1. 接收 `startListening()` 传来的 Intent
2. 加载对应的声学模型和语言模型
3. 不断从 AudioRecord 或客户端传入的音频 buffer 中取数据
4. 执行 VAD 切分语音段
5. 对每个语音段做声学特征提取（MFCC / FBANK）
6. 送入 Encoder-Decoder 模型做序列到序列的映射
7. 通过 Beam Search 或 CTC 解码得到文本
8. 把结果通过 `RecognitionListener` 回调返回

Android 16 的关键变化是引入了 **OnDeviceAsrEngine** 作为新的系统服务。它把联邦学习（Federated Learning）训练的 Compact ASR 模型预置到了系统分区，不再需要在运行时从 Play Store 动态下载语言包。模型大小约 50MB，覆盖中、英、日等 8 种语言。

通过 `adb shell dumpsys on_device_asr` 可以查看当前设备上的模型状态：

```bash
$ adb shell dumpsys on_device_asr
OnDeviceAsrEngine State:
  Loaded models: zh-CN (v2.1.0), en-US (v2.1.0)
  Memory footprint: 48.3 MB
  VAD state: idle
  Active sessions: 0
```

`createOnDeviceSpeechRecognizer` 在 Android 16 上调用的就是这个内置引擎，断网也能正常转写。

## 离线工程实践的三个关键决策

### 缓冲区设计：平衡延迟与吞吐

`AudioRecord.read()` 是阻塞调用，必须放在独立线程里。缓冲区设太大，端到端延迟（用户说完到出第一个字）会飙升；设太小，CPU 频繁上下文切换反而降低吞吐。

我用的是双缓冲 + 环形队列方案：

```kotlin
private val audioBuffer = CircularBuffer<ShortArray>(capacity = 10)

// 采集线程
thread {
    while (isRecording) {
        val chunk = ShortArray(chunkSize)
        val read = audioRecord.read(chunk, 0, chunkSize)
        if (read > 0) audioBuffer.put(chunk.copyOf(read))
    }
}

// 识别线程
thread {
    while (isRecognizing) {
        val data = audioBuffer.take() // 阻塞等待
        recognizer.write(data)
    }
}
```

`chunkSize` 设为 3200 个采样点（16kHz 下对应 200ms 的音频），实测端到端延迟控制在 800ms 以内，CPU 占用不超过 5%。

### VAD 前置：沉默片段不进模型

系统 `RecognitionService` 自带 VAD，但在端侧场景下，把 VAD 前置到采集侧能减少约 30% 的无效推理。思路是在 AudioRecord 和 `recognizer.write()` 之间加一层能量检测：

```kotlin
fun isSilence(buffer: ShortArray, threshold: Double): Boolean {
    val rms = sqrt(buffer.map { (it * it).toDouble() }.average())
    return rms < threshold
}
```

`threshold` 取值和环境强相关。我用 `200` 作为车内场景的经验值，安静房间里可以降到 `100`。前端 VAD 不会完全替代系统的 VAD——它只是一个粗筛，用来跳过明显的静音段。

### 兜底策略：离线优先、在线兜底

端侧模型的准确率即使到 2026 年也做不到和云端持平，尤其在专有名词、方言场景下。我目前的策略是：

1. 优先使用 `createOnDeviceSpeechRecognizer` 做离线识别
2. 监听 `ERROR_NETWORK` 之外的错误码，准备随时切换
3. 当 `onPartialResults` 连续 3 次置信度低于 0.6 时，自动切换到云端 `createSpeechRecognizer`
4. 云端返回结果后，用编辑距离比较两端结果，差距大则用云端，差距小用端侧（保护隐私）

这套逻辑在生产环境跑了半年，离线优先的可用率（不需要云端补救的比例）在普通话场景下约 78%，中英文混合场景下降到 62%。

## 踩坑记录

**设备兼容性**是大坑。`createOnDeviceSpeechRecognizer` 在 Android 15 上返回非 null 但不一定可用——部分厂商的定制 ROM 里系统 ASR 服务被裁减了。调用前最好先 `checkRecognitionSupport`，不要假设 API level >= 31 就能用。

**AudioRecord 的状态机**是经典事故场景。`startRecording()` 之后立即 `read()` 有概率返回 `ERROR_INVALID_OPERATION`，因为底层硬件还没准备好。加一个 100ms 的延迟或轮询 `recordingState` 可以避免。

**性能预算**要算清楚。端侧 ASR 不是零成本——模型加载占 50MB 内存，单次推理的峰值 CPU 可以达到单核的 60%（骁龙 8 Gen 2 实测）。如果你的 App 本身是内存大户，需要在 ASR 和非 ASR 场景之间做模型的热加载和卸载，`OnDeviceAsrEngine.unloadModel()` 可以手动释放。

做端侧 ASR 的这一年，最大的感受是：离线识别不是一个"有或没有"的二进制开关，而是一系列工程权衡的组合——延迟换准确率、内存换可用性、复杂度换隐私保护。每个决策都得结合自己的场景算账，没有银弹。
