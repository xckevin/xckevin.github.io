---
title: "Android TextView Internals: Text Measurement and Layout, Part 1"
lang: en
translationKey: android-textview-measure-layout-part1
slug: android-textview-measure-layout-part1
excerpt: "Part 1 of the Android TextView measurement and layout series, covering the journey from characters to pixels and TextView's onMeasure pipeline."
publishDate: '2024-05-18'
displayInBlog: false
tags:
- "Android"
- "TextView"
- "UI"
- "Custom View"
series:
  name: "Android TextView Internals: Text Measurement and Layout"
  part: 1
  total: 4
seo:
  title: "Android TextView Measurement and Layout: From Characters to Pixels"
  description: "Learn how Android TextView turns characters into pixels, including the View measure-layout-draw pipeline and the role of Layout objects."
  pageType: article
---
> This is part 1 of the four-part series "Android TextView Internals: Text Measurement and Layout."

In Android app development, TextView is one of the most fundamental and most frequently used widgets. We use it every day to display all kinds of text, from simple button labels to complex rich-text paragraphs. But have you ever wondered how TextView turns a string into visible, neatly arranged text inside a limited rectangle? Behind that simple widget is a complex and precise measurement and layout system.

This series walks through TextView internals: how text measurement and layout work, when Android uses key Layout classes such as `BoringLayout`, `StaticLayout`, and `DynamicLayout`, how fonts and typography properties affect the result, how RTL text and emoji are handled, how line breaking works, and what font metrics really mean. The goal is to make TextView behavior easier to reason about when you run into real-world text rendering issues.

---

## 1. Opening: The Journey from Characters to Pixels

Imagine setting the text of a TextView to `"Hello, Android!"`. How does that simple string become what the user sees on screen?

At a high level, the process has several stages:

1. **Character processing**: the system receives the string.
2. **Measurement**: TextView calculates how much space it needs, based on the text, font, text size, available width, and other constraints.
3. **Layout**: TextView determines the exact position of every character, or more precisely every glyph, inside its drawing area, including line breaks and alignment.
4. **Drawing**: TextView uses the computed layout information and calls lower-level graphics libraries such as Skia to draw each glyph into screen pixels.

This article focuses on step 2, measurement, and step 3, layout.

## 2. Android View Rendering and TextView.onMeasure

In Android, every View follows the standard rendering pipeline: Measure -> Layout -> Draw.

- **Measure phase**: the parent passes a `MeasureSpec` to each child. The spec contains a size mode and size. The child computes its desired size from the spec and its own content, then stores the result with `setMeasuredDimension()`.
- **Layout phase**: the parent uses each child's measured size to calculate its exact bounds in the parent coordinate system: left, top, right, and bottom.
- **Draw phase**: each View draws its content into a Canvas using the position from the Layout phase and the dimensions from the Measure phase.

TextView is a View, so it follows the same flow. Its measurement logic is mainly implemented in `onMeasure(int widthMeasureSpec, int heightMeasureSpec)`.

`TextView.onMeasure()` is fairly involved. It must account for:

- **Text content**: text length and character types, such as English letters, CJK characters, emoji, and so on.
- **Text attributes**: font, `textSize`, bold or italic style, `lineSpacingExtra`, `lineSpacingMultiplier`, and more.
- **Layout constraints**: the maximum width and height provided by `MeasureSpec`.
- **Padding**: values from properties such as `android:padding`.
- **Other limits**: `maxLines`, `minLines`, `maxWidth`, `minWidth`, `maxHeight`, `minHeight`, and related constraints.

The core job of `onMeasure()` is to calculate the best width and height needed to contain the text. That calculation depends heavily on Android's internal text layout engine: the `Layout` class.

```java
// TextView.java (simplified sketch)
@Override
protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
    int widthMode = MeasureSpec.getMode(widthMeasureSpec);
    int heightMode = MeasureSpec.getMode(heightMeasureSpec);
    int widthSize = MeasureSpec.getSize(widthMeasureSpec);
    int heightSize = MeasureSpec.getSize(heightMeasureSpec);

    int width;
    int height;

    // ... many checks and preprocessing steps omitted

    // Key step: create or retrieve a Layout object to compute text dimensions.
    // availableWidth subtracts left and right padding.
    int availableWidth = (widthMode == MeasureSpec.EXACTLY) ? widthSize : Integer.MAX_VALUE;
    availableWidth -= getCompoundPaddingLeft() + getCompoundPaddingRight();

    // Choose the appropriate Layout implementation based on text and width.
    Layout localLayout = makeLayout(availableWidth); // A core method.

    // Compute the required height from the Layout.
    if (heightMode == MeasureSpec.EXACTLY) {
        height = heightSize;
        // A fixed height may require ellipsize handling.
    } else {
        // Use the Layout's actual text height.
        int desiredHeight = getDesiredHeight(localLayout);
        height = desiredHeight;
        if (heightMode == MeasureSpec.AT_MOST) {
            height = Math.min(desiredHeight, heightSize);
        }
    }

    // Compute the required width from the Layout, typically for AT_MOST or UNSPECIFIED.
    if (widthMode == MeasureSpec.EXACTLY) {
        width = widthSize;
    } else {
        // Use the Layout's actual text width.
        int desiredWidth = getDesiredWidth(localLayout);
        width = desiredWidth;
        if (widthMode == MeasureSpec.AT_MOST) {
            width = Math.min(desiredWidth, widthSize);
        }
    }

    // Add padding.
    width += getCompoundPaddingLeft() + getCompoundPaddingRight();
    height += getCompoundPaddingTop() + getCompoundPaddingBottom();

    // ... apply min/max width and height constraints

    // Store the measured result.
    setMeasuredDimension(width, height);
}

// Get the height computed by Layout (simplified).
private int getDesiredHeight(Layout layout) {
    if (layout == null) {
        return 0;
    }
    int lineCount = layout.getLineCount();
    // Account for maxLines and related constraints.
    // ...
    return layout.getHeight(); // Layout directly exposes its height.
}

// Get the width computed by Layout (simplified).
private int getDesiredWidth(Layout layout) {
    if (layout == null) {
        return 0;
    }
    // For multiline text, TextView usually uses the widest line.
    float maxWidth = 0;
    for (int i = 0; i < layout.getLineCount(); i++) {
        maxWidth = Math.max(maxWidth, layout.getLineWidth(i));
    }
    return (int) Math.ceil(maxWidth);
}
```

This simplified `onMeasure()` flow shows that TextView delegates the actual text size calculation to a `Layout` object. The `makeLayout()` method creates the right `Layout` implementation for the current situation.

## 3. The Core Engine: Layout and Its Responsibilities

`android.text.Layout` is an abstract class and the foundation of Android's text layout system. It defines the core APIs and behavior required to lay out a formatted `CharSequence`.

Its main responsibilities are:

1. **Line breaking**: decide where the text should wrap for a given width.
2. **Glyph positioning**: calculate the precise X and Y coordinates for glyphs on each line.
3. **Size calculation**: provide the total width and height of the text block, plus per-line width, height, baseline, and related metrics.
4. **Text queries**: map coordinates to character offsets, and map character offsets back to coordinates.
5. **Drawing**: expose a `draw()` method that renders the laid-out text into a Canvas.

In `TextView.onDraw()`, TextView eventually calls `draw()` on its Layout object to render the text.

```java
// TextView.java (simplified sketch)
@Override
protected void onDraw(Canvas canvas) {
    super.onDraw(canvas); // Draw background, drawables, and so on.

    // ... save and restore Canvas state, handle offsets, and more

    if (mLayout != null) {
        // Delegate text drawing to the Layout object.
        mLayout.draw(canvas, mHighlightPath, mHighlightPaint, mCursorOffsetVertical);
    }
}
```

Android provides several concrete `Layout` implementations for different situations. The most common ones are `BoringLayout`, `StaticLayout`, and `DynamicLayout`.

---

> In the next part, we will look at the three major Layout implementations in detail.

**Series Table of Contents**

1. **Opening: The Journey from Characters to Pixels** (this article)
2. The Three Major Layout Implementations
3. Line Breaking, Hyphenation, and Alignment
4. Handling Complex Text Scenarios
