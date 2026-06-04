---
title: "Android Audio System Deep Dive: AudioFlinger Mixing and AAudio Low Latency"
lang: en
translationKey: android-audio-system-audioflinger-aaudio
slug: android-audio-system-audioflinger-aaudio
excerpt: "A deep architecture walkthrough of the Android audio pipeline, from AudioTrack buffers and AudioFlinger mixer scheduling to AAudio MMAP pass-through, latency tradeoffs, and production API choices."
publishDate: '2026-05-12'
tags:
- "Android"
- "AudioFlinger"
- "AAudio"
- "Audio System"
- "Performance Optimization"
seo:
  title: "Android Audio: AudioFlinger Mixing and AAudio Low Latency"
  description: "Explore Android audio internals across AudioTrack, AudioFlinger, HAL, FastMixer, AAudio, MMAP mode, and practical low-latency playback choices."
  pageType: article
---

Last year, while working on a real-time voice calling app, I ran into a difficult problem: on the same device, WeChat calls had only about 40 ms of latency, while our app stayed above 120 ms. Same Android system, same hardware. Where did the gap come from?

During the investigation, I went through AudioTrack, AudioFlinger, and the HAL layer in detail. The conclusion was clear: low-latency audio is not something you fix by changing one parameter.

## AudioTrack: the app-layer delivery station

AudioTrack is the standard Android Java/Kotlin entry point for audio playback. After an app creates an AudioTrack instance, it submits PCM data to the buffer through `write()`, and the system handles the later mixing and output.

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
// Submit audio data
audioTrack.write(pcmData, 0, pcmData.size)
```

`setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)` is the key setting. Without this flag, AudioTrack uses the normal path by default, and the system allocates a buffer 2-4 times the value returned by `getMinBufferSize()`. With the flag enabled, AudioFlinger allocates a smaller buffer and gives that track higher-priority scheduling.

But the flag alone is not enough. On most devices, `getMinBufferSize()` returns 4 KB to 16 KB. For 48 kHz stereo 16-bit audio, that is roughly 20 ms to 80 ms of data. Add the HAL output buffer and total latency easily exceeds 100 ms.

### Shared memory and data movement

AudioTrack and the app do not communicate through simple memory copies alone. The framework layer uses `android::MemoryHeapBase` to create a shared memory region that both the app process and the AudioFlinger process can access directly. Data written by the app through `write()` is copied into the `mCblk` control block in that shared memory. When AudioFlinger reads it, no additional cross-process copy is needed.

This design avoids sending every `write()` call through Binder. A single Binder call costs about 50-100 microseconds, which is too expensive for a high-frequency audio data path.

`write()` is still a user-space copy. The true zero-copy option is to use AudioTrack's `getBuffer()` and `releaseBuffer()` APIs and operate on shared memory directly:

```cpp
// Native zero-copy write
void* buffer = nullptr;
size_t size = 0;
audioTrack->getBuffer(&buffer, &size);
if (buffer && size >= dataSize) {
    memcpy(buffer, pcmData, dataSize);
    audioTrack->releaseBuffer(dataSize);
}
```

The benefit of zero-copy depends on buffer size. For small 1-2 ms frames, as in real-time calling, zero-copy can significantly reduce CPU jitter. For frames larger than 20 ms, the copy cost of regular `write()` is a small part of the total cost, so the difference is minor.

## AudioFlinger: the mixing and scheduling hub

AudioFlinger is a daemon-style service thread in the SystemServer process that manages the lifecycle of all audio streams. Its core data structure is `PlaybackThread`; each audio output device, such as the speaker, headphones, or Bluetooth A2DP, corresponds to one PlaybackThread.

### How the mixer works

When multiple apps play audio at the same time, AudioFlinger must mix all active `Track` instances into one stream and send it to the HAL. Mixing happens during each cycle of `ThreadLoop()`:

```text
cycle = HAL output buffer size / sample rate / channel count / bit depth
example: 240 frames / 48000 Hz = 5 ms
```

During each cycle, AudioFlinger iterates through every active Track under the current PlaybackThread, adds their shared-memory data sample by sample, applies soft clipping to avoid overflow, and writes the result into the HAL ring buffer.

The mixer uses 32-bit floating-point precision. Even if the input is 16-bit integer PCM, it is converted to float before accumulation. That matters when processing multiple audio streams. If eight 16-bit streams are mixed together at 16-bit precision, the signal-to-noise ratio degrades noticeably. Float mixing avoids that problem.

```cpp
// Simplified AudioFlinger mixer core logic
for (size_t i = 0; i < frameCount; i++) {
    float sample = 0.0f;
    for (const auto& track : activeTracks) {
        sample += track->readSample(i);  // Read from shared memory
    }
    // Soft clip to [-1.0, 1.0]
    sample = clamp(sample, -1.0f, 1.0f);
    outputBuffer[i] = convertToInt16(sample);
}
```

### FastMixer: the independent low-latency path

The regular PlaybackThread mixing loop shares thread priority with other system work. When it runs into Binder calls or GC, it can be preempted, causing audio glitches or underruns.

FastMixer is an independent real-time thread inside AudioFlinger. It uses the `SCHED_FIFO` scheduling policy and has higher priority than normal threads. It specifically handles Tracks marked with `PERFORMANCE_MODE_LOW_LATENCY`.

FastMixer's core constraint is: **do not perform any operation that may block**. It cannot call the HAL's `write()` method, because a HAL implementation may take a lock. Instead, it uses the non-blocking `obtainBuffer()` and `releaseBuffer()` interfaces together with the HAL driver's callback mechanism.

After FastMixer is enabled, audio latency can drop from 50-100 ms to 10-20 ms. The cost is slightly higher CPU usage because the real-time thread wakes up frequently and scheduling overhead is not free.

## HAL layer: hardware pass-through and latency bottlenecks

The HAL, or Hardware Abstraction Layer, is the interface between AudioFlinger and the DSP/codec hardware. Since Android 8.0, Android has promoted the HIDL Audio HAL, while AIDL HAL adoption has also been progressing.

The HAL layer defines the contracts for input and output streams, including `IStreamIn` and `IStreamOut`. The `getLatency()` method returns only the latency introduced by the HAL itself. It does not include the latency from AudioFlinger or Track buffers.

Across several flagship devices I measured, the HAL-layer `getLatency()` values looked like this:

- Pixel 7: 5 ms on the speaker
- A 2024 model from a Chinese OEM: 15-25 ms with a DSP post-processing pipeline
- Low-end devices: 40-80 ms

Most HAL latency differences come from vendor DSP audio-effect pipelines. Speaker protection algorithms, equalizers, virtual surround sound, and other post-processing all add frame buffers. These implementations are usually closed source, and apps cannot bypass them.

### MMAP pass-through mode

The traditional HAL output path is app -> AudioFlinger -> HAL -> ALSA -> codec. Every layer has its own buffer, and latency accumulates layer by layer.

AAudio's MMAP, or memory-mapped, mode bypasses part of that path. The app process maps the ALSA driver's DMA buffer directly through `mmap()`. In this mode, AudioTrack's `write()` is effectively writing into the hardware ring buffer directly, without passing through AudioFlinger's mixer.

```text
Traditional path: App -> AudioTrack buffer -> Flinger mixer -> HAL buffer -> ALSA -> Codec
MMAP path:        App -> mmap'd ALSA buffer -> Codec
```

MMAP mode can reduce latency to 3-8 ms, but it has two hard limits. First, it cannot mix because output is exclusive. Second, the ALSA driver must support the `mmap` interface. That support is often incomplete on lower-end SoCs.

## AAudio: a redesigned low-latency API

AAudio is a native API introduced in Android 8.0 for low-latency audio scenarios. Compared with AudioTrack, it has two core differences.

**Callbacks replace active writes.** AAudio invokes the app through `AAudioStream_dataCallback` when it needs data, instead of making the app decide when to write. This callback runs directly in the context of AudioFlinger's PlaybackThread, removing app-layer polling overhead.

```cpp
aaudio_data_callback_result_t dataCallback(
    AAudioStream* stream,
    void* userData,
    void* audioData,
    int32_t numFrames) {
    // Generate audio data directly in the AudioFlinger thread context
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

When callback mode is combined with the MMAP path, the time from app-side data generation to codec playback can be kept under 3 ms.

**Capacity queries replace guessing.** AAudio provides `AAudioStream_getBufferCapacityInFrames()`, which directly returns the minimum buffer frame count allowed by the hardware. It no longer depends on estimates such as `getMinBufferSize()`.

One pitfall I hit when migrating from AudioTrack to AAudio was callback execution. AAudio callbacks run on the FastMixer thread. If your audio generation logic has lock contention or memory allocation, it directly causes underruns. AudioTrack's blocking `write()` path has higher latency, but it is more forgiving of the caller's real-time behavior because AudioFlinger has more buffering to absorb app-side jitter.

Migration advice: first make sure the audio generation path is lock-free and allocation-free, using a preallocated ring buffer. Only then switch to AAudio callback mode.

## Choosing the right option

The choice among the three APIs can be made according to latency requirements:

**AudioTrack in regular mode**: 80-200 ms latency. Suitable for music players and notification sounds. It is the simplest to develop and has good fault tolerance.

**AudioTrack + LowLatency + FastMixer**: 10-30 ms latency. Suitable for real-time sound effects and instrument apps. It is easier to debug than AAudio and can be operated from Java/Kotlin.

**AAudio + MMAP**: 3-10 ms latency. Suitable for VoIP, game audio, and professional audio DAWs. It requires native development and has the highest real-time requirements for the audio generation path.

For that voice calling project, the final choice was the middle option: AudioTrack in low-latency mode, paired with an adaptive jitter buffer for Opus encoding. AAudio's exclusive mode could not support call audio effects such as echo cancellation and noise suppression, and those effects had to integrate with the vendor DSP pipeline at the app layer. Technical selection is not about choosing the lowest possible latency. It is about choosing what can work reliably within the constraints.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android performance optimization](/en/android-performance/)
- [Android cold-start optimization: Perfetto practice from Zygote fork to first frame](/blog/android-cold-start-zygote-systrace/)
- [Android app startup optimization: metrics, pipeline, tools, and governance](/blog/app-startup-optimization/)
- [RecyclerView caching internals: four-level cache, reuse, and prefetch](/blog/android-recyclerview-four-level-cache/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/android-bitmap-oom/)
<!-- /seo-internal-links -->
