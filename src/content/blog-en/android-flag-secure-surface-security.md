---
title: "Android Secure Surfaces: FLAG_SECURE, SurfaceFlinger, and DRM"
lang: en
translationKey: android-flag-secure-surface-security
slug: android-flag-secure-surface-security
excerpt: "A practical deep dive into Android content protection, covering FLAG_SECURE, SurfaceFlinger protected overlays, Widevine DRM, and Compose pitfalls."
publishDate: '2025-10-22'
tags:
- "Android"
- "Security"
- "SurfaceFlinger"
- "DRM"
- "Jetpack Compose"
seo:
  title: "Android Secure Surfaces: FLAG_SECURE, SurfaceFlinger, and DRM"
  description: "Understand Android screen-capture protection from FLAG_SECURE scope and SurfaceFlinger secure layers to Widevine DRM and Compose integration pitfalls."
  pageType: article
---

When building screenshot protection for financial apps, the most common move is to add `FLAG_SECURE` to the Window. I once saw a screen recorder still capture part of the UI even after that flag was set. The root cause turned out to be SurfaceFlinger's composition strategy. `FLAG_SECURE` is only the first line of defense. Reliable content protection has to be traced from the View layer all the way down to hardware composition.

## What FLAG_SECURE actually covers

`FLAG_SECURE` marks the Surface behind a Window as a secure layer:

```kotlin
window.setFlags(
    WindowManager.LayoutParams.FLAG_SECURE,
    WindowManager.LayoutParams.FLAG_SECURE
)
```

When the system screenshot service or MediaProjection captures the screen, secure layers are skipped and rendered as black. Recent-task thumbnails follow the same rule.

There are two important gaps. First, Dialogs and PopupWindows must be secured separately; they do not inherit the host Activity's flag. Second, some OEM ROMs can bypass the flag when hardware composition falls back.

```kotlin
val dialog = Dialog(context)
dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
```

## Secure layer composition inside SurfaceFlinger

On every VSYNC, SurfaceFlinger performs composition: collect visible Layers, sort by Z-order, invoke HWC or GPU composition, and output to the Display.

Secure-layer handling happens in the third step. When HWC sees a secure layer, it creates a protected hardware overlay. That protected overlay has a physically isolated data path from normal layers, so the GPU cannot read its pixel data.

The risk appears in mixed-composition scenarios. When secure and non-secure layers overlap, and HWC does not have enough overlay planes, the system falls back to the GLES GPU composition path. In the GPU path, secure-flag isolation depends on the OEM implementation. Some ROMs have had real bypass issues here.

You can verify the current composition path with:

```bash
adb shell dumpsys SurfaceFlinger | grep -A5 "Secure"
# Check whether the secure layer uses DEVICE (HWC), not CLIENT (GLES)
```

If the secure layer lands on CLIENT composition, that device has a risk.

## The three-layer DRM secure video pipeline

For paid video content, `FLAG_SECURE` alone is not enough. Android's Widevine DRM has three levels:

| Level | Decryption location | Data exposure risk |
|------|----------|-------------|
| L1 | TEE, the trusted execution environment | None |
| L2 | Hardware security module | Low |
| L3 | Software layer | High |

A complete secure video path needs three layers working together: Widevine L1 decrypts inside the TEE, MediaCodec secure mode performs secure decoding, and `FLAG_SECURE` plus Protected Overlay performs secure rendering.

```kotlin
val mediaDrm = MediaDrm(UUID.fromString(WIDEVINE_UUID))
mediaDrm.setPropertyString("securityLevel", "L1")

val format = MediaFormat.createVideoFormat(MIME_TYPE_AVC, w, h)
format.setInteger(MediaFormat.KEY_PROTECTED, 1) // Enable secure decoding

val codec = MediaCodec.createByCodecName(selectSecureCodec())
codec.configure(format, secureSurface, mediaDrm.mediaCrypto, 0)
```

The secure decoder's output Surface is bound to the DRM session. Decoded frames go directly into SurfaceFlinger's secure overlay, without passing through user-space memory in the app process.

To verify that the secure pipeline is active:

```bash
adb shell dumpsys media.drm
# securityLevel should be L1, and mCurrentState should contain SECURE_DECODER
```

## Compose integration pitfalls

**Pitfall 1: Compose Dialog does not inherit the Activity's FLAG_SECURE**

Compose renders into `AndroidComposeView`, and the Activity's `FLAG_SECURE` only applies at the Window level. A Dialog opened from Compose must still be protected at the native Window layer:

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

**Pitfall 2: screenshot detection must be registered at the Activity layer**

Android 14's `ScreenCaptureCallback` can detect screenshot events, but in a Compose app it still has to be registered from the Activity:

```kotlin
if (Build.VERSION.SDK_INT >= 34) {
    registerScreenCaptureCallback(mainExecutor) {
        logSecurityEvent("screenshot_detected")
    }
}
```

**Pitfall 3: partial masking is not system-level protection**

Some screens only need to hide a specific region, such as a card number, rather than the entire page. Compose can use `drawWithContent` for local masking, but that is only a rendering-layer effect. It does not replace system-level `FLAG_SECURE` protection.

## Engineering defense in depth

On-device content security spans three layers: the View layer with `FLAG_SECURE`, the composition layer with hardware overlay verification, and the decode layer with the DRM secure pipeline. In practice, I prefer to centralize this in a `SecurityManager`:

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

Each screen declares its own security level in `onCreate`, and the centralized entry point prevents omissions. One production incident I handled two years ago came from a new page that simply forgot to add `FLAG_SECURE`.

No single layer is absolutely reliable. Each can be bypassed with the right technique. But when the three layers are stacked together, the attack cost rises sharply. In real projects, that is far more practical than chasing a supposedly perfect solution.
