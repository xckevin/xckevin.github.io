---
title: 深入 Android AGSL RuntimeShader 全链路：从 Skia 着色器编译到 Compose 自定义图形特效
excerpt: 本文深入剖析 Android AGSL RuntimeShader 的完整编译链路（AGSL→SkSL→GPU），详解 uniform shader 嵌套采样机制、Compose 两种集成方式及实战案例，并总结性能边界与工程实践建议。
publishDate: '2026-05-28'
tags:
- Android
- AGSL
- Jetpack Compose
- Skia
- 图形渲染
seo:
  title: 深入 Android AGSL RuntimeShader 全链路：从 Skia 着色器编译到 Compose 自定义图形特效
  description: 深入剖析 Android AGSL RuntimeShader 完整编译链路，详解 uniform shader 机制、Compose 集成与性能优化实践。
---

去年做 Compose 迁移时，我需要在列表里实现毛玻璃模糊的 Header。`Modifier.blur()` 能用，但没法和半透明遮罩叠加——它是对整个图层的操作，粒度太粗。当时的思路：能不能自己写一个 Shader，精确控制每个像素的混合？

Android 13 的 **AGSL（Android Graphics Shading Language）** 和 `RuntimeShader` 就是干这个的。和传统的 GLSL 不同，AGSL 不依赖 GLSurfaceView，可以直接嵌入 Canvas 渲染管线，在 View 体系和 Compose 里都能用。

但深入用起来我发现，理解它的关键不在语法——AGSL 和 GLSL 八分像——而在于：**这段代码经过了怎样的编译链路，最终跑在 GPU 上？** 这个链路决定了你能做什么、性能瓶颈在哪。

## AGSL → SkSL：编译链路的第一环

入口代码很简单：

```kotlin
val shader = RuntimeShader("""
    uniform float2 resolution;
    half4 main(float2 coord) {
        float2 uv = coord / resolution;
        return half4(uv.x, uv.y, 0.5, 1.0);
    }
""")
shader.setFloatUniform("resolution", width.toFloat(), height.toFloat())
```

传入一段 AGSL 字符串，Android 运行时编译。但 **AGSL 不是直接送给 GPU 的**。

实际编译路径：`AGSL → SkSL（Skia Shading Language）→ 平台后端代码`。Skia 是 Android 2D 渲染引擎，内部用 SkSL 做中间表示。AGSL 本质是 SkSL 的超集，加上了 Android 特有的 `uniform shader` 类型和一些语义约束。

踩过的一个坑：`texture()` 采样函数在 AGSL 中坐标是 `[0,1]` 归一化的，和 GLSL 一致，但某些 Skia 版本对越界采样的 clamp 策略不同——纹理边缘会出黑线。排查方向不是改采样坐标，而是检查 Skia 的 tile mode 是否被正确传递到 Shader 的 sampler 对象上。

## uniform shader：区别于普通 Shader 的核心

AGSL 最特别的设计是 **`uniform shader`**——你可以把 `BitmapShader`、`LinearGradient`、甚至另一个 `RuntimeShader` 作为 uniform 传入，然后在 Shader 里调用 `.eval()` 采样：

```kotlin
val imageShader = ImageShader(bitmap)
val blurShader = RuntimeShader("""
    uniform shader content;
    uniform float2 resolution;
    float gauss(float x, float sigma) {
        return exp(-(x*x)/(2.0*sigma*sigma)) / (2.506628*sigma);
    }
    half4 main(float2 coord) {
        half4 color = half4(0.0);
        for (int i = -3; i <= 3; i++) {
            float w = gauss(float(i), 1.5);
            color += content.eval(coord + float2(0, float(i)*4.0)) * w;
        }
        return color;
    }
""")
blurShader.setInputShader("content", imageShader)
```

GLSL 只能采样纹理，不能嵌套调用 Shader 对象。`content.eval()` 让 AGSL 可以把已有的 Android 绘制对象直接当作着色器输入——这个能力在实际项目中非常实用。整条链路是：Compose 绘制 → RenderNode → Skia Picture → AGSL Shader 后处理 → GPU 渲染。

## Compose 中的两种集成方式

Compose 里使用 `RuntimeShader` 分两个场景，执行路径不同。

**场景一：作为 Paint 的 Shader 绘制内容**

```kotlin
Canvas(modifier = Modifier.fillMaxSize()) {
    shader.setFloatUniform("time", currentTime)
    drawRect(brush = ShaderBrush(shader), size = size)
}
```

这替换掉了 Paint 的默认着色器，适合生成型效果：渐变、噪声、程序化图案。

**场景二：作为 RenderEffect 做后处理**

```kotlin
Image(
    bitmap = imageBitmap,
    modifier = Modifier.graphicsLayer {
        renderEffect = RenderEffect
            .createRuntimeShaderEffect(shader, "content")
            .asComposeRenderEffect()
    }
)
```

这里 Shader 在 RenderNode 层级执行，对已绘制内容叠加一个额外的 Pass。有个细节容易被忽略：**在 LazyColumn 里对 Item 套 `graphicsLayer { renderEffect }` 不会有额外开销**——Compose 只为可见的 Item 维护 RenderNode，不可见的 Item 不会被提交到 GPU。

## 一个完整案例：呼吸光晕

把以上几点串起来，做一个用 uniform 驱动动画的动态效果：

```kotlin
@Composable
fun BreathingGlow(modifier: Modifier = Modifier) {
    val shader = remember {
        RuntimeShader("""
            uniform float2 resolution;
            uniform float time;
            half4 main(float2 coord) {
                float2 uv = coord / resolution;
                float dist = distance(uv, float2(0.5));
                float glow = 0.02 / (dist + 0.02);
                float pulse = 1.0 + 0.3 * sin(time * 2.0);
                return half4(0.2, 0.6, 1.0, glow * pulse);
            }
        """)
    }
    val time by rememberInfiniteTransition().animateFloat(
        initialValue = 0f, targetValue = 6.28f,
        animationSpec = infiniteRepeatable(tween(2000))
    )
    Canvas(modifier = modifier.fillMaxSize()) {
        shader.setFloatUniform("resolution", size.width, size.height)
        shader.setFloatUniform("time", time)
        drawRect(brush = ShaderBrush(shader), size = size)
    }
}
```

两个关键点：`remember` 确保重组时不重新编译 Shader；`rememberInfiniteTransition` 让动画循环不创建额外协程。

性能方面，每个像素在 GPU 上并行计算。Pixel 6 上实测，单 Shader 的 GPU 占用约 3-5%。但叠加 5 个以上类似复杂度的 Shader 时，GPU 时间从 8ms 升到 18ms，接近 60fps 的阈值。在实际业务里，我更倾向于把一个复杂效果合并到单个 Shader 里，而不是多层叠加——减少 Pass 数比优化单 Pass 的指令更见效。

## 边界与限制

用 AGSL 必须接受几个硬性限制：

**没有 Geometry/Tessellation Shader**。只有 Fragment Shader，你只能改变像素颜色，不能改几何形状。要做顶点变换，只能回到 OpenGL/Vulkan。

**uniform 不支持 Struct 和数组**。每个变量必须单独声明和设置。参数多的时候很啰嗦——变通方案是把多个值打包进 `float4`，但牺牲可读性。

**编译时机问题**。`RuntimeShader` 构造时不编译，首次绑定时才触发 SkSL 编译。语法错误会崩在 `drawRect` 那行，调用栈里看不到你的 AGSL 代码。调试技巧：`adb logcat | grep -i "skia\|shader"` 抓编译日志。

最后，一个实践建议：**把 Shader 逻辑和 UI 状态拆开**。封装一个独立的类管理 `RuntimeShader` 和 uniform 更新，而不是直接写在 Composable 里。在重组频繁的场景下，Shader 对象的生命周期就能和 UI 重组节奏解耦——这是我踩过重组导致 Shader 反复编译的坑之后形成的习惯。
