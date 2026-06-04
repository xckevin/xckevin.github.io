---
title: "Inside Android CameraX: From Camera2 Pipeline to Compose Camera UI"
lang: en
translationKey: android-camerax-camera2-pipeline
slug: android-camerax-camera2-pipeline
excerpt: "Analyze CameraX's layered pipeline from HAL and Camera2 to UseCase APIs and Compose integration, with production lessons on focus, resolution, and leaks."
publishDate: '2026-05-10'
tags:
- "Android"
- "CameraX"
- "Jetpack Compose"
- "Camera2"
- "Architecture"
seo:
  title: "Inside Android CameraX: Camera2 Pipeline to Compose Camera UI"
  description: "Explore CameraX architecture from HAL and Camera2 to UseCases, lifecycle binding, Compose PreviewView integration, and production pitfalls."
  pageType: article
---

Last year, while refactoring the camera module in a video social app, our team inherited a handwritten implementation based on the Camera2 API. As soon as I opened the code, one thing was obvious: the `CameraCaptureSession` state machine alone took more than 200 lines, and every orientation change had a chance to trigger a random ANR.

Camera2's pain is structural. It exposes hardware capability directly to developers, but it does not provide a reasonable abstraction layer. CameraX exists to fill that missing layer in the pipeline.

## From HAL to UseCase: four layers in one pipeline

From hardware to app code, the camera pipeline has four layers.

**HAL layer, or Hardware Abstraction Layer**: the interface between camera drivers and system services. SoC vendors implement 3A algorithms here: auto exposure, auto focus, and auto white balance. CameraX talks to the HAL through the `Camera2 API`; it does not modify the HAL layer.

**Camera2 layer**: the low-level API provided by Android Framework. `CameraManager` enumerates devices, `CameraDevice` represents a physical camera, and `CameraCaptureSession` manages a capture session. This is where the complexity lives. Session creation, configuration, and state transitions are all handwritten, and a bad configuration can throw `CameraAccessException` with little context.

**UseCase abstraction layer**: this is CameraX's core design. It abstracts camera operations into four UseCases:

```text
Preview        -> Real-time preview through a Surface
ImageCapture   -> Still capture, outputting JPEG or RAW
VideoCapture   -> Recording, outputting an encoded video stream
ImageAnalysis  -> Frame analysis, outputting YUV or RGBA for ML models
```

Each UseCase is configured independently. For example, if you run face detection while recording video, VideoCapture and ImageAnalysis can bind to the same `LifecycleOwner`. Under the hood they share one CameraCaptureSession, but each receives its own `Surface`.

**Business layer**: your Activity, Fragment, or Composable talks only to UseCases. It does not need to know that CameraDevice and sessions exist.

The key to this layering is that **CameraX maintains an internal session manager**. Based on the currently active UseCase combination, it automatically builds the `OutputConfiguration` list, merges conflicting streams, and creates the best CaptureSession it can. You no longer write the session state machine yourself.

## How lifecycle binding works

`ProcessCameraProvider` is the entry point into CameraX. It is acquired asynchronously through `ListenableFuture`:

```kotlin
val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
cameraProviderFuture.addListener({
    val cameraProvider = cameraProviderFuture.get()
    val preview = Preview.Builder().build()
    val imageCapture = ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .build()
    // Bind to the current lifecycle.
    cameraProvider.bindToLifecycle(
        lifecycleOwner, cameraSelector, preview, imageCapture
    )
}, ContextCompat.getMainExecutor(context))
```

Internally, `bindToLifecycle` observes the `LifecycleOwner` state:

- `ON_START` -> opens CameraDevice, creates the session, and starts the preview stream
- `ON_STOP` -> pauses but does not release hardware, keeping the connection while backgrounded
- `ON_DESTROY` -> closes the device and releases every Surface and thread resource

One easy trap: **once a UseCase combination is bound, it cannot be modified dynamically**. If you want to switch between still capture and recording at runtime, you cannot unbind only one UseCase. You need to unbind everything and bind again. The recommended approach is often to bind Preview + ImageCapture + VideoCapture at the same time and use business logic to control which UseCase is actually active. When multiple UseCases coexist, CameraX shares streams internally, so the overhead is small.

## Compose camera UI: turning a Surface into a Composable

Using CameraX in Compose is mostly about **declaratively managing a Surface**. The traditional bridge is `AndroidView`:

```kotlin
@Composable
fun CameraPreview(
    preview: Preview,
    modifier: Modifier = Modifier
) {
    AndroidView(
        factory = { ctx ->
            PreviewView(ctx).apply {
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                // SurfaceProvider automatically connects to the Preview UseCase.
            }
        },
        modifier = modifier,
        update = { view ->
            preview.setSurfaceProvider(view.surfaceProvider)
        }
    )
}
```

`PreviewView.surfaceProvider` is the bridge between Compose and CameraX. At its core, it is an implementation of `Preview.SurfaceProvider`; CameraX gives it `SurfaceRequest` objects through callbacks.

There are two important modes:

- `ImplementationMode.PERFORMANCE`: uses `SurfaceView`, renders in a separate window layer, and has lower latency, but does not support Compose `Modifier` animation and clipping
- `ImplementationMode.COMPATIBLE`: uses `TextureView`, participates in Compose layout as a normal View, and supports all Modifier operations, but adds one extra texture copy

I usually use COMPATIBLE mode. On modern devices, the texture-copy cost is usually negligible, while losing Modifier flexibility is expensive in complex UIs.

Photo capture logic also fits naturally into a Composable:

```kotlin
@Composable
fun rememberImageCapture(): ImageCapture {
    return remember { ImageCapture.Builder().build() }
}

// Usage
val imageCapture = rememberImageCapture()
Button(onClick = {
    imageCapture.takePicture(
        ContextCompat.getMainExecutor(context),
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                // Handle the saved result.
            }
            override fun onError(exc: ImageCaptureException) {
                // ImageCaptureException wraps lower-level errors and is much friendlier than Camera2.
            }
        }
    )
})
```

There are still practical issues when integrating CameraX with Compose. Android still does not provide a complete official Compose Camera wrapper, so PreviewView has to be bridged through `AndroidView`. That means complex viewfinder animations, such as zooming crop frames or real-time filter overlays, can pay a rendering cost at the AndroidView boundary.

## Production pitfalls

**1. Focus and metering coordinate-system traps**

Camera2's `MeteringRectangle` uses sensor coordinates, while touches on `PreviewView` use display coordinates. The two may differ by rotation and mirroring. CameraX wraps this in `FocusMeteringAction`, but its internal conversion handles only `PreviewView`'s `displayOrientation`; it does not handle front-camera mirroring. In portrait mode, face-focus coordinates often need custom correction.

**2. Recording resolution and preview resolution mismatch**

When Preview and VideoCapture are bound together, setting Preview to 1080p and VideoCapture to 4K requires the HAL to output two streams at different resolutions. Some low-end devices fail directly with `StreamConfigurationMap` errors. The fix is to align Preview resolution with recording through `setTargetResolution`, or downgrade Preview during recording.

**3. ImageAnalysis memory leaks**

`ImageProxy` objects must be closed manually. CameraX maintains a limited internal Image buffer pool, two frames by default. If you do not close images, frames are dropped and the analysis callback gets slower and slower. My usual pattern is:

```kotlin
imageAnalysis.setAnalyzer(executor) { imageProxy ->
    try {
        // Process frame data.
    } finally {
        imageProxy.close() // Required.
    }
}
```

**4. Do not use CameraX for custom camera effects**

If your requirement is AR filters, custom beauty processing, real-time style transfer, or another highly customized rendering pipeline, CameraX's UseCase abstraction can become an obstacle. In that case, use Camera2 plus an OpenGL ES SurfaceTexture directly and manage the render loop yourself. CameraX is designed as a productivity tool for mainstream photo and video scenarios, not as an effects engine.

CameraX's value is that it automates the three most error-prone parts of camera development: session management, lifecycle binding, and multi-stream coordination. The cost is losing some flexibility, but 90% of app scenarios do not need that flexibility in the first place.
