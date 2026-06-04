---
title: "From Pixels to Soul: Typography and Android Font Architecture, Part 14"
lang: en
translationKey: android-typography-font-architecture-part14
slug: android-typography-font-architecture-part14
excerpt: "Part 14 shows how to define FontFamily, use Downloadable Fonts, and centralize typography in Jetpack Compose themes."
publishDate: '2026-01-12'
displayInBlog: false
tags:
- "Android"
- "Fonts"
- "Typography"
- "UI"
series:
  name: "From Pixels to Soul: Typography and Android Font Architecture"
  part: 14
  total: 15
seo:
  title: "Jetpack Compose Typography: FontFamily, Google Fonts, and Themes"
  description: "Learn practical Jetpack Compose typography with Text, FontFamily, packaged fonts, Google Fonts, and MaterialTheme Typography."
  pageType: article
---
> This is part 14 of the 15-part series "From Pixels to Soul: Typography and Android Font Architecture." In the previous part, we covered "Choosing the Right Font for Your App."

## Chapter 3: Modern UI Typography: Practice in Jetpack Compose

Jetpack Compose, Android's modern UI toolkit, provides a declarative way to build interfaces. Its font handling is also simpler and more type-safe.

**1. The Text composable and core parameters**

In Compose, `androidx.compose.material.Text`, or `androidx.compose.foundation.text.BasicText`, is the core composable for displaying text. Font-related styling is usually passed directly as parameters.

Kotlin:

```kotlin
import androidx.compose.material.Text
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color

@Composable
fun SimpleText() {
    Text(
        text = "Hello Compose!",
        color = Color.Blue,
        fontSize = 20.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace, // Use the system monospace font.
        letterSpacing = 1.sp,
        lineHeight = 24.sp
        // Other parameters include fontStyle, textAlign, and textDecoration.
    )
}
```

**2. Define FontFamily**

Compose provides flexible ways to define font families through `androidx.compose.ui.text.font.FontFamily`.

- **System fonts:** `FontFamily.Default`, `FontFamily.SansSerif`, `FontFamily.Serif`, `FontFamily.Monospace`, and `FontFamily.Cursive`.
- **Fonts packaged in `res/font`:**
  1. First, place font files such as `.ttf` or `.otf`, or font family XML files, under `res/font`, just as in the View system.
  2. Create a `FontFamily` object in code.

Kotlin:

```kotlin
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import com.myapp.R // Import your R file.

// Define a font family with multiple weights and styles.
val appFontFamily = FontFamily(
    Font(R.font.my_brand_regular, FontWeight.Normal, FontStyle.Normal), // Regular.
    Font(R.font.my_brand_bold, FontWeight.Bold, FontStyle.Normal),      // Bold.
    Font(R.font.my_brand_italic, FontWeight.Normal, FontStyle.Italic),  // Italic.
    Font(R.font.my_brand_light, FontWeight.Light, FontStyle.Normal)     // Light.
    // Add more variants as needed.
)

// Define a font family that contains a single file.
val displayFont = FontFamily(
    Font(R.font.my_display_font, FontWeight.Bold) // FontStyle.Normal by default.
)

// Use the fonts in composables.
Text(text = "Branded Text", fontFamily = appFontFamily, fontWeight = FontWeight.Bold)
Text(text = "Display Heading", fontFamily = displayFont)
```

  - The `Font()` function accepts a resource ID plus optional `FontWeight` and `FontStyle`. Compose automatically chooses the closest matching `Font` definition based on the requested `fontWeight` and `fontStyle`.
- **Downloadable Fonts through Google Fonts:** Compose provides dedicated APIs for asynchronously loading Google Fonts.

1. **Define the provider**, usually once at the theme or app level.

Kotlin:

```kotlin
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.text.font.FontFamily
import com.myapp.R // Import your R file.

// Define the Google Fonts provider. Certificates are required.
val provider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs // Certificate array resource ID.
)
```

2. **Define the font.**

Kotlin:

```kotlin
import androidx.compose.ui.text.googlefonts.Font // Import the Google Fonts Font.

// Define the font to download, Lato in this example.
val latoFontName = GoogleFont("Lato")

// Create the FontFamily.
val latoFontFamily = FontFamily(
    Font(googleFont = latoFontName, fontProvider = provider, weight = FontWeight.Normal),
    Font(googleFont = latoFontName, fontProvider = provider, weight = FontWeight.Bold),
    Font(googleFont = latoFontName, fontProvider = provider, weight = FontWeight.Light)
)
```

3. **Use it in a composable.**

Kotlin:

```kotlin
Text(text = "Downloaded Lato Bold", fontFamily = latoFontFamily, fontWeight = FontWeight.Bold)
```

Compose loads the font asynchronously in the background. Before loading completes, it may use a fallback font. You can also use `androidx.compose.ui.text.font.createFontFamilyResolver(context)` and `resolveAsynchronous` for finer control over loading state.

**3. Typography in MaterialTheme: the core Compose practice**

As with the View system, Compose strongly recommends centralizing text styles in the theme's `Typography`.

- Define `Typography`.

Kotlin:

```kotlin
import androidx.compose.material.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Assume appFontFamily has been defined as above.

val AppTypography = Typography(
    h1 = TextStyle(
        fontFamily = displayFont, // Use the displayFont defined above.
        fontWeight = FontWeight.Bold,
        fontSize = 96.sp
    ),
    h6 = TextStyle(
        fontFamily = appFontFamily,
        fontWeight = FontWeight.Medium, // Use the Medium weight.
        fontSize = 20.sp,
        letterSpacing = 0.15.sp
    ),
    body1 = TextStyle(
        fontFamily = appFontFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp
    ),
    button = TextStyle(
        fontFamily = appFontFamily,
        fontWeight = FontWeight.Bold, // Button text uses bold.
        fontSize = 14.sp,
        letterSpacing = 1.25.sp
    )
    // Define other TextStyle entries for the Material type scale.
)
```

- Apply it in `MaterialTheme`.

Kotlin:

```kotlin
import androidx.compose.material.MaterialTheme
// Other imports.

@Composable
fun MyAppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colors = if (darkTheme) DarkColorPalette else LightColorPalette

    MaterialTheme(
        colors = colors,
        typography = AppTypography, // Apply the custom Typography.
        shapes = AppShapes,
        content = content
    )
}
```

- **Use theme styles in composables (recommended).**

Kotlin:

```kotlin
import androidx.compose.material.MaterialTheme

@Composable
fun ThemedText() {
    Text(text = "Main Headline", style = MaterialTheme.typography.h1)
    Text(text = "Regular body text.", style = MaterialTheme.typography.body1)
    Button(onClick = { /* handle click */ }) {
        Text(text = "Click Me", style = MaterialTheme.typography.button) // Text inside Button often applies this automatically.
    }
}
```

- **Benefits:** Similar to `TextAppearance` in the View system, this provides excellent consistency, maintainability, and theming. It is the **standard and recommended** way to handle font styles in Compose.

**Compose font summary:** Compose provides type-safe and flexible font handling. Prefer `Typography` in `MaterialTheme` for defining and applying text styles. Use `FontFamily` and `Font` for packaged fonts, and use the Google Fonts API for Downloadable Fonts.

---

---

> In the next part, we will cover "Inclusive Design: Accessibility and Fonts." Stay tuned.

**"From Pixels to Soul: Typography and Android Font Architecture" series index**

1. A Strong Foundation: The Basics of Typography
2. First Steps: Basic Font Classification
3. Part Summary and Outlook
4. From Curves to Pixels: The Font Rendering Pipeline
5. No Rules, No Square: Font Licensing and Compliance
6. Android's Native Font Ecosystem: Roboto, Noto, and Font Fallback
7. Imperative Control: Dynamically Setting Fonts in Code
8. Personal Expression: Packaging and Using Custom Fonts
9. Part Summary and Outlook
10. Infinite Variation from One File: Variable Fonts
11. Planning Ahead: Font Preloading
12. Looking Globally: Rethinking Internationalization (I18N) and Fonts
13. Choosing the Right Font for Your App
14. **Modern UI Typography: Practice in Jetpack Compose** (this article)
15. Inclusive Design: Accessibility and Fonts
