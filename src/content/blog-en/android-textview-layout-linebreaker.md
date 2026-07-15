---
title: "Android Text Layout: StaticLayout, FontMetrics, and LineBreaker"
lang: en
translationKey: android-textview-layout-linebreaker
slug: android-textview-layout-linebreaker
excerpt: "Learn Android text layout internals, from StaticLayout and font metrics to LineBreaker strategies and custom View rendering."
publishDate: '2026-07-11'
tags:
- "Android"
- "TextView"
- "Typography"
- "Custom Views"
seo:
  title: "Android Text Layout: StaticLayout and LineBreaker"
  description: "Understand Android text measurement, layout, and line breaking with StaticLayout and LineBreaker."
  pageType: article
---

When doing text rendering for a custom View, I encountered a pitfall: I used `Canvas.drawText()` to draw multiple lines of text and manually calculated the line break positions. As a result, the line endings were uneven when Chinese and English were mixed, and additional processing was required for the `\n` line breaks. Later I realized that Android provides a complete text layout engine-**StaticLayout**, which is the core layout inside TextView.

To use StaticLayout well, you must first understand the working mechanism of the typesetting engine, the text measurement coordinate system, and the decision-making logic of the line breaking algorithm.

## Text layout engine: StaticLayout and DynamicLayout

Android's text layout is defined by the `android.text.Layout` abstract class, and the two core subclasses are `StaticLayout` and `DynamicLayout`. TextView automatically selects one of them based on whether the text will change.

The "Static" of `StaticLayout` does not mean that the text content is immutable, but that the layout cannot be modified after it is created. If the text changes, you have to create a new one. Its advantage is that it is fast: all measurements and line breaks are completed at once during creation, and subsequent `getLineStart()`, `getLineEnd()`, and `getLineBottom()` are all O(1) table lookups.

```java
// Simplified TextView internals
Layout layout;
if (text instanceof Spannable) {
    layout = new DynamicLayout(text, paint, width, alignment, spacingMult, spacingAdd, includepad);
} else {
    layout = new StaticLayout(text, paint, width, alignment, spacingMult, spacingAdd, includepad);
}
```

`DynamicLayout` supports incremental updates: when the content of a `Spannable` changes, only the affected area is recalculated, not the entire layout. The trade-off is that the text must be a `Spannable` or `Editable` instance.

`Layout` maintains a key structure internally: **line table**. Each line records the starting character offset, line width, and line height. Use `LineBreaker` to calculate the line break position when creating, then measure the width and height line by line, and finally determine the total height.

To render multi-line text in a custom View, directly using `StaticLayout` is the most worry-free solution:

```kotlin
val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
    .setLineSpacing(4f, 1.2f)  // extra spacing, multiplier
    .setIncludePad(true)
    .build()

// Iterate over lines directly when drawing.
for (i in 0 until layout.lineCount) {
    val lineStart = layout.getLineStart(i)
    val lineEnd = layout.getLineEnd(i)
    canvas.drawText(text, lineStart, lineEnd, x, layout.getLineBaseline(i), paint)
}
```

The two parameters of `setLineSpacing` correspond to `android:lineSpacingExtra` and `android:lineSpacingMultiplier`, and the final line height = original line height × multiplier + extra.

## FontMetrics: Coordinate system for text metrics

To understand layout calculations, you must first understand `FontMetrics` - it is Paint's metric description of fonts and defines a set of coordinate systems based on **baseline**.

```kotlin
val fm = paint.fontMetrics
// fm.top     → Maximum distance above the baseline (negative, for example -250.7)
// fm.ascent  → Recommended distance above the baseline (negative, for example -214.8)
// fm.descent → Recommended distance below the baseline (positive, for example 59.6)
// fm.bottom  → Maximum distance below the baseline (positive, for example 69.4)
// fm.leading → Extra line spacing (usually outside bottom - ascent)
```

The relationship between these values ​​is shown below (described in text):
```
  ─────── top (negative; highest extent)
  ─────── ascent (negative; recommended ascender extent)
  ═══════ baseline (0; baseline)
  ─────── descent (positive; recommended descender extent)
  ─────── bottom (positive; lowest extent)
```

Many people think that `textSize` is equal to `descent - ascent`, but it is not. `textSize` is the design size of the font, actual characters may exceed this range - letters with diacritics may extend beyond `ascent` into the `top` area. This is why the height returned by `getTextBounds()` is larger than `textSize`.

The difference between `Layout.getLineTop(i)` and `Layout.getLineBottom(i)` is the actual height of line i. `Layout.getLineBaseline(i)` returns the absolute position of the line's baseline in the layout, which is the y-coordinate of the `drawText` when drawn.

`setIncludePad(true)` will add `top - ascent` and `bottom - descent` extra space to the top of the first line and the bottom of the last line, in order to prevent the top characters from being clipped. If the top space of the text in the custom View is too large, just turn it off:

```kotlin
StaticLayout.Builder.obtain(...)
    .setIncludePad(false)  // Remove top and bottom padding.
    .build()
```

## LineBreaker: Analysis of line breaking algorithm

The most complex aspect of text formatting is line breaking - deciding where to break a line. Android introduced the `LineBreaker` class starting from Q (API 29), which supports three strategies:

| Strategy | Constants | Behavior |
|------|------|------|
| Simple line break | `BREAK_STRATEGY_SIMPLE` | Advance character by character and fall back to the previous line breakable position when the width is exceeded |
| High-quality line breaking | `BREAK_STRATEGY_HIGH_QUALITY` | Based on Unicode line breaking algorithm + language rules, automatically handles hyphens |
| Balanced line breaking | `BREAK_STRATEGY_BALANCED` | Based on high-quality line breaking, try to keep the width of each line as close as possible to avoid the last line being too short |

`StaticLayout.Builder` uses `BREAK_STRATEGY_SIMPLE` by default, which is also the default behavior of TextView. This is the reason why English words are cut off at the middle when Chinese and English are mixed. Switching to high-quality line breaks solves the problem:

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    StaticLayout.Builder.obtain(...)
        .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
        .build()
}
```

The core logic of line breaks is in `LineBreaker.computeLineBreaks()`: given text, width and Paint, it returns an `int[]` array, each element representing the end character position of a line. The general process of the algorithm:

1. Starting from the beginning of the current line, advance character by character
2. Measure the width of the accumulated text after each push
3. When the width exceeds the available width, fall back to the nearest breakable point (space, CJK character boundary, hyphen position, etc.)
4. Record the line break position and start the next line

**The particularity of CJK (Chinese, Japanese and Korean) text** is that each character itself is a breakable point. Therefore, words are rarely truncated in Chinese typesetting. But when there are no spaces in English, the `SIMPLE` strategy will directly truncate the word.

`BREAK_STRATEGY_HIGH_QUALITY` significantly improves English typesetting: it will break lines at word boundaries and use hyphens when necessary, and the effect is close to that of professional typesetting software. It is indeed more computationally expensive, but for text within a few hundred lines, the difference is negligible.

`BREAK_STRATEGY_BALANCED` goes a step further and distributes line breaks more evenly throughout the text. For example, in a 3-line English paragraph, the first two lines will not be full and the third line will only have two words. This strategy requires API 31+ to be supported in `TextView`.

## Line height calculation: from FontMetrics to Layout

When `Layout` calculates row height, it does not use `descent - ascent` directly, but uses `bottom - top`. Here is a detail:

```java
// Simplified internal Layout line-height calculation
int lineHeight = (int) Math.ceil(fm.bottom - fm.top);
```

If `setIncludePad(true)`, `fm.top - fm.ascent` will be added to the first line, and `fm.bottom - fm.descent` will be added to the last line.

Android P (API 28) introduced `setFallbackLineSpacing()` to handle the line height issue of **fallback font**. When a line of text contains characters that need to fall back to rendering in a different font (such as a line of Latin letters with an Emoji mixed in), the FontMetrics of different fonts can vary greatly. `setFallbackLineSpacing(true)` ensures that the line height is affected by the maximum fallback font measurement value to prevent text jumping caused by inconsistent line heights.

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    StaticLayout.Builder.obtain(...)
        .setFallbackLineSpacing(true)
        .build()
}
```

## Practice in customizing View

A typical onDraw implementation of a custom text rendering View:

```kotlin
override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val layout = buildLayout()
    for (i in 0 until layout.lineCount) {
        canvas.drawText(
            layout.text, layout.getLineStart(i), layout.getLineEnd(i),
            0f, layout.getLineBaseline(i), textPaint
        )
    }
}

private fun buildLayout(): StaticLayout {
    return StaticLayout.Builder.obtain(text, 0, text.length, textPaint, width.toFloat())
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
        .setFallbackLineSpacing(true)
        .build()
}
```

The above code has a performance problem: `buildLayout()` is called every time in `onDraw` to create a new `StaticLayout`. If the text is long, line break calculations become a burden every frame. The correct approach is to cache the Layout object and only rebuild it when the text or width changes.

Another easy pitfall is `Layout.getLineWidth(i)`: it returns the width of the line of plain text, **excluding the offset caused by alignment**. When centering or right-aligning, you need to use `getLineLeft(i)` or `getLineRight(i)` instead to get the actual drawing position.

The difference between `Layout.getLineLeft(i)` and `getLineRight(i)` is equal to the maximum width of the line, affected by `getLineMax(i)`. When doing requirements such as "text selection and highlighting", using these two values ​​​​to determine the boundary of the highlighted background is much more reliable than manual calculation.

##Finally

StaticLayout replaces manual typesetting, FontMetrics' baseline coordinate system, and the choice of line breaking strategy - these three form the basis of Android text typesetting. It is clear that the measurement of TextView, custom text rendering, and even typesetting issues in the rich text editor can all be understood from the same model.

The difference in `BreakStrategy` is not so obvious in the Chinese scenario, but when doing international applications, `HIGH_QUALITY` is almost a must. In terms of performance, unless each item in your list is rendering a large amount of text in real time, there is no need to worry about the creation overhead of `StaticLayout` - its calculation is completed at the Java layer, which is much faster than imagined.
