---
title: 深入 Android Material 3 动态配色全链路：从 Monet 引擎色彩提取算法到 Compose MaterialTheme 的声明式主题架构
excerpt: 从 Monet 引擎的加权 K-Means 取色算法到 HCT 色彩空间的色调调色板生成，再到 Compose MaterialTheme 的声明式消费，完整解析 Material You 动态配色的全链路实现原理。
publishDate: '2026-06-01'
tags:
- Android
- Material Design
- Jetpack Compose
- 动态配色
- HCT 色彩空间
seo:
  title: 深入 Android Material 3 动态配色全链路：从 Monet 引擎色彩提取算法到 Compose MaterialTheme 的声明式主题架构
  description: 完整解析 Material You 动态配色全链路：从 WallpaperManager 取色入口、Monet 引擎的加权 K-Means 量化算法、HCT 色彩空间色调调色板生成，到 Compose MaterialTheme 声明式消费与暗色模式映射策略。
---

Android 12 引入 Material You 那天，我做了一件同行都会做的事——盯着换壁纸时系统界面颜色的渐变过程看了十几遍。几秒内，锁屏、通知栏、设置页的色调全部跟着壁纸变化，过渡流畅。后来我开始好奇：壁纸里哪几个像素决定了最终的色板？为什么某些壁纸能生成和谐的配色，另一些翻车严重？

这篇文章从 Monet 引擎的取色算法讲起，一路追踪到 Compose MaterialTheme 消费这些颜色的机制。

## WallpaperManager 与 Monet：取色的入口

动态配色的触发点藏得很深。系统监听壁纸变化事件，通过 `WallpaperManager` 回调把位图传给 SystemUI 进程中的 Monet 引擎。入口在 `SystemUI` 项目中，不在 AOSP 的三方应用 API 层。

```kotlin
// frameworks/base/packages/SystemUI/src/.../colors/ColorExtractor.kt
suspend fun extractColors(context: Context): Map<Int, Int> {
    val wallpaper = withContext(Dispatchers.IO) {
        WallpaperManager.getInstance(context).getBitmap()
    }
    return quantizeAndExtract(wallpaper)
}
```

这里拿到的是原始壁纸位图，未经缩放。核心环节是**颜色量化（Quantization）**——把一张可能有上百万种颜色的图片压缩成几十种代表性颜色。

Monet 采用的是 **Wang 的 K-Means 变体算法**，和标准 K-Means 的差异在于：它使用**加权色差距离**，在 Lab 色彩空间中计算。算法会给图片中每个像素分配一个权重——这个权重基于像素在图片中的出现频率和空间分布，高频出现且分布均匀的颜色权重更高。

量化完成后，得到一组候选色（通常是 8-16 个），进入评分和排序阶段。

## 颜色评分：不是最"多"的颜色赢

候选色的排序不是简单按频率来。Monet 的评分公式考虑三个维度：

1. **色度（Chroma）**——饱和度越高的颜色得分越高，鲜艳的颜色更有"主题感"
2. **亮度（Luminance）**——排除极亮和极暗的颜色，它们作为主题色不合适
3. **色调（Hue）**——对某些色调（如皮肤色范围）做降权处理，避免把肤色当主题色

具体的评分逻辑在 `ColorExtractor` 的实现中：

```java
float score = chroma * 0.5f + luminanceScore * 0.3f + hueScore * 0.2f;
if (isSkinTone(hue)) score *= 0.3f; // 肤色大幅降权
if (chroma < 15) score *= 0.5f;     // 低色度颜色不显眼
```

这个公式解释了为什么某些壁纸的取色会很怪：如果壁纸以浅灰和米白为主，色度普遍低于 15，评分会趋向平均，最终选出的"主色"可能和肉眼感知的完全不同。

排名第一的颜色成为 **Seed Color（种子色）**，这是整个调色板的起点。

## HCT：为什么不用 HSL

拿到种子色后，Monet 需要生成一套完整的色板——从浅到深共 13 个色阶，覆盖 Primary、Secondary、Tertiary、Neutral 四个系列。如果用传统的 HSL 模型，会遇到一个经典问题：**不同色调在 HSL 中的等亮度值，人眼感知的亮度差异巨大**。

试过在 HSL 里把纯黄（H=60, L=50）和纯蓝（H=240, L=50）放在一起吗？黄色亮得刺眼，蓝色几乎要消失。这是 HSL 的设计缺陷——它的亮度值不考虑人眼对不同波长的敏感度差异。

Material 3 引入的 **HCT（Hue, Chroma, Tone）** 色彩空间解决了这个问题：

- **H（Hue）**：沿用 CAM16 的色相定义，和 HSL 的 H 行为类似
- **C（Chroma）**：直接来自 CAM16 的色度，比 HSL 的 S（饱和度）更能准确反映颜色的鲜艳程度
- **T（Tone）**：Tone 基于 **CIELAB 的 L\*** 值，天然符合人眼的亮度感知曲线。**T=50 意味着无论什么色调，人眼感知的亮度完全一致**

在 HCT 空间中生成色板时，算法固定 Tone 值（比如 Primary 系列取 T=0, 10, 20, ..., 100），然后在种子色的 Hue 和 Chroma 附近进行插值。生成的 13 个色阶在视觉亮度上完全对齐，不会出现某个色阶"看起来偏亮"的问题。

Material 3 的色调调色板定义了 5 个色调层级：

```
Tone 0-10：Surface 深色背景用，接近纯黑
Tone 10-20：深色模式下的强调色
Tone 40-50：主色（Primary）的核心 Tonal Palette
Tone 80-90：浅色 Surface 上的点缀色
Tone 95-100：最亮色，用于 Surface 背景
```

## 从源色到完整色板的生成

种子色确定后，Monet 生成 13 阶色调调色板的流程大致如下：

```kotlin
fun generateTonalPalette(seedColor: Int): TonalPalette {
    val hct = Hct.fromInt(seedColor)
    val tones = listOf(0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100)
    val palette = tones.map { tone ->
        Hct.from(hct.hue, hct.chroma, tone.toDouble()).toInt()
    }
    return TonalPalette(palette)
}
```

注意这里 Chroma 的取值不是完全固定的——低色调和高色调阶段，Chroma 会受色域限制被压缩。例如纯黄色在 T=40 时 Chroma 可达 120，但到 T=90 时由于 sRGB 色域边界限制，Chroma 会自然降到 60 左右。HCT 库内部自动处理这个映射。

生成的 TonalPalette 会被赋值给 Material 3 的 6 个关键色角色：

| 角色 | 色调来源 | 用途 |
|------|---------|------|
| Primary | 种子色调板 T=40 | 主按钮、选中状态 |
| Primary Container | 种子色调板 T=90 | 主色容器背景 |
| Secondary | 种子色 ±30° 色相 | 次要元素 |
| Tertiary | 种子色 ±60° 色相 | 点缀强调 |
| Neutral | Chroma≈4 的灰色调板 | 背景、文字 |
| Error | 红色固定调板 | 错误状态 |

Secondary 和 Tertiary 的 ±30°、±60° 色相偏移是 Material 3 规格的硬性要求，和种子色本身的色调无关。这个设计保证了配色在色环上有足够的对比度。

## Compose 侧：MaterialTheme 如何消费动态颜色

取色和色板生成都在 SystemUI 进程中完成。三方应用拿到结果的路径是：

**SystemUI → WallpaperColors API → AndroidX Core → DynamicColors → Compose MaterialTheme**

`WallpaperColors` 是 AOSP 提供的公共 API，任何应用可以调用：

```kotlin
val colors = WallpaperManager.getInstance(context)
    .getWallpaperColors(WallpaperManager.FLAG_SYSTEM)
val primary = colors?.primaryColor?.toArgb()
```

`DynamicColors.applyToActivitiesIfAvailable()` 做了封装，把 WallpaperColors 注入到 Activity 的 Theme 中，覆盖 `colorPrimary` 等属性。在 Compose 场景，Google 进一步封装了 `dynamicLightColorScheme`：

```kotlin
MaterialTheme(
    colorScheme = if (Build.VERSION.SDK_INT >= 31) {
        dynamicLightColorScheme(LocalContext.current)
    } else {
        lightColorScheme()
    }
) {
    // 使用 MaterialTheme.colorScheme.primary 等即可
}
```

一个实现细节：**`dynamicLightColorScheme` 内部并不是直接读取 Monet 的 TonalPalette，而是读取 AndroidX 通过 `Resources.getColor` 注入的属性值**。也就是说，Compose 消费的已经是解析过的 ARGB 颜色值，不再保有 HCT 空间的色相和色调信息。

如果你需要在 Compose 中做进一步的色相旋转或色调调整（比如基于 Primary 生成更浅的衍生色），直接拿到的是 `Color` 对象，得手动转换回 HCT 才能操作。Material 3 的 Compose 库没有暴露这个能力。

## 暗色模式的色调映射策略

暗色模式下的动态配色不是简单取反色。Material 3 的策略是**色调（Tone）重新映射**：

- 亮色模式下 Primary 取 Tone=40（深色文字上的鲜艳色）
- 暗色模式下 Primary 取 Tone=80（深色背景上的明亮色）
- Surface 从 Tone=99（亮）降到 Tone=10（暗）

变换规则决定了 **Chroma 也会变**，因为在低 Tone 下，色域能容纳的 Chroma 更小。这解释了为什么同一张壁纸在暗色模式下颜色看起来更"柔和"——不是设计选择，是物理限制。

```kotlin
fun darkColorScheme(
    primary: Color,
    secondary: Color,
    tertiary: Color,
    // ...
): ColorScheme = lightColorScheme(
    primary = primary,
    // 实际 Tone 映射已经在 dynamicDarkColorScheme 中完成
)
```

实际项目中踩过的一个坑：自定义 Surface 颜色时直接用 `MaterialTheme.colorScheme.surface`，在暗色模式下获得了预期效果；但改了几次壁纸后，发现有些壁纸的暗色 Surface 偏蓝，有些偏灰。根因是 Neutral 色板的生成仍然会受到种子色的微弱影响，Chroma 不为 0。

解决方案：需要纯粹的暗色背景时，直接用 `Color(0xFF1C1B1F)` 而非走动态色板。

## 实践中的取舍

动态配色在实际项目中面临两个典型问题。

**品牌色冲突。**如果你的产品有固定的品牌色（比如某个特定的红色），Material 3 的 `OverrideColorScheme` 可以部分解决，但只覆盖 Primary 不够——Primary Container、Surface Variant 等衍生色如果和品牌色不协调，界面会显得混乱。我倾向于对品牌属性强的界面（首页、Logo 展示区）硬编码配色，通用页面走动态方案。

**色板质量不稳定。**种子色提取算法在低色度壁纸上表现不佳，选出的色板会缺乏层次感。Monet 的评分公式有一定容错性，但终究无法把一个没有色彩信息的图片变成好配色。如果检测到种子色的 Chroma 低于阈值（建议 15-20），退回到自定义的 fallback 色板是更可控的选择。

Material 3 的动态配色是一套设计成熟度很高的系统，从 CAM16 色度模型到 HCT 的亮度对齐，从量化算法到色相偏移策略，每个环节都有合理的设计决策。理解这些基层原理之后，哪些场景适合用它、哪些场景需要自己把控，心里就有数了。
