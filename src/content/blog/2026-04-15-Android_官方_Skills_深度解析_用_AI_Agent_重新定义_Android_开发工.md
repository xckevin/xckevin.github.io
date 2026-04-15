---
title: "Android 官方 Skills 深度解析：用 AI Agent 重新定义 Android 开发工作流"
excerpt: "深入解析 Google 官方 android/skills 仓库，这套面向 AI Agent 的结构化指令集涵盖 Compose 迁移、Navigation 3、R8 优化等六大核心场景，重新定义 AI 辅助 Android 开发工作流。"
publishDate: 2026-04-15
tags:
  - Android
  - AI Agent
  - Jetpack Compose
  - 性能优化
  - 开发工具
seo:
  title: "Android 官方 Skills 深度解析：用 AI Agent 重新定义 Android 开发工作流"
  description: "深入解析 Google 官方 android/skills 仓库，面向 AI Agent 的结构化技能指令集，覆盖 Compose 迁移、Navigation 3、R8 分析、Billing Library 升级等核心 Android 开发迁移场景。"
---

最近在逛 GitHub 时发现了一个有点意思的仓库——`android/skills`，3 月份上线，不到一个月已经拿到近 700 Star。看名字以为是某个新的示例项目，点进去才意识到这是完全不同的东西：它不是给人类工程师看的文档，而是给 AI Agent 看的「技能说明书」。

这个思路值得认真聊一聊。

## 这不是文档，是 Agent 的操作手册

传统的 Android 官方文档是面向人类的：你去 developer.android.com 查，读完自己理解，自己动手实现。`android/skills` 做了一件事：把这套「读懂 → 理解 → 执行」的流程直接封装进结构化指令，让 Cursor、Gemini CLI、Android Studio AI 等工具可以直接「消费」。

它遵循 [agentskills.io](https://agentskills.io/home) 开放标准，每个 Skill 的核心文件是 `SKILL.md`，头部带 YAML frontmatter（name / description / keywords），便于 Agent 检索和索引。文件结构如下：

```
skill-name/
  SKILL.md          # AI 可解析的技术规范
  references/       # 详细参考文档（官方指南 Markdown 镜像）
```

`SKILL.md` 的内容结构是固定的：任务目标 → 分阶段步骤 → 代码示例 → **Mandatory rules**（强制规则）。最后这一部分尤其有意思——它明确列出「AI 不得做什么」，相当于在指令层面就预防了常见错误。

目前仓库包含 6 个 Skill：

```
build/agp/agp-9-upgrade
jetpack-compose/migration/migrate-xml-views-to-jetpack-compose
navigation/navigation-3
performance/r8-analyzer
play/play-billing-library-version-upgrade
system/edge-to-edge
```

这 6 个选题不是随机的——它们精准覆盖了 2025-2026 年间 Android 开发最集中的迁移痛点。

## 六个 Skill 在解决什么问题

### Compose 迁移：10 步工作流

`migrate-xml-views-to-jetpack-compose` 定义了一套 10 步迁移工作流，其中有两个细节值得注意。

第一，它要求 Agent 在迁移前先**截图保存原始 XML UI**，迁移完成后进行视觉对比验证。这个步骤在人工迁移时经常被跳过，结果 Review 时才发现间距不对、颜色有偏差。

第二，主题迁移有明确的 Mandatory rule：**不得一次性迁移整个主题，仅迁移当前目标组件所需的部分**。这条规则直接堵死了 AI「一把梭」的冲动——这恰恰是 AI 辅助迁移最常见的踩坑来源。

互操作层的处理也有具体规范：

```kotlin
// 在 View 体系中嵌入 Compose
val composeView = ComposeView(context).apply {
    setContent {
        MyComposable()
    }
}

// 在 Compose 中嵌入 View
AndroidView(
    factory = { ctx -> MyLegacyView(ctx) },
    update = { view -> view.text = state.text }
)
```

### Navigation 3：不是升级，是重写

Navigation 3 是这 6 个 Skill 里技术含量最高的一个。它不是 Navigation 2 的兼容升级，而是**架构层面的重写**，核心概念全部替换：

| Navigation 2 | Navigation 3 |
|---|---|
| String-based route | `NavKey`（类型安全） |
| `NavHost` | `NavDisplay` |
| destination | `Scene` |

`NavDisplay` + `entryProvider` DSL 的声明方式更接近 Compose 的设计哲学：

```kotlin
NavDisplay(
    backStack = backStack,
    entryProvider = entryProvider {
        entry<HomeKey> { HomeScreen() }
        entry<DetailKey> { key -> DetailScreen(key.id) }
    }
)
```

多回退栈、条件导航、Deep Links、返回结果——这些场景 Navigation 3 都有对应的 Skill 步骤。迁移路径是：Navigation 2 → 类型安全 Navigation 2 → Navigation 3，有官方 migration guide 支撑，不用一步跳。

我个人的判断是，Navigation 3 短期内不会强制替换 Navigation 2，但新项目直接上 Navigation 3 是合理选择。

### R8 Analyzer：把 keep 规则当技术债来还

这个 Skill 解决的是一个被低估的问题：很多项目的 ProGuard 文件里堆满了历史遗留的 `keep` 规则，相当一部分要么是冗余的，要么已经被 AGP 或库本身的 consumer rules 覆盖了。

R8 Analyzer 的核心逻辑是 **Impact Hierarchy**：对每条 keep 规则按影响范围分级，识别哪些规则互相包含（subsume），从而建议删除宽泛规则、保留精确的。

比如同时存在这两条规则：

```proguard
-keep class com.example.** { *; }
-keep class com.example.model.UserModel { *; }
```

第二条被第一条完全覆盖，可以删除。而第一条本身范围过宽，应该替换为更精确的规则。

Skill 还明确指出：Google/AndroidX/Kotlin/Room/Gson/Retrofit 的 keep 规则**通常不需要手动添加**，这些库自带 consumer ProGuard rules。在实际项目中我发现，大约 30-40% 的手动 keep 规则属于这类冗余配置。

### Billing Library 升级：用代码判断「真实版本」

Play Billing Library 的升级 Skill 有一个很聪明的设计：它不直接读取 `build.gradle` 里的版本号来判断当前版本，而是通过代码中是否存在**废弃 API**（如 `SkuDetails`）来推断「有效版本（Effective Version）」。

原因在于现实中存在这种情况：`build.gradle` 写的是 v6，但代码里全是 v4 的 API，说明当时只改了版本号没做代码适配。直接按 v6 升到最新版会产生大量编译错误，且极难定位。

迁移策略分两条路：
- 有效版本与目标版本差 **≤ 2** 个主版本 → Direct Migration
- 差 **> 2** 个主版本 → Stepped Migration（每次跨 2 个主版本，每步通过编译验证再继续）

### Edge-to-Edge：IME 处理的正确姿势

`edge-to-edge` 这个 Skill 对我来说即时参考价值最高，尤其是 IME（软键盘）的处理部分。

在 targetSdk ≥ 35 的项目里，Edge-to-Edge 是强制的，但处理 Insets 有优先级顺序：

1. **首选**：通过 `Scaffold` 的 `innerPadding` 传递
2. Material 3 组件（TopAppBar、NavigationBar 等）自动处理
3. 非 Scaffold 场景：`Modifier.safeDrawingPadding()`
4. 深层嵌套：`Modifier.fitInside(WindowInsetsRulers.SafeDrawing.current)`

IME 处理有一个高频踩坑点，Skill 里专门列为 Mandatory rule：

```kotlin
// ❌ 错误：会导致双重 padding
Scaffold(contentWindowInsets = WindowInsets.safeDrawing) {
    Column(modifier = Modifier.imePadding()) { ... }
}

// ✅ 正确：用新 API，jank 更少
Column(
    modifier = Modifier.fitInside(WindowInsetsRulers.Ime.current)
) { ... }
```

`fitInside(WindowInsetsRulers.Ime.current)` 比 `imePadding()` 更推荐，键盘弹出时的动画抖动明显更少。导航栏处理还有一个细节：使用 `BottomAppBar`/`NavigationBar` 时需要：

```kotlin
// 防止系统在导航栏上叠加半透明遮罩（SDK 29+）
window.isNavigationBarContrastEnforced = false
```

### AGP 9 升级：kapt 终于到了该退场的时候

`agp-9-upgrade` 的迁移流程分 5 步，最有意义的是 kapt → KSP 这一步。AGP 9 没有强制删除 kapt，但 Skill 明确建议迁移到 KSP 2.3.6+，原因是 KSP 的增量编译性能显著优于 kapt。

如果项目当前 AGP 版本低于 8，建议先用 **Android Studio AGP Upgrade Assistant** 完成基础升级，再执行这个 Skill。直接跨大版本跳容易产生难以定位的问题。

一个已知的兼容性坑：Paparazzi v2.0.0-alpha04 及以下版本与 AGP 9 不兼容。用 Paparazzi 做截图测试的项目，升级前需要先确认这个版本。

## SKILL.md 作为「人机协同文档」的工程价值

把这 6 个 Skill 放在一起看，能发现一个共同模式：它们不只是「怎么做」的步骤列表，更重要的是内嵌了**决策逻辑**和**防错规则**。

传统技术文档是线性阅读的，工程师自己判断哪些规则适用于自己的场景。SKILL.md 的设计要求把这套判断逻辑显式化——Billing Skill 的 Effective Version 判断、R8 Skill 的 Impact Hierarchy、Compose Skill 的最小化迁移原则，这些都是「判断逻辑」而非「操作步骤」。

从这个角度看，`android/skills` 实际上在做一件事：把资深工程师的工程判断能力提炼成可执行规范，通过 AI Agent 下发给整个团队。它更接近「自动化 Code Review 规范」，而不是普通的文档库。

目前这套标准还很年轻，6 个 Skill 也只覆盖了部分场景。方向是清晰的：随着 Android Studio Gemini、Cursor 等 AI IDE 的普及，agent skills 会逐渐成为工程规范的标准载体——就像 `.editorconfig` 统一了代码格式，`SKILL.md` 会统一 AI 辅助开发的行为边界。

对现阶段的工程师来说，有两件事可以立刻做：直接把 `edge-to-edge` 和 `r8-analyzer` 这两个 Skill 拿来用，其中的规则对人工实施同样有效；关注 agentskills.io 标准的演进，如果团队已经在用 AI 辅助开发，结合 `android/skills` 建立项目自己的 Skill 文件，是值得投入的工程化方向。

