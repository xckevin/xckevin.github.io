---
title: "Android AGSL RuntimeShader: From Skia Compilation to Compose Effects"
lang: en
translationKey: android-agsl-runtimeshader-skia
slug: android-agsl-runtimeshader-skia
excerpt: "A deep dive into Android AGSL RuntimeShader, including the AGSL-to-SkSL-to-GPU pipeline, uniform shader sampling, Compose integration, practical effects, and performance limits."
publishDate: '2026-05-28'
tags:
- "Android"
- "AGSL"
- "Jetpack Compose"
- "Skia"
- "Graphics Rendering"
seo:
  title: "Android AGSL RuntimeShader: Skia Compilation and Compose Effects"
  description: "Understand Android AGSL RuntimeShader from AGSL and SkSL compilation to uniform shader inputs, Compose integration, limits, and practical UI effects."
  pageType: article
---

Last year, during a Compose migration, I needed a frosted-glass header inside a list. `Modifier.blur()` worked, but it could not be combined cleanly with a translucent mask because it operates on the whole layer. The control was too coarse. The question became: could I write my own Shader and precisely control how every pixel is blended?

Android 13's **AGSL, or Android Graphics Shading Language**, and `RuntimeShader` are built for this. Unlike traditional GLSL, AGSL does not require `GLSurfaceView`. It plugs directly into the Canvas rendering pipeline and works in both the View system and Compose.

After using it in depth, I found that the key is not syntax. AGSL looks a lot like GLSL. The real question is: **what compilation path does this code go through before it finally runs on the GPU?** That path determines what you can do and where the performance bottlenecks are.

## AGSL to SkSL: the first stage of compilation

The entry code is simple:

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

You pass in an AGSL string, and the Android runtime compiles it. But **AGSL is not sent directly to the GPU**.

The actual path is `AGSL -> SkSL, or Skia Shading Language -> platform backend code`. Skia is Android's 2D rendering engine, and it uses SkSL internally as an intermediate representation. AGSL is essentially a SkSL extension with Android-specific features such as the `uniform shader` type and additional semantic constraints.

One pitfall I hit: the `texture()` sampling function in AGSL uses normalized `[0,1]` coordinates, just like GLSL. But in some Skia versions, the clamp strategy for out-of-bounds sampling differs, and black lines can appear at texture edges. The right debugging direction is not to keep tweaking sampling coordinates. Check whether Skia's tile mode is being passed correctly into the Shader's sampler object.

## uniform shader: the core difference from ordinary shaders

AGSL's most distinctive feature is **`uniform shader`**. You can pass a `BitmapShader`, a `LinearGradient`, or even another `RuntimeShader` as a uniform, then sample it inside the Shader by calling `.eval()`:

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

GLSL can sample textures, but it cannot nest and invoke Shader objects this way. `content.eval()` lets AGSL treat existing Android drawing objects as shader inputs, which is extremely useful in real projects. The full path is: Compose draw operation -> RenderNode -> Skia Picture -> AGSL Shader post-processing -> GPU rendering.

## Two ways to integrate with Compose

Using `RuntimeShader` in Compose falls into two scenarios, and the execution paths are different.

**Scenario one: draw content with the Shader used as Paint's shader.**

```kotlin
Canvas(modifier = Modifier.fillMaxSize()) {
    shader.setFloatUniform("time", currentTime)
    drawRect(brush = ShaderBrush(shader), size = size)
}
```

This replaces Paint's default shader and is a good fit for generative effects: gradients, noise, and procedural patterns.

**Scenario two: use the Shader as a RenderEffect for post-processing.**

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

Here the Shader runs at the RenderNode layer and adds an extra pass over already drawn content. One detail is easy to miss: **wrapping a LazyColumn item with `graphicsLayer { renderEffect }` does not add work for invisible items**. Compose only keeps RenderNodes for visible items. Invisible items are not submitted to the GPU.

## A complete example: breathing glow

Putting the pieces together, here is a dynamic effect driven by uniforms:

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

There are two key points. `remember` prevents the Shader from being recompiled during recomposition. `rememberInfiniteTransition` runs the looping animation without creating an extra coroutine.

For performance, each pixel is computed in parallel on the GPU. In measurements on a Pixel 6, a single Shader used roughly 3-5% GPU. But after stacking more than five Shaders of similar complexity, GPU time rose from 8 ms to 18 ms, approaching the 60 fps frame budget. In production UI, I usually prefer merging a complex effect into one Shader instead of stacking multiple layers. Reducing the number of passes is often more effective than optimizing instructions inside a single pass.

## Boundaries and limitations

Using AGSL means accepting a few hard limits.

**No Geometry Shader or Tessellation Shader.** AGSL is fragment-only. You can change pixel colors, but not geometry. For vertex transforms, you need to return to OpenGL or Vulkan.

**Uniforms do not support structs or arrays.** Every variable has to be declared and set separately. This becomes verbose when there are many parameters. A common workaround is packing several values into a `float4`, but that hurts readability.

**Compilation timing can surprise you.** `RuntimeShader` does not compile at construction time. SkSL compilation is triggered the first time the Shader is bound. Syntax errors can crash at the `drawRect` line, and the stack trace may not show your AGSL code. A useful debugging habit is to capture compilation logs with `adb logcat | grep -i "skia\|shader"`.

One final practice recommendation: **separate Shader logic from UI state**. Wrap `RuntimeShader` and uniform updates in a standalone class instead of writing everything directly inside a Composable. In frequently recomposed screens, this decouples the Shader object's lifecycle from UI recomposition. That habit came from debugging repeated Shader compilation caused by recomposition.
