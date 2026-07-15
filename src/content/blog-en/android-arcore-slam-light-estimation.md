---
title: "Android ARCore: SLAM, Environment Understanding, and Light Estimation"
lang: en
translationKey: android-arcore-slam-light-estimation
slug: android-arcore-slam-light-estimation
excerpt: "Build stable Android AR experiences by understanding ARCore tracking, planes and depth, light estimation, rendering timing, and Compose integration."
publishDate: '2026-07-13'
tags:
- "Android"
- "ARCore"
- "Augmented Reality"
- "SLAM"
seo:
  title: "Android ARCore: SLAM and Light Estimation"
  description: "Understand ARCore motion tracking, environment understanding, and light estimation on Android."
  pageType: article
---

While working on an AR try-on project, I encountered a troublesome bug: the virtual glasses would drift slightly when the user turned their head, as if they were floating on the face instead of being worn on the face. After investigation, it was found that the problem lies in the insufficient understanding of the coupling relationship between the three subsystems of ARCore - motion tracking provides poses, but the update frequencies of illumination estimation and depth occlusion are completely different. Directly using the pose of the Camera callback to drive the rendering will introduce a slight phase difference between frames.

After ARCore entered version 1.40 on Android, the API has become quite mature. Its core capabilities are divided into three links: **motion tracking** is responsible for "where am I", **environment understanding** is responsible for "what is around me", and **illumination estimation** is responsible for "where does the light come from". The three run asynchronously inside the Session, but expose a unified Frame interface to the outside world. Clarifying this timing relationship is a prerequisite for writing stable AR applications.

## SLAM motion tracking: state machine and coordinate system

ARCore's motion tracking is essentially a visual inertial odometry (VIO) that combines camera images and IMU data to perform 6-DoF pose estimation. Each frame will produce a `TrackingState`, which is a three-state enumeration:

- **TRACKING**: Normal tracking, pose available
- **PAUSED**: Tracking is temporarily lost (fast movement, camera occlusion), pose maintains the previous frame value but is not credible
- **STOPPED**: Completely lost, requiring the user's mobile device to be re-initialized

Just judging `TRACKING` is not enough. The pitfall I have encountered is: continuing to use `frame.getCamera().getPose()` in the `PAUSED` state to update the position of the virtual object. As a result, the object is "pinned" to the screen and a jump occurs after the tracking is resumed. The correct approach is to maintain a **pose validity state machine** and freeze the world coordinates of the virtual object in the non-TRACKING state:

```kotlin
class ArSessionManager {
    private var lastValidPose: Pose? = null
    
    fun onDrawFrame(frame: Frame): Pose? {
        return when (frame.camera.trackingState) {
            TrackingState.TRACKING -> {
                lastValidPose = frame.camera.pose
                lastValidPose
            }
            TrackingState.PAUSED -> lastValidPose  // Freeze the last pose; do not update.
            TrackingState.STOPPED -> null           // Prompt the user to move the device.
            else -> null
        }
    }
}
```

Coordinate system conversion is also an easy pitfall. ARCore's world coordinate system has the device position when the Session was created as the origin, with the Y-axis pointing upward (similar to the OpenGL convention). If you use Sceneform or Filament for rendering, their coordinate system is a right-handed system with the Y axis pointing upward, which is consistent with ARCore and does not require additional conversion. But when using Unity or custom OpenGL, you need to pay attention to the difference in the Y-axis direction.

## Environment understanding: collaboration between plane detection and Depth API

ARCore's environment understanding is divided into two levels: **Geometric Plane** and **Depth Map (Depth)**. The former provides semantic horizontal/vertical surfaces, and the latter provides pixel-by-pixel depth values. The combination of the two can achieve accurate virtual and real occlusion.

### Internal mechanism of plane detection

Plane detection is not a simple point cloud fitting. ARCore maintains a **Point Cloud** internally, updating approximately 2000-5000 feature points each frame. When these points are coplanar within a certain area, the system will cluster and fit a plane. This process has three stages:

1. **Feature point extraction and matching**: Extract FAST corner points from consecutive frames and track them using the optical flow method
2. **Coplanar clustering**: RANSAC algorithm filters out coplanar interior points from point clouds
3. **Plane boundary optimization**: Calculate the plane polygon boundary using convex hull algorithm

The `Plane` object has a field that is easily misunderstood: `isPoseInExtents()`. Its semantics is "whether the 3D point is within the range of the plane polygon", not "whether it is on the infinite extension surface of the plane". When doing a hit test, you need to first determine whether it hits the plane, and then determine whether it is within the range:

```kotlin
fun hitTestPlane(frame: Frame, tapX: Float, tapY: Float): Pose? {
    val hits = frame.hitTest(tapX, tapY)
    for (hit in hits) {
        val trackable = hit.trackable
        if (trackable is Plane && trackable.isPoseInPolygon(hit.hitPose)) {
            // isPoseInPolygon checks whether the pose lies in the plane polygon.
            // isPoseInExtents checks the plane's rectangular bounds (a coarse check).
            return hit.hitPose
        }
    }
    return null
}
```

There are three types of planes: `HORIZONTAL_UPWARD` (floor/desktop), `HORIZONTAL_DOWNWARD` (ceiling), `VERTICAL` (wall). When making indoor navigation applications, filtering only `HORIZONTAL_UPWARD` can avoid misidentifying walls as the ground.

### Pixel-level occlusion of Depth API

The Depth API requires device support (checked via `isDepthModeSupported()`), and provides two outputs of `RawDepthImage` and `DepthImage` after version 1.18. The former is a 16-bit millimeter-level depth value, and the latter is an 8-bit normalized depth (0-255 mapped to the near-far range).

Typical way of writing occlusion judgment in Fragment Shader:

```glsl
// Sample the current pixel's depth from the depth map.
float depth = texture(u_DepthTexture, v_TexCoord).r;
// Compare virtual-object depth with scene depth.
float occlusion = step(v_ObjectDepth, depth);
// occlusion = 1.0 means the object is in front and visible; 0.0 means occluded.
gl_FragColor.a *= occlusion;
```

However, the depth map resolution of the Depth API is usually only 160x120 or 160x90, which is quite different from the screen resolution. Sampling directly with linear interpolation will result in jagged edges. My approach is to do 3x3 bilinear sampling in Shader to take the minimum value and simulate conservative rasterization:

```glsl
float minDepth = 1.0;
for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
        vec2 offset = vec2(x, y) / depthTextureSize;
        minDepth = min(minDepth, texture(u_DepthTexture, v_TexCoord + offset).r);
    }
}
```

## Lighting estimation: evolution from single value to directional light

ARCore's lighting estimation goes through two stages. Early versions only provided a `pixelIntensity` (a single value of 0-1), and later added an `Environmental HDR` mode, which can output:

- **Main directional light color and direction** (Directional Light)
- **Ambient SH coefficient** (Spherical Harmonics, 9 floats)
- **HDR Cubemap** (optional, for specular reflections)

The single value intensity mode is suitable for 2D AR filter applications. You only need to multiply the brightness of the virtual object by `pixelIntensity`. But when doing 3D rendering, a single value is completely insufficient - you have no way of knowing which direction the light is coming from, and there is no way to talk about the direction of the shadows.

The `DirectionalLight` structure output by `Environmental HDR` mode contains color, direction and intensity, which can be directly mapped to the PBR rendering pipeline:

```kotlin
fun configureLighting(frame: Frame, renderer: PbrRenderer) {
    val lightEstimate = frame.lightEstimate
    // Main directional light
    val dirLight = lightEstimate.environmentalHdrMainDirectionalLight
    renderer.setDirectionalLight(
        direction = dirLight.direction,  // Direction in world space
        color = floatArrayOf(dirLight.colorR, dirLight.colorG, dirLight.colorB),
        intensity = lightEstimate.environmentalHdrAmbientSphericalHarmonics[0]
    )
    // SH ambient light (nine coefficients for low-frequency illumination)
    renderer.setAmbientSh(lightEstimate.environmentalHdrAmbientSphericalHarmonics)
}
```

Here is a measured conclusion: **The quality of directional light depends on the geometric features in the scene**. In a room with white walls, directional light estimation is basically unreliable, the color is white and the direction jumps randomly. In an environment rich in objects (bookshelf, furniture), the accuracy of directional light direction and color temperature is significantly improved. So if your AR application is mainly used in an indoor white wall environment, it is recommended to fallback to single value mode, or add a low-pass filter to the directional light to smooth the transition.

```kotlin
// Smooth directional-light jumps with a first-order low-pass filter.
private var smoothedDirection = Vector3(0f, -1f, 0f)

fun smoothDirection(raw: Vector3, alpha: Float = 0.1f): Vector3 {
    smoothedDirection = smoothedDirection * (1f - alpha) + raw * alpha
    return smoothedDirection.normalized()
}
```

## Compose integration: state bridging for AR scenes

ARCore's rendering loop is imperative (`onDrawFrame` callback), while Compose is declarative. The key to bridging the two is to map the spatial data in the AR Frame to Compose's UI state, but leave the rendering itself in the GL thread.

The architecture I commonly use is an `ArStateHolder`, which holds the Session and the rendering thread, and exposes the state that the UI layer cares about through `StateFlow`:

```kotlin
class ArStateHolder {
    private val _trackingState = MutableStateFlow(TrackingState.STOPPED)
    val trackingState: StateFlow<TrackingState> = _trackingState
    
    private val _detectedPlanes = MutableStateFlow<List<PlaneInfo>>(emptyList())
    val detectedPlanes: StateFlow<List<PlaneInfo>> = _detectedPlanes
    
    fun onDrawFrame(frame: Frame) {
        _trackingState.value = frame.camera.trackingState
        // Expose only the plane summary the UI needs, not the complete Plane object.
        _detectedPlanes.value = frame.getUpdatedTrackables(Plane::class.java)
            .map { PlaneInfo(it.centerPose, it.type, it.extentX, it.extentZ) }
    }
}

data class PlaneInfo(
    val centerPose: Pose,
    val type: Plane.Type,
    val width: Float,
    val height: Float
)
```

The Compose side uses `collectAsState` to consume these states and display UI overlays such as tracking tips and flat indicators. The key principle is: **AR's 3D rendering is always in the GL thread of SurfaceView/TextureView, and Compose is only responsible for the 2D overlay**.

For scenarios where `AndroidView` wraps GLSurfaceView, you need to pay attention to life cycle synchronization. Session's `resume()` and `pause()` must be bound to `Lifecycle.Event.ON_RESUME` and `ON_PAUSE`:

```kotlin
@Composable
fun ArScene(modifier: Modifier, arState: ArStateHolder) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> arState.resume()
                Lifecycle.Event.ON_PAUSE -> arState.pause()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    
    AndroidView(
        modifier = modifier,
        factory = { context ->
            GLSurfaceView(context).apply {
                setRenderer(arState.renderer)
            }
        }
    )
}
```

## Performance and Debugging

According to actual measurements on Pixel 6, ARCore's CPU usage is about 15-20% (including rendering), of which **VIO threads account for about 8%** and **Depth API accounts for about 5%**. If Environmental HDR mode is turned on, the GPU will increase load by about 10% for cubemap generation. For mid- to low-end devices, it is recommended to classify them as follows:

- High-end devices (Snapdragon 8 Gen series): Turn on Depth + Environmental HDR
- Mid-range devices: Turn on Depth and use single value lighting
- Low-end devices: only basic plane detection, using single-valued lighting

When debugging AR applications, the `arcoreimg` command line tool can analyze the `.mp4` recorded AR data set offline to check the number and quality of feature points. Another practical tip is to turn on "Show Point Cloud" and "Show Plane" in the developer options to intuitively judge the tracking quality of the current environment.

Although the three links of ARCore are independent, they need to be coordinated during rendering - the pose of motion tracking drives the position of the virtual object, the plane detection determines the placement position, the depth map does occlusion, and the lighting estimation harmonizes the appearance. Clarifying the update timing and frequency differences of each frame is the watershed for AR applications from "running" to "stable".
