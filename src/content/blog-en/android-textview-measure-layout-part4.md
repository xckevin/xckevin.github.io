---
title: "Android TextView Internals: Complex Text Layout Scenarios, Part 4"
lang: en
translationKey: android-textview-measure-layout-part4
slug: android-textview-measure-layout-part4
excerpt: "Part 4 of the Android TextView measurement and layout series covers RTL/BiDi text, emoji, rich text spans, performance, and debugging."
publishDate: '2025-05-18'
tags:
- "Android"
- "TextView"
- "UI"
- "Custom View"
seo:
  title: "Android TextView Complex Layout: RTL, Emoji, Spans, and Performance"
  description: "Learn how Android TextView handles RTL and BiDi text, emoji, complex scripts, Spanned rich text, performance tuning, and debugging."
  pageType: article
---
> This is part 4 of the four-part series "Android TextView Internals: Text Measurement and Layout." In the previous part, we covered line breaking, hyphenation, and alignment.

## 7. Complex Scenario Handling

Modern apps often need to handle cases that are more complex than simple LTR text.

### RTL (Right-to-Left) Text Layout

Android provides strong support for RTL languages such as Arabic and Hebrew.

- **Automatic detection**: `TextView` and `Layout` can detect whether the text contains RTL characters.
- **BiDi algorithm**: When text mixes LTR and RTL characters, for example Arabic embedded in English, the system applies the Unicode Bidirectional Algorithm to determine the correct display order and direction for each text run. `StaticLayout` and `DynamicLayout` implement BiDi handling internally.
- **android:textDirection**: You can explicitly control the base text direction of a `TextView`, commonly with values such as `locale`, `ltr`, `rtl`, or `inherit`. For `Layout`, this affects how `Alignment.ALIGN_NORMAL` and `Alignment.ALIGN_OPPOSITE` behave. For example, `ALIGN_NORMAL` means right alignment in an RTL context.

![](../../assets/%E6%B7%B1%E5%85%A5%E6%B5%85%E5%87%BA-android-textview%E6%8F%AD%E7%A7%98%E6%96%87%E6%9C%AC%E6%B5%8B%E9%87%8F%E4%B8%8E%E5%B8%83%E5%B1%80%E7%9A%84%E8%89%BA%E6%9C%AF-2.webp)

*Figure*: A `TextView` containing mixed English and Arabic text, such as "This is an example with Arabic text." The text should be displayed according to correct BiDi rules: English runs left to right, Arabic runs right to left, while the overall logical order remains correct.

For developers, BiDi handling is usually transparent. The `Layout` classes are responsible for computing the correct glyph order and positions.

### Emoji and Special Characters

- **Emoji**: Emoji are Unicode characters. Modern Android versions and fonts usually include built-in emoji support.
  - **Measurement**: Emoji are often wider than regular characters, sometimes twice as wide. `Layout` accounts for their width during measurement and line breaking.
  - **Rendering**: The system uses color fonts, such as Noto Color Emoji, to render emoji.
  - **Line breaking**: Emoji are usually treated as a single unit and are not split in the middle.
- **Complex scripts**: For languages that require glyph composition or shaping, such as Arabic letter joining or Indic vowel composition, Android uses the **HarfBuzz** engine. This happens before `Layout` calculation: text is first shaped by HarfBuzz into the correct glyph sequence and positions, and then `Layout` uses that glyph information for line breaking and placement.

Developers usually do not need to intervene directly in emoji or complex script handling. Use recent Android versions and fonts that support these features.

### Rich Text (Spanned String)

`TextView` supports rich text through the `Spanned` interface, including different styles, colors, clickable links, and more. When calculating layout, the `Layout` classes recognize and process the different `Span` objects inside a `Spanned` string:

- **MetricAffectingSpan**: Examples include `StyleSpan` for bold or italic text, `RelativeSizeSpan`, and `TextAppearanceSpan`. These spans change text metrics such as width and height, so `Layout` must account for them during measurement and line breaking. `BoringLayout` does not support this kind of span.
- **CharacterStyle (non-metric)**: Examples include `ForegroundColorSpan`, `BackgroundColorSpan`, and `UnderlineSpan`. These spans only affect drawing, not text metrics, so `Layout` mainly applies them during the draw phase.
- **ParagraphStyle**: Examples include `AlignmentSpan`, `LineBackgroundSpan`, and `BulletSpan`. These spans affect the layout or drawing of an entire line or paragraph.

`StaticLayout` and `DynamicLayout` can correctly handle all span types.

```java
SpannableString spannable = new SpannableString("This text has bold, colored, and clickable parts.");

// Bold
spannable.setSpan(new StyleSpan(Typeface.BOLD), 15, 19, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
// Color
spannable.setSpan(new ForegroundColorSpan(Color.RED), 21, 28, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
// Clickable
ClickableSpan clickableSpan = new ClickableSpan() {
    @Override
    public void onClick(@NonNull View widget) {
        Toast.makeText(widget.getContext(), "Clicked!", Toast.LENGTH_SHORT).show();
    }
    @Override
    public void updateDrawState(@NonNull TextPaint ds) {
        super.updateDrawState(ds);
        ds.setUnderlineText(true); // Make clickable part underlined
        ds.setColor(Color.BLUE); // Make clickable part blue
    }
};
spannable.setSpan(clickableSpan, 34, 43, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);

TextView textView = findViewById(R.id.myTextView);
textView.setText(spannable);
// Important: MovementMethod must be set for ClickableSpan to respond to clicks.
textView.setMovementMethod(LinkMovementMethod.getInstance());
```

The `Layout` classes parse these spans, make sure bold text takes the correct width, draw colored text with the correct color, and provide positional information for `ClickableSpan` so touch events can be handled.

## 8. Performance Considerations and Optimization Tips

Although `TextView` is powerful, performance can become a bottleneck when it handles large amounts of text or frequent updates.

- **Avoid creating `Layout` or `Paint` objects inside `onDraw`**: Creating these objects has a cost. Create or update them during initialization or when text and properties change, then reuse them in `onDraw`. `TextView` already follows this principle internally.
- **StaticLayout vs DynamicLayout**:
  - For text that rarely changes, `StaticLayout` renders faster.
  - For editable text, such as `EditText`, `DynamicLayout` is required.
  - If your `TextView` content updates frequently but is not editable, each update recreates the `StaticLayout`, which can be expensive. Consider alternatives such as splitting long text with `RecyclerView`, or updating only changed parts. The latter is often difficult in practice.
- **Cache `Layout` objects**: If you manually create a `Layout` in a custom view and the text plus constraints do not change, cache the `Layout` object to avoid repeated calculation.
- **TextView optimization**:
  - **Reduce unnecessary `setText()` calls**: Call it only when the text has actually changed.
  - **Avoid excessive complex spans in lists**: Large numbers of complex spans increase layout and drawing cost.
  - **Consider `PrecomputedText` (API 28+)**: For long text that can be loaded on a background thread, use `PrecomputedText` to perform most text layout calculation off the main thread, then set the result on the `TextView` on the main thread to reduce UI jank.

```java
// On a background thread
TextView textView = findViewById(R.id.myTextView);
CharSequence longText = ... ;
PrecomputedText.Params params = textView.getTextMetricsParams();
Spannable newText = PrecomputedText.create(longText, params);

// Back on the main thread
textView.setText(newText);
```

- **Simplify surrounding layouts**: Overly complex `ConstraintLayout` graphs or deeply nested layouts increase overall measurement and layout time, indirectly affecting `TextView` display performance.

## 9. Debugging Tips

When a `TextView` does not render as expected, try the following debugging techniques:

- **Layout Inspector**: Android Studio's built-in tool lets you inspect the `TextView` bounds, padding, measured width and height, and text content.
- **Check attributes**: Carefully verify XML attributes or code-set values such as `textSize`, `textColor`, `lineSpacingExtra`, `includeFontPadding`, `breakStrategy`, `maxLines`, and `ellipsize`.
- **Print FontMetrics**: Get the `TextPaint` from the `TextView` and print `FontMetrics` to understand the current font metrics and baseline position.

```java
TextPaint paint = textView.getPaint();
Paint.FontMetrics fm = paint.getFontMetrics();
Log.d("FontMetrics", "top: " + fm.top + ", ascent: " + fm.ascent +
                   ", descent: " + fm.descent + ", bottom: " + fm.bottom +
                   ", leading: " + fm.leading);
```

- **Simplify the case**: Try simpler text, remove spans, use a standard font, remove line spacing, and narrow down which factor causes the issue.
- **Visualize bounds**: Temporarily set a highly visible background color on the `TextView`, or enable **Show layout bounds** in Developer Options to inspect the actual area occupied by the view.

## 10. Summary: Mastering TextView Layout

Text measurement and layout in `TextView` is a precise process involving many factors. Understanding the underlying mechanics, especially the roles and differences of the `Layout` classes (`BoringLayout`, `StaticLayout`, and `DynamicLayout`) and the impact of font metrics on vertical spacing, is essential for building high-quality, high-performance Android apps.

**Key takeaways:**

- `TextView.onMeasure` relies on `Layout` objects to calculate size.
- `BoringLayout` optimizes simple single-line LTR text.
- `StaticLayout` is the main implementation for complex static multiline text. It is feature-rich but has creation cost.
- `DynamicLayout` is used by `EditText` and supports efficient incremental updates.
- Line-breaking strategy (`breakStrategy`) and hyphenation (`hyphenationFrequency`) affect text flow.
- Font metrics (`top`, `ascent`, `descent`, `bottom`) determine vertical space.
- `includeFontPadding` and `elegantTextHeight` control how font metrics are used to calculate line height and spacing, affecting vertical alignment.
- The system automatically handles RTL/BiDi text, emoji, and complex scripts.
- `Spanned` text enables rich text rendering, with `Layout` handling the details.
- Performance optimization requires attention to layout choice, caching, and avoiding unnecessary computation.

After this deep dive, you should have a clearer and more complete understanding of how Android `TextView` measures and lays out text. The next time you tune `lineSpacingMultiplier`, handle multilingual alignment, or optimize list scrolling performance, you will have a much stronger mental model.

---

**"Android TextView Internals: Text Measurement and Layout" series**

1. Opening: the journey of text from characters to pixels
2. The three major `Layout` implementations
3. Line breaking, hyphenation, and alignment
4. **Complex scenario handling** (this article)
