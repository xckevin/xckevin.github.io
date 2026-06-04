---
title: "Android TextView Internals: Text Measurement and Layout, Part 3"
lang: en
translationKey: android-textview-measure-layout-part3
slug: android-textview-measure-layout-part3
excerpt: "Part 3 covers line breaking, hyphenation, alignment, font metrics, includeFontPadding, and elegantTextHeight in Android TextView."
publishDate: '2025-05-18'
displayInBlog: false
tags:
- "Android"
- "TextView"
- "UI"
- "Custom View"
series:
  name: "Android TextView Internals: Text Measurement and Layout"
  part: 3
  total: 4
seo:
  title: "Android TextView Line Breaking, Hyphenation, and Font Metrics"
  description: "Understand TextView line breaking, hyphenation, alignment, font metrics, includeFontPadding, and elegantTextHeight for precise layouts."
  pageType: article
---
> This is part 3 of the four-part series "Android TextView Internals: Text Measurement and Layout." In the previous part, we covered the three major Layout implementations.

## 5. Line Breaking, Hyphenation, and Alignment

One of the core capabilities of `StaticLayout` and `DynamicLayout` is handling line breaks.

### A Quick Look at Line-Breaking Algorithms

The simplest line-breaking algorithm is the **greedy algorithm**:

1. Start at the beginning of the current line and fit as many words as possible, usually split by spaces or punctuation.
2. Stop when the next word no longer fits within the available width.
3. Finalize the current line, then continue with the next word on the next line.

The greedy algorithm is simple and fast, and many text layout systems are built on top of it. But it does not always produce the best typography. One line may look too empty, or the last line may contain only a very short word. More advanced algorithms, such as the Knuth-Plass algorithm used by TeX, consider line breaks across the whole paragraph to produce more balanced and visually pleasing results, but they are more computationally expensive. Android's `StaticLayout` is mainly based on a greedy strategy, with configurable options to improve quality.

### Android Line-Breaking Strategy: android:breakStrategy

Android provides the `android:breakStrategy` attribute on API 23 and later. It lets developers tune line-breaking behavior and balance typography quality against performance.

- **simple**: the default on API 23-27. This is a basic, fast strategy, but it may not break CJK text or punctuation-heavy text as nicely.
- **high_quality**: the default on API 28 and later. It provides higher-quality line breaks, especially around punctuation and CJK characters, and is generally recommended. It does more work to find better break points.
- **balanced**: tries to keep line lengths as even as possible for a more balanced visual result. This usually costs more computation and is most appropriate for titles or short text blocks.

```xml
<TextView
    android:layout_width="200dp"
    android:layout_height="wrap_content"
    android:text="This text demonstrates different break strategies. High quality is often preferred."
    android:breakStrategy="high_quality" />
```

### Hyphenation: android:hyphenationFrequency

For Western languages, when a long word does not fit at the end of a line, the layout engine can split it with a hyphen (`-`) and continue it on the next line. Android controls this behavior with `android:hyphenationFrequency` on API 23 and later.

- **none**: do not hyphenate. If a word does not fit, move the entire word to the next line.
- **normal**: the default. Apply moderate hyphenation, balancing readability and space usage.
- **full**: apply more aggressive hyphenation to maximize space usage and produce a cleaner text edge.

```xml
<TextView
    android:layout_width="150dp"
    android:layout_height="wrap_content"
    android:text="Demonstrating hyphenation for long words like 'internationalization'."
    android:breakStrategy="high_quality"
    android:hyphenationFrequency="normal" />
```

Enabling `normal` or `full` hyphenation often improves Western text layout at narrow widths, but it can slightly increase layout time because the engine needs to consult hyphenation dictionaries.

**Note**: hyphenation requires the device to support hyphenation rules for the relevant language.

### Alignment: android:gravity or Layout.Alignment

Text alignment inside a TextView is controlled by `gravity` for horizontal alignment, or by `Layout.Alignment` when creating a Layout manually.

- `Gravity.LEFT` / `Alignment.ALIGN_NORMAL`: left-aligned in the default LTR context.
- `Gravity.RIGHT` / `Alignment.ALIGN_OPPOSITE`: right-aligned in the default RTL context.
- `Gravity.CENTER_HORIZONTAL` / `Alignment.ALIGN_CENTER`: centered horizontally.

TextView converts `gravity` into the corresponding `Layout.Alignment` and passes it to the Layout object.

## 6. Font Metrics and Vertical Spacing

Text is not only laid out horizontally. Vertical spacing matters just as much. Understanding font metrics is key to understanding line height and vertical alignment.

### Understanding Paint.FontMetrics

`android.graphics.Paint.FontMetrics` provides vertical metrics for a specific font and text size. You can obtain it with `paint.getFontMetrics()`.

- **baseline**: not a field on `FontMetrics`, but the baseline used to draw text. All other metrics are relative to it. Think of the line where the lowercase English letter `x` sits.
- **ascent**: the recommended distance from the baseline to the top of typical Western characters, usually a **negative** value. It accounts for most characters such as `h` and `l`, but may not include the highest accents or special characters.
- **descent**: the recommended distance from the baseline to the bottom of typical Western characters, usually a **positive** value. It accounts for descenders such as `g`, `p`, and `y`.
- **top**: the distance from the baseline to the **highest** pixel the font might draw, also **negative**, and `top <= ascent`. It includes all possible marks or glyphs, including rare very tall ones.
- **bottom**: the distance from the baseline to the **lowest** pixel the font might draw, **positive**, and `bottom >= descent`. It includes all marks or glyphs that may extend below the baseline.
- **leading**: the suggested extra space between the previous line's descent and the next line's ascent. This value is often 0.

![](../../assets/%E6%B7%B1%E5%85%A5%E6%B5%85%E5%87%BA-android-textview%E6%8F%AD%E7%A7%98%E6%96%87%E6%9C%AC%E6%B5%8B%E9%87%8F%E4%B8%8E%E5%B8%83%E5%B1%80%E7%9A%84%E8%89%BA%E6%9C%AF-1.webp)

*Illustration*: a horizontal line represents the baseline. Above the baseline are ascent and top, both negative. Below it are descent and bottom, both positive. The letters `jEh` demonstrate that the top of `h` is close to ascent and the bottom of `j` is close to descent. A very tall accented glyph may reach top, and a very low mark may reach bottom. Leading appears between two lines of text.

### Line Height Calculation: Default Behavior

By default, with `includeFontPadding=true` and `elegantTextHeight=false`, the basic height of a line in TextView is roughly determined by `descent - ascent`. In practice, the calculation is more nuanced so it can accommodate all possible glyphs, including the range covered by `top` and `bottom`, and keep spacing consistent across multiple lines.

### What includeFontPadding Does: android:includeFontPadding

This property, **true by default**, controls whether TextView includes extra space above ascent and below descent as defined by top and bottom.

- **includeFontPadding="true"**, the default:
  - the first line's top includes the extra space from `top - ascent`;
  - the last line's bottom includes the extra space from `bottom - descent`;
  - line spacing accounts for bottom and top, avoiding overlap even with very tall or very low glyphs;
  - **advantage**: accommodates all glyphs and avoids clipping in edge cases;
  - **drawback**: text may appear to have too much vertical padding, especially at the top and bottom, making precise visual alignment with other UI elements harder.
- **includeFontPadding="false"**:
  - line height is mainly based on ascent and descent;
  - the first line's top sits close to ascent, and the last line's bottom sits close to descent;
  - line spacing is also mainly based on ascent and descent;
  - **advantage**: the text bounds are closer to the visible glyphs, which makes pixel-level alignment with other elements easier;
  - **drawback**: if a font contains very tall or very low glyphs outside the ascent/descent range, those parts **may be clipped**.

**Recommendation**: if you need precise vertical alignment or the default top and bottom spacing looks too large, try `android:includeFontPadding="false"`. Test on multiple devices and fonts to make sure important glyphs are not clipped.

```xml
<LinearLayout
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:orientation="horizontal"
    android:background="#DDDDDD">

    <ImageView
        android:layout_width="48dp"
        android:layout_height="48dp"
        android:src="@drawable/ic_launcher_foreground"
        android:background="#AAAAAA"/>

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="48dp"
        android:text="Align Me (Padding True)"
        android:textSize="20sp"
        android:gravity="center_vertical"
        android:includeFontPadding="true"
        android:background="#EEEEEE"/>

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="48dp"
        android:text="Align Me (Padding False)"
        android:textSize="20sp"
        android:gravity="center_vertical"
        android:includeFontPadding="false"
        android:background="#DDDDDD"/>

</LinearLayout>
```

Run the example above with both TextViews using the same height and `center_vertical`. You will see that the baseline of the TextView with `includeFontPadding="false"` appears different from the one with `includeFontPadding="true"`. The latter often looks slightly lower because of the extra font padding.

### elegantTextHeight: Pursuing a More Refined Vertical Rhythm

This property, available on API 21 and later and **false by default**, provides another way to calculate line height. It aims for a more consistent and refined vertical rhythm, especially when text mixes scripts such as Latin, Devanagari, and Thai, or contains complex combining marks.

- **elegantTextHeight="false"**, the default: mainly uses ascent/descent as the baseline, and adds extra space through `includeFontPadding` when that property is true.
- **elegantTextHeight="true"**:
  - tends to use font metrics intended for "elegant" typography if the font supports them, or falls back to using top/bottom as the main basis for line height;
  - aims to provide more consistent line heights and baselines across languages and scripts, even when their ascent/descent values differ significantly;
  - usually **increases line height**, because it needs to accommodate the maximum vertical range of different scripts;
  - implies behavior similar to `includeFontPadding="true"` by always accounting for top and bottom.

**When to use it:**

- when you mix multiple scripts and want more harmonious line height and baseline alignment;
- when your font explicitly supports elegant-height metrics;
- when default line height looks inconsistent for certain languages or special characters.

**Note**: enabling `elegantTextHeight` can change the overall vertical size of the text, so test the layout impact carefully. It is not universally "better"; it depends on your design requirements and fonts.

```xml
<TextView
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:text="Text with default height.\nअगला पाठ (Hindi)"
    android:textSize="24sp" />

<TextView
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:text="Text with elegant height.\nअगला पाठ (Hindi)"
    android:textSize="24sp"
    android:elegantTextHeight="true"
    android:layout_marginTop="16dp"/>
```

Compare the two TextViews above. After enabling `elegantTextHeight`, you may notice a change in the vertical spacing between the English and Hindi lines, and in the overall height. The change usually helps accommodate the height of Hindi characters more comfortably.

---

> In the next part, we will look at complex text scenarios.

**Series Table of Contents**

1. Opening: The Journey from Characters to Pixels
2. The Three Major Layout Implementations
3. **Line Breaking, Hyphenation, and Alignment** (this article)
4. Handling Complex Text Scenarios
