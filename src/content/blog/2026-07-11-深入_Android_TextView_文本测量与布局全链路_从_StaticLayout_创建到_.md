---
title: 深入 Android TextView 文本测量与布局全链路：从 StaticLayout 创建到 LineBreaker 断行的文本排版引擎解析
slug: android-textview-layout-linebreaker
translationKey: android-textview-layout-linebreaker
excerpt: 深入解析 Android 文本排版引擎核心机制，涵盖 StaticLayout 布局创建、FontMetrics 度量坐标系、LineBreaker 断行算法策略及自定义 View 文本渲染实践。
publishDate: '2026-07-11'
tags:
- Android
- 文本排版
- StaticLayout
- 自定义View
- FontMetrics
seo:
  title: 深入 Android TextView 文本测量与布局全链路：从 StaticLayout 创建到 LineBreaker 断行的文本排版引擎解析
  description: 深入解析 Android TextView 文本排版全链路，从 StaticLayout 与 DynamicLayout 的选型机制、FontMetrics 基线坐标系到 LineBreaker 三种断行策略，助你掌握自定义文本渲染的核心原理。
---

做自定义 View 的文本渲染时，我踩过一个坑：用 `Canvas.drawText()` 画多行文本，手动算换行位置，结果中英文混排时行尾参差不齐，加上 `\n` 换行符还要额外处理。后来才意识到，Android 提供了完整的文本排版引擎——**StaticLayout**，它就是 TextView 内部的排版核心。

要用好 StaticLayout，得先理解排版引擎的工作机制、文字度量坐标系和断行算法的决策逻辑。

## 文本排版引擎：StaticLayout 与 DynamicLayout

Android 的文本排版由 `android.text.Layout` 抽象类定义，两个核心子类是 `StaticLayout` 和 `DynamicLayout`。TextView 内部根据文本是否会变化，自动选择其中之一。

`StaticLayout` 的「Static」不是指文本内容不可变，而是**布局创建后不能修改**。文本变了就得重新 `new` 一个。它的优势在于快：创建时一次性完成所有测量和断行，后续 `getLineStart()`、`getLineEnd()`、`getLineBottom()` 都是 O(1) 查表。

```java
// TextView 内部简化逻辑
Layout layout;
if (text instanceof Spannable) {
    layout = new DynamicLayout(text, paint, width, alignment, spacingMult, spacingAdd, includepad);
} else {
    layout = new StaticLayout(text, paint, width, alignment, spacingMult, spacingAdd, includepad);
}
```

`DynamicLayout` 支持增量更新：当 `Spannable` 内容变化时，只重新计算受影响的区域，而不是整个布局。代价是文本必须是 `Spannable` 或 `Editable` 实例。

`Layout` 内部维护了一个关键结构：**行表（line table）**。每行记录起始字符偏移、行宽、行高。创建时用 `LineBreaker` 计算断行位置，然后逐行测量宽度和高度，最终确定总高度。

在自定义 View 中做多行文本渲染，直接用 `StaticLayout` 是最省心的方案：

```kotlin
val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
    .setLineSpacing(4f, 1.2f)  // extra spacing, multiplier
    .setIncludePad(true)
    .build()

// 绘制时直接遍历行
for (i in 0 until layout.lineCount) {
    val lineStart = layout.getLineStart(i)
    val lineEnd = layout.getLineEnd(i)
    canvas.drawText(text, lineStart, lineEnd, x, layout.getLineBaseline(i), paint)
}
```

`setLineSpacing` 的两个参数对应 `android:lineSpacingExtra` 和 `android:lineSpacingMultiplier`，最终行高 = 原始行高 × multiplier + extra。

## FontMetrics：文字度量的坐标系

要理解布局计算，必须先搞清楚 `FontMetrics`——它是 Paint 对字体的度量描述，定义了一套基于 **基线（baseline）** 的坐标系。

```kotlin
val fm = paint.fontMetrics
// fm.top     → 基线以上最大距离（负值，如 -250.7）
// fm.ascent  → 基线以上推荐距离（负值，如 -214.8）
// fm.descent → 基线以下推荐距离（正值，如 59.6）
// fm.bottom  → 基线以下最大距离（正值，如 69.4）
// fm.leading → 行间距（通常为 bottom - ascent 之外的额外空间）
```

这些值的关系如下图所示（用文字描述）：

```
  ─────── top（负值，最上方）
  ─────── ascent（负值，推荐升部上界）
  ═══════ baseline（0，基线）
  ─────── descent（正值，推荐降部下界）
  ─────── bottom（正值，最下方）
```

很多人以为 `textSize` 等于 `descent - ascent`，实际上不是。`textSize` 是字体的设计尺寸，实际字符可能超出这个范围——带变音符号的字母可能越过 `ascent` 延伸到 `top` 区域。`getTextBounds()` 返回的高度比 `textSize` 大就是这个原因。

`Layout.getLineTop(i)` 和 `Layout.getLineBottom(i)` 的差值就是第 i 行的实际高度。`Layout.getLineBaseline(i)` 返回该行基线在布局中的绝对位置，这是绘制时 `drawText` 的 y 坐标。

`setIncludePad(true)` 会让第一行顶部和最后一行底部各增加 `top - ascent` 和 `bottom - descent` 的额外空间，目的是防止顶部字符被裁剪。如果自定义 View 中文本顶部留白过大，关掉它就行：

```kotlin
StaticLayout.Builder.obtain(...)
    .setIncludePad(false)  // 去掉顶部/底部内边距
    .build()
```

## LineBreaker：断行算法解析

文本排版里最复杂的环节是**断行**——决定一行在哪里换行。Android 从 Q（API 29）开始引入了 `LineBreaker` 类，支持三种策略：

| 策略 | 常量 | 行为 |
|------|------|------|
| 简单断行 | `BREAK_STRATEGY_SIMPLE` | 逐字符推进，超出宽度时回退到上一个可断行位置 |
| 高质量断行 | `BREAK_STRATEGY_HIGH_QUALITY` | 基于 Unicode 断行算法 + 语言规则，自动处理连字符 |
| 均衡断行 | `BREAK_STRATEGY_BALANCED` | 在高质量断行基础上，尽量让每行宽度接近，避免末行过短 |

`StaticLayout.Builder` 默认使用 `BREAK_STRATEGY_SIMPLE`，这也是 TextView 的默认行为。中英文混排时英文单词被拦腰截断，就是这个原因。切换到高质量断行即可解决：

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    StaticLayout.Builder.obtain(...)
        .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
        .build()
}
```

断行的核心逻辑在 `LineBreaker.computeLineBreaks()` 中：给定文本、宽度和 Paint，它返回一个 `int[]` 数组，每个元素表示一行的结束字符位置。算法大致流程：

1. 从当前行起始位置开始，逐个字符推进
2. 每次推进后测量已累积文本的宽度
3. 宽度超过可用宽度时，回退到最近的**可断行点**（空格、CJK 字符边界、连字符位置等）
4. 记录断行位置，开始下一行

**CJK（中日韩）文字的特殊性**在于：每个字符本身就是一个可断行点。所以中文排版很少出现单词被截断的情况。但英文没有空格时，`SIMPLE` 策略会直接截断单词。

`BREAK_STRATEGY_HIGH_QUALITY` 对英文排版提升明显：它会在单词边界断行，必要时使用连字符，效果接近专业排版软件。计算量确实更大，但对于几百行以内的文本，差异可以忽略。

`BREAK_STRATEGY_BALANCED` 更进一步，让断行位置在整段文本中更均匀分布。比如一段 3 行英文，不会出现前两行很满、第三行只有两个单词的情况。这个策略在 `TextView` 中需要 API 31+ 才支持。

## 行高计算：从 FontMetrics 到 Layout

`Layout` 计算行高时，不是直接用 `descent - ascent`，而是用 `bottom - top`。这里有个细节：

```java
// Layout 内部行高计算（简化）
int lineHeight = (int) Math.ceil(fm.bottom - fm.top);
```

如果 `setIncludePad(true)`，第一行会额外加上 `fm.top - fm.ascent`，最后一行额外加上 `fm.bottom - fm.descent`。

Android P（API 28）引入了 `setFallbackLineSpacing()`，用于处理 **fallback 字体** 的行高问题。当一行文本包含需要回退到不同字体渲染的字符时（比如拉丁字母行里混入了一个 Emoji），不同字体的 FontMetrics 可能差异很大。`setFallbackLineSpacing(true)` 确保行高受最大 fallback 字体度量值的影响，防止行高不一致导致的文本跳动。

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    StaticLayout.Builder.obtain(...)
        .setFallbackLineSpacing(true)
        .build()
}
```

## 自定义 View 中的实践

一个典型的自定义文本渲染 View 的 onDraw 实现：

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

上面这段代码有一个性能问题：`onDraw` 里每次都调用 `buildLayout()` 创建新的 `StaticLayout`。如果文本较长，断行计算会成为每帧的负担。正确做法是**缓存 Layout 对象**，只在文本或宽度变化时重建。

另一个容易踩的坑是 `Layout.getLineWidth(i)`：它返回的是该行纯文本的宽度，**不包括对齐产生的偏移**。居中或右对齐时，需要改用 `getLineLeft(i)` 或 `getLineRight(i)` 获取实际绘制位置。

`Layout.getLineLeft(i)` 和 `getLineRight(i)` 的差值等于该行最大宽度，受 `getLineMax(i)` 影响。做「文本选中高亮」一类需求时，用这两个值来确定高亮背景的边界，比手动计算靠谱得多。

## 最后

StaticLayout 替代手动排版，FontMetrics 的基线坐标系，断行策略的选择——这三者构成了 Android 文本排版的基础。搞清楚了，TextView 的测量、自定义文本渲染、甚至富文本编辑器里的排版问题，都能从同一个模型出发去理解。

`BreakStrategy` 的差异在中文场景下不那么明显，但做国际化应用时，`HIGH_QUALITY` 几乎是必选项。性能方面，除非你的列表里每个 item 都在实时渲染大量文本，否则不用纠结 `StaticLayout` 的创建开销——它的计算在 Java 层完成，比想象中快得多。
