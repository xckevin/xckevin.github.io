---
title: "深入浅出 Android TextView：揭秘文本测量与布局的艺术（1）：开篇：文字的旅程 —— 从字符到像素"
excerpt: "「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列第 1/4 篇：开篇：文字的旅程 —— 从字符到像素"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - TextView
  - UI
  - 自定义View
series:
  name: "深入浅出 Android TextView：揭秘文本测量与布局的艺术"
  part: 1
  total: 4
seo:
  title: "深入浅出 Android TextView：揭秘文本测量与布局的艺术（1）：开篇：文字的旅程 —— 从字符到像素"
  description: "「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列第 1/4 篇：开篇：文字的旅程 —— 从字符到像素"
---
# 深入浅出 Android TextView：揭秘文本测量与布局的艺术（1）：开篇：文字的旅程 —— 从字符到像素

> 本文是「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列的第 1 篇，共 4 篇。

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

---

> 下一篇我们将探讨「三大 Layout 实现详解」，敬请关注本系列。

**「深入浅出 Android TextView：揭秘文本测量与布局的艺术」系列目录**

1. **开篇：文字的旅程 —— 从字符到像素**（本文）
2. 三大 Layout 实现详解
3. 精雕细琢：换行、断字与对齐
4. 复杂场景处理
