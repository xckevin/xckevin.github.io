---
title: "Progressive Android Compose Migration from Views to Declarative UI"
lang: en
translationKey: android-compose-progressive-migration
slug: android-compose-progressive-migration
excerpt: "A practical review of progressive migration from Android Views to Jetpack Compose, covering infrastructure, phased replacement, list performance, interop governance, rollout validation, and real performance data."
publishDate: '2025-07-04'
tags:
- "Android"
- "Jetpack Compose"
- "Architecture"
- "Performance Optimization"
- "Progressive Migration"
seo:
  title: "Progressive Android Compose Migration from Views to Declarative UI"
  description: "A practical migration playbook for moving a large Android app from Views to Jetpack Compose, with phased rollout, interop rules, and performance validation."
  pageType: article
---

Last year, when I took over the technical migration of an ecommerce app with more than one million DAU, the team was split on Compose migration. One group wanted a direct rewrite. The more conservative group thought XML was good enough. In the end, we spent eight months completing a progressive migration without blocking a single release. This article reviews the architecture decisions and pitfalls from that process.

## Migration is not about whether, but how

After using the View system for a long time, three problems become increasingly visible.

**Code growth is hard to reverse**: a `RecyclerView` Adapter plus ViewHolder can easily exceed 500 lines. XML, binding, and business logic live in three different files, so changing one interaction means jumping across three places.

**State synchronization is the root of many bugs**: manual `findView`, `setText`, and callback chains create a bug surface that grows with every additional nesting level.

**Animation cost is high**: property animations, Transitions, and `CoordinatorLayout` each have their own style. Once interactions need to coordinate, glue code can outweigh business code.

What Compose solves most thoroughly is not "less code." It brings the `UI = f(state)` model into real engineering practice. You no longer manually pass state changes among Activity/Fragment, ViewModel, and Adapter. Recomposition does that work for you. The payoff is especially visible in complex interaction scenarios.

I am not saying Compose has no issues. Performance hotspot control, list scroll optimization, and View-system interop overhead all need real engineering work. I will cover those later.

## A phased strategy: five steps through the migration chain

The core strategy was simple: **use Navigation Graph nodes as migration units, and use release cycles as validation windows**. No cross-page degradation. No half-View and half-Compose Fragment.

### Phase 1: prepare infrastructure (2 weeks)

First, make sure the whole project can compile both View and Compose code. This step should not touch any business behavior.

```kotlin
// app/build.gradle.kts
android {
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.10"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.01.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.8.2")
}
```

Introducing the Compose BOM early was the key decision here. The BOM keeps all Compose library versions aligned and avoids runtime incompatibilities. We hit this during phase 1: upgrading `ui-tooling` alone caused preview crashes.

At the same time, set up the Theme bridge:

```kotlin
// Reuse attributes from the existing XML theme to avoid visual divergence.
object AppThemeBridge {
    fun colors(context: Context) = when {
        // Read XML attributes so both UI systems use the same colors.
        else -> lightColors(
            primary = Color(context.getColorFromAttr(R.attr.colorPrimary)),
            background = Color(context.getColorFromAttr(R.attr.colorBackground)),
            surface = Color(context.getColorFromAttr(R.attr.colorSurface)),
        )
    }
}
```

The Theme bridge had the best return on investment in the whole migration. Two days of infrastructure work let every later Compose page use the same visual system with no visible divergence.

### Phase 2: replace bottom navigation pages one by one (10 weeks)

This was the main battlefield. We chose the low-risk "Profile" tab as the pilot because it was mostly forms and lists, without the complex animated banner behavior found on the home page.

The migration template for each page looked like this:

```kotlin
@Composable
fun ProfileScreen(viewModel: ProfileViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    ProfileContent(
        state = uiState,
        onEditClick = { viewModel.onEditProfile() },
        onLogout = { viewModel.onLogout() }
    )
}

@Composable
private fun ProfileContent(
    state: ProfileUiState,
    onEditClick: () -> Unit,
    onLogout: () -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item { ProfileHeader(state.user) }
        item { ProfileSettingsList(onEditClick, onLogout) }
    }
}
```

Three engineering decisions held up well:

1. **Keep the Screen layer thin**: it only collects state and dispatches events. UI logic stays in the Content layer.
2. **Reuse ViewModels completely**: do not reshape the ViewModel. Expose `StateFlow<UiState>`.
3. **Parameterize Previews**: every Content Composable must support Preview so the UI is visible while writing it.

One pitfall: `collectAsStateWithLifecycle()` is not a cure-all. In a Fragment plus `ComposeView` nesting scenario, if the Fragment `viewLifecycleOwner` and the `ComposeView` lifecycle do not match, state can be lost. Our fix was to standardize on `findViewTreeLifecycleOwner()` as the lifecycle owner.

### Phase 3: focus on list pages (4 weeks)

Lists are the hard part of Compose migration. Early on, we directly replaced `RecyclerView` with `LazyColumn`, and performance tests were not great. During fast scrolling, frame rate dropped from 58 fps to 42 fps.

The investigation found two problems: the Modifier chain inside each item was too long, doubling measurement cost, and image loading did not use pre-decoding.

We made three concrete changes:

```kotlin
// 1. Provide stable keys for list items to avoid unnecessary recomposition.
LazyColumn {
    items(
        items = productList,
        key = { it.id }  // About 40% fewer recompositions than default index keys.
    ) { product ->
        ProductCard(
            product = product,
            modifier = Modifier.animateItem() // 2. Enable optimized item placement animation.
        )
    }
}

// 3. Decode images at exact size to avoid post-decode scaling on the main thread.
@Composable
fun AsyncImage(
    url: String,
    modifier: Modifier = Modifier
) {
    SubcomposeAsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
            .data(url)
            .size(360, 480) // Exact size; skip secondary scaling after decode.
            .build(),
        contentDescription = null,
        modifier = modifier
    )
}
```

After optimization, frame rate stayed above 56 fps. About 80% of list performance issues came from item-level Composable functions and resource handling. The lazy loading mechanism in `LazyColumn` itself was not the bottleneck.

### Phase 4: govern View/Compose interop boundaries (3 weeks)

Before full migration, Views and Compose inevitably coexist. Our boundary rules were:

- **Page-level isolation**: do not mix systems inside the same Fragment. A Fragment is either pure View or pure Compose.
- **Component-level interop**: use `AndroidView` to embed legacy Views such as `WebView` or `MapView`; use `ComposeView` to embed small Compose widgets inside XML.
- **Unified navigation**: all page transitions go through Navigation Compose. Old Fragments are wrapped through `AndroidView`.

```kotlin
// Use ComposeView to embed a small Compose widget into an XML layout.
// Good for gradually replacing a bottom button, top bar, or similar small area on a View page.
class LegacyFragment : Fragment() {
    override fun onCreateView(/*...*/): View {
        return inflater.inflate(R.layout.fragment_legacy, container, false).apply {
            findViewById<ComposeView>(R.id.compose_bottom_bar).apply {
                setContent {
                    AppThemeBridge {
                        ModernBottomBar(
                            onTabSelected = { /* Communicate through a shared ViewModel. */ }
                        )
                    }
                }
            }
        }
    }
}
```

The biggest interop pitfall is event direction. Compose Pointer Input handling and View Touch Event dispatch are separate chains. When a View page nests a `ComposeView`, gesture conflicts are hard to diagnose. In practice, embedding a View inside Compose through `AndroidView` was more stable than the reverse.

### Phase 5: full switch plus staged validation (3 weeks)

The final step was not just "delete the old code." It needed a validation mechanism. We used Feature Flags plus page-level A/B switches:

```kotlin
object ComposeMigrationFlag {
    private val migratedScreens = setOf("profile", "cart", "orders", "settings")

    fun isComposeRoute(route: String): Boolean {
        // Staged rollout: keep 10% of users on the View fallback.
        if (RemoteConfig.getBoolean("compose_fallback_enabled", false)) {
            return false
        }
        return route in migratedScreens
    }
}
```

During rollout, we monitored three core metrics: time to interactive (TTI), frame rate, and crash rate. Based on a 100,000-user sample, the comparison was:

| Metric | View version | Compose version | Change |
|--------|--------------|-----------------|--------|
| Home TTI | 720 ms | 580 ms | **-19%** |
| List scroll frame rate | 57.3 fps | 56.8 fps | Basically flat |
| Page-related crash rate | 0.08% | 0.03% | **-62%** |
| Page code lines | 12,400 | 6,800 | **-45%** |

The crash-rate drop mainly came from Compose removing `findViewById` NPEs and View lifecycle confusion. Those two categories accounted for more than half of our View-page crashes.

## A counterintuitive finding: the worst performance cost was not recomposition

We ran a lot of systrace analysis during the migration. The conclusion was counterintuitive: Compose bottlenecks were rarely in Recomposition. They were more often in the Measure/Layout phase.

The longer the `Modifier` chain, the deeper the `LayoutNode` measurement tree. A chain such as `padding -> background -> clip -> border -> shadow` can add 3 to 5 ms of measurement work in a single frame. This is why Modifier order matters: not just for visual output, but also for performance.

Think of Modifier as a layout call chain. If built-in Modifier composition can solve the problem, avoid writing a custom `layout {}`. If `graphicsLayer {}` can perform an offscreen transform, avoid triggering the measurement phase.

## Three principles for migration decisions

Looking back at the whole process, three principles saved us from many detours.

**Prioritize delivery timing.** Do not delay releases just to make the migration "more complete." Finish one page, ship it, validate it, then move to the next iteration. A pace of one page every two weeks is sustainable and keeps the project from becoming permanently stuck.

**Use data-driven fallback.** The rollout switch is not decorative. One base library upgrade caused Compose pages to drop frames on low-end devices. We rolled back to the View version within 30 minutes with no user impact. If we had done a direct rewrite, the entire failure would have landed on engineering.

**Do not use Compose just for the sake of Compose.** `AndroidView` is not technical debt; it is engineering reality. Components such as `WebView`, `SurfaceView`, and CameraX Preview are still more stable through `AndroidView` than through native Compose support. Full Compose should not be the KPI. Lower maintenance cost should be the goal.
