---
title: "Android Official Skills Deep Dive: Redefining Android Development Workflows with AI Agents"
lang: en
translationKey: android-official-skills-ai-agent
slug: android-official-skills-ai-agent
excerpt: "A deep dive into Google's official android/skills repository, a structured instruction set for AI agents that covers Compose migration, Navigation 3, R8 optimization, and other core Android workflows."
publishDate: 2026-04-15
tags:
  - Android
  - AI Agent
  - Jetpack Compose
  - Performance Optimization
  - Developer Tools
seo:
  title: "Android Official Skills: AI Agent Workflows for Android Developers"
  description: "Explore Google's android/skills repository for AI agents, covering Compose migration, Navigation 3, R8 analysis, Billing Library upgrades, and more."
  pageType: article
---

I recently came across an interesting GitHub repository: `android/skills`. It launched in March and had already reached nearly 700 stars in less than a month. At first the name made it look like a new sample project, but opening it made the intent clear: this is not documentation for human engineers. It is a set of skill manuals for AI agents.

That idea is worth looking at seriously.

## This is not documentation. It is an operating manual for agents

Traditional Android documentation is written for humans. You search developer.android.com, read the material, understand it, and implement the change yourself. `android/skills` does something different: it packages the whole "read, understand, execute" workflow into structured instructions that tools such as Cursor, Gemini CLI, and Android Studio AI can consume directly.

It follows the open [agentskills.io](https://agentskills.io/home) standard. The core file for each Skill is `SKILL.md`, with YAML frontmatter for `name`, `description`, and `keywords` so agents can search and index it. The file structure looks like this:

```text
skill-name/
  SKILL.md          # AI-readable technical specification
  references/       # Detailed reference docs, mirrored from official guides in Markdown
```

The content structure of `SKILL.md` is fixed: task goal, phased steps, code examples, and **Mandatory rules**. The last section is especially interesting. It explicitly lists what the AI must not do, preventing common mistakes at the instruction level.

The repository currently contains six Skills:

```text
build/agp/agp-9-upgrade
jetpack-compose/migration/migrate-xml-views-to-jetpack-compose
navigation/navigation-3
performance/r8-analyzer
play/play-billing-library-version-upgrade
system/edge-to-edge
```

These six topics are not random. They precisely target the migration pain points that Android teams will face most often in 2025 and 2026.

## What the six Skills solve

### Compose migration: a 10-step workflow

`migrate-xml-views-to-jetpack-compose` defines a 10-step migration workflow. Two details stand out.

First, it requires the agent to **capture screenshots of the original XML UI before migration**, then run visual comparison after the migration is complete. This step is often skipped during manual migration, only for reviewers to discover spacing issues or color drift later.

Second, theme migration has a clear Mandatory rule: **do not migrate the entire theme at once; migrate only the parts required by the current target component**. This directly blocks the AI's temptation to do everything in one sweep, which is one of the most common failure modes in AI-assisted migration.

The interop layer is also specified concretely:

```kotlin
// Embed Compose inside the View system
val composeView = ComposeView(context).apply {
    setContent {
        MyComposable()
    }
}

// Embed a View inside Compose
AndroidView(
    factory = { ctx -> MyLegacyView(ctx) },
    update = { view -> view.text = state.text }
)
```

### Navigation 3: not an upgrade, a rewrite

Navigation 3 is the most technically substantial of the six Skills. It is not a compatibility upgrade from Navigation 2. It is an **architectural rewrite** with the core concepts replaced:

| Navigation 2 | Navigation 3 |
|---|---|
| String-based route | `NavKey` with type safety |
| `NavHost` | `NavDisplay` |
| destination | `Scene` |

The `NavDisplay` plus `entryProvider` DSL feels closer to Compose's design philosophy:

```kotlin
NavDisplay(
    backStack = backStack,
    entryProvider = entryProvider {
        entry<HomeKey> { HomeScreen() }
        entry<DetailKey> { key -> DetailScreen(key.id) }
    }
)
```

Multiple back stacks, conditional navigation, deep links, and returning results all have corresponding Skill steps. The migration path is Navigation 2 to type-safe Navigation 2 to Navigation 3, supported by an official migration guide, so teams do not have to jump in one step.

My read is that Navigation 3 will not forcibly replace Navigation 2 in the short term, but it is a reasonable default for new projects.

### R8 Analyzer: pay down keep rules as technical debt

This Skill addresses an underestimated problem: many projects have ProGuard files full of old `keep` rules. A large share of them are either redundant or already covered by AGP or library-provided consumer rules.

R8 Analyzer's core idea is **Impact Hierarchy**. It grades each keep rule by its scope of impact and identifies which rules subsume others, so it can recommend deleting broad rules and keeping precise ones.

For example, if both of these rules exist:

```plaintext
-keep class com.example.** { *; }
-keep class com.example.model.UserModel { *; }
```

The second rule is completely covered by the first and can be removed. The first rule itself is too broad and should be replaced with something more precise.

The Skill also states clearly that keep rules for Google, AndroidX, Kotlin, Room, Gson, and Retrofit **usually do not need to be added manually**, because these libraries ship consumer ProGuard rules. In real projects, I have found that roughly 30 to 40 percent of manually added keep rules fall into this redundant category.

### Billing Library upgrade: infer the real version from code

The Play Billing Library upgrade Skill has a smart design choice: it does not determine the current version by reading the version number in `build.gradle`. Instead, it infers the **Effective Version** by checking whether deprecated APIs such as `SkuDetails` still exist in code.

The reason is practical. A project may say v6 in `build.gradle` while still using v4 APIs everywhere, meaning someone changed only the dependency version and never adapted the code. Upgrading straight from that state to the latest version would produce a large number of compile errors that are hard to localize.

The migration strategy has two paths:

- If the effective version is within **two** major versions of the target version: Direct Migration
- If the gap is **greater than two** major versions: Stepped Migration, crossing at most two major versions at a time and verifying compilation after each step

### Edge-to-Edge: the right way to handle IME

The `edge-to-edge` Skill is the one with the most immediate reference value for me, especially its IME handling section.

For projects with targetSdk 35 or higher, Edge-to-Edge is mandatory, but inset handling has a priority order:

1. **Preferred**: pass `Scaffold`'s `innerPadding`
2. Material 3 components such as `TopAppBar` and `NavigationBar` handle insets automatically
3. In non-Scaffold scenarios: `Modifier.safeDrawingPadding()`
4. In deeply nested layouts: `Modifier.fitInside(WindowInsetsRulers.SafeDrawing.current)`

IME handling has a high-frequency pitfall that the Skill calls out as a Mandatory rule:

```kotlin
// Incorrect: causes double padding
Scaffold(contentWindowInsets = WindowInsets.safeDrawing) {
    Column(modifier = Modifier.imePadding()) { ... }
}

// Correct: use the newer API, with less jank
Column(
    modifier = Modifier.fitInside(WindowInsetsRulers.Ime.current)
) { ... }
```

`fitInside(WindowInsetsRulers.Ime.current)` is preferred over `imePadding()`, with noticeably less animation jank when the keyboard appears. There is also a detail for navigation bars: when using `BottomAppBar` or `NavigationBar`, set:

```kotlin
// Prevent the system from adding a translucent overlay over the navigation bar on SDK 29+
window.isNavigationBarContrastEnforced = false
```

### AGP 9 upgrade: kapt has finally reached the exit

The `agp-9-upgrade` migration flow has five steps. The most meaningful one is migrating from kapt to KSP. AGP 9 does not forcibly remove kapt, but the Skill explicitly recommends migrating to KSP 2.3.6 or later because KSP's incremental compilation performance is significantly better than kapt's.

If the project is currently below AGP 8, the recommendation is to first use the **Android Studio AGP Upgrade Assistant** for the basic upgrade, then run this Skill. Jumping directly across major versions tends to create problems that are hard to locate.

One known compatibility issue: Paparazzi v2.0.0-alpha04 and earlier are incompatible with AGP 9. Projects using Paparazzi for screenshot tests need to verify this version before upgrading.

## The engineering value of SKILL.md as human-agent collaboration documentation

Looking at these six Skills together, a common pattern emerges: they are not just lists of steps for "how to do it." More importantly, they embed **decision logic** and **error-prevention rules**.

Traditional technical documentation is read linearly, and engineers decide which rules apply to their own scenario. The design of `SKILL.md` forces that judgment to be made explicit. Billing's Effective Version detection, R8's Impact Hierarchy, and Compose's minimal migration principle are all judgment logic, not mere operational steps.

From that perspective, `android/skills` is doing something specific: extracting senior engineers' engineering judgment into executable specifications, then distributing that judgment to the whole team through AI agents. It is closer to an automated code review standard than to an ordinary documentation repository.

The standard is still young, and six Skills only cover part of the Android surface. But the direction is clear: as Android Studio Gemini, Cursor, and other AI IDEs become common, agent skills will gradually become a standard vehicle for engineering rules, much like `.editorconfig` standardized code formatting. `SKILL.md` will standardize the behavioral boundaries of AI-assisted development.

For engineers today, two things are immediately useful. First, use the `edge-to-edge` and `r8-analyzer` Skills directly; their rules are just as valuable for manual work. Second, watch the evolution of the agentskills.io standard. If your team already uses AI-assisted development, building your own project Skills on top of `android/skills` is an engineering investment worth considering.
