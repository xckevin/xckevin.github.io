---
title: "Unified Runtime Skinning for View and Compose with One Theme State"
lang: en
translationKey: android-runtime-skinning-resources-compose
slug: android-runtime-skinning-resources-compose
excerpt: "A unified architecture that shares one theme state across View and Compose, so runtime theme switching works seamlessly without recreating activities."
publishDate: '2026-08-04'
tags:
- "Android"
- "Jetpack Compose"
- "View System"
- "Theming"
seo:
  title: "Unified Runtime Skinning for View and Compose Apps"
  description: "How to switch themes at runtime without recreating activities by intercepting Resources for View and driving Compose through CompositionLocal."
  pageType: article
---

I once took over a reading app with tens of millions of daily active users. The product required runtime, seamless switching between night mode and multiple themes, without recreating the Activity. At the time, the team mixed View and Compose, and the skinning logic for the two UI systems was completely disconnected; every theme change had to be maintained separately.

This forced me to redesign a unified skinning architecture. The core idea: **treat Resources as a replaceable abstraction layer**, let the View system implement skinning by intercepting resource loading, and let the Compose system drive recomposition through `CompositionLocal`. Both share the same theme state and are dispatched from a single entry point.

## Overall Architecture: Single Source of Truth + Dual Rendering Channels

Let's start with the top-level design of the architecture:

```
┌─────────────────────────────────┐
│       ThemeState (Kotlin)       │  ← 全局单例，持有当前主题 ID
└──────────┬──────────────────────┘
           │
     ┌─────┴──────┐
     ▼            ▼
┌─────────┐  ┌──────────────┐
│  View   │  │   Compose    │
│ 通道    │  │   通道        │
│         │  │              │
│Resources│  │CompositionLcl│
│ 替换    │  │ 主题分发     │
└─────────┘  └──────────────┘
```

`ThemeState` is driven by `StateFlow`. The View layer listens for updates through `addOnPropertyChangedCallback`, while the Compose layer automatically recomposes through `collectAsState`. The triggering of both channels is controlled entirely by this single source of state.

## View Channel: Intercepting the Resources Loading Path

Skinning in the View system is essentially **redirection at the resource lookup stage**. Android resource loading eventually funnels into methods such as `Resources.getColor()` and `Resources.getDrawable()`. By replacing the `Resources` instance, you can take over all resource retrieval.

### Create a Replaceable Resources Wrapper Class

```kotlin
class SkinResources(
    private val context: Context,
    private val skinPkgName: String,
    private val skinRes: Resources  // 皮肤包的 Resources
) : Resources(context.assets, context.resources.displayMetrics, context.resources.configuration) {

    override fun getColor(id: Int, theme: Theme?): Int {
        val entryName = context.resources.getResourceEntryName(id)
        val skinId = skinRes.getIdentifier(entryName, "color", skinPkgName)
        return if (skinId != 0) skinRes.getColor(skinId, theme)
        else super.getColor(id, theme)  // 兜底到宿主资源
    }

    override fun getDrawable(id: Int, theme: Theme?): Drawable {
        val entryName = context.resources.getResourceEntryName(id)
        val skinId = skinRes.getIdentifier(entryName, "drawable", skinPkgName)
        return if (skinId != 0) {
            val drawable = skinRes.getDrawable(skinId, theme)
            // 关键：处理涉及宿主类的 Drawable（如 VectorDrawable）
            SkinDrawableProcessor.process(drawable, id)
        } else super.getDrawable(id, theme)
    }
}
```

A `Drawable` loaded from an external APK may internally reference classes from the host app (for example, a custom `VectorDrawable` subclass). Using it directly throws `ClassNotFoundException`. You need to handle this at a higher layer with reflection or wrap it in a common base class — this pitfall is discussed in detail later.

### Replacing the Context's Resources

The hard part is not creating `SkinResources`, but **globally replacing the Context used by all Views**. There are two entry points:

**Entry point one: replace the Application's Resources.** Calling `setResources()` directly on `Application` has too broad an impact and is risky.

**Entry point two: replace the Activity's Resources.** Inject it at the end of `Activity.onCreate()`, after `super.onCreate()`. It only takes effect within the Activity scope, keeping the impact manageable:

```kotlin
abstract class BaseActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applySkinIfNeeded()
    }

    private fun applySkinIfNeeded() {
        val skinEngine = SkinEngine.instance
        if (skinEngine.isSkinApplied) {
            resources  // 触发 Resources 对象创建
            // 反射替换 Activity 内部的 mResources
            SkinReflectHelper.setResources(this, skinEngine.skinResources)
        }
    }
}
```

To be clear, this reflection-based approach is **not a reliable universal solution**, and it has two kinds of limitations:

1. **Version fragility.** `mResources` is only an internal AOSP field name and is not covered by any field naming contract. It can change across vendor ROMs and major Android versions (including both field renames and structural changes — for example, resource access on newer versions moved to centralized management by `ResourcesManager`). You need to adapt the reflection path version by version and provide a fallback when reflection fails; you cannot assume it will succeed on all devices.
2. **It does not cover paths that have cached Resources references.** Replacing only the Activity's `mResources` field does not automatically sync to places that cached the old `Resources` reference before `onCreate` (for example, a custom View that saved `context.resources` in a field early on, or a singleton that pulled in Resources during initialization and holds onto it long-term). These places need business code to ensure it does not cache Resources references, or to proactively rebuild those components when the theme switches.

In real projects, this usually needs to be paired with compatibility handling from open-source solutions (such as Android-Skin-Loader and Android-Skin-Support), along with thorough regression testing across a matrix of target devices before adoption — rather than treating reflection replacement as a technique that can cover all scenarios once and for all.

### Handling LayoutInflater: Intercepting View Creation

Replacing Resources is not enough. When inflating XML, `LayoutInflater` reads attributes by default through `context.obtainStyledAttributes()`, but if the XML references custom attributes (`attr`), swapping Resources alone does not help — you need to intercept at the `Factory2` level:

```kotlin
class SkinLayoutFactory(
    private val delegate: LayoutInflater.Factory2
) : LayoutInflater.Factory2 {
    override fun onCreateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? {
        val view = delegate.onCreateView(parent, name, context, attrs) ?: return null
        // 从 AttributeSet 中提取换肤相关属性
        SkinAttributeParser.parseAndApply(view, attrs)
        return view
    }
}
```

`SkinAttributeParser` is responsible for parsing attributes such as `background`, `textColor`, and `src`, keeping track of the original resource IDs, and reapplying them when the theme switches. At its core is a `Map<View, List<SkinAttr>>` that records which attributes each View needs for skinning.

## Compose Channel: CompositionLocal Drives Declarative Theming

Compose takes a completely different approach to skinning — it has no `Resources` interception mechanism, but it offers the more elegant `CompositionLocal`. A theme is essentially a `data class` injected into the composition tree through `CompositionLocalProvider`.

### Define the Theme Data Structure

```kotlin
data class AppTheme(
    val colors: ColorScheme,
    val typography: TypographyScheme,
    val isDark: Boolean
)

// 全局主题值，MaterialTheme 之外的补充
val LocalAppTheme = staticCompositionLocalOf { AppTheme() }
```

Use `staticCompositionLocalOf` rather than `compositionLocalOf`: theme changes are infrequent, so there is no need to precisely track every component.

### How Theme Switching Is Triggered

```kotlin
@Composable
fun ThemeHost(content: @Composable () -> Unit) {
    val currentThemeId by ThemeState.themeId.collectAsState()
    val theme = remember(currentThemeId) {
        ThemeLoader.loadTheme(currentThemeId)  // 加载对应主题配置
    }
    CompositionLocalProvider(
        LocalAppTheme provides theme
    ) {
        content()
    }
}
```

When `ThemeState.themeId` changes, `collectAsState` triggers recomposition of `ThemeHost`, and all components that consume `LocalAppTheme` refresh automatically — no need to manually notify a single View.

### Handling Resource-Based Assets

Compose also has some resources defined in XML (such as `painterResource`), which cannot be intercepted the way the View channel does. The approach is to select dynamically at load time:

```kotlin
@Composable
fun skinPainterResource(@DrawableRes defaultRes: Int): Painter {
    val theme = LocalAppTheme.current
    return remember(theme) {
        val skinResId = SkinBridge.getSkinDrawableId(defaultRes, theme.id)
        if (skinResId != 0) painterResource(skinResId)
        else painterResource(defaultRes)
    }
}
```

## Pitfalls Encountered: Several Key Details

**Pitfall one: Configuration changes reset Resources.** When the screen orientation or locale changes, the Activity's `Resources` is rebuilt by the system. You need to re-inject `SkinResources` in `onConfigurationChanged`. If you use `android:configChanges` to brute-force handle it, this issue is not triggered — but it introduces many other side effects, so it is not recommended.

**Pitfall two: `VectorDrawable` loading across packages.** When a `VectorDrawable` packaged in a skin APK is loaded into the host app, it crashes directly if it references the host app's `R.attr` or a custom class. The solution is to make skin package resources fully self-contained, or catch the exception in `SkinResources.getDrawable()` and fall back to a default image.

**Pitfall three: theme desynchronization when mixing Compose and View.** After `ThemeState` updates, the View channel refreshes by manually iterating over the View list recorded in `SkinAttributeParser`, while Compose updates automatically through recomposition. Both must be triggered from the same dispatch entry point; otherwise, there can be brief visual inconsistencies:

```kotlin
fun switchTheme(themeId: Int) {
    ThemeState.themeId.value = themeId         // 触发 Compose 重组
    SkinAttributeParser.applySkinForAllViews() // 触发 View 刷新
}
```

Compose has frame-rate control, so its actual rendering is asynchronous, whereas View refreshing is synchronous. In practice, the two finish almost simultaneously, and the difference is imperceptible to the naked eye.

## Two Practical Recommendations

**Prefer modeling themes as data classes rather than resource files.** Whether for View or Compose, I prefer to define theme data structures at the Kotlin layer (`ColorScheme`, `Dimensions`, and so on), using resource files only as reading entry points and not for state storage. Theme switching then becomes switching data structures in memory, with nearly zero latency and no need to re-parse APKs.

**Do not blindly chase "runtime loading of external skin packages".** Loading Resources from an external APK requires handling signature consistency, `ClassLoader` isolation, resource ID conflicts, and other issues. If the product only needs 3–5 built-in themes, a resource variant approach is sufficient (build different flavors, or put a configuration JSON plus color codes in assets). The full Resources replacement scheme is worth investing in only for scenarios that genuinely need user-customized skins or dynamic delivery by operations. After stepping into this pit once, I became much more pragmatic when evaluating requirements later.
