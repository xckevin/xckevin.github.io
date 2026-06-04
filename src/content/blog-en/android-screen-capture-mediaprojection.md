---
title: "Android Screen Capture Internals: MediaProjection, Surface, and MediaCodec"
lang: en
translationKey: android-screen-capture-mediaprojection
slug: android-screen-capture-mediaprojection
excerpt: "A deep dive into Android screen capture, covering MediaProjection permissions, VirtualDisplay, ImageReader, MediaCodec, BufferQueue transport, and frame-rate debugging."
publishDate: '2025-10-20'
tags:
- "Android"
- "MediaCodec"
- "Screen Recording"
- "Surface"
- "Performance Optimization"
seo:
  title: "Android Screen Capture Internals: MediaProjection, Surface, and MediaCodec"
  description: "Explore Android screen capture from MediaProjection permissions to VirtualDisplay, ImageReader, MediaCodec, BufferQueue transport, and frame-rate tuning."
  pageType: article
---

Last year, while building a game recording SDK, I hit a strange issue: recorded video dropped from 60 fps to 15 fps, even though GPU and CPU usage were not high. After a full day of debugging, the root cause was not MediaCodec encoding. It was Surface buffer management. The consumer could not keep up with the VirtualDisplay producer, and BufferQueue started dropping frames frequently.

That investigation forced me to trace the full path from MediaProjection to the encoder. The core mechanisms are worth breaking down.

## MediaProjection's Permission Model: Why a Foreground Service Is Required

The entry point is straightforward:

```kotlin
val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
val intent = manager.createScreenCaptureIntent()
startActivityForResult(intent, REQUEST_CODE)
```

After receiving the `MediaProjection` object in `onActivityResult`, the real constraints take effect:

```kotlin
val mediaProjection = manager.getMediaProjection(resultCode, data)
// Register Callback immediately after acquisition, or the token can become invalid.
mediaProjection.registerCallback(object : MediaProjection.Callback() {
    override fun onStop() {
        // The user stopped screen projection from the notification shade.
    }
}, null)
```

`createScreenCaptureIntent()` shows a system-level permission dialog. After the user agrees, the system creates a **MediaProjection token** with two hard constraints:

1. **Lifecycle bound to a foreground Service**: during screen capture, the app must run a foreground Service of type `MediaProjection`. This is not a suggestion. When the Service is destroyed, the system automatically calls `MediaProjection.stop()`.
2. **Single-use token**: the `MediaProjection` object cannot be passed across processes or serialized. Each capture session must request authorization again.

A typical foreground Service declaration looks like this:

```xml
<service
    android:name=".ScreenCaptureService"
    android:foregroundServiceType="mediaProjection"
    android:exported="false" />
```

Starting with Android 14, `mediaProjection` must be declared explicitly as the `foregroundServiceType`. Otherwise, `startForeground` throws `MissingForegroundServiceTypeException`. This is a real migration trap when moving `targetSdk` to 34.

## VirtualDisplay: A Virtual Screen

After obtaining the MediaProjection token, create a VirtualDisplay:

```kotlin
val display = mediaProjection.createVirtualDisplay(
    "ScreenCapture",
    width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    surface,  // Destination for frame data.
    null, null
)
```

The key parameter is **Surface**. The system treats VirtualDisplay as a virtual screen. SurfaceFlinger composites captured layers into it and outputs the result to the provided Surface. The simplified flow is:

```text
Target window frame -> SurfaceFlinger composition -> VirtualDisplay -> Surface -> consumer
```

**Surface determines how frame data is consumed.** Pass an ImageReader Surface and you get screenshots. Pass a MediaCodec Surface and you get recording. MediaProjection is responsible only for producing frames. Consumption is entirely controlled by the caller, which is a useful separation of concerns.

`VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR` lets the VirtualDisplay mirror the primary screen automatically, so you do not need to specify the source Display manually. Another common flag, `VIRTUAL_DISPLAY_FLAG_PRESENTATION`, creates an independent secondary display and is not suitable for screen recording.

## Two Consumption Paths: ImageReader for Screenshots, MediaCodec for Recording

### Screenshot Path: ImageReader

```kotlin
val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
imageReader.setOnImageAvailableListener({ reader ->
    val image = reader.acquireLatestImage()
    val planes = image.planes
    val buffer = planes[0].buffer
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    // Write bytes to a file or process them as a Bitmap.
    image.close()
}, backgroundHandler)

val display = mediaProjection.createVirtualDisplay(
    "Screenshot", width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    imageReader.surface, null, null
)
```

**A `maxImages` value of 2 is enough.** Screenshot consumption is slow, usually one frame at a time, so a larger queue mostly wastes memory. `acquireLatestImage()` automatically discards older queued frames and returns the latest screen.

One easy trap: every `Image` object must be closed explicitly. Otherwise the underlying GraphicBuffer is not released and BufferQueue eventually blocks. I have seen screenshot features run for hours and then crash with OOM because `close()` was missing.

### Recording Path: MediaCodec

The core challenge in recording is matching frame rate with encoding throughput:

```kotlin
val mediaCodec = MediaCodec.createEncoderByType("video/avc")
val format = MediaFormat.createVideoFormat("video/avc", width, height).apply {
    setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
    setInteger(MediaFormat.KEY_FRAME_RATE, 30)
    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    setInteger(MediaFormat.KEY_COLOR_FORMAT,
        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
}
mediaCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
val inputSurface = mediaCodec.createInputSurface()

// Pass MediaCodec's inputSurface to VirtualDisplay.
mediaProjection.createVirtualDisplay(
    "Recording", width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    inputSurface, null, null
)

mediaCodec.start()
```

`COLOR_FormatSurface` is the key. It lets MediaCodec receive frames directly from a Surface, making the data path zero-copy. Compared with a `COLOR_FormatYUV420Flexible` approach that manually copies YUV data from ImageReader, the performance difference is significant.

## How Surface Cross-Process Transport Works

This path involves three processes: the **app process** as the caller, **SurfaceFlinger** as the compositor, and the **MediaCodec process** as the encoder. Surface crosses process boundaries through `SurfaceControl` and `BufferQueue`:

1. The app process calls `createVirtualDisplay`, notifying SurfaceFlinger through Binder to create a virtual Display.
2. SurfaceFlinger writes that Display's composed output into the **producer side**, `IGraphicBufferProducer`, of the BufferQueue behind the Surface passed by the app.
3. The consumer, either ImageReader or MediaCodec, holds the **consumer side**, `IGraphicBufferConsumer`, of the same BufferQueue.

**A Surface object is essentially a Binder wrapper around `IGraphicBufferProducer`.** Passing a Surface across processes means passing the Binder reference for `IGraphicBufferProducer`. The real GraphicBuffer data travels through shared memory, not through Binder copies.

This also explains why VirtualDisplay's frame-rate ceiling depends on the consumer. When MediaCodec cannot encode fast enough, every buffer in BufferQueue becomes occupied, `dequeueBuffer` fails, and SurfaceFlinger drops frames.

Returning to the frame-rate drop from the beginning, the fix was to increase `MediaFormat.KEY_I_FRAME_INTERVAL`, reducing I-frame frequency because I-frames are large and expensive to encode, and to raise the target bitrate so the encoder could consume frames faster.

## Practical Engineering Choices

**Engine choice for screenshots vs recording**: if the requirement is "continuous screenshots and recording," I maintain only the MediaCodec engine. When a screenshot is needed, I take a key frame from the encoded output. This avoids maintaining both ImageReader and MediaCodec paths. The downside is that a pure screenshot flow still starts the encoder, but code complexity drops a lot.

**Resolution control**: the width and height passed to `createVirtualDisplay` are the logical resolution of the VirtualDisplay, not necessarily the physical screen resolution. For GIF recording or low-quality preview, specify half or even quarter resolution. SurfaceFlinger downsamples during composition, so the app does not need a manual scaling step.

**Android 14 partial screen recording**: Android 14 added the `MediaProjection.Callback#onCapturedContentResize` callback, which supports dynamic capture-area changes while recording. `createScreenCaptureIntent` also supports a `CAPTURE_REGION` parameter to control the initial capture area. This is useful for app-level and region-based recording, but some vendor ROMs do not support it completely, so device-by-device validation is still required.

**Performance metrics**: after releasing a recording SDK, I focused on two metrics: the interval between `MediaCodec.Callback.onOutputBufferAvailable` calls, which indicates whether encoding is blocked, and the VirtualDisplay frame callback interval, which indicates whether composition is blocked. These two signals locate encoding and composition bottlenecks much better than watching CPU usage alone.
