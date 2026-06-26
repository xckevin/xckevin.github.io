---
title: 深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎
slug: android-spannable-rich-text-rendering
translationKey: android-spannable-rich-text-rendering
excerpt: 深入剖析 Android Spannable 富文本从标记存储、Span 分层回调到 TextLine Canvas 渲染的完整链路，涵盖自定义 ReplacementSpan 与 ParagraphStyle 实战、异步测量陷阱及 Compose AnnotatedString 演进对比。
publishDate: '2026-06-16'
tags:
- Android
- Spannable
- 富文本
- Canvas
- 自定义View
seo:
  title: 深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎
  description: 从 Spanned 接口的标记存储模型，到 SpannableStringBuilder 内部数组管理，再到 TextLine 的 Canvas 渲染调度——全面拆解 Android 富文本引擎，附自定义 Span 实战与 Compose AnnotatedString 对比。
---

## 三行代码的背后

```kotlin
val text = SpannableStringBuilder("Android 富文本")
text.setSpan(ForegroundColorSpan(Color.RED), 0, 7, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
textView.text = text
```

三行代码，「Android」就变红了。简单到让人忽略背后的完整链路：一个 span 对象被存入字符串，在测量和绘制两个关键节点被取出，最终在 Canvas 上完成颜色切换。这套机制运转了十几年，支撑了从 Markdown 渲染到代码高亮的几乎所有 Android 富文本场景。

我最初深入这个系统，是因为要实现一个带自定义下划线的文本组件。Android 自带的 UnderlineSpan 文字紧贴下划线，视觉上很难看。市面上的方案大多在 onDraw 里手动画线，位置算不准、行高也对不齐。这才促使我研究 span 从「标记」到「渲染」的全流程。

## Spanned 接口：标记系统的数据契约

Android 富文本的核心是**标记（Markup）与文本（Text）的分离存储**，通过 4 个接口落地：

- **Spanned**：只读的「文本 + 标记」容器，定义查询能力
- **Spannable**：可变的标记容器，提供 setSpan / removeSpan
- **SpannedString**：不可变实现，无额外内存开销
- **SpannableStringBuilder**：可变实现，标记和文本都可动态修改

核心设计集中在 Spanned 的三个方法签名：

```java
public interface Spanned extends CharSequence {
    <T> T[] getSpans(int start, int end, Class<T> type);
    int getSpanStart(Object tag);
    int getSpanEnd(Object tag);
    int getSpanFlags(Object tag);
    int SPAN_PRIORITY_SHIFT = 16;
}
```

`getSpans()` 有两个实用的设计。其一，用 `start` 和 `end` 限定查询范围——TextView 在绘制第 3 个字符时，只需取出覆盖该位置的所有 span，不用遍历全部标记。其二，返回 `T[]` 数组支持按类型过滤，一次取回所有 ForegroundColorSpan。

`spanFlags` 是位掩码，低 16 位控制标记边界行为，高 16 位（经 `SPAN_PRIORITY_SHIFT` 右移后）表示优先级。插入新字符时，系统通过 flags 判断该位置的 span 是否需要扩展覆盖：

```java
SPAN_EXCLUSIVE_EXCLUSIVE   // 新字符不继承标记
SPAN_INCLUSIVE_INCLUSIVE   // 新字符继承标记
SPAN_EXCLUSIVE_INCLUSIVE   // 仅后侧包含
SPAN_INCLUSIVE_EXCLUSIVE   // 仅前侧包含
```

我在调试富文本编辑器时踩过一个坑：用 `SPAN_EXCLUSIVE_INCLUSIVE` 在末尾插入字符，新字符没有继承粗体样式。原因是在 position 处插入时，span 的 end 恰好等于插入点，EXCLUSIVE 意味着该位置不在区间内，不覆盖。统一用 `INCLUSIVE_EXCLUSIVE` 解决了光标插入时的样式继承——既保证后续输入继承当前样式，又不影响之前的字符。

## SpannableStringBuilder：标记的内部存储

SpannableStringBuilder 用三个数组管理标记：两个 `int[]` 记录每个 span 的 start 和 end 位置，一个 `Object[]` 持有 span 实例。插入和删除文本时，系统遍历所有 span，通过 flags 决定是否移动标记位置：

```java
// 源码中的替换逻辑（简化）
void replace(int start, int end, CharSequence tb) {
    int change = tb.length() - (end - start);
    for (int i = 0; i < mSpanCount; i++) {
        if (mSpanStarts[i] > end) {
            mSpanStarts[i] += change;           // 区间后的 span 整体偏移
        } else if (mSpanStarts[i] >= start) {
            boolean flag = (mSpanFlags[i] & SPAN_PARAGRAPH) != 0;
            if (flag) mSpanStarts[i] = start;   // 区间内的按规则处理
        }
        // end 位置的类似逻辑...
    }
}
```

每次文本变更都是 O(n) 遍历所有 span。100 个 span 以下完全够用，但如果你在 RecyclerView 的 Item 里频繁 setSpan 并在一个字符串上叠加了几百个标记，TextView 的 onMeasure 阶段会触发明显卡顿。

实践中，批量操作时先用 `SpannableStringBuilder` 构建，完成后转为 `SpannedString` 交给 TextView。不可变实现跳过了所有变更监听逻辑，后续测量阶段干净利落。

## Span 的分层回调体系

Android 把 span 分成了几个清晰的回调层次，每一层决定了框架在哪个阶段回调你：

| 接口 | 回调时机 | 典型实现 |
|------|---------|---------|
| UpdateAppearance | draw 时 | ForegroundColorSpan, UnderlineSpan |
| UpdateLayout | measure 时触发重新布局 | AbsoluteSizeSpan, StyleSpan |
| MetricAffectingSpan | 文字度量阶段 | 影响行高的 span |
| ParagraphStyle | 段落级别绘制 | AlignmentSpan, LeadingMarginSpan |
| CharacterStyle | 字符级别属性修改 | 通过 updateDrawState 修改 TextPaint |
| ReplacementSpan | 完全接管绘制 | 内嵌图片、自定义图形 |

分层设计的实际意义在于，它决定了什么时候需要**重新测量**（requestLayout），什么时候只需要**重新绘制**（invalidate）。设颜色 span 只需 invalidate，设字号 span 则需 requestLayout——字号变了，换行位置就可能跟着变。

实际开发中我更倾向于直接继承 CharacterStyle 或 ReplacementSpan，它们的生命周期最可控。接口越底层，出问题的概率越低——这是踩过几次 UpdateLayout 触发无限 layout 循环后的教训。

## TextLine 的绘制调度

TextView 的绘制链路：

```
TextView.onDraw()
  → Layout.draw(Canvas)
    → TextLine.draw(Canvas, TextPaint, int, ...)
```

TextLine 是真正的渲染调度器。在 `draw()` 内部，它按 run 切分文本，每段 run 内按优先级排序 span，逐个回调：

```java
// TextLine 内部逻辑（简化）
void draw(Canvas c, float x, int offset) {
    for (int i = 0; i < runs.length; i++) {
        TextPaint wp = mWorkPaint;
        wp.set(mPaint);                          // 恢复基础画笔
        
        CharacterStyle[] styles = mCharacterStyles[i];
        for (CharacterStyle style : styles) {
            style.updateDrawState(wp);           // 修改画笔属性
        }
        c.drawText(mText, runStart, runEnd, x, y, wp);
    }
    // ReplacementSpan 最后单独绘制
    for (ReplacementSpan span : mReplacementSpans) {
        span.draw(c, mText, start, end, x, top, y, bottom, mPaint);
    }
}
```

CharacterStyle 的 `updateDrawState()` 接收一个共享的 `mWorkPaint` 对象，你修改它的 color、typeface、underline 等属性，TextLine 复用这个画笔去 `drawText()`。模式是**修改画笔而非直接绘制**——用一个 mWorkPaint 反复复用，避免频繁创建 Paint 对象。

ReplacementSpan 走另一条路径：完全接管指定范围内文本的测量和绘制。框架先调用 `getSize()` 获取宽度，再调用 `draw()` 在 Canvas 上自绘。

## 自定义 Span 的两个典型场景

**场景一：圆角标签（ReplacementSpan）**

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

ReplacementSpan 的代价是它接管了整段文本的绘制。这段文字无法再叠加下划线或删除线效果——原文本的 Canvas 绘制权已被你拿走。需要叠加效果的话，得在 `draw()` 里手动补上。

**场景二：引用块竖线（ParagraphStyle）**

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
        // dir 处理 RTL 布局：左边距在左，右边距在右
        val left = if (dir > 0) x.toFloat() else (x + dir * quoteWidth).toFloat()
        canvas.drawRect(left, top.toFloat(),
                        left + quoteWidth, bottom.toFloat(), paint)
    }
}
```

`drawLeadingMargin()` 的 `first` 参数指示当前是否为段落首行，容易踩坑。如果你希望每行都有竖直装饰条，务必在 `first` 为 false 时也执行绘制——很多网上的示例代码只处理了首行。

## 异步测量：别绕过 Span

在 RecyclerView 中预测量文本高度时，常见做法是 new 一个 Paint 直接 measureText：

```kotlin
// 错误写法——丢失了 span 的度量影响
val paint = Paint().apply { textSize = 48f }
val width = paint.measureText(spannableText.toString())
```

`measureText(String)` 不走 Spanned 的 span 回调，AbsoluteSizeSpan 的字体大小变更不会生效。正确方式是用 `TextPaint` 搭配 `Layout.getDesiredWidth()`：

```kotlin
val textPaint = TextPaint().apply { textSize = 48f }
val width = Layout.getDesiredWidth(spannableText, textPaint)
```

`getDesiredWidth()` 内部会构建 StaticLayout，遍历所有 MetricAffectingSpan，得到真实的度量宽度。代价是比 measureText 慢一个数量级——在列表中务必缓存测量结果。我用 LruCache 按文本内容 hash 做缓存，ListItem 预测量耗时从 8ms 降到 0.3ms。

## Compose AnnotatedString：同一枚硬币的另一面

Jetpack Compose 的 `AnnotatedString` 本质上在做和 Spannable 同样的事：文本和标记分离存储。但接口设计上有几处明显的演进：

```kotlin
val text = buildAnnotatedString {
    withStyle(SpanStyle(color = Color.Red, fontWeight = FontWeight.Bold)) {
        append("Android")
    }
    append(" 富文本")
}
```

用 `SpanStyle`（字符级）和 `ParagraphStyle`（段落级）统一分类，不再区分 UpdateAppearance 和 UpdateLayout——Compose 的渲染管线本身就会在重组时重新测量，不需要 span 层做区分。

`buildAnnotatedString` 的 DSL 让 span 作用域天然清晰。SpannableStringBuilder 的 setSpan(start, end) 在多次修改后，start/end 偏移极易出错，而 DSL 嵌套结构天然表达了作用域。

`AnnotatedString` 默认不可变。可变文本交给 `TextFieldValue` 的 composition / commit 机制单独处理，和 span 层解耦了。

Compose 目前仍通过 `AndroidView` 桥接传统 View 体系，Spannable 短期内不会消失。但在纯 Compose 项目里，我更倾向于直接用 AnnotatedString + ClickableText，绕开 Spannable 那套 flags 标记的心智负担。两套 API 之间通过 `AnnotatedString.toSpannedString()` 和 `Spannable.toAnnotatedString()` 互转，桥接层不做多余的事情。

## 几条实用原则

**选基类时往上靠**：能继承 CharacterStyle 就不继承 ReplacementSpan，能继承 ReplacementSpan 就不继承 DynamicDrawableSpan。每往下一层，你要处理的细节成倍增加。

**排查 span 不生效**：先确认是没走到 measure 还是没走到 draw。在 `updateDrawState()` 和 `updateMeasureState()` 里打日志。前者只影响绘制，后者影响布局。如果在 `updateMeasureState()` 里改了 textSize 但没生效，检查是否用了 `setText(CharSequence)` 而非 `setText(Spannable)`——后者才会触发布局重测量。

**控制 span 数量**：单个字符串上的 span 控制在 200 以内。超出这个阈值建议用 WebView 或自定义 View。代码语法高亮场景尤其容易超标——一个 500 行的文件，keyword、string、comment 三类 span 轻松破 300。

**构建完就冻结**：`SpannableStringBuilder` 构建完成后转为 `SpannedString` 再使用，避免后续无意的修改触发连锁 layout 请求。这个小习惯帮我解决过不少 RecyclerView item 复用时莫名卡顿的问题。
