---
title: 'Android Audio Capture End to End: AudioRecord, Echo Cancellation, and On-Device ASR'
lang: en
translationKey: android-audiorecord-aec-on-device-speech
slug: android-audiorecord-aec-on-device-speech
excerpt: 'A complete walkthrough of Android audio capture: AudioRecord buffer tradeoffs, AAudio low-latency input, echo cancellation, on-device ASR data adaptation, and a practical reference architecture for simultaneous playback and listening.'
publishDate: '2026-08-28'
tags:
- Android
- AudioRecord
- AAudio
- Echo Cancellation
- On-Device ASR
- VAD
seo:
  title: 'Android Audio Capture: AudioRecord, Echo Cancellation, and On-Device ASR'
  description: 'A complete guide to Android audio capture: AudioRecord buffers, AAudio low latency, echo cancellation, VAD, and on-device ASR, with a reference architecture.'
  pageType: article
---

While working on an on-device voice assistant, I hit an awkward situation: when a user interrupted a TTS announcement, the microphone picked up the audio the speaker had just played back, and the ASR transcribed the machine's own lines into text. Digging into it, I found that most Android audio articles online focus on the playback path; the capture path is either glossed over or assumed to be as simple as "just copy the official demo."

This article walks the entire capture path: how to choose AudioRecord buffers, how AAudio reduces latency, why echo cancellation depends on both playback and capture, and what format on-device ASR actually requires. After reading, you won't need to piece together scattered experience for "play-while-listening" scenarios.

## The Starting Point of the Capture Path: AudioRecord and Buffer Tradeoffs

The entry-level API for Android capture is `AudioRecord`, which hands you microphone data as a PCM byte stream. The most commonly overlooked detail at creation time is the semantics of `getMinBufferSize()`—it returns the minimum buffer the system guarantees won't drop data, which is neither a recommended value nor a low-latency value.

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

Setting the buffer to 2–4 times `min` is common practice, but the cost is higher latency. At 16 kHz, 16-bit, mono, `min` usually corresponds to a few tens of milliseconds of data; doubling it can push input latency above 100 ms. That doesn't matter for push-to-wake scenarios, but it becomes noticeable in real-time conversation.

The `setAudioSource` choice directly determines the downstream processing path. `VOICE_RECOGNITION` goes through vendor tuning for recognition and may include built-in noise suppression and AGC; `UNPROCESSED` bypasses all preprocessing and gives you the rawest audio, which is suitable when you have your own frontend algorithm—but it requires device support, and some vendors implement it carelessly.

## AAudio: The Choice When Low Latency Is a Hard Requirement

If the goal is input latency under 20 ms, Java-layer AudioRecord basically can't get there. Internally it interacts with AudioFlinger through the Binder control plane, and the data also has to shuffle through Java-layer buffers—one round trip eats up the entire latency budget. `AAudio`, introduced in Android 8.0, takes a native passthrough path, and on some devices it can even get mmap shared memory or exclusive mode.

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

The key is the last line: `getFramesPerBurst()` returns the device's burst size—the number of frames the hardware transfers at once. **Your read loop should use burst as the minimum unit**, rather than picking an arbitrary 1024. Reading by burst lets AAudio make the most of the shared-memory path; otherwise it has to do an extra stitch-and-unpack internally.

In real projects I prefer Google's `Oboe`, which wraps AAudio and OpenSL ES. It smooths over the differences between the two APIs: low-latency devices use AAudio, older devices fall back to OpenSL ES automatically, and it handles device hot-swapping and clock-drift correction for you. Writing raw AAudio yourself usually isn't worth it for most teams.

## Echo Cancellation: Where Playback and Capture Meet

Back to the opening problem. When the user interrupts, the speaker's announcement travels through the air to the microphone, forming an echo. The ASR can't tell whether it was the user or the machine speaking, and the whole recognition result gets polluted. The solution is to apply acoustic echo cancellation (AEC) to the captured signal: use the playback signal as a reference, estimate the echo path, and subtract it from the captured signal.

Android provides a wrapper for hardware AEC, `AcousticEchoCanceler`:

```kotlin
val sessionId = recorder.audioSessionId
if (AcousticEchoCanceler.isAvailable()) {
    val aec = AcousticEchoCanceler.create(sessionId)
    aec.enabled = true
}
```

This code works, but it comes with an easily misunderstood point: `AcousticEchoCanceler.create(sessionId)` only binds to the capture-side AudioRecord session—**it does not require AudioTrack and AudioRecord to explicitly share the same session id**. The AEC layer Android provides is a black-box hardware/driver-level process: as long as the device supports it, once enabled it automatically references the channel signal the device is currently playing; developers don't need to—and can't—explicitly feed it reference PCM. Also remember to declare the `MODIFY_AUDIO_SETTINGS` permission, otherwise `create` returns null directly. This hardware AEC works completely differently from the WebRTC software AEC described next; don't conflate the two.

Hardware AEC's effectiveness depends on vendor driver quality; on mid-range and low-end devices it often fails to cancel the echo cleanly, especially at high playback volume. For serious far-field or full-duplex scenarios, I recommend software AEC instead, such as WebRTC's AEC3. The fundamental difference between software AEC and the platform's hardware AEC is: **you must explicitly feed it the pre-playback PCM and the post-capture PCM, frame-aligned**, as a far-end reference signal for the algorithm to estimate the echo path—because software AEC runs at the application layer and can't access the device driver's internal playback signal, so it has to rely on you submitting it. Its built-in delay estimation handles tens to hundreds of milliseconds of offset, making it far more robust than the hardware layer, at the cost of higher development difficulty and compute.

## On-Device ASR's Data Requirements and Adaptation

After AEC, the captured signal still can't go straight into the recognition engine. On-device ASR is very picky about input format: mainstream engines (whisper.cpp, Vosk, Sherpa) almost all require **16 kHz, mono, 16-bit PCM**. If your capture path runs at 48 kHz for low latency, you'll need to resample.

Don't write your own linear interpolation for resampling. 48k to 16k is a 3:1 integer ratio, and simple decimation can handle some scenarios, but the safer approach is a dedicated resampler to avoid high-frequency aliasing. In real projects I reuse WebRTC's PushResampler—stable quality with no extra dependency burden.

After resampling you usually add a voice activity detection (VAD) stage. VAD's job is to cut out the segments that actually contain speech, keeping silence and pure echo residue out of the ASR. This not only saves compute but, more importantly, prevents the ASR from outputting hallucinated text when there is no speech. WebRTC's VAD or Silero VAD are both directly usable; the latter performs better in noisy Chinese environments—in my experience it has fewer false triggers.

## Tying the Chain Together: A Practical Reference Architecture

The whole chain ends up as a classic producer-consumer model. The capture thread produces audio frames; the processing thread consumes them and applies AEC, resampling, and VAD; finally it feeds the ASR's streaming interface. Use a lock-free ring buffer for the queue in between, with frame size standardized at 20 ms to avoid frequent copying from different frame lengths everywhere.

```kotlin
val frame = ByteArray(320 * 2) // 16k * 16bit * 20ms = 640 bytes
while (running.get()) {
    val n = recorder.read(frame, 0, frame.size)
    if (n > 0) queue.offer(frame.copyOf(n))
}
```

The capture thread does exactly one thing: read data and push it into the queue. AEC and resampling go in the same processing thread, because both depend on frame alignment—splitting them would force you to handle cross-thread synchronization. If the ASR supports streaming callbacks, attach it directly at the tail of the processing thread; otherwise, throw recognition results back to the main thread via callback to update the UI.

Work out the latency budget up front. Capture buffering + AEC frame alignment + VAD frame length + ASR decoding adds up to the total latency from "user finishes speaking" to "text appears." In real-time conversation scenarios, keep it under 300 ms or the experience falls apart; the AEC delay-estimation window is usually the biggest contributor, so prioritize it when tuning.

## Three Practical Recommendations

First, decide on your latency budget before choosing an API. Real-time conversation calls for AAudio + software AEC; async recording only needs AudioRecord. Don't bring out the heavy weapons right away.

Second, keep your troubleshooting for hardware AEC and software AEC separate. When hardware AEC can't cancel the echo, first check whether the capture-side session is correct and whether the device actually supports it. When software AEC can't, first check whether the reference PCM you feed it is the pre-playback copy and whether it's frame-aligned.

Third, decouple the capture, processing, and recognition layers into independent threads plus a ring buffer. Once the chain works, swapping the ASR engine or adding a noise-suppression module later only requires touching a single stage—no need to start over.
