---
title: "Android TextView Internals: Text Measurement and Layout, Part 2"
lang: en
translationKey: android-textview-measure-layout-part2
slug: android-textview-measure-layout-part2
excerpt: "Part 2 explains BoringLayout, StaticLayout, and DynamicLayout, including when TextView and EditText use each implementation."
publishDate: '2025-05-18'
displayInBlog: false
tags:
- "Android"
- "TextView"
- "UI"
- "Custom View"
series:
  name: "Android TextView Internals: Text Measurement and Layout"
  part: 2
  total: 4
seo:
  title: "Android TextView Layout Classes: BoringLayout, StaticLayout, DynamicLayout"
  description: "Compare Android's key text Layout implementations and learn how TextView chooses between fast single-line, static multiline, and editable layouts."
  pageType: article
---
> This is part 2 of the four-part series "Android TextView Internals: Text Measurement and Layout." In the previous part, we covered the journey from characters to pixels.

## 4. The Three Major Layout Implementations

Inside TextView, `makeLayout()` tries to choose the most efficient Layout implementation for the current text. The usual selection order is `BoringLayout` first, then `StaticLayout`. `DynamicLayout` is mainly used by EditText.

### BoringLayout: A Simple and Fast Single-Line Layout

**When it applies:**

- The text is **single-line**.
- The text direction is pure **left-to-right (LTR)**, with no RTL characters or complex bidirectional text.
- The text has no `MetricAffectingSpan` that changes measurement, such as `RelativeSizeSpan` or `StyleSpan`. Non-metric spans such as `ForegroundColorSpan` are fine.

**Problem it solves:**

For simple text that meets those conditions, `BoringLayout` provides a highly optimized layout path. It avoids complex line-breaking and bidirectional text processing, so measurement and layout are very fast.

**How it works:**

The factory-style method `BoringLayout.isBoring(CharSequence text, TextPaint paint, BoringLayout.Metrics metrics)` checks whether the text qualifies as "boring." If it does, TextView can create a `BoringLayout`. Internally, the implementation is straightforward: measure the whole line width and store the single-line metrics.

**Advantages:**

- **Excellent performance**: minimal calculation overhead.

**Limitations:**

- **Limited capability**: only handles very simple single-line LTR text.

**Code example, used implicitly:**

You usually do not create `BoringLayout` yourself. When you set simple single-line text on a TextView, the framework can choose it automatically.

```xml
<TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:text="OK"
    android:singleLine="true" />
```

For the `"OK"` text above, TextView will likely use `BoringLayout` internally.

### StaticLayout: A Powerful Static Multiline Layout

**When it applies:**

- The text needs to display across **multiple lines**.
- The text content is relatively **stable** and does not change frequently.
- The text needs complex features such as:
  - right-to-left (RTL) and bidirectional (BiDi) text;
  - spans that change size, style, color, background, or insert images;
  - custom line-breaking and hyphenation strategies.

**Problem it solves:**

`StaticLayout` is Android's most common and most capable text layout engine. It handles most complex typography needs, including internationalized text and rich text.

**How it works:**

When a `StaticLayout` is created, it performs full text analysis and layout calculation. It:

1. uses `TextPaint` to measure character or glyph widths;
2. applies a line-breaking algorithm, usually a greedy strategy, to split text into lines for the given width;
3. applies the BiDi algorithm for RTL and mixed-direction text;
4. calculates each line's width, height, ascent/descent, and baseline;
5. processes spans in `Spanned` text.

Once a `StaticLayout` is created, its layout result is **immutable**. If the text or width changes, a new `StaticLayout` must be created.

**Advantages:**

- **Feature-rich**: supports multiline text, RTL, BiDi, spans, and other complex text behavior.
- **Good rendering performance**: after layout has been computed, `draw()` is relatively cheap because it uses precomputed layout data.

**Limitations:**

- **Creation cost**: creating a `StaticLayout` requires significant computation. Recreating it frequently can be expensive.
- **Immutable result**: not suitable for text that is edited or modified frequently.

**Code example, used implicitly:**

When TextView text wraps, contains RTL characters, or has complex spans, the framework automatically uses `StaticLayout`.

```xml
<TextView
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:text="This is a longer text that will likely wrap into multiple lines. It supports different styles like &lt;b&gt;bold&lt;/b&gt; and &lt;i&gt;italic&lt;/i&gt;, as well as RTL text like שלום (Shalom)." />
```

**Code example, explicit creation:**

TextView normally handles this for you, but you can create a `StaticLayout` manually when drawing text in a custom View.

```java
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.graphics.Canvas;

// Inside a custom View's onDraw.
@Override
protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);

    String myText = "Manually creating a StaticLayout example.";
    TextPaint textPaint = new TextPaint();
    textPaint.setAntiAlias(true);
    textPaint.setTextSize(50); // 50px
    textPaint.setColor(Color.BLACK);

    int availableWidth = getWidth() - getPaddingLeft() - getPaddingRight();

    // On Android Q (API 29) and later, StaticLayout.Builder is recommended.
    StaticLayout.Builder builder = StaticLayout.Builder.obtain(myText, 0, myText.length(), textPaint, availableWidth)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setLineSpacing(0f, 1.0f) // lineSpacingExtra, lineSpacingMultiplier
            .setIncludePad(true); // Corresponds to includeFontPadding.

    // Set additional properties as needed.
    // builder.setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY);
    // builder.setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NORMAL);

    StaticLayout staticLayout = builder.build();

    canvas.save();
    // Move the drawing origin to the top-left corner inside padding.
    canvas.translate(getPaddingLeft(), getPaddingTop());
    staticLayout.draw(canvas);
    canvas.restore();
}
```

### DynamicLayout: A Responsive Layout for Editable Text

**When it applies:**

- The text changes or is edited **frequently**, such as text inside an EditText.

**Problem it solves:**

EditText lets users type, delete, and modify text in real time. If every change recreated a full `StaticLayout`, the cost would be high and typing could become janky. `DynamicLayout` improves editing performance by **incrementally updating** layout data instead of recomputing everything from scratch.

**How it works:**

`DynamicLayout` extends `Layout`. Its core idea is to maintain internal data structures, such as text blocks and line information. When text changes, it recalculates only the affected portion, typically the line containing the edit and later lines that may be impacted, rather than the entire text. It also listens to changes in `Editable` text.

**Advantages:**

- **Good editing performance**: layout updates are efficient when text changes.
- **Full functionality**: supports most `StaticLayout` features, including multiline text, RTL, and spans.

**Limitations:**

- **Initial creation and drawing can be slightly slower**: its internal structure is more complex than `StaticLayout`, so one-time setup and drawing may cost a bit more.
- **Memory usage may be higher**: it keeps extra data structures to support dynamic updates.

**Code example, mainly used internally by EditText:**

You almost never need to create `DynamicLayout` by hand. When you use EditText, it uses `DynamicLayout` internally for text layout.

```xml
<EditText
    android:id="@+id/editText"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:hint="Enter text here" />
```

When the user types in this EditText, `DynamicLayout` works behind the scenes to update the text layout efficiently.

### Comparison: Which Layout Is Used When?

| **Feature** | **BoringLayout** | **StaticLayout** | **DynamicLayout** |
| --- | --- | --- | --- |
| **Main use case** | Simple single-line LTR text | Complex static multiline text | Editable text, especially EditText |
| **Line count** | Single line | Single or multiple lines | Single or multiple lines |
| **Text direction** | LTR only | LTR, RTL, and BiDi | LTR, RTL, and BiDi |
| **Spans** | Non-metric spans only | All span types | All span types |
| **Mutability** | Immutable | Immutable | Mutable, with incremental updates |
| **Creation performance** | Very fast | Slower, full calculation required | Slower, slightly more complex than StaticLayout |
| **Update performance** | N/A, immutable | N/A, recreate required | Fast incremental updates |
| **Widget usage** | TextView, selected automatically | TextView, selected automatically | EditText, used internally |
| **Primary problem solved** | Optimize simple text layout | Lay out complex static text | Optimize editable text layout |

**Selection strategy:**

- For TextView:
  - If the text is simple, single-line, and pure LTR, the system automatically chooses `BoringLayout` for best performance.
  - If the text is multiline, contains RTL/BiDi characters, or uses complex spans, the system automatically chooses `StaticLayout`.
- For EditText:
  - The system uses `DynamicLayout` to keep editing smooth.

Developers usually do not need to explicitly choose or create these Layout classes unless they are building a custom View or doing targeted performance work. Understanding the differences helps when you need to reason about TextView and EditText behavior.

---

> In the next part, we will look at line breaking, hyphenation, and alignment.

**Series Table of Contents**

1. Opening: The Journey from Characters to Pixels
2. **The Three Major Layout Implementations** (this article)
3. Line Breaking, Hyphenation, and Alignment
4. Handling Complex Text Scenarios
