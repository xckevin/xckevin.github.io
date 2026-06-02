---
title: Android 多语言国际化动态化工程实践：从 Configuration 资源系统到 Android 13 App Locale API 的全链路架构解析
excerpt: 深入解析 Android 多语言国际化的全链路方案，涵盖 Configuration 资源系统、ContextWrapper 隔离与 Android 13 Per-App Locale API，并给出 Crowdin 翻译流水线工程实践。
publishDate: '2026-06-01'
tags:
- Android
- Kotlin
- 国际化
- 资源管理
- 架构设计
seo:
  title: Android 多语言国际化动态化工程实践：从 Configuration 资源系统到 Android 13 App Locale API 的全链路架构解析
  description: 深入解析 Android 多语言国际化全链路方案：从 Configuration 资源系统、ContextWrapper 隔离到 Android 13 Per-App Locale API，结合 Crowdin 翻译流水线给出最佳工程实践。
---

接手一个出海 App 时，产品提了需求：用户在 App 内切语言后立刻生效，不用杀进程。当时觉得不就是改个 Locale 么？踩进去才意识到，这背后牵涉了 Android 资源加载机制的一整条链路——从 Configuration 的全局副作用，到 ContextWrapper 拦截方案，再到 Android 13 的系统级 API，每个环节都有坑。

## Configuration 切换的全局副作用

Android 通过 `Configuration.locale` 决定加载 `values-zh` 还是 `values-en`。最粗暴的做法是直接改它：

```kotlin
val config = resources.configuration
config.setLocale(Locale.ENGLISH)
resources.updateConfiguration(config, resources.displayMetrics)
```

`updateConfiguration()` 是进程级全局生效的。Activity A 切了英文，Activity B 也跟着变。更麻烦的是，Configuration 变更默认会触发 Activity 销毁重建——除非在 `AndroidManifest.xml` 里声明 `android:configChanges="locale"` 拦截。

声明了 `configChanges`，Activity 不再重建，但所有 UI 刷新逻辑你得手动写在 `onConfigurationChanged()` 里。每个 Activity 都要处理一遍，维护成本随页面数线性增长。项目做到十几个页面时，光给 `onConfigurationChanged` 补刷新逻辑就够喝一壶的。

## 用 ContextWrapper 做隔离

与其改全局，不如在 Context 层拦截。思路是自定义 `ContextWrapper`，重写 `getResources()`，返回一个 locale 被替换过的 Resources：

```kotlin
class LocaleContextWrapper(base: Context, locale: Locale) : ContextWrapper(base) {
    override fun getResources(): Resources {
        val config = Configuration(super.getResources().configuration)
        config.setLocale(locale)
        return base.createConfigurationContext(config).resources
    }
}
```

在 `BaseActivity.attachBaseContext()` 中挂载：

```kotlin
override fun attachBaseContext(newBase: Context) {
    val locale = Locale(LanguageManager.currentLanguage)
    super.attachBaseContext(LocaleContextWrapper(newBase, locale))
}
```

这个方案把语言切换隔离在单个 Activity 内，不影响全局。Activity 重建时自动应用新的 Locale，不需要手动干预。AppCompat 1.6+ 的 `AppCompatDelegate.setApplicationLocales()` 底层思路与此一致——只不过它把语言偏好持久化到 `AppLocalesMetadataHolderService` 中，在 Application 级别统一管理。

踩过一个坑：**WebView 不搭理你的 ContextWrapper**。WebView 初始化时已经缓存了 `ApplicationContext` 的 Resources，配置变更传不进去。解决方式是在 WebView 创建时显式传入包装过的 Context：

```kotlin
val wrappedContext = LocaleContextWrapper(context, targetLocale)
WebView(wrappedContext)
```

## Android 13 的 Per-App Locale

Android 13 给出了系统级方案：per-app language preferences。用户在系统设置里就能为每个 App 单独设语言，不需要应用内部再搞一套选择器。

核心 API 是 `LocaleManager.setApplicationLocales()`：

```kotlin
val localeManager = context.getSystemService(LocaleManager::class.java)
localeManager.applicationLocales = LocaleList(Locale.forLanguageTag("zh"))
```

调用后系统发送 `ACTION_LOCALE_CHANGED` 广播，所有 Activity 收到后自动重建，新的 Locale 随之生效。不需要 ContextWrapper，也不需要手动管理 Configuration——这是最干净的方案。

但这套 API 有两个硬伤：版本限制（Android 13+），以及它绑定系统设置面板——如果你的 App 需要在应用内做自定义语言选择器，还是得额外维护 UI 和映射逻辑。

实际项目中的做法是封装一层抽象，按版本分发：

```kotlin
object LocaleDelegate {
    fun applyLocale(context: Context, tag: String) {
        val locale = Locale.forLanguageTag(tag)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.getSystemService(LocaleManager::class.java)
                ?.applicationLocales = LocaleList(locale)
        } else {
            LanguageManager.saveLocale(tag)
            // 手动重启 Activity 栈，使 ContextWrapper 生效
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            context.startActivity(intent)
        }
    }
}
```

三种方案的代价对比如下：

| 方案 | 版本要求 | Activity 重建 | 侵入性 |
|------|---------|-------------|--------|
| updateConfiguration | 无 | 需手动处理 | 全局 |
| ContextWrapper | 无 | 自动 | 单 Activity |
| Per-App Locale | ≥13 | 自动 | 零侵入 |

新项目我倾向于直接用 Per-App Locale + ContextWrapper 兜底，不再手写 updateConfiguration 那套。

## Crowdin 翻译流水线

语言切了，翻译内容从哪来？手动维护 `values-zh/strings.xml` 在多语种场景下是灾难。项目接入 Crowdin 后，流程变成了：

1. 开发者只维护英文源文件 `values/strings.xml`
2. CI 通过 Crowdin CLI 推源文件到平台
3. 翻译团队在平台上协作完成各语种
4. CI 定时拉取翻译结果，生成对应的 `values-zh/strings.xml`
5. 构建时直接打包

GitHub Actions 配置精简到几行：

```yaml
- name: Sync translations
  run: |
    crowdin upload sources --config crowdin.yml
    crowdin download --config crowdin.yml
```

流水线跑起来后一个容易忽略的问题是**翻译文件冲突**。翻译团队在 Crowdin 上改过的内容，和开发者在仓库里的提交可能互相覆盖。解法是把翻译产物加进 `.gitignore`——只提交英文源文件，各语种的 `strings.xml` 全部由 CI 生成，不进版本库。

另一个经验是 Key 的命名。`btn_submit` 在中文是「提交」，日文是「送信」，翻译人员靠 Key 名称和注释理解语境。把 Key 写成 `order_confirm_btn` 比 `btn_submit` 直观得多，减少了来回确认的成本。

## 实践要点

不要从零手写 updateConfiguration。AppCompat 1.6+ 的 `setApplicationLocales()` 已经处理了大部分兼容性，新项目直接用 Per-App Locale + ContextWrapper 双轨方案。

翻译源文件入版本库，产物由 CI 生成。`values-zh/` 目录加进 `.gitignore`，避免多人协作的合并冲突。

横竖屏切换、深色模式切换、分屏模式——这些 Configuration 变更的边界场景都要纳入复测范围。WebView、Dialog 的自定义 Context 传递尤其容易遗漏，实际踩坑最多的就是这两个地方。
