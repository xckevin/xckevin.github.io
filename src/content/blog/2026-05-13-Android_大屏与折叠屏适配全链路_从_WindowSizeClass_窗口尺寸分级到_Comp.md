---
title: Android 大屏与折叠屏适配全链路：从 WindowSizeClass 窗口尺寸分级到 Compose 自适应布局的声明式响应架构
excerpt: 深入讲解 Android 大屏与折叠屏适配实践：基于 WindowSizeClass 窗口尺寸分级机制，结合 Compose 声明式自适应组件，实现从手机到平板的响应式布局，并覆盖折叠屏姿态感知与分屏场景。
publishDate: '2026-05-13'
tags:
- Android
- Jetpack Compose
- WindowSizeClass
- 大屏适配
- 折叠屏
seo:
  title: Android 大屏与折叠屏适配全链路：从 WindowSizeClass 窗口尺寸分级到 Compose 自适应布局的声明式响应架构
  description: 基于 WindowSizeClass 窗口尺寸分级与 Jetpack Compose 自适应组件，详解 Android 大屏与折叠屏适配全链路，涵盖断点定制、声明式布局与折叠屏姿态感知。
---

两年前我接手一个平板适配项目，第一件事就是改布局 XML —— 给十几个页面分别加 `layout-sw600dp` 和 `layout-sw840dp` 资源目录。改到第 5 个页面我就不干了：维护两套独立布局文件，UI 调一处就得同步改三处，不出三个月必然出现"平板端改了竖屏忘了横屏"的线上事故。

Android 12L 引入的 **WindowSizeClass** 窗口尺寸分级机制，正是冲着这个问题来的：它不再让你对着像素宽度写死断点，而是把窗口抽象为"紧凑-中等-扩展"三个语义级别，布局逻辑跟着语义走，而不是跟着具体数值走。

## WindowSizeClass：三个级别解决所有屏幕

WindowSizeClass 按窗口可用宽度和高度分别分级，宽度分三级：

| 级别 | 断点 | 典型设备场景 |
|------|------|-------------|
| Compact | < 600dp | 手机竖屏、折叠屏折叠态 |
| Medium | 600dp ~ 840dp | 手机横屏、小平板竖屏、折叠屏展开态（窄） |
| Expanded | ≥ 840dp | 平板横屏、折叠屏全展开、桌面模式 |

断点值 600dp 和 840dp 是官方推荐值，Material 3 的规范也围绕这两条线设计。获取当前窗口级别的代码：

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

`currentWindowAdaptiveInfo()` 返回的不只是宽度级别，还包含 `windowHeightSizeClass` 和 `windowPosture`（折叠屏姿态）。**高度级别在横屏场景不能忽略** —— 手机横屏时宽度是 Medium，高度通常还是 Compact，列表项的高度和间距必须跟上，否则内容会被纵向压缩得没法看。

WindowSizeClass 的值是**响应式**的：折叠屏展开/折叠、分屏模式拖拽、窗口大小调整，都会触发 recomposition，不需要手动监听 Configuration 变化。后面 Compose 自适应布局能跑通，靠的就是这个响应能力。

## 实际项目中的断点微调

官方推荐 600dp/840dp，我在项目里**把 Medium 的下限从 600dp 调到了 500dp**。原因是团队测试发现：Pixel Fold 展开时内屏宽度约 585dp，按官方断点会被归为 Compact，但那个尺寸显然不适合堆叠式布局，用双列布局体验更好。

调整方式不依赖官方 API 预置值：

```kotlin
enum class AdaptiveWindowSize(
    val minWidthDp: Float
) {
    COMPACT(0f),
    MEDIUM(500f),    // 自定义：500dp 起
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

踩过一个坑：不要直接用 `screenWidthDp` 判断，它在分屏模式下代表的是**物理屏幕宽度**而非窗口宽度。正确做法是从 `WindowMetricsCalculator` 获取当前窗口的实际 bounds。上面那段简化写法只在全屏场景准确，分屏场景会误判。如果你的 App 需要支持分屏或多窗口，用这个版本：

```kotlin
val windowMetrics = WindowMetricsCalculator.getOrCreate()
    .computeCurrentWindowMetrics(activity)
val widthDp = windowMetrics.bounds.width() / 
    resources.displayMetrics.density
```

## Compose 中的声明式自适应布局

有了 WindowSizeClass，Compose 层的自适应布局就不是"先判断尺寸再选布局"，而是**用声明式 API 描述"当前空间下内容应该如何排布"**。Material 3 的 adaptive layout 组件封装了三种核心布局模式，覆盖不同窗口宽度级别。

### 列表-详情双面板：Expanded 场景

最常见的场景是"列表-详情"双面板，Expanded 下左右并排，Compact 下分两页。M3 的 `ListDetailPaneScaffold` 专门处理这个模式：

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

`directive` 和 `value` 由 navigator 根据当前窗口宽度自动驱动：Expanded 时双面板同时展示，Compact 时导航到详情覆盖列表。不需要手动写 `when(widthClass)` 判断。

`AnimatedPane` 让面板切换有过渡动画，但这层动画在配置变化（折叠屏展开/合上）时可能掉帧。我的做法是在 `isConfigurationChanging` 时临时禁用动画，变化完成后再恢复。

### 辅助面板：Medium 场景的补充

Medium 宽度不上不下 —— 放两个完整面板太挤，放一个面板太浪费。这种场景用 `SupportingPaneScaffold`，在主导航旁边加一个窄辅助面板：

```kotlin
@Composable
fun DocumentEditor() {
    SupportingPaneScaffold(
        mainPane = { DocumentCanvas() },
        supportingPane = { ToolPalette() }
    )
}
```

Expanded 时辅助面板常驻显示，Compact/Medium 时收起到侧边抽屉或底部 Sheet。`supportingPane` 的宽度由框架控制在约 240dp-360dp 之间，不会挤压主面板。

我在文档编辑场景中用它放工具栏：平板横屏时工具栏固定在右侧，折叠屏竖屏时自动收到 overflow menu 里，零额外代码。

### 自适应导航栏：全宽度段适配

底部导航栏在手机上只有 3-5 个 tab，但大屏上底部 tab 的操作热区偏大、视觉也不够紧凑。`NavigationSuiteScaffold` 根据窗口尺寸自动切换导航样式：

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
        // 内容区域
    }
}
```

默认行为：Compact → 底部导航栏，Medium → 侧边导航栏（带图标+文字），Expanded → 常驻侧边抽屉。可以通过 `NavigationSuiteType` 参数覆盖。我对 Medium 做了定制 —— 7-8 寸小平板用侧边栏效果不错，但折叠屏展开态（更接近方形）用侧边栏会挤压内容宽度，所以改成了 `NavigationSuiteScaffoldLayout.Compact`。

## 折叠屏姿态感知：不只是大小变化

折叠屏除了窗口尺寸变化，还有**姿态（Posture）**变化。`WindowLayoutInfo` 提供两类关键信息：

- **FoldingFeature**：设备折叠/展开状态，折叠轴位置和角度
- **DisplayFeature**：屏幕是否存在物理分离区域（如铰链遮挡区）

Compose 中获取姿态信息：

```kotlin
@Composable
fun FoldableAwareLayout() {
    val windowInfo = currentWindowAdaptiveInfo().windowPosture
    val hingePosition = remember(windowInfo) {
        (windowInfo as? WindowPosture.Folded)?.hingePosition
    }
    
    if (hingePosition != null && isSeparating(hingePosition)) {
        // 铰链两侧各自独立布局，避免内容被折叠区域遮挡
        HingeSeparatedLayout(hingePosition)
    } else {
        NormalLayout()
    }
}
```

一个容易栽跟头的地方：`hingePosition` 返回的是相对于窗口的像素坐标，不同设备铰链物理位置差异很大。Galaxy Fold 的铰链在正中间，Surface Duo 的铰链有明确物理宽度。**不要假设铰链位置**，一定从 API 拿实际值再计算两侧可用空间。

`isSeparating` 这个判断也值得单独拿出来说：同一个姿态下，有些 App 需要在铰链两侧分别布局（避免内容被遮挡），有些 App 需要跨越铰链铺满（如地图）。这不是技术层面的问题，是产品设计决策。

## 适配策略：两套设计稿就够了

回到开头"维护三套布局"的问题。我现在的策略是：**只维护 Compact 和 Expanded 两套 UI 设计稿，Medium 从 Expanded 的组件中自动降级**。

具体做法：Medium 宽度段复用 Expanded 的双面板结构，但把辅助面板收起到可呼出状态，或者直接用单面板 + BottomSheet 的变体。Medium 不需要独立设计稿，布局框架本身就能给出合理的默认行为。

这套策略的前提是在 Compose 层用自适应组件代替硬编码宽度判断。`ListDetailPaneScaffold`、`SupportingPaneScaffold`、`NavigationSuiteScaffold` 三个组件覆盖了 80% 以上的日常布局场景，剩下 20% 用 `BoxWithConstraints` 配合 WindowSizeClass 手动处理。

效果：之前 16 个页面需要 48 个布局文件（每页面 3 套），现在每个页面 1 个 Composable 函数，内部用自适应组件处理所有宽度段，新增折叠屏设备形态时基本零代码改动。
