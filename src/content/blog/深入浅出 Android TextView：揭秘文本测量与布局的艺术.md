---
title: 深入浅出 Android TextView：揭秘文本测量与布局的艺术
excerpt: 在 Android 应用开发中，TextView 是最基础也是最常用的控件之一。我们每天都在用它来显示各种文本信息，从简单的按钮标签到复杂的富文本段落。但你是否曾好奇：TextView 是如何在有限的空间内，将一串字符精确地转换成屏幕上可见的、排列整齐的文字？这背后涉及一套复杂而精密的测量（Measure）与布局（Layout）机制。
publishDate: 2025-02-24
tags:
  - Android
  - TextView
  - UI
  - 自定义View
seo:
  title: 深入浅出 Android TextView：揭秘文本测量与布局的艺术
  description: 深入浅出 Android TextView：揭秘文本测量与布局的艺术：全面解析 TextView 的测量与排版细节，提供实用的性能与排版优化技巧。
---
# 深入浅出 Android TextView：揭秘文本测量与布局的艺术

在 Android 应用开发中，TextView 是最基础也是最常用的控件之一。我们每天都在用它来显示各种文本信息，从简单的按钮标签到复杂的富文本段落。但你是否曾好奇：TextView 是如何在有限的空间内，将一串字符精确地转换成屏幕上可见的、排列整齐的文字？这背后涉及一套复杂而精密的测量（Measure）与布局（Layout）机制。

本文将带你深入 TextView 的内部世界，系统性地探讨其文本测量和布局的工作原理、关键的 Layout 类（BoringLayout、StaticLayout、DynamicLayout）及其适用场景、字体和排版属性的影响、RTL 和 Emoji 等特殊情况的处理、换行策略，以及 Font Metrics 等底层概念。希望能帮助你更深刻地理解 TextView，并在实际开发中游刃有余地处理各种文本显示问题。

---

## 1. 开篇：文字的旅程 —— 从字符到像素

想象一下，你给 TextView 设置了一段文字 "Hello, Android!"。这个简单的字符串是如何变成屏幕上用户看到的样子的？

这个过程大致可以分为几个阶段：

1. **字符处理**：系统接收到字符串；
2. **测量（Measure）**：TextView 根据文本内容、字体、字号、可用空间等因素，计算自己需要占据多大的空间（宽度和高度）；
3. **布局（Layout）**：TextView 确定每个字符（或更准确地说，字形 Glyph）在自身绘制区域内的具体位置，包括如何断行、对齐等；
4. **绘制（Draw）**：TextView 使用计算好的布局信息，调用底层的图形库（如 Skia），将每个字形绘制到屏幕对应的像素上。

本文的核心，就是深入探讨第 2 步（测量）和第 3 步（布局）的过程。

## 2. Android 视图绘制流程与 TextView 的 onMeasure

在 Android 中，所有视图（View）的显示都遵循一个标准的绘制流程，主要包含三个阶段：Measure → Layout → Draw。

- **Measure 阶段**：父视图向子视图传递 MeasureSpec（包含尺寸模式和大小），子视图根据 MeasureSpec 和自身内容计算出期望的尺寸，并通过 `setMeasuredDimension()` 方法保存结果；
- **Layout 阶段**：父视图根据 Measure 阶段确定的子视图尺寸，计算并确定每个子视图在父视图坐标系中的具体位置（左、上、右、下边界）；
- **Draw 阶段**：每个视图根据 Layout 阶段确定的位置和 Measure 阶段确定的尺寸，将自己的内容绘制到 Canvas 上。

TextView 作为一个 View，自然也遵循这个流程。其测量逻辑主要在 `onMeasure(int widthMeasureSpec, int heightMeasureSpec)` 方法中实现。

TextView 的 onMeasure 方法是一个相当复杂的过程，它需要考虑：

- **文本内容**：文本的长度、字符类型（英文、中文、Emoji 等）；
- **文本属性**：字体、字号（textSize）、样式（粗体、斜体）、行间距（lineSpacingExtra、lineSpacingMultiplier）等；
- **布局约束**：MeasureSpec 提供的最大可用宽度和高度；
- **内边距（Padding）**：`android:padding` 属性；
- **其他限制**：如 maxLines、minLines、maxWidth、minWidth、maxHeight、minHeight 等。

onMeasure 的核心任务是计算出容纳文本所需的**最佳宽度和高度**。这个计算过程严重依赖于一个内部的文本布局引擎，这就是我们接下来要讲的 Layout 类。

```java
// TextView.java (简化示意)
@Override
protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
    int widthMode = MeasureSpec.getMode(widthMeasureSpec);
    int heightMode = MeasureSpec.getMode(heightMeasureSpec);
    int widthSize = MeasureSpec.getSize(widthMeasureSpec);
    int heightSize = MeasureSpec.getSize(heightMeasureSpec);

    int width;
    int height;

    // ... (省略大量判断和预处理)

    // 关键：创建或获取 Layout 对象来计算文本尺寸
    // availableWidth 会减去左右 padding
    int availableWidth = (widthMode == MeasureSpec.EXACTLY) ? widthSize : Integer.MAX_VALUE;
    availableWidth -= getCompoundPaddingLeft() + getCompoundPaddingRight();

    // 根据文本内容、宽度等条件，决定使用哪种 Layout
    Layout localLayout = makeLayout(availableWidth); // 这是一个核心方法

    // 根据 Layout 计算所需高度
    if (heightMode == MeasureSpec.EXACTLY) {
        height = heightSize;
        // 如果高度固定，可能需要处理 ellipsize
    } else {
        // 使用 Layout 计算文本实际高度
        int desiredHeight = getDesiredHeight(localLayout);
        height = desiredHeight;
        if (heightMode == MeasureSpec.AT_MOST) {
            height = Math.min(desiredHeight, heightSize);
        }
    }

    // 根据 Layout 计算所需宽度 (通常在 AT_MOST 或 UNSPECIFIED 模式下)
    if (widthMode == MeasureSpec.EXACTLY) {
        width = widthSize;
    } else {
        // 使用 Layout 计算文本实际宽度
        int desiredWidth = getDesiredWidth(localLayout);
        width = desiredWidth;
        if (widthMode == MeasureSpec.AT_MOST) {
            width = Math.min(desiredWidth, widthSize);
        }
    }

    // 加上 Padding
    width += getCompoundPaddingLeft() + getCompoundPaddingRight();
    height += getCompoundPaddingTop() + getCompoundPaddingBottom();

    // ... (处理 min/max 宽高限制)

    // 保存测量结果
    setMeasuredDimension(width, height);
}

// 获取 Layout 计算的高度 (简化)
private int getDesiredHeight(Layout layout) {
    if (layout == null) {
        return 0;
    }
    int lineCount = layout.getLineCount();
    // 考虑 maxLines 等
    // ...
    return layout.getHeight(); // Layout 对象直接提供了高度
}

// 获取 Layout 计算的宽度 (简化)
private int getDesiredWidth(Layout layout) {
    if (layout == null) {
        return 0;
    }
    // 对于多行文本，通常取最宽行的宽度
    float maxWidth = 0;
    for (int i = 0; i < layout.getLineCount(); i++) {
        maxWidth = Math.max(maxWidth, layout.getLineWidth(i));
    }
    return (int) Math.ceil(maxWidth);
}
```

从 onMeasure 的简化逻辑可以看出，TextView 将实际的文本尺寸计算委托给了 Layout 对象。`makeLayout` 方法会根据具体情况创建合适的 Layout 实例。

## 3. 核心引擎：Layout 类及其职责

`android.text.Layout` 是一个抽象类，它是 Android 文本布局系统的基石。它定义了对一段格式化文本（CharSequence）进行排版布局所需的核心接口和功能。

Layout 的主要职责如下：

1. **断行（Line Breaking）**：根据给定的宽度，决定文本在哪里换行；
2. **字形定位（Glyph Positioning）**：计算每一行内每个字形的精确 X、Y 坐标；
3. **尺寸计算**：提供整个文本块的总宽度和高度，以及每一行的宽度、高度、基线位置等信息；
4. **文本信息查询**：支持根据坐标查询对应的字符偏移量，或根据字符偏移量查询坐标等；
5. **绘制**：提供 `draw()` 方法，可以将布局好的文本绘制到 Canvas 上。

TextView 在 `onDraw()` 方法中，最终会调用其持有的 Layout 对象的 `draw()` 方法来完成文本的绘制。

```java
// TextView.java (简化示意)
@Override
protected void onDraw(Canvas canvas) {
    super.onDraw(canvas); // 绘制背景、Drawable 等

    // ... (省略保存和恢复 Canvas 状态，处理偏移等)

    if (mLayout != null) {
        // 委托给 Layout 对象绘制文本
        mLayout.draw(canvas, mHighlightPath, mHighlightPaint, mCursorOffsetVertical);
    }
}
```

Android 提供了几个 Layout 的具体实现类，以适应不同的场景和需求。最常用的有 BoringLayout、StaticLayout 和 DynamicLayout。

## 4. 三大 Layout 实现详解

TextView 内部的 `makeLayout` 方法会尝试为当前文本选择最高效的 Layout 实现。选择顺序通常是：BoringLayout → StaticLayout。DynamicLayout 主要用于 EditText。

### BoringLayout：简单高效的单行布局

**适用场景：**

- 文本是**单行**的；
- 文本方向是纯粹的**从左到右（LTR）**，不包含任何 RTL 字符或复杂的双向文本；
- 文本不包含任何会影响测量的 MetricAffectingSpan（例如 RelativeSizeSpan、StyleSpan 等，但 ForegroundColorSpan 等非度量 Span 是允许的）。

**解决了什么问题：**

对于满足上述条件的简单文本，BoringLayout 提供了一种高度优化的布局计算方式。它避免了复杂的断行和双向文本处理逻辑，测量和布局速度非常快。

**工作原理：**

BoringLayout 的工厂方法 `isBoring(CharSequence text, TextPaint paint, BoringLayout.Metrics metrics)` 会预先检查文本是否满足「Boring」的条件。如果满足，TextView 就会创建 BoringLayout 实例。它的内部实现非常简单，基本上就是测量整行文本的总宽度，然后记录下单行的度量信息。

**优点：**

- **性能极高**：计算开销最小。

**缺点：**

- **功能限制**：只能处理非常简单的单行 LTR 文本。

**代码示例（隐式使用）：**

你通常不需要手动创建 BoringLayout。当你给 TextView 设置简单的单行文本时，系统会自动选用它。

```xml
<TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:text="OK"
    android:singleLine="true" />
```

对于上面的 "OK" 文本，TextView 内部很可能会使用 BoringLayout。

### StaticLayout：功能强大的静态多行布局

**适用场景：**

- 需要显示**多行**文本；
- 文本内容相对**固定**，不会频繁改变；
- 需要支持复杂的文本特性，如：
  - 从右到左（RTL）文本和双向（BiDi）文本；
  - 各种 Span 效果（改变字号、样式、颜色、背景、插入图片等）；
  - 自定义换行和断字策略。

**解决了什么问题：**

StaticLayout 是 Android 中最常用、功能最全面的文本布局器。它能够处理绝大多数复杂的文本排版需求，包括国际化语言和富文本。

**工作原理：**

StaticLayout 在创建时会执行完整的文本分析和布局计算。它会：

1. 使用 TextPaint 测量每个字符或字形的宽度；
2. 应用断行算法（通常是贪心算法），根据给定宽度将文本分割成多行；
3. 处理 BiDi 算法以支持 RTL 和混合方向文本；
4. 计算每一行的尺寸（宽度、高度、ascent/descent）和基线位置；
5. 处理 Spanned 文本中的各种 Span 效果。

一旦 StaticLayout 创建完成，其布局结果就是**不可变（Immutable）**的。如果文本内容或宽度发生变化，需要重新创建一个新的 StaticLayout 实例。

**优点：**

- **功能强大**：支持多行、RTL、BiDi、Spans 等复杂特性；
- **渲染性能好**：布局计算完成后，绘制（draw）操作相对较快，因为它只需要根据预先计算好的信息进行绘制。

**缺点：**

- **创建开销**：创建 StaticLayout 的过程涉及较多的计算，相对耗时。对于频繁变化的文本，重复创建开销较大；
- **不可变**：不适合需要频繁编辑或修改内容的场景。

**代码示例（隐式使用）：**

当 TextView 的文本需要换行，或者包含 RTL 字符、复杂 Span 时，系统会自动选用 StaticLayout。

```xml
<TextView
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:text="This is a longer text that will likely wrap into multiple lines. It supports different styles like &lt;b&gt;bold&lt;/b&gt; and &lt;i&gt;italic&lt;/i&gt;, as well as RTL text like שלום (Shalom)." />
```

**代码示例（显式创建 —— 不常见，但有助于理解）：**

虽然 TextView 会自动处理，但你也可以手动创建 StaticLayout，例如在自定义 View 中绘制文本。

```java
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.graphics.Canvas;

// 在自定义 View 的 onDraw 中
@Override
protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);

    String myText = "Manually creating a StaticLayout example.";
    TextPaint textPaint = new TextPaint();
    textPaint.setAntiAlias(true);
    textPaint.setTextSize(50); // 50px
    textPaint.setColor(Color.BLACK);

    int availableWidth = getWidth() - getPaddingLeft() - getPaddingRight();

    // Android Q (API 29) 及以后推荐使用 StaticLayout.Builder
    StaticLayout.Builder builder = StaticLayout.Builder.obtain(myText, 0, myText.length(), textPaint, availableWidth)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setLineSpacing(0f, 1.0f) // lineSpacingExtra, lineSpacingMultiplier
            .setIncludePad(true); // 对应 includeFontPadding

    // 设置其他属性...
    // builder.setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY);
    // builder.setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NORMAL);

    StaticLayout staticLayout = builder.build();

    canvas.save();
    // 将绘制原点移动到 Padding 左上角
    canvas.translate(getPaddingLeft(), getPaddingTop());
    staticLayout.draw(canvas);
    canvas.restore();
}
```

### DynamicLayout：灵活应变的动态编辑布局

**适用场景：**

- 文本内容需要**频繁更改或编辑**，例如 EditText 控件。

**解决了什么问题：**

EditText 允许用户实时输入、删除和修改文本。如果每次修改都重新创建 StaticLayout，性能开销会非常大，导致输入卡顿。DynamicLayout 通过内部优化，使得在文本变化时能够**增量更新**布局信息，而不是完全重新计算，从而提高了编辑性能。

**工作原理：**

DynamicLayout 继承自 Layout。它的核心思想是维护一些内部数据结构（如文本块 Blocks 和行信息），当文本发生变化时，它只重新计算受影响的部分（通常是修改点所在的行以及后续可能受到影响的行），而不是整个文本。它会监听 Editable 文本的变化。

**优点：**

- **编辑性能好**：文本修改时的布局更新效率高；
- **功能完整**：支持 StaticLayout 的大部分功能（多行、RTL、Spans 等）。

**缺点：**

- **初始创建和绘制可能稍慢**：相比 StaticLayout，其内部结构更复杂，初始构建和绘制的单次开销可能略高；
- **内存占用可能稍高**：需要维护额外的数据结构来支持动态更新。

**代码示例（主要由 EditText 内部使用）：**

你几乎不需要手动创建 DynamicLayout。当你使用 EditText 时，它内部就会使用 DynamicLayout 来处理文本布局。

```xml
<EditText
    android:id="@+id/editText"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:hint="Enter text here" />
```

当用户在此 EditText 中输入文字时，DynamicLayout 就在幕后工作，高效地更新文本布局。

### 对比与选择：何时使用哪个 Layout？

| **特性** | **BoringLayout** | **StaticLayout** | **DynamicLayout** |
| --- | --- | --- | --- |
| **主要用途** | 简单的单行 LTR 文本显示 | 复杂的静态多行文本显示 | 可编辑的文本（EditText） |
| **行数** | 单行 | 单行或多行 | 单行或多行 |
| **文本方向** | 仅 LTR | 支持 LTR、RTL、BiDi | 支持 LTR、RTL、BiDi |
| **Spans** | 支持非度量 Span | 支持所有 Span 类型 | 支持所有 Span 类型 |
| **可变性** | 不可变 | 不可变 | 可变（增量更新） |
| **创建性能** | 非常快 | 相对较慢（需要完整计算） | 相对较慢（比 StaticLayout 稍复杂） |
| **更新性能** | N/A（不可变） | N/A（需要重新创建） | 快（增量更新） |
| **适用控件** | TextView（自动选择） | TextView（自动选择） | EditText（内部使用） |
| **主要解决问题** | 优化简单文本的布局性能 | 处理复杂静态文本的布局 | 优化可编辑文本的布局性能 |

**选择策略总结：**

- 对于 TextView：
  - 如果文本简单、单行、纯 LTR，系统自动选用 BoringLayout 以获得最佳性能；
  - 如果文本多行、包含 RTL/BiDi 字符或有复杂 Span，系统自动选用 StaticLayout；
- 对于 EditText：
  - 系统总是使用 DynamicLayout 来保证编辑时的流畅性。

开发者通常不需要显式选择或创建这些 Layout，除非在进行自定义 View 开发或有特殊的性能优化需求时。理解它们的区别有助于分析 TextView/EditText 的行为和性能。

## 5. 精雕细琢：换行、断字与对齐

StaticLayout 和 DynamicLayout 的核心能力之一就是处理文本换行。

### 换行算法简介

最简单的换行算法是**贪心算法（Greedy Algorithm）**：

1. 从当前行首开始，尽可能多地放入单词（以空格或标点分隔）；
2. 直到下一个单词放不下（超出可用宽度）为止；
3. 将当前行确定下来，然后从下一个单词开始处理下一行。

贪心算法简单快速，是很多文本布局系统的基础。但它不一定能产生最优的排版效果（例如，可能导致某一行特别空，或者最后一行只有一个很短的单词）。更高级的算法（如 TeX 使用的 Knuth-Plass 算法）会考虑整个段落的断行，以达到更均衡、美观的效果，但计算复杂度也更高。Android 的 StaticLayout 主要基于贪心策略，但提供了一些可配置的选项来优化效果。

### Android 的换行策略（android:breakStrategy）

Android 提供了 `android:breakStrategy` 属性（API 23+），允许开发者调整换行行为，以在排版质量和性能之间取得平衡。

- **simple**：默认值（API 23–27）。非常基础的策略，速度快，但可能在 CJK（中日韩）文本或标点附近断行不够理想；
- **high_quality**：默认值（API 28+）。提供更高质量的换行，尤其改善了标点悬挂、CJK 字符处理等，推荐使用。它会进行更多的计算来寻找更好的断点；
- **balanced**：尝试让每行的长度尽可能接近，以获得更均衡的视觉效果。这通常需要更多的计算，可能影响性能，适用于标题或短文本块。

```xml
<TextView
    android:layout_width="200dp"
    android:layout_height="wrap_content"
    android:text="This text demonstrates different break strategies. High quality is often preferred."
    android:breakStrategy="high_quality" />
```

### 断字（android:hyphenationFrequency）

对于西文，当一个较长的单词在一行末尾放不下时，可以使用连字符（-）将其分割到下一行，这就是断字（Hyphenation）。Android 提供了 `android:hyphenationFrequency` 属性（API 23+）来控制断字行为。

- **none**：不使用断字。如果单词放不下，整个单词会被移到下一行；
- **normal**：默认值。进行适度的断字，平衡可读性和空间利用率；
- **full**：进行更积极的断字，以最大限度地利用空间，使文本边缘更整齐。

```xml
<TextView
    android:layout_width="150dp"
    android:layout_height="wrap_content"
    android:text="Demonstrating hyphenation for long words like 'internationalization'."
    android:breakStrategy="high_quality"
    android:hyphenationFrequency="normal" />
```

启用 normal 或 full 断字通常能改善窄宽度下西文的排版效果，但可能会稍微增加布局计算时间，因为它需要查询断字词典。

**注意**：断字需要设备支持相应语言的断字规则。

### 对齐（android:gravity 或 Layout.Alignment）

文本在 TextView 的布局区域内如何对齐，由 `gravity` 属性控制（水平方向），或在创建 Layout 时通过 `Layout.Alignment` 指定。

- `Gravity.LEFT` / `Alignment.ALIGN_NORMAL`：左对齐（LTR 默认）；
- `Gravity.RIGHT` / `Alignment.ALIGN_OPPOSITE`：右对齐（RTL 默认）；
- `Gravity.CENTER_HORIZONTAL` / `Alignment.ALIGN_CENTER`：居中对齐。

TextView 会将 gravity 转换成对应的 `Layout.Alignment` 传递给 Layout 对象。

## 6. 字体之韵：Font Metrics 与垂直间距

文本不仅仅是水平排列，垂直方向的间距同样重要。理解字体度量（Font Metrics）是掌握行高和垂直对齐的关键。

### 理解 Paint.FontMetrics

`android.graphics.Paint.FontMetrics` 类提供了关于特定字体和字号的垂直度量信息。可以通过 `paint.getFontMetrics()` 获取。

- **baseline**：这不是 FontMetrics 的字段，而是绘制文本的基准线。其他度量都是相对于基线的。想象一下英语字母 'x' 坐落的那条线；
- **ascent**：基线（baseline）到西文字符最高处的建议距离（通常为**负值**）。它考虑了大部分字符（如 'h'、'l'）的高度，但不一定包含所有重音符号或特殊字符的最高点；
- **descent**：基线（baseline）到西文字符最低处的建议距离（通常为**正值**）。它考虑了像 'g'、'p'、'y' 这样低于基线的字符部分；
- **top**：基线（baseline）到字体所能绘制的**最高**可能像素的距离（为**负值**，且 top ≤ ascent）。它包含了所有可能的标记或字形（包括罕见的、非常高的）；
- **bottom**：基线（baseline）到字体所能绘制的**最低**可能像素的距离（为**正值**，且 bottom ≥ descent）。它包含了所有可能低于基线的标记或字形；
- **leading**：行间距，即上一行的 descent 和下一行的 ascent 之间的建议额外空间。这个值很多时候是 0。

![](../../assets/深入浅出-android-textview揭秘文本测量与布局的艺术-1.webp)

*图示说明*：一条水平线表示 baseline。从 baseline 向上标记 ascent 和 top（负值），向下标记 descent 和 bottom（正值）。用字母 'jEh' 演示：'h' 的顶部接近 ascent，'j' 的底部接近 descent。可能有一个带很高重音符号的字母触及 top，一个带很低标记的字母触及 bottom。leading 显示在两行文本之间。

### 行高的计算：默认行为

默认情况下（`includeFontPadding=true`、`elegantTextHeight=false`），TextView 中一行的基本高度大致由 `descent - ascent` 决定。但是，为了容纳所有可能的字形（包括 top 和 bottom 覆盖的范围），并且为了在多行之间提供一致的间距，实际的行高计算会更复杂一些。

### includeFontPadding 的作用与影响（android:includeFontPadding）

这个属性（**默认为 true**）控制是否在 ascent 之上和 descent 之下额外包含由 top 和 bottom 定义的空间。

- **includeFontPadding="true"（默认）**：
  - 第一行的顶部会包含 top - ascent 的额外空间；
  - 最后一行的底部会包含 bottom - descent 的额外空间；
  - 行与行之间的间距会考虑 bottom 和 top，确保即使有非常高或低的字符，也不会发生重叠；
  - **优点**：能容纳所有字形，避免极端情况下的裁剪；
  - **缺点**：可能会导致文本看起来上下 padding 过大，尤其是在顶部和底部，使得文本与其他 UI 元素在视觉上精确对齐变得困难；
- **includeFontPadding="false"**：
  - 行高主要基于 ascent 和 descent；
  - 第一行的顶部紧贴 ascent，最后一行的底部紧贴 descent；
  - 行间距也主要基于 ascent 和 descent；
  - **优点**：文本的实际边界更贴近可见字符，更容易与其他元素进行像素级对齐；
  - **缺点**：如果字体包含非常高或低的字形（超出 ascent 或 descent 范围），这些部分**可能被裁剪**。

**建议**：如果你需要精确控制文本的垂直对齐，或者觉得默认的上下边距过大，可以尝试设置 `android:includeFontPadding="false"`。但一定要在多种设备和字体上测试，确保没有重要的字形被裁剪。

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

运行上面的例子，你会发现在设置了相同高度和 `center_vertical` 的情况下，`includeFontPadding="false"` 的 TextView 中的文本，其基线位置看起来会与 `includeFontPadding="true"` 的有所不同，后者通常因为额外的字体 padding 显得「偏下」一点。

### elegantTextHeight：追求极致的排版美学（android:elegantTextHeight）

这个属性（API 21+，**默认为 false**）提供了另一种计算行高的方式，旨在实现更一致和「优雅」的垂直韵律，尤其是在处理包含多种脚本（如拉丁文、梵文、泰文等混合）或带有复杂附加符号的文本时。

- **elegantTextHeight="false"（默认）**：主要使用 ascent/descent 作为基准，并通过 includeFontPadding（如果为 true）来增加额外的空间；
- **elegantTextHeight="true"**：
  - 它倾向于使用字体文件中定义的**特定于「优雅」排版的度量标准**（如果字体支持的话），或者回退到使用 top/bottom 作为主要的行高计算依据；
  - 目标是为不同语言和脚本提供更一致的行高和基线，即使它们的 ascent/descent 值差异很大；
  - 通常会导致**行高增加**，因为它需要容纳各种语言的最大高度范围；
  - 它隐含了 `includeFontPadding="true"` 的行为，即总是考虑 top 和 bottom。

**何时使用：**

- 当你混合显示多种脚本，并且希望它们的行高和基线对齐更和谐时；
- 当你使用的字体明确支持「优雅高度」特性时；
- 当默认的行高在某些语言或特殊字符下显得不一致时。

**注意**：启用 elegantTextHeight 可能会改变文本的整体垂直尺寸，需要仔细测试布局影响。它并不总是「更好」，取决于具体的设计需求和字体。

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

比较上面两个 TextView 的渲染效果，你可能会观察到启用 elegantTextHeight 后，两行文本（英文和印地语）之间的垂直间距和整体高度有所变化，通常是为了更好地适应印地语字符的高度。

## 7. 复杂场景处理

现代应用常常需要处理比简单 LTR 文本更复杂的情况。

### RTL（从右到左）文本布局

Android 对 RTL 语言（如阿拉伯语、希伯来语）提供了完善的支持。

- **自动检测**：TextView 和 Layout 类能自动检测文本中是否存在 RTL 字符；
- **BiDi 算法**：当文本混合了 LTR 和 RTL 字符时（例如，英文中嵌入阿拉伯语），系统会应用 Unicode 双向算法（BiDi Algorithm）来确定每个字符片段的正确显示顺序和方向。StaticLayout 和 DynamicLayout 内部实现了 BiDi 处理；
- **android:textDirection**：你可以显式控制 TextView 的基础文本方向（通常设为 locale、ltr、rtl、inherit 等）。对于 Layout，这会影响 `Alignment.ALIGN_NORMAL` 和 `Alignment.ALIGN_OPPOSITE` 的具体行为（例如，ALIGN_NORMAL 在 RTL 上下文中是右对齐）。

![](../../assets/深入浅出-android-textview揭秘文本测量与布局的艺术-2.webp)

*图示说明*：显示一个 TextView，包含英文和阿拉伯文混合的文本，例如 "This is an example with العربية text."。图中文字应按正确的 BiDi 规则显示：英文从左到右，阿拉伯文从右到左，但整体语序符合逻辑。

系统处理 BiDi 的过程对开发者通常是透明的，Layout 类会负责计算正确的字形顺序和位置。

### Emoji 与特殊字符

- **Emoji**：本质上是 Unicode 字符。现代 Android 系统和字体通常内置了对 Emoji 的支持。
  - **测量**：Emoji 表情通常比普通字符宽（有时是普通字符的两倍宽度），Layout 在测量和换行时会正确处理它们的宽度；
  - **渲染**：系统使用彩色字体（如 Noto Color Emoji）来渲染表情符号；
  - **换行**：表情符号通常被视为一个整体，不会在中间断开；
- **复杂脚本**：对于需要字形组合（Glyph Composition/Shaping）的语言（如阿拉伯语的字母连接、印地语的元音组合），Android 使用 **HarfBuzz** 引擎进行处理。这个过程发生在 Layout 计算之前：文本先经过 HarfBuzz 转换成正确的字形序列和位置，然后 Layout 再基于这些字形信息进行断行和定位。

开发者通常不需要直接干预 Emoji 和复杂脚本的处理，系统底层会自动完成。确保使用支持这些特性的较新 Android 版本和字体即可。

### 富文本（Spanned String）

TextView 支持通过 Spanned 接口显示富文本（不同样式、颜色、可点击链接等）。Layout 类在计算布局时会识别并处理 Spanned 中的各种 Span 对象：

- **MetricAffectingSpan**：如 StyleSpan（粗体/斜体）、RelativeSizeSpan（相对字号）、TextAppearanceSpan。这些 Span 会改变文本的度量（宽度、高度），Layout 在测量和换行时必须考虑它们。BoringLayout 不支持这类 Span；
- **CharacterStyle（非度量）**：如 ForegroundColorSpan、BackgroundColorSpan、UnderlineSpan。这些 Span 只影响绘制效果，不改变文本度量，Layout 主要在绘制阶段应用它们的效果；
- **ParagraphStyle**：如 AlignmentSpan（影响段落对齐）、LineBackgroundSpan（行背景）、BulletSpan（项目符号）。这些 Span 影响整行或整个段落的布局或绘制。

StaticLayout 和 DynamicLayout 能够正确处理所有类型的 Span。

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
// !!! 重要：必须设置 MovementMethod 才能使 ClickableSpan 响应点击
textView.setMovementMethod(LinkMovementMethod.getInstance());
```

Layout 类会解析这些 Span，确保加粗的文字占用正确的宽度，着色的文字在绘制时使用正确的颜色，并为 ClickableSpan 提供位置信息以便响应触摸事件。

## 8. 性能考量与优化建议

虽然 TextView 功能强大，但在处理大量文本或频繁更新时，性能可能成为瓶颈。

- **避免在 onDraw 中创建 Layout 或 Paint 对象**：这些对象的创建有一定开销，应在初始化或文本/属性变化时创建/更新，然后在 onDraw 中复用。TextView 内部已经遵循了这个原则；
- **StaticLayout vs DynamicLayout**：
  - 对于不经常变化的文本，StaticLayout 渲染更快；
  - 对于需要编辑的文本（EditText），必须使用 DynamicLayout；
  - 如果你的 TextView 内容需要频繁更新（但不可编辑），每次更新都会触发 StaticLayout 的重新创建，开销较大。考虑是否有其他方式（例如，使用 RecyclerView 分割长文本，或只更新变化部分，但这通常很难实现）；
- **缓存 Layout 对象**：如果你在自定义 View 中手动创建 Layout，并且文本和约束条件不变，可以缓存 Layout 对象避免重复计算；
- **TextView 优化**：
  - **减少不必要的 setText() 调用**：只有在文本确实改变时才调用；
  - **避免在列表中过度使用复杂 Span**：大量复杂的 Span 会增加布局和绘制的负担；
  - **考虑 PrecomputedText（API 28+）**：对于可能在后台线程加载的长文本，可以使用 PrecomputedText 在后台线程完成大部分文本布局计算，然后在主线程将结果设置给 TextView，减少主线程卡顿。

```java
// 在后台线程
TextView textView = findViewById(R.id.myTextView);
CharSequence longText = ... ;
PrecomputedText.Params params = textView.getTextMetricsParams();
Spannable newText = PrecomputedText.create(longText, params);

// 回到主线程
textView.setText(newText);
```

- **简化布局**：过于复杂的 ConstraintLayout 或嵌套布局会增加整体测量/布局时间，间接影响 TextView 的显示性能。

## 9. 调试技巧

当 TextView 的显示效果不符合预期时，可以尝试以下调试方法：

- **Layout Inspector（布局检查器）**：Android Studio 自带的工具，可以查看 TextView 的边界、内边距、测量的宽高以及文本内容；
- **检查属性**：仔细核对 XML 属性或代码中设置的 textSize、textColor、lineSpacingExtra、includeFontPadding、breakStrategy、maxLines、ellipsize 等是否正确；
- **打印 FontMetrics**：获取 TextView 的 TextPaint 对象，打印 FontMetrics 信息，帮助理解当前的字体度量和基线位置。

```java
TextPaint paint = textView.getPaint();
Paint.FontMetrics fm = paint.getFontMetrics();
Log.d("FontMetrics", "top: " + fm.top + ", ascent: " + fm.ascent +
                   ", descent: " + fm.descent + ", bottom: " + fm.bottom +
                   ", leading: " + fm.leading);
```

- **简化场景**：尝试使用更简单的文本、移除 Span、使用标准字体、移除 lineSpacing 等，逐步排查是哪个因素导致了问题；
- **边界可视化**：临时给 TextView 设置一个明显的背景色，或者在开发者选项中打开「显示布局边界」，查看 TextView 的实际占用区域。

## 10. 总结：掌握 TextView 布局的精髓

TextView 的文本测量与布局是一个涉及多方面因素的精密过程。理解其背后的机制，特别是 Layout 类（BoringLayout、StaticLayout、DynamicLayout）的角色和差异，以及 Font Metrics 对垂直间距的影响，对于我们构建高质量、高性能的 Android 应用至关重要。

**核心要点回顾：**

- TextView 的 onMeasure 依赖 Layout 对象计算尺寸；
- BoringLayout 用于优化简单的单行 LTR 文本；
- StaticLayout 是处理复杂、静态多行文本的主力，功能全面但创建有开销；
- DynamicLayout 用于 EditText，支持高效的增量更新；
- 换行策略（breakStrategy）和断字（hyphenationFrequency）影响文本流的外观；
- Font Metrics（top、ascent、descent、bottom）决定了垂直空间；
- includeFontPadding 和 elegantTextHeight 控制如何使用 Font Metrics 来计算行高和行距，影响垂直对齐；
- 系统能自动处理 RTL/BiDi、Emoji 和复杂脚本；
- Spanned 文本允许富文本展示，由 Layout 负责处理；
- 性能优化需要关注 Layout 的选择、缓存和避免不必要的计算。

希望通过本文的深入探讨，你对 Android TextView 的文本测量和布局有了更清晰、更全面的认识。下次当你调整 lineSpacingMultiplier、处理多语言对齐或者优化列表滚动性能时，能够更加胸有成竹。
