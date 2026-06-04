---
title: "Android On-device Speech Recognition: From SpeechRecognizer to Android 16 ASR"
lang: en
translationKey: android-on-device-speech-recognition
slug: android-on-device-speech-recognition
excerpt: "A full-stack look at Android on-device speech recognition, from AudioRecord capture and SpeechRecognizer APIs to Android 16's built-in ASR engine."
publishDate: '2025-12-19'
tags:
- "Android"
- "Speech Recognition"
- "ASR"
- "On-device AI"
- "Performance Optimization"
seo:
  title: "Android On-device Speech Recognition with SpeechRecognizer and ASR"
  description: "Explore Android on-device speech recognition from AudioRecord capture and SpeechRecognizer to Android 16 ASR, VAD, buffering, and offline fallback."
  pageType: article
---

Last year, while working on an in-car navigation project, product asked for a feature: users should still be able to search for addresses by voice inside a tunnel with no network. My first reaction was that Android speech recognition had always depended on cloud services.

After digging through the platform, I found that Android 16 officially built in an on-device ASR, or Automatic Speech Recognition, engine. Offline transcription is no longer only available through third-party SDKs. This article follows the complete path from `AudioRecord` capture to `RecognitionService` transcription, and summarizes the architecture and engineering decisions behind on-device speech recognition.

## AudioRecord: more than just recording audio

The first step in speech recognition is capturing raw audio data. Android gives you two common APIs, `AudioRecord` and `MediaRecorder`. For on-device ASR, you need `AudioRecord` because the recognizer needs raw PCM frames, not an encoded file.

```kotlin
val bufferSize = AudioRecord.getMinBufferSize(
    16000, // Sample rate, ASR usually uses 16 kHz
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT
)
val audioRecord = AudioRecord(
    MediaRecorder.AudioSource.MIC, // Or VOICE_RECOGNITION
    16000,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT,
    bufferSize * 2 // Use a buffer slightly larger than the minimum to avoid frame drops
)
audioRecord.startRecording()

val buffer = ShortArray(bufferSize)
while (isRecording) {
    val readSize = audioRecord.read(buffer, 0, bufferSize)
    if (readSize > 0) {
        recognizer.write(buffer.copyOf(readSize)) // Feed audio to the recognition engine
    }
}
```

Several details are easy to get wrong.

**Sample-rate consistency** is the first one. The sample rate used by `AudioRecord` must match the ASR engine. A mismatch can make recognition quality fall off sharply. A 16 kHz sample rate is the standard input for mainstream ASR models, with 16-bit depth and mono audio as the default. Do not record at 44.1 kHz and resample later unless you have a strong reason. Resampling is not cheap on mobile devices, and the quantization error can also hurt VAD, or Voice Activity Detection, accuracy.

**Audio source selection** also affects recognition quality. The difference between `MIC` and `VOICE_RECOGNITION` is that the latter enables hardware-level echo cancellation and noise suppression. In my tests, `VOICE_RECOGNITION` improved recognition accuracy by about 15-20% in noisy environments, at the cost of about 50 ms of additional first-frame latency. For in-car use cases, I prefer `VOICE_RECOGNITION`; trading a little latency for accuracy is worth it.

**Permissions cannot be skipped**. `RECORD_AUDIO` is a runtime permission. On Android 14 and later, you also need to declare `foregroundServiceType="microphone"` in the manifest if recording happens inside a foreground service. This is an easy detail to miss when upgrading `targetSdk`.

## SpeechRecognizer: the bridge between intent and service

Once you have the audio stream, the next step is sending it to the recognition engine. Android's standard entry point is `SpeechRecognizer`:

```kotlin
val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)

recognizer.setRecognitionListener(object : RecognitionListener {
    override fun onResults(results: Bundle) {
        val matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        // matches[0] is the transcription with the highest confidence
    }

    override fun onPartialResults(partialResults: Bundle) {
        // Real-time partial results for streaming display
    }

    override fun onError(error: Int) { /* Handle errors */ }
    override fun onReadyForSpeech(params: Bundle?) { /* Ready */ }
    // ... Other callbacks
})

val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true) // Enable streaming results
recognizer.startListening(intent)
```

`SpeechRecognizer` itself does not perform recognition. It is a client-side proxy that forwards audio data and recognition intent to a system-level `RecognitionService` through Binder. On Android 15 and earlier, Google's preinstalled `RecognitionService` uses cloud recognition by default. When the device is offline, the instance returned by `createOnDeviceSpeechRecognizer` often reports `ERROR_NETWORK` directly.

That is where many developers' impression of on-device ASR stops: the API exists, but offline recognition does not actually run.

## RecognitionService model distribution

`RecognitionService` is the component that actually performs speech recognition. It runs inside `com.android.systemui` or a dedicated system process. Its workflow looks like this:

1. Receive the `Intent` passed from `startListening()`
2. Load the corresponding acoustic model and language model
3. Continuously read audio buffers from `AudioRecord` or the client
4. Use VAD to split speech segments
5. Extract acoustic features such as MFCC or FBANK for each segment
6. Feed features into an Encoder-Decoder model for sequence-to-sequence mapping
7. Decode text through Beam Search or CTC
8. Return results through `RecognitionListener` callbacks

The key change in Android 16 is the introduction of **OnDeviceAsrEngine** as a new system service. It places compact ASR models trained with Federated Learning into the system partition, so language packs no longer have to be downloaded dynamically from the Play Store at runtime. The model size is about 50 MB, and it covers eight languages including Chinese, English, and Japanese.

You can inspect model state on a device with `adb shell dumpsys on_device_asr`:

```bash
$ adb shell dumpsys on_device_asr
OnDeviceAsrEngine State:
  Loaded models: zh-CN (v2.1.0), en-US (v2.1.0)
  Memory footprint: 48.3 MB
  VAD state: idle
  Active sessions: 0
```

On Android 16, `createOnDeviceSpeechRecognizer` calls into this built-in engine, so transcription works even without a network.

## Three key decisions for offline engineering

### Buffer design: balancing latency and throughput

`AudioRecord.read()` is a blocking call, so it must run on a dedicated thread. If the buffer is too large, end-to-end latency, from the user finishing a phrase to the first word appearing, rises quickly. If the buffer is too small, frequent CPU context switches reduce throughput.

I use a double-buffer plus circular-queue design:

```kotlin
private val audioBuffer = CircularBuffer<ShortArray>(capacity = 10)

// Capture thread
thread {
    while (isRecording) {
        val chunk = ShortArray(chunkSize)
        val read = audioRecord.read(chunk, 0, chunkSize)
        if (read > 0) audioBuffer.put(chunk.copyOf(read))
    }
}

// Recognition thread
thread {
    while (isRecognizing) {
        val data = audioBuffer.take() // Block until data is available
        recognizer.write(data)
    }
}
```

I set `chunkSize` to 3200 samples, which is 200 ms of audio at 16 kHz. In tests, this kept end-to-end latency below 800 ms while CPU usage stayed under 5%.

### Front-loaded VAD: keep silence out of the model

The system `RecognitionService` includes its own VAD, but in on-device scenarios, moving a lightweight VAD step closer to capture can reduce invalid inference by about 30%. The idea is to add an energy detector between `AudioRecord` and `recognizer.write()`:

```kotlin
fun isSilence(buffer: ShortArray, threshold: Double): Boolean {
    val rms = sqrt(buffer.map { (it * it).toDouble() }.average())
    return rms < threshold
}
```

The right `threshold` depends heavily on the environment. I use `200` as a practical value for in-car audio. In a quiet room, it can be lowered to `100`. This front-end VAD does not replace the system VAD; it is a coarse filter for skipping obvious silence.

### Fallback strategy: offline first, cloud as backup

Even in 2026, on-device ASR accuracy is still not equal to cloud recognition, especially for proper nouns and dialects. My current strategy is:

1. Prefer `createOnDeviceSpeechRecognizer` for offline recognition
2. Watch error codes other than `ERROR_NETWORK` and be ready to switch
3. If confidence stays below 0.6 for three consecutive `onPartialResults` callbacks, switch to cloud `createSpeechRecognizer`
4. After the cloud result returns, compare it with the on-device result using edit distance; use the cloud result when the difference is large, otherwise keep the on-device result to protect privacy

This logic has run in production for six months. In Mandarin scenarios, the offline-first availability rate, meaning the share that does not need cloud rescue, is about 78%. For mixed Chinese-English speech, it drops to about 62%.

## Pitfalls

**Device compatibility** is the major one. On Android 15, `createOnDeviceSpeechRecognizer` can return a non-null instance that still does not work because some OEM ROMs remove the system ASR service. Call `checkRecognitionSupport` before use. Do not assume API level 31 or later means on-device recognition is available.

**The AudioRecord state machine** is a classic failure source. Immediately calling `read()` after `startRecording()` can sometimes return `ERROR_INVALID_OPERATION` because the underlying hardware is not ready yet. A 100 ms delay or polling `recordingState` avoids this.

**The performance budget has to be explicit**. On-device ASR is not free. Model loading takes about 50 MB of memory, and single-inference peak CPU usage can reach 60% of one core on a Snapdragon 8 Gen 2 device. If your app already has a large memory footprint, you need to hot-load and unload the model between ASR and non-ASR scenarios. `OnDeviceAsrEngine.unloadModel()` can release it manually.

After a year of building on-device ASR, my biggest takeaway is that offline recognition is not a binary switch. It is a set of engineering trade-offs: latency for accuracy, memory for availability, complexity for privacy. Each decision has to be evaluated against the product scenario. There is no silver bullet.
