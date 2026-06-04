---
title: "Android Large Screens and Foldables: From WindowSizeClass to Compose Adaptive Layouts"
lang: en
translationKey: android-large-screen-foldable-window-size-class-compose
slug: android-large-screen-foldables
excerpt: "A practical guide to Android large-screen and foldable adaptation with WindowSizeClass, Compose adaptive layouts, posture awareness, split-screen behavior, and responsive UI strategy."
publishDate: '2026-05-13'
tags:
- "Android"
- "Jetpack Compose"
- "WindowSizeClass"
- "Large Screens"
- "Foldables"
seo:
  title: "Android Large Screens and Foldables: WindowSizeClass and Compose Adaptive Layouts"
  description: "Build adaptive Android layouts with WindowSizeClass, Compose Material 3 adaptive components, foldable posture awareness, and split-screen support."
  pageType: article
---

Two years ago, I took over a tablet adaptation project. The first task was changing layout XML: adding `layout-sw600dp` and `layout-sw840dp` resource directories for more than a dozen pages. By the fifth page, I stopped. Maintaining multiple independent layout files means every UI change has to be synchronized in several places. Within three months, production would inevitably have a bug like "the tablet landscape layout was updated, but portrait was forgotten."

Android 12L introduced the **WindowSizeClass** mechanism exactly for this problem. Instead of making you hard-code breakpoints against pixel widths, it abstracts the window into three semantic levels: compact, medium, and expanded. Layout logic follows meaning, not raw numbers.

## WindowSizeClass: three levels for all screens

WindowSizeClass classifies available window width and height separately. Width has three levels:

| Level | Breakpoint | Typical device scenario |
|------|------|-------------|
| Compact | < 600dp | Phone portrait, folded foldable |
| Medium | 600dp ~ 840dp | Phone landscape, small tablet portrait, narrow unfolded foldable |
| Expanded | >= 840dp | Tablet landscape, fully unfolded foldable, desktop mode |

The 600dp and 840dp breakpoints are the official recommendations, and the Material 3 spec is also designed around those two lines. The current window class can be read like this:

```kotlin
@Composable
fun MainScreen() {
    val windowSizeClass = currentWindowAdaptiveInfo().windowSizeClass
    val widthClass = windowSizeClass.windowWidthSizeClass
    
    when (widthClass) {
        WindowWidthSizeClass.COMPACT -> CompactLayout()
        WindowWidthSizeClass.MEDIUM -> MediumLayout()
        WindowWidthSizeClass.EXPANDED -> ExpandedLayout()
        else -> CompactLayout()
    }
}
```

`currentWindowAdaptiveInfo()` returns more than width class. It also includes `windowHeightSizeClass` and `windowPosture` for foldables. **Height class cannot be ignored in landscape scenarios**. A phone in landscape may have Medium width, but its height is usually still Compact. Row height and spacing must adapt, or content becomes vertically compressed and hard to read.

WindowSizeClass is **responsive**. Unfolding or folding a device, dragging split-screen mode, and resizing the window all trigger recomposition. You do not need to manually listen for Configuration changes. Compose adaptive layout works because this signal is reactive.

## Breakpoint tuning in real projects

Although the official recommendation is 600dp and 840dp, in one project I **lowered the Medium threshold from 600dp to 500dp**. The reason came from testing: Pixel Fold's inner display is about 585dp wide when unfolded, so the official breakpoint classifies it as Compact. But that size clearly works better with a two-column layout than a stacked layout.

The adjustment does not need to depend on the official preset API:

```kotlin
enum class AdaptiveWindowSize(
    val minWidthDp: Float
) {
    COMPACT(0f),
    MEDIUM(500f),    // Custom: Medium starts at 500dp
    EXPANDED(840f)
}

@Composable
fun rememberAdaptiveSize(): AdaptiveWindowSize {
    val widthDp = with(LocalDensity.current) {
        LocalConfiguration.current.screenWidthDp.toFloat()
    }
    return when {
        widthDp >= AdaptiveWindowSize.EXPANDED.minWidthDp -> AdaptiveWindowSize.EXPANDED
        widthDp >= AdaptiveWindowSize.MEDIUM.minWidthDp -> AdaptiveWindowSize.MEDIUM
        else -> AdaptiveWindowSize.COMPACT
    }
}
```

One pitfall: do not directly use `screenWidthDp` for this decision. In split-screen mode, it represents the **physical screen width**, not the current window width. The correct approach is to get the current window's actual bounds from `WindowMetricsCalculator`. The simplified code above is only accurate in full-screen scenarios. If your app needs split-screen or multi-window support, use this version:

```kotlin
val windowMetrics = WindowMetricsCalculator.getOrCreate()
    .computeCurrentWindowMetrics(activity)
val widthDp = windowMetrics.bounds.width() / 
    resources.displayMetrics.density
```

## Declarative adaptive layout in Compose

With WindowSizeClass in place, adaptive layout in Compose is no longer "check size first, then choose a layout." Instead, you use declarative APIs to describe how content should be arranged under the current space. Material 3 adaptive layout components package three core layout patterns that cover different window width classes.

### List-detail dual pane: Expanded scenarios

The most common pattern is list-detail dual pane: side by side in Expanded, two pages in Compact. M3's `ListDetailPaneScaffold` is built for this pattern:

```kotlin
@Composable
fun ConversationsScreen() {
    val navigator = rememberListDetailPaneScaffoldNavigator<ListItem>()
    
    ListDetailPaneScaffold(
        directive = navigator.scaffoldDirective,
        value = navigator.scaffoldValue,
        listPane = {
            AnimatedPane {
                ConversationList(onItemClick = { item ->
                    navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, item)
                })
            }
        },
        detailPane = {
            AnimatedPane {
                navigator.currentDestination?.content?.let { item ->
                    ConversationDetail(item)
                } ?: Placeholder()
            }
        }
    )
}
```

`directive` and `value` are driven automatically by the navigator based on the current window width. In Expanded, both panes are shown together. In Compact, navigation to detail covers the list. You do not have to manually write `when(widthClass)`.

`AnimatedPane` gives pane switches a transition animation, but that animation can drop frames during configuration changes such as folding and unfolding. My approach is to temporarily disable the animation while `isConfigurationChanging` is true, then restore it after the change completes.

### Supporting pane: a supplement for Medium

Medium width is awkward: two full panes are too cramped, while one pane wastes space. This is where `SupportingPaneScaffold` works well. It adds a narrow supporting pane next to the main content:

```kotlin
@Composable
fun DocumentEditor() {
    SupportingPaneScaffold(
        mainPane = { DocumentCanvas() },
        supportingPane = { ToolPalette() }
    )
}
```

In Expanded, the supporting pane is persistently visible. In Compact and Medium, it can collapse into a side drawer or bottom sheet. The framework keeps `supportingPane` width around 240dp to 360dp, so it does not squeeze the main pane too aggressively.

I used it for toolbars in a document editor. On tablet landscape, the toolbar is fixed on the right. On a foldable in portrait, it automatically moves into an overflow menu with no extra code.

### Adaptive navigation across all width classes

Bottom navigation works well on phones with 3-5 tabs, but on large screens the touch targets become too large and the visual density feels loose. `NavigationSuiteScaffold` switches navigation style automatically based on window size:

```kotlin
@Composable
fun AppNavigation() {
    NavigationSuiteScaffold(
        navigationSuiteItems = {
            tabs.forEach { tab ->
                item(
                    icon = { Icon(tab.icon, contentDescription = tab.label) },
                    label = { Text(tab.label) },
                    selected = currentTab == tab,
                    onClick = { currentTab = tab }
                )
            }
        }
    ) {
        // Content area
    }
}
```

The default behavior is: Compact -> bottom navigation, Medium -> navigation rail with icon plus text, Expanded -> persistent navigation drawer. You can override it through the `NavigationSuiteType` parameter. I customized Medium: side navigation works well on 7-8 inch small tablets, but on unfolded foldables that are closer to square, a side rail squeezes content width, so I switched it to `NavigationSuiteScaffoldLayout.Compact`.

## Foldable posture awareness: not just size changes

Foldables have more than window size changes. They also have **posture** changes. `WindowLayoutInfo` provides two key kinds of information:

- **FoldingFeature**: folded or unfolded state, hinge position, and angle
- **DisplayFeature**: whether the screen has a physical separation area, such as a hinge occlusion region

Posture information in Compose can be read like this:

```kotlin
@Composable
fun FoldableAwareLayout() {
    val windowInfo = currentWindowAdaptiveInfo().windowPosture
    val hingePosition = remember(windowInfo) {
        (windowInfo as? WindowPosture.Folded)?.hingePosition
    }
    
    if (hingePosition != null && isSeparating(hingePosition)) {
        // Lay out each side of the hinge independently to avoid occluded content
        HingeSeparatedLayout(hingePosition)
    } else {
        NormalLayout()
    }
}
```

One easy mistake: `hingePosition` is returned in pixel coordinates relative to the window, and physical hinge positions vary widely by device. Galaxy Fold places the hinge near the center. Surface Duo has a clear physical hinge width. **Do not assume the hinge position**. Always read the actual value from the API before calculating the usable space on each side.

The `isSeparating` decision also deserves separate treatment. Under the same posture, some apps should lay out separately on both sides of the hinge to avoid occlusion, while others should span across the hinge, such as maps. This is a product design decision, not just a technical one.

## Adaptation strategy: two design sets are enough

Returning to the opening problem of maintaining three layout sets, my current strategy is: **keep only Compact and Expanded designs, and let Medium degrade automatically from Expanded components**.

Concretely, Medium reuses the Expanded dual-pane structure but collapses the supporting pane into an on-demand state, or uses a single pane plus BottomSheet variant. Medium does not need its own independent design. The layout framework itself can provide reasonable defaults.

This strategy depends on using adaptive components in Compose instead of hard-coded width checks. `ListDetailPaneScaffold`, `SupportingPaneScaffold`, and `NavigationSuiteScaffold` cover more than 80% of everyday layout scenarios. The remaining 20% can be handled manually with `BoxWithConstraints` plus WindowSizeClass.

The result: what used to require 48 layout files for 16 pages, with 3 versions per page, now uses one Composable function per page. The function uses adaptive components internally to handle every width class, and adding new foldable device shapes usually requires little to no code change.
