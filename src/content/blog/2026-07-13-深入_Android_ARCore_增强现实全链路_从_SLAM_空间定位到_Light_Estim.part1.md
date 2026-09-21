---
title: "深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构（1）：SLAM 运动追踪：状态机与坐标系"
excerpt: "「深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构」系列第 1/2 篇：SLAM 运动追踪：状态机与坐标系"
publishDate: 2026-07-13
displayInBlog: false
series:
  name: "深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构"
  part: 1
  total: 2
seo:
  title: "深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构（1）：SLAM 运动追踪：状态机与坐标系"
  description: "「深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构」系列第 1/2 篇：SLAM 运动追踪：状态机与坐标系"
---


> 本文是「深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构」系列的第 1 篇，共 2 篇。

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

Depth API 需要设备支持（通过 `isDepthModeSupported()` 检查）。获取深度数据的公开 API 是 `Frame` 上的方法，而不是一个名为 `RawDepthImage`/`DepthImage` 的类：`acquireDepthImage16Bits()` 获取经过平滑处理的深度图，`acquireRawDepthImage16Bits()` 获取未经过滤波的原始深度图，二者都返回标准的 `android.media.Image`（16-bit，每个像素值以毫米为单位）。旧版 `acquireDepthImage()`/`acquireRawDepthImage()`（8-bit，已弃用）因深度范围受限（仅 8191mm）且需额外清除高 3 位，已不推荐使用。

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

---

> 下一篇我们将探讨「光照估计：从单值到方向光的演进」，敬请关注本系列。

**「深入 Android ARCore 增强现实全链路：从 SLAM 空间定位到 Light Estimation 光照估计的虚实融合架构」系列目录**

1. **SLAM 运动追踪：状态机与坐标系**（本文）
2. 光照估计：从单值到方向光的演进
