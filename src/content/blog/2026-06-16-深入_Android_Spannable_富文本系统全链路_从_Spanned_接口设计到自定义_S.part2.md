---
title: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎（2）：自定义 Span 的两个典型场景"
excerpt: "「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列第 2/2 篇：自定义 Span 的两个典型场景"
publishDate: 2026-06-16
displayInBlog: false
series:
  name: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎"
  part: 2
  total: 2
seo:
  title: "深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎（2）：自定义 Span 的两个典型场景"
  description: "「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列第 2/2 篇：自定义 Span 的两个典型场景"
---


> 本文是「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列的第 2 篇，共 2 篇。在上一篇中，我们探讨了「行代码的背后」的相关内容。

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

---

**「深入 Android Spannable 富文本系统全链路：从 Spanned 接口设计到自定义 Span 的 Canvas 渲染引擎」系列目录**

1. 行代码的背后
2. **自定义 Span 的两个典型场景**（本文）
