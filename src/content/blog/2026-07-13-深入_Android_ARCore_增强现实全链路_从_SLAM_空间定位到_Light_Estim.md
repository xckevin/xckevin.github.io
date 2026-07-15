---
title: 深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构
slug: android-arcore-slam-light-estimation
translationKey: android-arcore-slam-light-estimation
excerpt: 深入剖析 ARCore 运动追踪、环境理解与光照估计三条核心链路的技术原理，结合 Compose 集成与性能优化实践，构建稳定的虚实融合 AR 应用。
publishDate: '2026-07-13'
tags:
- Android
- ARCore
- 增强现实
- SLAM
- 性能优化
seo:
  title: 深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构
  description: 本文深入 Android ARCore 增强现实全链路，从 SLAM 运动追踪的状态机与坐标系，到平面检测与 Depth API 的像素级遮挡，再到光照估计从单值到方向光的演进，完整解析虚实融合渲染架构与 Compose 集成实践。
---

在做一个 AR 试戴项目时，我遇到了一个让人头疼的 bug：虚拟眼镜在用户转头时会轻微漂移，像是悬浮在脸上而不是戴在脸上。排查后发现，问题出在对 ARCore 三套子系统之间耦合关系的理解不够——运动追踪提供了位姿，但光照估计和深度遮挡的更新频率截然不同，直接用 Camera 回调的 pose 去驱动渲染，在帧间会引入微小的相位差。

ARCore 在 Android 上进入 1.40 版本后，API 已经相当成熟。它的核心能力分三条链路：**运动追踪**负责"我在哪"、**环境理解**负责"我周围有什么"、**光照估计**负责"光从哪来"。三者在 Session 内部异步运行，但对外暴露统一的 Frame 接口。把这个时序关系理清楚，是写出稳定 AR 应用的前提。

## SLAM 运动追踪：状态机与坐标系

ARCore 的运动追踪本质上是一个**视觉惯性里程计（VIO）**，融合了摄像头图像和 IMU 数据来做 6-DoF 位姿估计。每帧会产出一个 `TrackingState`，这是个三态枚举：

- **TRACKING**：正常追踪，pose 可用
- **PAUSED**：暂时丢失追踪（快速移动、遮挡镜头），pose 保持上一帧值但不可信
- **STOPPED**：完全丢失，需要用户移动设备重新初始化

只判断 `TRACKING` 是不够的。我踩过的坑是：在 `PAUSED` 状态下继续用 `frame.getCamera().getPose()` 去更新虚拟物体位置，结果物体"钉"在屏幕上不动，恢复追踪后会产生一次跳变。正确的做法是维护一个 **pose 有效性状态机**，非 TRACKING 状态下冻结虚拟物体的世界坐标：

```kotlin
class ArSessionManager {
    private var lastValidPose: Pose? = null
    
    fun onDrawFrame(frame: Frame): Pose? {
        return when (frame.camera.trackingState) {
            TrackingState.TRACKING -> {
                lastValidPose = frame.camera.pose
                lastValidPose
            }
            TrackingState.PAUSED -> lastValidPose  // 冻结，不更新
            TrackingState.STOPPED -> null           // 提示用户移动设备
            else -> null
        }
    }
}
```

坐标系转换也是一个容易踩坑的点。ARCore 的世界坐标系以 Session 创建时的设备位置为原点，Y 轴朝上（类似 OpenGL 惯例）。如果你用 Sceneform 或 Filament 做渲染，它们的坐标系是 Y 轴朝上的右手系，与 ARCore 一致，不需要额外转换。但用 Unity 或自定义 OpenGL 时，需要注意 Y 轴方向的差异。

## 环境理解：平面检测与 Depth API 的协同

ARCore 的环境理解分为两个层次：**几何平面（Plane）** 和 **深度图（Depth）**。前者提供语义化的水平/垂直表面，后者提供逐像素的深度值，二者配合才能实现精确的虚实遮挡。

### 平面检测的内部机制

平面检测不是简单的点云拟合。ARCore 内部维护了一个 **点云（Point Cloud）**，每帧更新约 2000-5000 个特征点。当这些点在一定区域内共面时，系统会聚类并拟合出一个平面。这个过程分三个阶段：

1. **特征点提取与匹配**：从连续帧中提取 FAST 角点，用光流法追踪
2. **共面聚类**：RANSAC 算法从点云中筛选出共面内点
3. **平面边界优化**：用凸包算法计算平面多边形边界

`Plane` 对象有一个容易被误解的字段：`isPoseInExtents()`。它的语义是"该 3D 点是否在平面多边形范围内"，不是"是否在平面无限延伸面上"。做 hit test 时，你需要先判断是否命中平面，再判断是否在范围内：

```kotlin
fun hitTestPlane(frame: Frame, tapX: Float, tapY: Float): Pose? {
    val hits = frame.hitTest(tapX, tapY)
    for (hit in hits) {
        val trackable = hit.trackable
        if (trackable is Plane && trackable.isPoseInPolygon(hit.hitPose)) {
            // isPoseInPolygon 判断是否在平面多边形内
            // isPoseInExtents 判断是否在平面矩形范围内（粗略版）
            return hit.hitPose
        }
    }
    return null
}
```

平面还分三种类型：`HORIZONTAL_UPWARD`（地板/桌面）、`HORIZONTAL_DOWNWARD`（天花板）、`VERTICAL`（墙壁）。做室内导航类应用时，只过滤 `HORIZONTAL_UPWARD` 可以避免把墙壁误识别为地面。

### Depth API 的像素级遮挡

Depth API 需要设备支持（通过 `isDepthModeSupported()` 检查），在 1.18 版本后提供了 `RawDepthImage` 和 `DepthImage` 两种输出。前者是 16-bit 毫米级深度值，后者是 8-bit 归一化深度（0-255 映射到 near-far 范围）。

在 Fragment Shader 中做遮挡判断的典型写法：

```glsl
// 从深度图采样当前像素的深度值
float depth = texture(u_DepthTexture, v_TexCoord).r;
// 将虚拟物体的深度与场景深度比较
float occlusion = step(v_ObjectDepth, depth);
// occlusion = 1.0 表示物体在前，可见；0.0 表示被遮挡
gl_FragColor.a *= occlusion;
```

但 Depth API 的深度图分辨率通常只有 160x120 或 160x90，与屏幕分辨率差距很大。直接用线性插值采样会导致边缘锯齿。我的做法是在 Shader 中做 3x3 双线性采样取最小值，模拟保守光栅化：

```glsl
float minDepth = 1.0;
for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
        vec2 offset = vec2(x, y) / depthTextureSize;
        minDepth = min(minDepth, texture(u_DepthTexture, v_TexCoord + offset).r);
    }
}
```

## 光照估计：从单值到方向光的演进

ARCore 的光照估计经历了两个阶段。早期版本只提供一个 `pixelIntensity`（0-1 的单值），后来加入了 `Environmental HDR` 模式，能输出：

- **主方向光颜色与方向**（Directional Light）
- **环境光 SH 系数**（Spherical Harmonics，9 个 float）
- **HDR 立方体贴图**（可选，用于镜面反射）

单值强度模式适合 2D AR 滤镜类应用，只需要把虚拟物体的亮度乘以 `pixelIntensity` 即可。但做 3D 渲染时，单值完全不够——你无法知道光从哪个方向来，阴影方向就无从谈起。

`Environmental HDR` 模式输出的 `DirectionalLight` 结构体包含了颜色、方向和强度，可以直接映射到 PBR 渲染管线：

```kotlin
fun configureLighting(frame: Frame, renderer: PbrRenderer) {
    val lightEstimate = frame.lightEstimate
    // 主方向光
    val dirLight = lightEstimate.environmentalHdrMainDirectionalLight
    renderer.setDirectionalLight(
        direction = dirLight.direction,  // 世界空间方向
        color = floatArrayOf(dirLight.colorR, dirLight.colorG, dirLight.colorB),
        intensity = lightEstimate.environmentalHdrAmbientSphericalHarmonics[0]
    )
    // SH 环境光（9 个系数用于低频环境光照）
    renderer.setAmbientSh(lightEstimate.environmentalHdrAmbientSphericalHarmonics)
}
```

这里有一个实测结论：**方向光的质量取决于场景中的几何特征**。在白墙房间内，方向光估算基本不可靠，颜色偏白且方向随机跳动。在物品丰富的环境中（书架、家具），方向光方向和色温准确度明显提升。所以如果你的 AR 应用主要在室内白墙环境使用，建议 fallback 到单值模式，或者给方向光加一个低通滤波平滑跳变。

```kotlin
// 一阶低通滤波平滑方向光跳变
private var smoothedDirection = Vector3(0f, -1f, 0f)

fun smoothDirection(raw: Vector3, alpha: Float = 0.1f): Vector3 {
    smoothedDirection = smoothedDirection * (1f - alpha) + raw * alpha
    return smoothedDirection.normalized()
}
```

## Compose 集成：AR 场景的状态桥接

ARCore 的渲染循环是命令式的（`onDrawFrame` 回调），而 Compose 是声明式的。桥接二者的关键在于：**把 AR Frame 中的空间数据映射为 Compose 的 UI 状态，但渲染本身留在 GL 线程中**。

我常用的架构是一个 `ArStateHolder`，它持有 Session 和渲染线程，通过 `StateFlow` 向外暴露 UI 层关心的状态：

```kotlin
class ArStateHolder {
    private val _trackingState = MutableStateFlow(TrackingState.STOPPED)
    val trackingState: StateFlow<TrackingState> = _trackingState
    
    private val _detectedPlanes = MutableStateFlow<List<PlaneInfo>>(emptyList())
    val detectedPlanes: StateFlow<List<PlaneInfo>> = _detectedPlanes
    
    fun onDrawFrame(frame: Frame) {
        _trackingState.value = frame.camera.trackingState
        // 只暴露 UI 关心的平面摘要，不暴露完整 Plane 对象
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

Compose 侧则用 `collectAsState` 消费这些状态，展示追踪提示、平面指示器等 UI 覆盖层。关键原则是：**AR 的 3D 渲染永远在 SurfaceView/TextureView 的 GL 线程中，Compose 只负责 2D 覆盖层**。

对于 `AndroidView` 包装 GLSurfaceView 的场景，需要注意生命周期同步。Session 的 `resume()` 和 `pause()` 必须与 `Lifecycle.Event.ON_RESUME` 和 `ON_PAUSE` 绑定：

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

## 性能与调试

在 Pixel 6 上实测，ARCore 的 CPU 占用约 15-20%（含渲染），其中 **VIO 线程约 8%**，**Depth API 约 5%**。如果开启 Environmental HDR 模式，GPU 会增加约 10% 的负载用于立方体贴图生成。对中低端设备，建议做分级：

- 高端设备（Snapdragon 8 Gen 系列）：开启 Depth + Environmental HDR
- 中端设备：开启 Depth，使用单值光照
- 低端设备：仅基础平面检测，使用单值光照

调试 AR 应用时，`arcoreimg` 命令行工具可以离线分析 `.mp4` 录制的 AR 数据集，检查特征点数量和质量。另一个实用技巧是在开发者选项中开启「显示点云」和「显示平面」，直观判断当前环境的追踪质量。

ARCore 的三条链路虽然独立，在渲染时却需要协同——运动追踪的 pose 驱动虚拟物体位置，平面检测决定放置位置，深度图做遮挡，光照估计调和外观。把每帧的更新时序和频率差异理清，正是 AR 应用从"能跑"到"稳定"的分水岭。
