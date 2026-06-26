---
title: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎（1）：行代码的背后"
excerpt: "「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列第 1/2 篇：行代码的背后"
publishDate: 2026-06-16
displayInBlog: false
series:
  name: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎"
  part: 1
  total: 2
seo:
  title: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎（1）：行代码的背后"
  description: "「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列第 1/2 篇：行代码的背后"
---


> 本文是「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列的第 1 篇，共 2 篇。

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

---

> 下一篇我们将探讨「自定义 Span 的两个典型场景」，敬请关注本系列。

**「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列目录**

1. **行代码的背后**（本文）
2. 自定义 Span 的两个典型场景
