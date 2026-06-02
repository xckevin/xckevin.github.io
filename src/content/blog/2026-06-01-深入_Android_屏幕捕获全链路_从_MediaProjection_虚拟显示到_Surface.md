---
title: Android 屏幕录制深度解析：从 MediaProjection 权限模型到 MediaCodec 编码的完整链路
excerpt: 本文深入拆解 Android 屏幕录制的完整链路，涵盖 MediaProjection 权限模型、VirtualDisplay 虚拟屏幕机制、ImageReader 与 MediaCodec 两条消费路径的选型实践，以及 BufferQueue 跨进程传输底层原理，并给出了帧率骤降问题的定位思路。
publishDate: '2026-06-01'
tags:
- Android
- MediaCodec
- 屏幕录制
- Surface
- 性能优化
seo:
  title: Android 屏幕录制深度解析：从 MediaProjection 权限模型到 MediaCodec 编码的完整链路
  description: 深入拆解 Android 屏幕录制完整链路：MediaProjection 权限约束、VirtualDisplay 机制、ImageReader 截图与 MediaCodec 录屏两条消费路径，以及 BufferQueue 跨进程传输原理与帧率优化实践。
---

去年做游戏录屏 SDK 时遇到一个诡异问题：录制视频的帧率从 60fps 骤降到 15fps，但 GPU 和 CPU 占用都不高。排查了一天定位到根因——瓶颈不在 MediaCodec 编码，而在 Surface 缓冲区管理：消费端跟不上 VirtualDisplay 的生产速度，BufferQueue 频繁丢帧。

正是这个排查过程，让我把 MediaProjection 到编码器的完整链路走了一遍。下面拆开讲核心机制。

## MediaProjection 的权限模型：为什么必须挂前台 Service

获取入口很直接：

```kotlin
val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
val intent = manager.createScreenCaptureIntent()
startActivityForResult(intent, REQUEST_CODE)
```

在 `onActivityResult` 里拿到 `MediaProjection` 对象后，真正的约束才生效：

```kotlin
val mediaProjection = manager.getMediaProjection(resultCode, data)
// 必须在获取后立刻注册 Callback，否则 token 会失效
mediaProjection.registerCallback(object : MediaProjection.Callback() {
    override fun onStop() {
        // 用户通过通知栏关闭了屏幕投射
    }
}, null)
```

`createScreenCaptureIntent()` 触发系统级权限弹窗，用户同意后系统生成一个 **MediaProjection token**，绑定两个硬约束：

1. **生命周期绑定前台 Service**：屏幕捕获期间必须运行一个 `MediaProjection` 类型的前台 Service。不是建议，是强制——Service 销毁时系统自动调用 `MediaProjection.stop()`。
2. **token 单次有效**：`MediaProjection` 对象不能跨进程传递，也不能序列化。每次捕获会话必须重新弹窗授权。

典型的前台 Service 声明：

```xml
<service
    android:name=".ScreenCaptureService"
    android:foregroundServiceType="mediaProjection"
    android:exported="false" />
```

Android 14 起 `mediaProjection` 必须显式声明为 `foregroundServiceType`，否则 `startForeground` 抛出 `MissingForegroundServiceTypeException`。升级 targetSdk 到 34 时这个坑踩过一回。

## VirtualDisplay：虚拟出来的"屏幕"

拿到 MediaProjection token 后，创建 VirtualDisplay：

```kotlin
val display = mediaProjection.createVirtualDisplay(
    "ScreenCapture",
    width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    surface,  // 关键：帧数据的目的地
    null, null
)
```

核心参数是 **Surface**。系统把 VirtualDisplay 当作一块虚拟屏幕，SurfaceFlinger 将捕获到的图层合成上去，输出到传入的 Surface。简化流程：

```
目标窗口帧 → SurfaceFlinger 合成 → VirtualDisplay → Surface → 消费端
```

**Surface 决定了帧数据的消费方式**——传给 ImageReader 的 Surface 就能截图，传给 MediaCodec 的 Surface 就能录像。MediaProjection 只负责"生产"帧，怎么消费完全由调用方决定，这个分层设计很实用。

`VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR` 让 VirtualDisplay 自动镜像主屏幕，无需手动指定源 Display。另一个常用 flag `VIRTUAL_DISPLAY_FLAG_PRESENTATION` 创建的是独立副屏，不适合录屏场景。

## 两条消费路径：截图用 ImageReader，录屏用 MediaCodec

### 截图路径：ImageReader

```kotlin
val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
imageReader.setOnImageAvailableListener({ reader ->
    val image = reader.acquireLatestImage()
    val planes = image.planes
    val buffer = planes[0].buffer
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    // 将 bytes 写入文件或处理为 Bitmap
    image.close()
}, backgroundHandler)

val display = mediaProjection.createVirtualDisplay(
    "Screenshot", width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    imageReader.surface, null, null
)
```

**`maxImages` 传 2 就够**。截图场景消费慢（一次一张），设大了纯浪费内存。`acquireLatestImage()` 自动丢弃队列旧帧，保证拿到最新画面。

容易踩的一个坑：`Image` 对象必须显式 `close()`，否则底层 GraphicBuffer 不释放，最终 BufferQueue 阻塞。我见过截图功能跑几小时后 OOM，根因就是忘了 close。

### 录屏路径：MediaCodec

录屏的核心挑战是帧率与编码速率匹配：

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

// 把 MediaCodec 的 inputSurface 传给 VirtualDisplay
mediaProjection.createVirtualDisplay(
    "Recording", width, height, dpi,
    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
    inputSurface, null, null
)

mediaCodec.start()
```

`COLOR_FormatSurface` 是关键。它让 MediaCodec 直接从 Surface 接收帧，数据通路零拷贝。对比 `COLOR_FormatYUV420Flexible` 方案需要手动从 ImageReader 拷贝 YUV 数据，性能差距明显。

## Surface 跨进程传输的底层机制

这条链路涉及三个进程：**App 进程**（调用方）、**SurfaceFlinger**（合成服务）、**MediaCodec 进程**（编码器）。Surface 跨进程传递靠 `SurfaceControl` + `BufferQueue` 这套机制：

1. App 进程调用 `createVirtualDisplay`，通过 Binder 通知 SurfaceFlinger 创建虚拟 Display
2. SurfaceFlinger 把该 Display 的合成结果写入 App 传入的 Surface 对应 BufferQueue 的 **生产者端（IGraphicBufferProducer）**
3. 消费端（ImageReader 或 MediaCodec）持有同一 BufferQueue 的 **消费者端（IGraphicBufferConsumer）**

**Surface 对象本身就是 IGraphicBufferProducer 的 Binder 封装**。跨进程传递 Surface，本质是传递 IGraphicBufferProducer 的 Binder 引用，真正的 GraphicBuffer 通过共享内存传递，数据不经过 Binder 复制。

这套机制也解释了 VirtualDisplay 帧率上限为什么取决于消费端：MediaCodec 编码跟不上时，BufferQueue 里 buffer 全部占用（dequeueBuffer 失败），SurfaceFlinger 直接丢帧。

回到开头那个帧率骤降问题——解决方法是调大 `MediaFormat.KEY_I_FRAME_INTERVAL`，降低 I 帧频率（I 帧体积大、编码耗时），同时提升码率目标值，让编码器消费更快。

## 工程实践中的几个选择

**截图 vs 录屏的引擎选型**：需求如果是「支持连续截图和录屏」，我只维护 MediaCodec 引擎。需要截图时从编码输出取关键帧，避免同时维护 ImageReader 和 MediaCodec 两条通路。缺点是纯截图场景也要启动编码器，但代码复杂度降了不少。

**分辨率控制**：`createVirtualDisplay` 的宽高是 VirtualDisplay 逻辑分辨率，与物理屏幕无关。做 GIF 录制或低质量预览时直接指定 1/2 甚至 1/4 分辨率，SurfaceFlinger 内部会降采样合成，省去应用端手动缩放的步骤。

**Android 14 的分区录屏**：Android 14 新增 `MediaProjection.Callback#onCapturedContentResize` 回调，支持录屏中动态调整捕获区域。`createScreenCaptureIntent` 也支持 `CAPTURE_REGION` 参数控制初始捕获范围。做应用级录屏和区域录屏时会用到，但部分厂商 ROM 对此支持不完整，实测需要逐个机型验证。

**性能监控指标**：录屏 SDK 上线后我重点盯两个指标——`MediaCodec.Callback.onOutputBufferAvailable` 的调用间隔（判断编码是否阻塞）和 VirtualDisplay 帧回调的帧间隔（判断合成是否阻塞）。这两个指标分别定位编码瓶颈和合成瓶颈，比盯着 CPU 占用有用得多。
