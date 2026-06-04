---
title: "Android MediaCodec Video Pipeline: MediaExtractor, Buffers, and Hardware Encoding"
lang: en
translationKey: android-mediacodec-mediaextractor
slug: android-mediacodec-mediaextractor
excerpt: "Trace Android video transcoding from MediaExtractor demuxing to MediaCodec async buffers, hardware decode compatibility, and MediaMuxer output."
publishDate: '2026-05-18'
tags:
- "Android"
- "MediaCodec"
- "Video Encoding"
- "Hardware Decoding"
- "Performance"
seo:
  title: "Android MediaCodec Pipeline: MediaExtractor to Hardware Encoding"
  description: "Understand MediaCodec video transcoding, including MediaExtractor demuxing, async buffer callbacks, hardware compatibility, and MediaMuxer."
  pageType: article
---

While building a video transcoding tool, I ran into a strange issue: the same H.264 video decoded and encoded correctly in synchronous mode, but after switching to asynchronous mode it frequently dropped frames, and the output showed green bars and corrupted blocks. After two days of debugging, the root cause was clear: **I was not handling IllegalStateException from MediaCodec input buffers correctly**. This article connects that debugging story with the full Codec pipeline.

## Demuxing: what MediaExtractor actually does

MediaExtractor's core job is parsing the container format. MP4, MKV, and WebM are containers. Video and audio tracks are compressed with different codecs and then packaged inside the container. "Reading the file" is only the surface-level operation.

```kotlin
val extractor = MediaExtractor()
extractor.setDataSource(filePath)

// Iterate through tracks and find the video track.
val videoTrackIndex = (0 until extractor.trackCount).first { index ->
    val format = extractor.getTrackFormat(index)
    format.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
}

extractor.selectTrack(videoTrackIndex)
val format = extractor.getTrackFormat(videoTrackIndex)
```

`MediaFormat` contains two critical pieces of information: the MIME type, such as `video/avc`, and **csd-0/csd-1**. CSD means Codec-Specific Data. For H.264, these are SPS, Sequence Parameter Set, and PPS, Picture Parameter Set. Without those metadata blocks, the decoder cannot initialize correctly.

Passing CSD into `MediaCodec.configure()` lets the Codec parse later frames correctly. If you skip CSD and send frame data directly, the Codec **might** parse it from the bitstream, but production code should not rely on that.

## Codec state machine: the async-mode trap

MediaCodec has three main states: **Stopped -> Executing -> Released**. The Executing phase is further divided into Configured, Started, formerly called Running, and Flushed substates.

Asynchronous callback ordering is completely different from synchronous mode. In synchronous mode, you manually control when to call `dequeueInputBuffer` and `dequeueOutputBuffer`, so you own the call order. In asynchronous mode, `MediaCodec.Callback` drives the flow:

```kotlin
codec.setCallback(object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
        // Receive an input-buffer index, fill it, then call queueInputBuffer.
    }

    override fun onOutputBufferAvailable(
        codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo
    ) {
        // Receive decoded data, process it, then call releaseOutputBuffer.
    }

    override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
        // Hardware-decoder-specific errors, such as an unsupported profile.
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
        // Output format changes, such as resolution changes.
    }
}, handler) // Pay attention to this Handler.
```

The `Handler` parameter decides which thread runs the callbacks. The bug was caused by passing `null`, so callbacks ran on Codec's internal thread. In the output-buffer callback, I did slow work, writing data to a file. That blocked later `onInputBufferAvailable` callbacks. Once Codec's internal queue filled up, callbacks stopped and the pipeline deadlocked.

The fix is to pass an explicit background-thread Handler and keep callback work lightweight.

```kotlin
val handlerThread = HandlerThread("CodecCallback")
handlerThread.start()
val handler = Handler(handlerThread.looper)
codec.setCallback(callback, handler)
```

## Buffer management: input and output are asymmetric

Input buffers and output buffers do not work symmetrically, which is a common source of bugs.

**Input side**: `dequeueInputBuffer` or `onInputBufferAvailable` gives you a reference to an empty buffer. You fill it with compressed data. Setting `timeoutUs` to `-1` means wait forever in synchronous mode, but in asynchronous mode that parameter does not apply because the callback itself means "a buffer is available."

**Output side**: you receive decoded data. After handling it, you **must** call `releaseOutputBuffer(index, render)` to release the buffer. If you do not, Codec runs out of buffers and drops every later frame. My corrupted-output bug happened because an exception path returned early without calling release.

For decoding, setting the second `releaseOutputBuffer` parameter, `render`, to `true` sends the data to a Surface for rendering. For encoding, this parameter is irrelevant; releasing the buffer is enough.

H.264 encoder output is not strictly frame-by-frame. Because B-frames can make decode order and display order differ, you may need to write samples in `BufferInfo.presentationTimeUs` order. In one encoder path, I used a `TreeMap` to sort timestamps:

```kotlin
private val pendingFrames = TreeMap<Long, Pair<ByteBuffer, MediaCodec.BufferInfo>>()

// In onOutputBufferAvailable
pendingFrames[info.presentationTimeUs] = outputBuffer to info.clone()

// Write in PTS order.
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

## Hardware decode and hardware encode compatibility

Hardware decode is efficient, but compatibility is messy. Codec implementations differ heavily by vendor. The same H.264 profile can work on Samsung and show green frames on Xiaomi.

Several practices have held up in real projects.

**1. Fallback path**: prefer hardware when creating the Codec, but keep a software decoder fallback:

```kotlin
val codecName = try {
    MediaCodecList(MediaCodecList.REGULAR_CODECS)
        .findDecoderForFormat(format) // Prefer hardware.
} catch (e: Exception) {
    "c2.android.avc.decoder" // Google's software decoder.
}
MediaCodec.createByCodecName(codecName)
```

**2. Color-format negotiation**: hardware decoders often output vendor-private color formats, such as `COLOR_QCOM_FormatYUV420PackedSemiPlanar32m`. Reading ByteBuffer directly may not give you standard YUV. My approach is to configure Surface output, let Codec render into an OpenGL texture, and then read a standard format back through an FBO. That adds one copy, but avoids a compatibility mess.

**3. Encoder bitrate control**: hardware encoders vary widely in VBR, Variable BitRate, behavior. I have seen devices ignore `KEY_BITRATE_MODE` and always encode with CBR. My current approach is to run a first-frame test with CBR, verify that output frame size matches expectations, and only then switch to VBR.

## MediaMuxer: packaging is more than writing a file

After decode, processing, and encode are done, `MediaMuxer` packages the output again. `addTrack` must be called before `start`; once the muxer starts, new tracks cannot be added.

```kotlin
val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
val trackIndex = muxer.addTrack(encoderOutputFormat) // Use the encoder output format.
muxer.start()

// Keep timestamps continuous when writing data.
muxer.writeSampleData(trackIndex, buffer, bufferInfo)

muxer.stop()
muxer.release()
```

MP4 requires `writeSampleData` timestamps to be continuous and monotonically increasing. If you drop frames in the middle, adjust later frames' `presentationTimeUs` manually, or the muxer may throw.

## Tradeoffs in real projects

There is no silver bullet in system-level video processing; everything is a tradeoff.

**Async mode vs sync mode**: I now default to async mode because the code is cleaner. But if you need precise frame-level control, such as dynamically choosing encode parameters based on decoded frames, sync mode is more flexible. The main caveat in sync mode is that `dequeueInputBuffer(-1)` can block forever, so a timeout and retry mechanism is safer.

**Surface input vs ByteBuffer input**: encoder Surface input through `createInputSurface` can send OpenGL render output directly into the encoder with zero copy. The cost is losing precise control over input-frame timing. My transcoding path needed exact control of every frame, so I chose ByteBuffer mode.

**Error recovery strategy**: once MediaCodec enters the Error state, it must be released and recreated; it cannot recover in place. Encoders are strict about input format. Resolution changes and SPS/PPS updates must be reconfigured through the `BUFFER_FLAG_CODEC_CONFIG` flag. After detecting `INFO_OUTPUT_FORMAT_CHANGED`, rebuild the muxer or the output MP4 can be corrupted.

`BUFFER_FLAG_END_OF_STREAM` in `BufferInfo.flags` tells Codec that all input data has been submitted. After EOS is sent, Codec can still emit remaining buffered frames until the output side also receives EOS. If you forget to send EOS on the input side, `dequeueOutputBuffer` keeps waiting and looks like it is stuck.
