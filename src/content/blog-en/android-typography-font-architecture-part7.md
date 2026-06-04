---
title: "From Pixels to Soul: Android Typography and Font Architecture, Part 7"
lang: en
translationKey: android-typography-font-architecture-part7
slug: android-typography-font-architecture-part7
excerpt: "Part 7 explains how to set fonts dynamically in Android code with Typeface, TextView, custom Views, and practical Typeface caching."
publishDate: '2026-01-12'
displayInBlog: false
tags:
- "Android"
- "Fonts"
- "Typography"
- "UI"
series:
  name: "From Pixels to Soul: Android Typography and Font Architecture"
  part: 7
  total: 15
seo:
  title: "Android Typography Part 7: Setting Fonts Dynamically in Code"
  description: "Use Android Typeface APIs to load system fonts, apply them to TextView and custom Views, and cache font objects for better performance."
  pageType: article
---
> This is part 7 of 15 in the "From Pixels to Soul: Android Typography and Font Architecture" series. The previous article covered Android's native font ecosystem, Roboto, Noto, and font fallback.

## Chapter 3: Imperative Control: Setting Fonts Dynamically in Code

XML layouts are the main way to set fonts, but some situations require changing the font of text controls at runtime through Java or Kotlin. For example, you may load a different font based on user preferences, or draw text directly inside a custom `View`.

**1. Core class: Typeface**

In Android code, the `android.graphics.Typeface` class is the object-oriented representation of a font. A `Typeface` object usually represents a concrete font file and its intrinsic weight and style.

**2. Getting Typeface instances for system fonts**

The `Typeface` class provides static constants and factory methods for retrieving predefined system font instances:

+ **Common static constants:**
    - `Typeface.DEFAULT`: Gets the system default font, usually Roboto Regular.
    - `Typeface.DEFAULT_BOLD`: Gets the system default bold font, usually Roboto Bold.
    - `Typeface.SANS_SERIF`: Gets the generic sans-serif family, usually Roboto.
    - `Typeface.SERIF`: Gets the generic serif family, usually Noto Serif.
    - `Typeface.MONOSPACE`: Gets the generic monospace family, usually Noto Mono.

Kotlin

```kotlin
// Kotlin example
val defaultTypeface: Typeface = Typeface.DEFAULT
val sansSerifTypeface: Typeface = Typeface.SANS_SERIF
```

Java

```java
// Java example
Typeface defaultTypeface = Typeface.DEFAULT;
Typeface sansSerifTypeface = Typeface.SANS_SERIF;
```

+ `Typeface.create(String familyName, int style)`, a more flexible option:
    - Creates a `Typeface` from a font family name, such as `"sans-serif-light"` from XML, and a style constant.
    - Style constants include:
        * `Typeface.NORMAL`
        * `Typeface.BOLD`
        * `Typeface.ITALIC`
        * `Typeface.BOLD_ITALIC`
    - **Example in Kotlin:**

```kotlin
// Get Roboto Light
val robotoLight: Typeface? = Typeface.create("sans-serif-light", Typeface.NORMAL)

// Get Monospace Bold Italic
val monoBoldItalic: Typeface? = Typeface.create("monospace", Typeface.BOLD_ITALIC)
```

Java

```java
// Get Roboto Light
Typeface robotoLight = Typeface.create("sans-serif-light", Typeface.NORMAL);

// Get Monospace Bold Italic
Typeface monoBoldItalic = Typeface.create("monospace", Typeface.BOLD_ITALIC);
```

+ **Note:** `create()` may return `null`, although this is unusual for standard system family names. It tries to find the closest matching font file. The `style` parameter mainly selects an existing bold or italic variant inside the family.
+ `Typeface.create(Typeface family, int style)`:
+ Creates a `Typeface` with a different style based on an existing `Typeface` object that represents a family or concrete font.
+ **Example in Kotlin:**

```kotlin
val baseMono: Typeface = Typeface.MONOSPACE
val monoBold: Typeface? = Typeface.create(baseMono, Typeface.BOLD)
```

Java

```java
Typeface baseMono = Typeface.MONOSPACE;
Typeface monoBold = Typeface.create(baseMono, Typeface.BOLD);
```

**3. Applying Typeface to TextView**

After you have a `Typeface` object, apply it with `TextView`'s `setTypeface()` method:

+ `textView.setTypeface(Typeface tf)`, recommended:
    - Directly sets the `TextView` font to the specified `Typeface`. The `Typeface` object should **already represent the weight and style you want**.
    - **Example in Kotlin:**

```kotlin
val myTextView: TextView = findViewById(R.id.my_text_view)
val robotoMedium: Typeface? = Typeface.create("sans-serif-medium", Typeface.NORMAL)
// Apply Roboto Medium
robotoMedium?.let { myTextView.typeface = it } // Use property access syntax
// Or myTextView.setTypeface(robotoMedium)
```

Java

```java
TextView myTextView = findViewById(R.id.my_text_view);
Typeface robotoMedium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
// Apply Roboto Medium
if (robotoMedium != null) {
    myTextView.setTypeface(robotoMedium);
}
```

+ `textView.setTypeface(Typeface tf, int style)`, use with care:
    - This overload lets you pass a base `Typeface` and a style constant.
    - **Behavior:** The system first tries to find a variant matching `style` in the font family represented by `tf`. If no match exists, it may try **algorithmic simulation** for bold or italic. Algorithmic simulation usually looks worse and can distort glyphs.
    - **Advice:** Avoid this overload when possible, unless you know the base `Typeface` does not contain a given style and you explicitly want the system to simulate it. Prefer `setTypeface(Typeface tf)` with a `Typeface` that already represents the correct weight and style.

**4. Using Typeface in custom Views**

If you draw text directly with `Canvas` and `Paint` inside a custom `View`'s `onDraw()` method, set the font with `paint.setTypeface(Typeface tf)`.

Kotlin

```kotlin
// Kotlin example inside a custom View's onDraw
override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val textPaint = Paint().apply {
        color = Color.BLACK
        textSize = 60f
        typeface = Typeface.create("sans-serif-thin", Typeface.NORMAL) // Set the font
    }
    canvas.drawText("Custom Drawn Text", 50f, 100f, textPaint)
}
```

**5. Performance tip: cache Typeface objects**

**Important:** Loading font files and creating `Typeface` objects is relatively **expensive in time and memory**. If code repeatedly creates `Typeface` instances for the same font, for example inside `RecyclerView.onBindViewHolder`, performance can suffer noticeably.

**Best practice:** **Cache** loaded `Typeface` objects.

+ **Simple cache strategy, Kotlin example:**

```kotlin
// Kotlin: use an object or companion object for a simple cache
object TypefaceCache {
    private val cache = mutableMapOf<String, Typeface?>()
    private val lock = Any()

    fun getTypeface(context: Context, fontName: String): Typeface? {
        synchronized(lock) {
            if (!cache.containsKey(fontName)) {
                cache[fontName] = try {
                    // Assume fontName is in the form "sans-serif-light" or "@font/my_font"
                    if (fontName.startsWith("@font/")) {
                        val resId = context.resources.getIdentifier(
                            fontName.substring(6), // Remove "@font/"
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

// Usage:
// val myTypeface = TypefaceCache.getTypeface(context, "sans-serif-medium")
// val customTypeface = TypefaceCache.getTypeface(context, "@font/my_custom_font")
// myTextView.typeface = myTypeface
```

A Java implementation is similar and can use a static `Map` plus synchronized blocks.

+ **More robust strategies:** You can combine this with `LruCache`, or manage `Typeface` instances in a `ViewModel`, repository, or singleton. The key idea is to **avoid repeatedly loading the same font file**.

**Summary:** `Typeface` is the core class for manipulating fonts in code. Use static constants or `create()` to get system font instances, and apply them with `textView.setTypeface()`. Always cache loaded `Typeface` objects to avoid performance problems.

---

---

> Next, we will explore "Personal Expression: Packaging and Using Custom Fonts" in this series.

**"From Pixels to Soul: Android Typography and Font Architecture" series index**

1. Building on Solid Ground: The Foundations of Typography
2. First Steps: Basic Font Classification
3. Part Summary and Outlook
4. From Curves to Pixels: The Font Rendering Pipeline
5. Rules Before Use: Font Licensing and Compliance
6. Android's Native Font Ecosystem: Roboto, Noto, and Font Fallback
7. **Imperative Control: Setting Fonts Dynamically in Code** (this article)
8. Personal Expression: Packaging and Using Custom Fonts
9. Part Summary and Outlook
10. Infinite Styles from One File: Variable Fonts
11. Prepare Ahead: Font Preloading
12. Think Globally: Internationalization and Fonts
13. Choosing the Right Font for Your App
14. Typography in Modern UI: Jetpack Compose Practice
15. Inclusive Design: Accessibility and Fonts
