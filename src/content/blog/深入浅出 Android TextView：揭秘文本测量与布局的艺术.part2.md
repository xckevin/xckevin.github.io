---
title: "深入浅出 Android TextView：揭秘文本测量与布局的艺术（2）：三大 Layout 实现详解"
excerpt: "「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列第 2/4 篇：三大 Layout 实现详解"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - TextView
  - UI
  - 自定义View
series:
  name: "深入浅出 Android TextView：揭秘文本测量与布局的艺术"
  part: 2
  total: 4
seo:
  title: "深入浅出 Android TextView：揭秘文本测量与布局的艺术（2）：三大 Layout 实现详解"
  description: "「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列第 2/4 篇：三大 Layout 实现详解"
---
# 深入浅出 Android TextView：揭秘文本测量与布局的艺术（2）：三大 Layout 实现详解

> 本文是「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列的第 2 篇，共 4 篇。在上一篇中，我们探讨了「开篇：文字的旅程 —— 从字符到像素」的相关内容。

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

---

> 下一篇我们将探讨「精雕细琢：换行、断字与对齐」，敬请关注本系列。

**「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列目录**

1. 开篇：文字的旅程 —— 从字符到像素
2. **三大 Layout 实现详解**（本文）
3. 精雕细琢：换行、断字与对齐
4. 复杂场景处理
