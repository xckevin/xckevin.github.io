---
title: "Android Spannable Internals: From Spanned to Canvas Rendering"
lang: en
translationKey: android-spannable-rich-text-rendering
slug: android-spannable-rich-text-rendering
excerpt: "An end-to-end walkthrough of Android's rich text engine — markup storage, span callback layers, TextLine Canvas dispatch, custom ReplacementSpan and ParagraphStyle, and Compose AnnotatedString."
publishDate: '2026-06-16'
tags:
- "Android"
- "Spannable"
- "RichText"
- "Canvas"
- "CustomView"
seo:
  title: "Android Spannable Internals: From Spanned to Canvas Rendering"
  description: "Android rich text internals: Spanned storage, SpannableStringBuilder, TextLine Canvas dispatch, custom spans, and Compose evolution."
  pageType: article
---

## Behind Three Lines of Code

```kotlin
val text = SpannableStringBuilder("Android rich text")
text.setSpan(ForegroundColorSpan(Color.RED), 0, 7, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
textView.text = text
```

Three lines, and "Android" turns red. It is simple enough to hide an entire pipeline: a span object is stored on the string, retrieved at the measure and draw stages, and finally switches color on a Canvas. This mechanism has run for over a decade and powers almost every Android rich-text scenario, from Markdown rendering to syntax highlighting.

I originally went deep on this system because I needed a text component with a custom underline. Android's built-in `UnderlineSpan` hugs the text too tightly and looks bad. Most solutions online draw lines manually in `onDraw`, with inaccurate positions and mismatched line heights. That pushed me to understand the full path from markup to rendering.

## Spanned: The Data Contract of the Markup System

The core of Android rich text is the **separation of markup and text storage**, realized through four interfaces:

- **Spanned**: a read-only "text + markup" container defining query capability.
- **Spannable**: a mutable markup container exposing `setSpan` / `removeSpan`.
- **SpannedString**: an immutable implementation with no extra memory overhead.
- **SpannableStringBuilder**: a mutable implementation where both markup and text can change dynamically.

The core design lives in three method signatures on Spanned:

```java
public interface Spanned extends CharSequence {
    <T> T[] getSpans(int start, int end, Class<T> type);
    int getSpanStart(Object tag);
    int getSpanEnd(Object tag);
    int getSpanFlags(Object tag);
    int SPAN_PRIORITY_SHIFT = 16;
}
```

Two details in `getSpans()` are worth noting. First, `start` and `end` bound the query — when TextView draws the third character, it only retrieves spans covering that position, not all markup. Second, returning `T[]` enables type filtering, so one call fetches every `ForegroundColorSpan`.

`spanFlags` is a bitmask. The low 16 bits control boundary behavior, and the high 16 bits (after a right shift via `SPAN_PRIORITY_SHIFT`) encode priority. When new characters are inserted, the system consults flags to decide whether spans at that position should expand to cover them:

```java
SPAN_EXCLUSIVE_EXCLUSIVE   // new chars do not inherit the span
SPAN_INCLUSIVE_INCLUSIVE   // new chars inherit the span
SPAN_EXCLUSIVE_INCLUSIVE   // only the trailing side includes
SPAN_INCLUSIVE_EXCLUSIVE   // only the leading side includes
```

I hit a pitfall while debugging a rich-text editor: using `SPAN_EXCLUSIVE_INCLUSIVE` and inserting at the end, the new character did not inherit the bold style. The reason: when inserting at a position where the span's end equals the insertion point, EXCLUSIVE means that position is outside the interval, so it is not covered. Switching uniformly to `INCLUSIVE_EXCLUSIVE` fixed style inheritance at the cursor — subsequent input inherits the current style, while previous characters are unaffected.

## SpannableStringBuilder: Internal Markup Storage

SpannableStringBuilder manages markup with three arrays: two `int[]` recording each span's start and end, and one `Object[]` holding the span instances. When text is inserted or deleted, the system walks every span and uses flags to decide whether to move its position:

```java
// Simplified replace logic from the source
void replace(int start, int end, CharSequence tb) {
    int change = tb.length() - (end - start);
    for (int i = 0; i < mSpanCount; i++) {
        if (mSpanStarts[i] > end) {
            mSpanStarts[i] += change;           // span after the region shifts
        } else if (mSpanStarts[i] >= start) {
            boolean flag = (mSpanFlags[i] & SPAN_PARAGRAPH) != 0;
            if (flag) mSpanStarts[i] = start;   // span inside the region handled by rule
        }
        // similar logic for end positions...
    }
}
```

Every text change is an O(n) walk over all spans. Under 100 spans this is fine, but if you stack hundreds of spans on a single string inside a RecyclerView item and call `setSpan` repeatedly, TextView's `onMeasure` will stall noticeably.

In practice, build with `SpannableStringBuilder` first, then convert to `SpannedString` before handing it to TextView. The immutable implementation skips all change-listener logic, so subsequent measurement is clean.

## The Span Callback Hierarchy

Android divides spans into clear callback layers, each determining when the framework calls back into you:

| Interface | Callback timing | Typical implementation |
|-----------|-----------------|------------------------|
| UpdateAppearance | During draw | ForegroundColorSpan, UnderlineSpan |
| UpdateLayout | Triggers re-layout during measure | AbsoluteSizeSpan, StyleSpan |
| MetricAffectingSpan | Text-metric stage | Spans affecting line height |
| ParagraphStyle | Paragraph-level drawing | AlignmentSpan, LeadingMarginSpan |
| CharacterStyle | Character-level property modification | Modifies TextPaint via updateDrawState |
| ReplacementSpan | Takes over drawing entirely | Inline images, custom shapes |

The practical meaning of this layering: it determines when you need a **re-measure** (`requestLayout`) versus a **re-draw** (`invalidate`). Setting a color span only needs `invalidate`; setting a size span needs `requestLayout` — a size change can shift wrapping points.

In day-to-day work I prefer inheriting directly from `CharacterStyle` or `ReplacementSpan`, whose lifecycles are the most controllable. The lower-level the interface, the lower the probability of bugs — a lesson earned after several infinite-layout loops triggered by `UpdateLayout`.

## TextLine's Draw Dispatch

TextView's draw path:

```
TextView.onDraw()
  → Layout.draw(Canvas)
    → TextLine.draw(Canvas, TextPaint, int, ...)
```

TextLine is the real render scheduler. Inside `draw()`, it splits text by run, sorts spans within each run by priority, and calls back one by one:

```java
// TextLine internal logic, simplified
void draw(Canvas c, float x, int offset) {
    for (int i = 0; i < runs.length; i++) {
        TextPaint wp = mWorkPaint;
        wp.set(mPaint);                          // reset base paint

        CharacterStyle[] styles = mCharacterStyles[i];
        for (CharacterStyle style : styles) {
            style.updateDrawState(wp);           // modify paint properties
        }
        c.drawText(mText, runStart, runEnd, x, y, wp);
    }
    // ReplacementSpans drawn separately afterward
    for (ReplacementSpan span : mReplacementSpans) {
        span.draw(c, mText, start, end, x, top, y, bottom, mPaint);
    }
}
```

`CharacterStyle.updateDrawState()` receives a shared `mWorkPaint`. You modify its color, typeface, underline, and TextLine reuses that paint for `drawText()`. The pattern is **modify the paint, do not draw directly** — one `mWorkPaint` is reused repeatedly, avoiding frequent Paint allocation.

`ReplacementSpan` takes a different path: it fully takes over measurement and drawing for its range. The framework calls `getSize()` for the width, then calls `draw()` to let you paint on the Canvas yourself.

## Two Common Custom-Span Scenarios

**Scenario 1: Rounded background tag (ReplacementSpan)**

```kotlin
class RoundedBackgroundSpan(
    private val bgColor: Int,
    private val textColor: Int,
    private val radius: Float
) : ReplacementSpan() {

    override fun getSize(
        paint: Paint, text: CharSequence?, start: Int, end: Int,
        fm: Paint.FontMetricsInt?
    ): Int = (paint.measureText(text, start, end) + radius * 4).toInt()

    override fun draw(
        canvas: Canvas, text: CharSequence?, start: Int, end: Int,
        x: Float, top: Int, y: Int, bottom: Int, paint: Paint
    ) {
        val width = paint.measureText(text, start, end)
        val rect = RectF(x + 2, top.toFloat() + 2,
                         x + width + radius * 2, bottom.toFloat() - 2)
        with(paint) {
            color = bgColor
            canvas.drawRoundRect(rect, radius, radius, this)
            color = textColor
            canvas.drawText(text!!, start, end, x + radius, y.toFloat(), this)
        }
    }
}
```

The cost of `ReplacementSpan` is that it takes over the entire draw of that text range. You can no longer layer underline or strikethrough effects on top — you have seized the Canvas for that text. If you need to combine effects, draw them manually inside `draw()`.

**Scenario 2: Block-quote vertical bar (ParagraphStyle)**

```kotlin
class BlockQuoteSpan(
    private val quoteColor: Int,
    private val quoteWidth: Int = 6
) : LeadingMarginSpan {

    override fun getLeadingMargin(first: Boolean): Int = quoteWidth + 16

    override fun drawLeadingMargin(
        canvas: Canvas, paint: Paint, x: Int, dir: Int,
        top: Int, baseline: Int, bottom: Int,
        text: CharSequence?, start: Int, end: Int,
        first: Boolean, layout: Layout?
    ) {
        paint.color = quoteColor
        val left = if (dir > 0) x.toFloat() else (x + dir * quoteWidth).toFloat()
        canvas.drawRect(left, top.toFloat(),
                        left + quoteWidth, bottom.toFloat(), paint)
    }
}
```

The `first` parameter of `drawLeadingMargin()` indicates whether the current line is the first of a paragraph, and it is easy to get wrong. If you want the vertical bar on every line, you must draw even when `first` is false — many online examples handle only the first line.

## Async Measurement: Do Not Bypass Spans

When pre-measuring text height in a RecyclerView, a common shortcut is to new up a Paint and call `measureText`:

```kotlin
// Wrong — drops the metric effect of spans
val paint = Paint().apply { textSize = 48f }
val width = paint.measureText(spannableText.toString())
```

`measureText(String)` bypasses Spanned's span callbacks, so an `AbsoluteSizeSpan`'s size change never takes effect. The correct approach pairs a `TextPaint` with `Layout.getDesiredWidth()`:

```kotlin
val textPaint = TextPaint().apply { textSize = 48f }
val width = Layout.getDesiredWidth(spannableText, textPaint)
```

`getDesiredWidth()` internally builds a StaticLayout, walks every `MetricAffectingSpan`, and returns the real measured width. The cost is roughly an order of magnitude slower than `measureText`, so cache the result in lists. I use an LruCache keyed by text-content hash and cut list-item pre-measure from 8ms to 0.3ms.

## Compose AnnotatedString: The Other Side of the Coin

Jetpack Compose's `AnnotatedString` does essentially the same thing as Spannable: separate text and markup. But the API design shows clear evolution:

```kotlin
val text = buildAnnotatedString {
    withStyle(SpanStyle(color = Color.Red, fontWeight = FontWeight.Bold)) {
        append("Android")
    }
    append(" rich text")
}
```

It unifies classification with `SpanStyle` (character level) and `ParagraphStyle` (paragraph level), and no longer distinguishes `UpdateAppearance` from `UpdateLayout` — Compose's render pipeline re-measures on recomposition anyway, so the span layer does not need to signal it.

The `buildAnnotatedString` DSL makes span scope natural. With `SpannableStringBuilder.setSpan(start, end)`, offsets drift error-prone after repeated edits; the DSL's nested structure expresses scope directly.

`AnnotatedString` is immutable by default. Mutable text is handled separately by `TextFieldValue`'s composition/commit mechanism, decoupled from the span layer.

Compose still bridges to the legacy View system via `AndroidView`, so Spannable is not disappearing soon. But in pure Compose projects I prefer `AnnotatedString` + `ClickableText`, sidestepping the cognitive overhead of Spannable's flag system. The two APIs interconvert via `AnnotatedString.toSpannedString()` and `Spannable.toAnnotatedString()`, and the bridge does nothing extraneous.

## Practical Rules

**Climb the base class ladder**: if `CharacterStyle` suffices, do not inherit `ReplacementSpan`; if `ReplacementSpan` suffices, do not inherit `DynamicDrawableSpan`. Each step down doubles the details you must handle.

**Debugging "span does not apply"**: first confirm whether the issue is measure or draw. Log inside `updateDrawState()` and `updateMeasureState()`. The former affects only drawing; the latter affects layout. If you changed `textSize` in `updateMeasureState()` but it did not take effect, check whether you called `setText(CharSequence)` instead of `setText(Spannable)` — only the latter triggers a re-measure.

**Control span count**: keep spans on a single string under 200. Above that, reach for WebView or a custom View. Syntax highlighting is the easiest offender — a 500-line file with keyword, string, and comment spans easily exceeds 300.

**Freeze after building**: after constructing with `SpannableStringBuilder`, convert to `SpannedString` before use. This prevents accidental later edits from triggering cascading layout requests. This one habit has solved many mysterious RecyclerView item-jank issues during recycling.
