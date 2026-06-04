---
title: "Android Material 3 Dynamic Color: Monet, HCT, and Compose Themes"
lang: en
translationKey: android-material3-dynamic-color-monet
slug: android-material3-dynamic-color-monet
excerpt: "A full tour of Material You dynamic color, from Monet's weighted K-Means color extraction and HCT tonal palettes to declarative consumption through Compose MaterialTheme."
publishDate: '2025-08-05'
tags:
- "Android"
- "Material Design"
- "Jetpack Compose"
- "Dynamic Color"
- "HCT Color Space"
seo:
  title: "Android Material 3 Dynamic Color: Monet, HCT, and Compose"
  description: "Understand Material You dynamic color from WallpaperManager and Monet quantization to HCT tonal palettes, Compose MaterialTheme, and dark-mode mapping."
  pageType: article
---

When Android 12 introduced Material You, I did what many Android engineers did: I changed wallpapers and watched the system UI color transition more than a dozen times. Within seconds, the lock screen, notification shade, and Settings app all shifted tone with the wallpaper, and the transition felt smooth. Later I started wondering: which pixels in the wallpaper decide the final palette? Why do some wallpapers produce harmonious schemes while others go badly wrong?

This article starts with the Monet color extraction algorithm and follows the path all the way to how Compose MaterialTheme consumes those colors.

## WallpaperManager and Monet: the entry point for extraction

The trigger for dynamic color is buried fairly deep. The system listens for wallpaper changes and passes the bitmap through `WallpaperManager` callbacks to the Monet engine running inside the SystemUI process. The entry point is in the `SystemUI` project, not in the third-party app API layer of AOSP.

```kotlin
// frameworks/base/packages/SystemUI/src/.../colors/ColorExtractor.kt
suspend fun extractColors(context: Context): Map<Int, Int> {
    val wallpaper = withContext(Dispatchers.IO) {
        WallpaperManager.getInstance(context).getBitmap()
    }
    return quantizeAndExtract(wallpaper)
}
```

The bitmap here is the original wallpaper, not a pre-scaled version. The core step is **color quantization**: compressing an image that may contain millions of colors into a few dozen representative colors.

Monet uses a **Wang-style K-Means variant**. Compared with standard K-Means, it calculates a **weighted color-distance metric** in Lab color space. Each pixel receives a weight based on how often it appears and how it is distributed spatially. Colors that appear frequently and are spread evenly across the image receive higher weights.

After quantization, Monet gets a set of candidate colors, usually 8-16 colors, and then moves into scoring and ranking.

## Color scoring: the most frequent color does not always win

Candidate colors are not sorted by frequency alone. Monet's scoring formula considers three dimensions:

1. **Chroma**: more saturated colors score higher and feel more theme-like
2. **Luminance**: extremely bright and extremely dark colors are filtered down because they are poor theme colors
3. **Hue**: some hue ranges, such as skin tones, are downweighted to avoid selecting skin as the theme color

The scoring logic in `ColorExtractor` looks roughly like this:

```java
float score = chroma * 0.5f + luminanceScore * 0.3f + hueScore * 0.2f;
if (isSkinTone(hue)) score *= 0.3f; // Heavily downweight skin tones
if (chroma < 15) score *= 0.5f;     // Low-chroma colors are less noticeable
```

This formula explains why extraction can look strange for some wallpapers. If a wallpaper is mostly light gray and off-white, most colors have chroma below 15. Scores become similar, and the final "primary" color may differ from what a human eye expects.

The top-ranked color becomes the **Seed Color**, the starting point for the entire palette.

## HCT: why not HSL

After Monet has a seed color, it needs to generate a complete palette: 13 tone levels from light to dark, across Primary, Secondary, Tertiary, and Neutral families. If it used the traditional HSL model, it would hit a classic problem: **equal lightness values in HSL can look wildly different to human eyes across hues**.

Try putting pure yellow (H=60, L=50) and pure blue (H=240, L=50) next to each other in HSL. Yellow looks painfully bright, while blue almost disappears. This is a flaw in HSL's design: its lightness value does not account for how human vision responds differently to different wavelengths.

Material 3 introduced the **HCT (Hue, Chroma, Tone)** color space to solve this:

- **H (Hue)**: uses CAM16's hue definition and behaves similarly to H in HSL
- **C (Chroma)**: comes directly from CAM16 chroma and better represents colorfulness than HSL saturation
- **T (Tone)**: based on **CIELAB L\***, naturally matching human brightness perception. **T=50 means the perceived brightness is consistent regardless of hue**

When generating a palette in HCT, the algorithm fixes Tone values, for example T=0, 10, 20, ..., 100 for the Primary family, then interpolates around the seed color's Hue and Chroma. The resulting 13 tones are visually aligned in brightness and do not have one tone level that "looks brighter" than the others.

Material 3's tonal palette defines five tone ranges:

```text
Tone 0-10: surface backgrounds in dark themes, close to black
Tone 10-20: accent colors in dark mode
Tone 40-50: the core Primary tonal palette
Tone 80-90: accent colors on light surfaces
Tone 95-100: the brightest colors for surface backgrounds
```

## Generating a full palette from the source color

After the seed color is chosen, Monet generates a 13-step tonal palette roughly like this:

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

Chroma is not completely fixed here. At very low and very high tone levels, Chroma is compressed by gamut limits. Pure yellow may reach a Chroma around 120 at T=40, but at T=90, the sRGB gamut boundary naturally pushes Chroma down to around 60. The HCT library handles this mapping internally.

The generated TonalPalette is assigned to six key Material 3 color roles:

| Role | Tone source | Use |
|------|-------------|-----|
| Primary | Seed palette T=40 | Primary buttons, selected states |
| Primary Container | Seed palette T=90 | Primary container backgrounds |
| Secondary | Seed hue +/-30 degrees | Secondary elements |
| Tertiary | Seed hue +/-60 degrees | Accent emphasis |
| Neutral | Gray palette with Chroma around 4 | Backgrounds, text |
| Error | Fixed red palette | Error states |

The +/-30 degree and +/-60 degree hue shifts for Secondary and Tertiary are hard requirements in the Material 3 spec. They do not depend on the seed hue itself. This design ensures enough contrast around the color wheel.

## Compose: how MaterialTheme consumes dynamic color

Color extraction and palette generation happen in the SystemUI process. Third-party apps receive the result through this path:

**SystemUI -> WallpaperColors API -> AndroidX Core -> DynamicColors -> Compose MaterialTheme**

`WallpaperColors` is a public AOSP API, so any app can call it:

```kotlin
val colors = WallpaperManager.getInstance(context)
    .getWallpaperColors(WallpaperManager.FLAG_SYSTEM)
val primary = colors?.primaryColor?.toArgb()
```

`DynamicColors.applyToActivitiesIfAvailable()` wraps this and injects WallpaperColors into the Activity theme, overriding attributes such as `colorPrimary`. For Compose, Google wraps it further with `dynamicLightColorScheme`:

```kotlin
MaterialTheme(
    colorScheme = if (Build.VERSION.SDK_INT >= 31) {
        dynamicLightColorScheme(LocalContext.current)
    } else {
        lightColorScheme()
    }
) {
    // Use MaterialTheme.colorScheme.primary and related roles
}
```

One implementation detail matters: **`dynamicLightColorScheme` does not directly read Monet's TonalPalette. It reads property values injected by AndroidX through `Resources.getColor`**. In other words, Compose receives resolved ARGB values and no longer has the original HCT hue and tone information.

If you need to rotate hue or adjust tone further inside Compose, for example to derive a lighter variant from Primary, the value you have is just a `Color` object. You need to convert it back into HCT manually. The Material 3 Compose library does not expose this capability.

## Dark-mode tone mapping

Dynamic color in dark mode is not simple color inversion. Material 3 uses **Tone remapping**:

- In light mode, Primary uses Tone=40, a vivid color on light backgrounds
- In dark mode, Primary uses Tone=80, a brighter color on dark backgrounds
- Surface moves from Tone=99 in light mode to Tone=10 in dark mode

These transformation rules also change **Chroma**, because low Tone values can hold less Chroma within the available gamut. This explains why the same wallpaper often looks more muted in dark mode. It is not just a design choice; it is a physical limitation of the color space and display gamut.

```kotlin
fun darkColorScheme(
    primary: Color,
    secondary: Color,
    tertiary: Color,
    // ...
): ColorScheme = lightColorScheme(
    primary = primary,
    // The real Tone mapping is already done inside dynamicDarkColorScheme
)
```

One practical pitfall: in one project, I used `MaterialTheme.colorScheme.surface` directly for custom Surface backgrounds. It behaved as expected in dark mode, but after changing wallpapers a few times, some dark surfaces looked slightly blue while others looked gray. The root cause was that Neutral palette generation is still weakly influenced by the seed color, so its Chroma is not zero.

The fix: when you need a purely dark background, use `Color(0xFF1C1B1F)` directly instead of going through the dynamic palette.

## Practical trade-offs

Dynamic color faces two common issues in real products.

**Brand color conflicts.** If your product has a fixed brand color, such as a specific red, Material 3's `OverrideColorScheme` can help only partially. Overriding Primary is not enough. If derived colors such as Primary Container and Surface Variant do not harmonize with the brand color, the UI becomes messy. I prefer hard-coded colors for strongly branded areas such as the home page and logo sections, while using dynamic color for generic screens.

**Palette quality is unstable.** Seed extraction performs poorly on low-chroma wallpapers, and the selected palette can lack depth. Monet's scoring formula has some tolerance, but it cannot turn an image with no useful color information into a good palette. If the seed color's Chroma is below a threshold, I recommend 15-20, falling back to a custom palette is more controllable.

Material 3 dynamic color is a mature design system. From the CAM16 chroma model to HCT brightness alignment, from quantization to hue-shift rules, each step has a defensible design decision behind it. Once you understand those foundations, it becomes much clearer where dynamic color fits and where your product should keep direct control.
