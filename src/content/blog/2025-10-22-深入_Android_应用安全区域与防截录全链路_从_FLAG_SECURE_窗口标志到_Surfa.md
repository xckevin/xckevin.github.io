---
title: 深入 Android 应用安全区域与防截录全链路
excerpt: Android 端侧内容安全需要多层纵深防御：FLAG_SECURE 标记、SurfaceFlinger 硬件 Overlay、Widevine DRM 管线，层层叠加抵御截屏录屏攻击。本文解析各层机制、覆盖盲区与 Compose 适配陷阱。
publishDate: '2025-10-22'
tags:
- Android
- 安全防护
- SurfaceFlinger
- DRM
- Jetpack Compose
seo:
  title: 深入 Android 应用安全区域与防截录全链路
  description: 详解 Android FLAG_SECURE 的生效范围与盲区、SurfaceFlinger 安全图层合成机制、Widevine DRM 三级管线，以及 Compose 中的防截屏适配陷阱与纵深防御工程实践。
---

在做金融类 App 的截屏防护时，最常见的做法是给 Window 加上 `FLAG_SECURE`。但有一次发现加了标志后，录屏工具依然能抓到部分画面——排查之后，根因在 SurfaceFlinger 的合成策略上。FLAG_SECURE 只是第一道防线，真正可靠的内容保护要从 View 层一路跟到硬件合成器。

## FLAG_SECURE 的生效范围

`FLAG_SECURE` 标记的是 Window 对应的 Surface 为安全图层：

```kotlin
window.setFlags(
    WindowManager.LayoutParams.FLAG_SECURE,
    WindowManager.LayoutParams.FLAG_SECURE
)
```

系统截屏服务和 MediaProjection 在捕获屏幕时会跳过安全图层，显示为纯黑。最近任务缩略图同理。

它有两个覆盖盲区：一是 Dialog 和 PopupWindow 需要单独设置，不会从宿主 Activity 继承；二是部分厂商 ROM 在硬件合成回退时可能绕过这个标记。

```kotlin
val dialog = Dialog(context)
dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
```

## SurfaceFlinger 里的安全图层合成

SurfaceFlinger 每次 VSYNC 时执行合成：收集可见 Layer → Z-order 排序 → 调用 HWC 或 GPU 合成 → 输出到 Display。

安全图层的处理发生在第三步。HWC 检测到安全图层后，创建受保护的硬件叠加层（Protected Overlay）——它的数据路径与普通图层物理隔离，GPU 无法读取其像素数据。

风险出在混合合成场景。当安全图层与非安全图层叠加时，如果 HWC 的 Overlay Plane 不够用，系统会回退到 GLES（GPU）合成路径。GPU 合成路径下，安全标记的隔离效果取决于厂商实现，部分 ROM 确实存在绕过的情况。

验证当前合成路径：

```bash
adb shell dumpsys SurfaceFlinger | grep -A5 "Secure"
# 检查安全图层是否走了 DEVICE (HWC) 而非 CLIENT (GLES)
```

如果安全图层落在 CLIENT 合成上，这台设备就存在风险。

## DRM 安全视频管线的三层保护

涉及付费视频内容时，仅靠 `FLAG_SECURE` 不够。Android 的 Widevine DRM 分为三级：

| 等级 | 解密位置 | 数据暴露风险 |
|------|----------|-------------|
| L1 | TEE 可信执行环境 | 无 |
| L2 | 硬件安全模块 | 低 |
| L3 | 软件层 | 高 |

完整的安全视频链路需要三层协同：Widevine L1 在 TEE 中解密，MediaCodec secure mode 做安全解码，FLAG_SECURE 配合 Protected Overlay 完成安全渲染。

```kotlin
val mediaDrm = MediaDrm(UUID.fromString(WIDEVINE_UUID))
mediaDrm.setPropertyString("securityLevel", "L1")

val format = MediaFormat.createVideoFormat(MIME_TYPE_AVC, w, h)
format.setInteger(MediaFormat.KEY_PROTECTED, 1) // 启用安全解码

val codec = MediaCodec.createByCodecName(selectSecureCodec())
codec.configure(format, secureSurface, mediaDrm.mediaCrypto, 0)
```

安全解码器的输出 Surface 绑定到 DRM Session，解码后的帧直接送入 SurfaceFlinger 的安全 Overlay——全程不经过应用进程的用户态内存。

验证安全管线是否生效：

```bash
adb shell dumpsys media.drm
# securityLevel 应为 L1，mCurrentState 含 SECURE_DECODER
```

## Compose 中的适配陷阱

**陷阱一：Compose Dialog 不继承 Activity 的 FLAG_SECURE**

Compose 渲染到 `AndroidComposeView` 上，Activity 的 FLAG_SECURE 只作用于 Window 级。通过 Compose 弹出的 Dialog 如果需要单独保护，必须在原生层设置：

```kotlin
@Composable
fun SecureDialog(content: @Composable () -> Unit) {
    Dialog(onDismissRequest = {}) {
        SideEffect {
            (LocalContext.current as? Activity)?.window
                ?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        content()
    }
}
```

**陷阱二：截图检测需在 Activity 层注册**

Android 14 的 `ScreenCaptureCallback` 可以感知截屏行为，但在 Compose 中必须在 Activity 侧注册：

```kotlin
if (Build.VERSION.SDK_INT >= 34) {
    registerScreenCaptureCallback(mainExecutor) {
        logSecurityEvent("screenshot_detected")
    }
}
```

**陷阱三：局部遮盖不等于系统级保护**

部分场景只需要隐藏特定区域（如银行卡号），而非整个页面。Compose 可通过 `drawWithContent` 做局部遮盖——但它只是渲染层效果，不能替代系统级的 `FLAG_SECURE`。

## 纵深防御的工程实践

端侧内容安全覆盖三个层次：View 层（FLAG_SECURE）、合成层（硬件 Overlay 验证）、解码层（DRM 安全管线）。实践中我倾向于用一个 SecurityManager 集中管理：

```kotlin
object SecurityManager {
    fun apply(window: Window, level: SecurityLevel) {
        when (level) {
            SecurityLevel.BASIC ->
                window.addFlags(FLAG_SECURE)
            SecurityLevel.DRM ->
                window.addFlags(FLAG_SECURE).also { verifyPipeline() }
            SecurityLevel.MAX ->
                window.addFlags(FLAG_SECURE).also {
                    verifyPipeline(); enableCaptureDetection(window)
                }
        }
    }
}
```

每个页面在 `onCreate` 时声明自身安全等级，统一入口避免遗漏——我两年前的一次线上事故就是新页面忘了加 `FLAG_SECURE`。

没有哪一层是绝对可靠的，每一层都可能被特定手段绕过。但三层叠加之后，攻击成本会大幅上升——在实际项目中，这比死磕某个「完美方案」实用得多。
