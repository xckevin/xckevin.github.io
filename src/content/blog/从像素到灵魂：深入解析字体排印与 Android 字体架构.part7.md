---
title: "从像素到灵魂：深入解析字体排印与 Android 字体架构（7）：指令式操作：在代码中动态设置字体"
excerpt: "「从像素到灵魂：深入解析字体排印与 Android 字体架构」系列第 7/15 篇：指令式操作：在代码中动态设置字体"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 字体
  - 排版
  - UI
series:
  name: "从像素到灵魂：深入解析字体排印与 Android 字体架构"
  part: 7
  total: 15
seo:
  title: "从像素到灵魂：深入解析字体排印与 Android 字体架构（7）：指令式操作：在代码中动态设置字体"
  description: "「从像素到灵魂：深入解析字体排印与 Android 字体架构」系列第 7/15 篇：指令式操作：在代码中动态设置字体"
---
# 从像素到灵魂：深入解析字体排印与 Android 字体架构（7）：指令式操作：在代码中动态设置字体

> 本文是「从像素到灵魂：深入解析字体排印与 Android 字体架构」系列的第 7 篇，共 15 篇。在上一篇中，我们探讨了「Android 的原生字体生态：Roboto、Noto 与字体回退」的相关内容。

## 第三章：指令式操作：在代码中动态设置字体

虽然 XML 布局是设置字体的主要方式，但在某些场景下，我们需要在运行时通过 Java 或 Kotlin 代码动态地改变文本控件的字体。例如，根据用户偏好设置加载不同字体，或者在自定义 View 中直接绘制文本。

**1. 核心类：Typeface**

在 Android 代码中，`android.graphics.Typeface` 类是字体的面向对象表示。一个 Typeface 对象通常代表了一个具体的字体文件（及其内在的字重和样式）。

**2. 获取系统字体的 Typeface 实例**

Typeface 类提供了一些静态常量和工厂方法来获取系统预定义字体的实例：

+ **常用静态常量:**
    - Typeface.DEFAULT: 获取系统默认字体（通常是 Roboto Regular）。
    - Typeface.DEFAULT_BOLD: 获取系统默认的粗体字体（通常是 Roboto Bold）。
    - Typeface.SANS_SERIF: 获取通用的 sans-serif 字体族（通常是 Roboto）。
    - Typeface.SERIF: 获取通用的 serif 字体族（通常是 Noto Serif）。
    - Typeface.MONOSPACE: 获取通用的等宽字体族（通常是 Noto Mono）。

Kotlin

```kotlin
// Kotlin示例
val defaultTypeface: Typeface = Typeface.DEFAULT
val sansSerifTypeface: Typeface = Typeface.SANS_SERIF
```

Java

```java
// Java示例
Typeface defaultTypeface = Typeface.DEFAULT;
Typeface sansSerifTypeface = Typeface.SANS_SERIF;
```

+ Typeface.create(String familyName, int style): (更灵活的方式) 
    - 通过字体家族名称 (如 XML 中使用的 "sans-serif-light") 和样式常量来创建 Typeface。
    - style 常量包括： 
        * Typeface.NORMAL
        * Typeface.BOLD
        * Typeface.ITALIC
        * Typeface.BOLD_ITALIC
    - **示例：** Kotlin

```kotlin
// 获取 Roboto Light
val robotoLight: Typeface? = Typeface.create("sans-serif-light", Typeface.NORMAL)

// 获取 Monospace Bold Italic
val monoBoldItalic: Typeface? = Typeface.create("monospace", Typeface.BOLD_ITALIC)
```

Java

```java
// 获取 Roboto Light
Typeface robotoLight = Typeface.create("sans-serif-light", Typeface.NORMAL);

// 获取 Monospace Bold Italic
Typeface monoBoldItalic = Typeface.create("monospace", Typeface.BOLD_ITALIC);
```

+ **注意：** create() 方法可能返回 null（尽管对于标准系统家族名通常不会）。它会尝试查找最匹配的字体文件。style 参数在这里主要是为了选择字体家族内已有的粗体/斜体变体。
+ Typeface.create(Typeface family, int style): 
+ 基于一个现有的 Typeface 对象（代表一个家族或特定字体），创建具有不同样式的 Typeface。
+ **示例：** Kotlin

```kotlin
val baseMono: Typeface = Typeface.MONOSPACE
val monoBold: Typeface? = Typeface.create(baseMono, Typeface.BOLD)
```

Java

```java
Typeface baseMono = Typeface.MONOSPACE;
Typeface monoBold = Typeface.create(baseMono, Typeface.BOLD);
```

**3. 将 Typeface 应用到 TextView**

获取到 Typeface 对象后，可以通过 TextView 的 `setTypeface()` 方法将其应用：

+ textView.setTypeface(Typeface tf): (推荐) 
    - 直接将 TextView 的字体设置为指定的 Typeface 对象。这个 Typeface 对象应该**本身就代表了你想要的字重和样式**。
    - **示例：** Kotlin

```kotlin
val myTextView: TextView = findViewById(R.id.my_text_view)
val robotoMedium: Typeface? = Typeface.create("sans-serif-medium", Typeface.NORMAL)
// 应用 Roboto Medium
robotoMedium?.let { myTextView.typeface = it } // 使用属性访问语法
// 或者 myTextView.setTypeface(robotoMedium)
```

Java

```java
TextView myTextView = findViewById(R.id.my_text_view);
Typeface robotoMedium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
// 应用 Roboto Medium
if (robotoMedium != null) {
    myTextView.setTypeface(robotoMedium);
}
```

+ textView.setTypeface(Typeface tf, int style): (需谨慎使用) 
    - 这个重载方法允许你传入一个基础 Typeface 和一个 style 常量。
    - **行为：** 系统会首先尝试在传入的 tf 代表的字体家族中寻找与 style 匹配的变体。如果找不到，它可能会尝试**算法模拟**粗体或斜体。算法模拟的效果通常较差，可能导致字形变形。
    - **建议：** 尽量避免使用这个方法，除非你明确知道基础 Typeface 不包含特定样式而你又希望系统尝试模拟。优先使用 setTypeface(Typeface tf) 并传入一个本身就代表了正确字重/样式的 Typeface 对象。

**4. 在自定义 View 中使用 Typeface**

如果你在自定义 View 的 `onDraw()` 方法中使用 Canvas 和 Paint 直接绘制文本，可以通过 `paint.setTypeface(Typeface tf)` 来设置绘制时使用的字体。

Kotlin

```kotlin
// Kotlin 示例 (在自定义 View 的 onDraw 内)
override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val textPaint = Paint().apply {
        color = Color.BLACK
        textSize = 60f
        typeface = Typeface.create("sans-serif-thin", Typeface.NORMAL) // 设置字体
    }
    canvas.drawText("Custom Drawn Text", 50f, 100f, textPaint)
}
```

**5. 性能提示：缓存 Typeface 对象**

**重要：** 加载字体文件并创建 Typeface 对象是一个相对**耗时且耗内存**的操作。如果在代码中频繁地创建同一个字体的 Typeface 实例（例如，在 RecyclerView 的 onBindViewHolder 中），会对性能产生显著影响。

**最佳实践：** 对加载的 Typeface 对象进行**缓存**。

+ **简单缓存策略（示例）：** Kotlin

```kotlin
// Kotlin - 使用对象或伴生对象实现简单缓存
object TypefaceCache {
    private val cache = mutableMapOf<String, Typeface?>()
    private val lock = Any()

    fun getTypeface(context: Context, fontName: String): Typeface? {
        synchronized(lock) {
            if (!cache.containsKey(fontName)) {
                cache[fontName] = try {
                    // 假设 fontName 是 "sans-serif-light" 或 "@font/my_font" 形式
                    if (fontName.startsWith("@font/")) {
                        val resId = context.resources.getIdentifier(
                            fontName.substring(6), // 去掉 "@font/"
                            "font",
                            context.packageName
                        )
                        if (resId != 0) ResourcesCompat.getFont(context, resId) else null
                    } else {
                        Typeface.create(fontName, Typeface.NORMAL)
                    }
                } catch (e: Exception) {
                    Log.e("TypefaceCache", "Could not get typeface: $fontName", e)
                    null
                }
            }
            return cache[fontName]
        }
    }
}

// 使用:
// val myTypeface = TypefaceCache.getTypeface(context, "sans-serif-medium")
// val customTypeface = TypefaceCache.getTypeface(context, "@font/my_custom_font")
// myTextView.typeface = myTypeface
```

(Java 实现类似，可以使用静态 Map 和同步块)

+ **更健壮的策略：** 可以结合 LruCache，或者在 ViewModel/Repository/Singleton 中管理 Typeface 实例。关键思想是**避免重复加载同一个字体文件**。

**小结：** Typeface 类是在代码中操作字体的核心。使用静态常量或 create() 方法获取系统字体实例，使用 textView.setTypeface() 应用。务必缓存加载的 Typeface 对象以避免性能问题。

---

---

> 下一篇我们将探讨「个性化表达：打包和使用自定义字体」，敬请关注本系列。

**「从像素到灵魂：深入解析字体排印与 Android 字体架构」系列目录**

1. 万丈高楼平地起：奠定字体排印的坚实基础
2. 初识门径：字体的基本分类
3. 分小结与展望
4. 从曲线到像素——字体渲染管线揭秘
5. 无规矩不成方圆——字体授权与合规
6. Android 的原生字体生态：Roboto、Noto 与字体回退
7. **指令式操作：在代码中动态设置字体**（本文）
8. 个性化表达：打包和使用自定义字体
9. 分总结与展望
10. 千变万化，始于一文：可变字体 (Variable Fonts)
11. 未雨绸缪：字体预加载 (Font Preloading)
12. 放眼全球：国际化 (I18N) 与字体再思考
13. 千挑万选：为你的 App 选择合适的字体
14. 现代 UI 的字体之道：Jetpack Compose 中的实践
15. 包容性设计：无障碍 (Accessibility) 与字体
