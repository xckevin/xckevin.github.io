---
title: 当手机版 Compose 组件在手表上崩掉：Wear OS 声明式 UI 的排坑之路
excerpt: 深入分析手机 Compose 组件迁移 Wear OS 的适配难点，涵盖圆形裁剪、ScalingLazyColumn 视口缩放、Tile 服务渲染沙箱及 DataLayer 数据同步等关键技术。
publishDate: '2026-06-02'
tags:
- Android
- Wear OS
- Jetpack Compose
- Tile 服务
- 声明式UI
seo:
  title: 当手机版 Compose 组件在手表上崩掉：Wear OS 声明式 UI 的排坑之路
  description: 手机端 Compose 组件直接迁移到 Wear OS 会遇到圆形裁剪、列表缩放等问题。本文详解 ScalingLazyColumn 视口缩放机制、Tile 服务沙箱约束及 DataLayer 数据同步策略。
---

去年把手机端一套 Compose 布局直接迁移到 Wear OS，`LazyColumn` 在圆形表盘上滚动时内容被裁切得面目全非。第一反应是「加个 padding 不就行了」——远没那么简单。手表屏幕的物理约束决定了它需要一套完全不同的组件模型，尤其是列表滚动和后台服务这两块。

## 硬件约束如何重塑组件

手表屏幕在 1.2-1.6 英寸之间，圆形居多，ppi 高但可视面积极小。两个约束直接决定了组件设计方向：

**第一个是裁剪区域。** 圆形屏幕按矩形 FrameLayout 布局，四角必然被切掉。手机端靠 `padding` 或 `clipToPadding=false` 能处理——在这里失效，表盘四个角的空白区域不是设计取舍，是物理事实。

Wear OS 的 Material 主题内置了水平方向的 `percentage` padding：

```kotlin
// Wear OS 自动处理的水平内边距，圆形表盘约为 5.2%
compositionLocalOf { 0.052f }
```

不需要手动处理，但自定义组件得从 `WearSystem` 里拿这个值。所有标准组件（Chip、Card、Button）都默认留出了弧形安全区。

**第二个是滚动方向。** 表冠是垂直旋转的，竖着转比横着划更自然，因此 Wear OS 的主列表都是**垂直滚动**，`HorizontalPager` 只用于表盘切换这类低频场景。回到上面的翻车案例——`LazyColumn` 的问题在于它的 item 没有处理圆形视口边缘的缩放效果，首尾 item 会直接切进表框。

## ScalingLazyColumn：不只是「手表版 LazyColumn」

`ScalingLazyColumn` 的核心机制是**视口缩放**：离屏幕中心越远的 item，透明度越高、scale 越小。它解决了两个工程问题：

1. 用户始终能看到当前聚焦的 item 完整内容
2. 滚出视区的 item 通过缩小和变淡来提示位置，而不是被粗暴裁切

```kotlin
ScalingLazyColumn(
    modifier = Modifier.fillMaxSize(),
    autoCentering = AutoCenteringParams(itemIndex = 0, itemOffset = 0),
    scalingParams = ScalingLazyColumnDefaults.scalingParams(
        edgeScale = 0.6f,      // 边缘 item 缩放到 60%
        edgeAlpha = 0.3f       // 边缘 item 透明度 30%
    )
) {
    items(messageList) { message ->
        ChatCard(message)
    }
}
```

`edgeScale` 和 `edgeAlpha` 控制衰减曲线。建议把 `edgeScale` 设为 0.6-0.7，太低会让用户以为列表已经到头了，太高则裁切感依然明显。

**踩过的坑：** `autoCentering` 默认以列表第一个 item 为锚点，如果顶部有 header 组件，需要把 `itemIndex` 指向真正的内容首项。否则旋转表冠时列表会弹回 header 位置，体验像 bug。

### 列表状态与可见性检测

`ScalingLazyListState` 提供了 `layoutInfo.visibleItemsInfo`，能拿到当前可见 item 的信息：

```kotlin
val listState = rememberScalingLazyListState()
val centerItem = listState.layoutInfo.visibleItemsInfo
    .minByOrNull { abs(it.unadjustedOffset) }

LaunchedEffect(centerItem) {
    centerItem?.let {
        viewModel.onItemFocused(it.index)
    }
}
```

「旋转表冠选中 → 自动播放语音」这类交互就是建立在这个基础上的——不需要监听滚动手势，状态变化直接映射到业务逻辑。

### 列表锚点与 RotaryScroll 协同

`RotaryScrollHandler` 是 Wear OS 的输入抽象层，负责把表冠旋转事件转成列表滚动。常规场景下不需要手动处理，但自定义组件绕不开它：

```kotlin
@Composable
fun CustomPicker(
    state: ScalingLazyListState,
    onFling: () -> Unit
) {
    ScalingLazyColumn(state = state) { /* items */ }
    
    // 自定义表冠行为：快速旋转触发侧滑
    RotaryScrollHandler { event ->
        if (event.verticalScrollPixels > 100) {
            onFling()
        }
        true
    }
}
```

普通场景直接用默认行为。**自定义 RotaryScrollHandler 要返回 true**，否则事件会继续传播给系统手势，表冠转不动。

## Tile 服务：手表上的「卡片式微应用」

如果 `ScalingLazyColumn` 是 Wear OS 的 RecyclerView，那 Tile 就是手表端的 Widget。它运行在受限沙箱里，有几个硬性约束：

- **不能访问网络**。Tile 是纯本地渲染的服务
- **没有生命周期感知**。不绑定 Activity，`onTileResourcesRequest` 触发时甚至没有 Context
- **只能跑 10 秒**。超过时限系统直接杀进程

这些约束意味着 Tile 的所有数据必须在请求之前准备好。典型架构是：手机端同步数据到手表的 DataLayer，Tile 从本地读取。

```kotlin
class WeatherTileService : TileService() {

    override fun onResourcesRequest(requestParams: ResourcesRequest) =
        serviceScope.future {
            // 从本地 DataStore 拿数据，不能在这里做网络请求
            val weather = repository.getLatest()
            Tile.Builder()
                .setResourcesVersion(weather.version)
                .setTile(buildTile(weather))
                .build()
        }

    override fun onTileAddEvent(requestParams: AddEventRequest) {
        // Tile 被添加到表盘时触发，可在此做初始化
    }
}
```

### 声明式 Tile 布局：代码即模板

Tile 的布局不是 XML 也不是 Compose，而是通过 builder 模式描述：

```kotlin
private fun buildTile(weather: WeatherData) = Tile.Builder()
    .setTimeline(
        Timeline.fromLayoutElement(
            LayoutElementBuilders.Row.Builder()
                .setWidth(DimensionBuilders.expand())
                .addContent(
                    LayoutElementBuilders.Column.Builder()
                        .addContent(
                            LayoutElementBuilders.Text.Builder()
                                .setText("${weather.temp}°")
                                .setTypography(Typography.TYPOGRAPHY_DISPLAY1)
                                .build()
                        )
                        .addContent(
                            LayoutElementBuilders.Text.Builder()
                                .setText(weather.condition)
                                .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                                .build()
                        )
                        .build()
                )
                .build()
        )
    ).build()
```

写法冗长，但好处是静态度极高——没有重组、没有 diff，渲染路径极短。Tile 是预编译的布局树，切到表盘时几乎 0 延迟。

### 用 Compose 思路组织 Tile 代码

Builder 嵌套太深时，可以把布局单元抽成工厂方法：

```kotlin
object TileLayouts {
    fun primaryText(value: String) = Text.Builder()
        .setText(value)
        .setTypography(Typography.TYPOGRAPHY_TITLE1)

    fun row(vararg elements: LayoutElement) = Row.Builder()
        .apply { elements.forEach { addContent(it) } }
        .build()
}
```

配合 Kotlin 扩展函数能进一步精简。我在项目里最终形成了一个类似 `@Composable` 风格的 DSL，每个 Tile 的 `build()` 方法不超过 30 行。

### Tile 与 DataLayer 的数据同步管道

Tile 不能访问网络，数据必须走 Wearable DataLayer。标准流程：

```
手机 App → DataClient.putDataItem() → Play Services → 手表 DataClient → 本地存储 → Tile 读取
```

`onResourcesRequest` 里 `future {}` 做的 IO 操作包括 DataLayer 读取。如果数据同步延迟导致读取耗时超过 8 秒，Tile 直接白屏。解法是**在 Tile 之外的 Service 里预拉取数据到本地 Room/DataStore**：

```kotlin
// 独立 Service，监听 DataLayer 变化并持久化
class DataSyncService : WearableListenerService() {
    override fun onDataChanged(dataEvents: DataEventBuffer) {
        // 将变动的数据全部写入本地
        // Tile 启动时直接从本地读取
    }
}
```

这样 `onResourcesRequest` 的耗时可以控制在毫秒级。

## GradientEdge：小屏上的视觉引导

手表屏幕太小，用户经常看不到列表边缘有没有更多内容。`ScalingLazyColumn` 默认支持 `GradientEdge`——列表顶部和底部有渐隐指示：

```kotlin
ScalingLazyColumn(
    modifier = Modifier.gradientEdge(
        ScalingLazyColumnDefaults.gradientEdge()
    )
)
```

这个渐变只出现在有额外内容可滚动的方向上，滑到底部时底部渐变自动消失。本质上是在 View 层级叠加了一个 `Canvas` 绘制层，对性能无影响。

## 实践建议

在 Wear OS 上做列表类 UI，几条用坑换来的经验：

**能交给 `ScalingLazyColumn` 就别自己滚。** 它处理了圆形裁剪、表冠输入和缩放反馈，自己实现的工作量远大于适配成本。

**把 Tile 当成静态快照，而不是动态 Widget。** 数据新鲜度控制在分钟级就够了。数据拉取逻辑完全放在 Tile 之外，`onResourcesRequest` 是渲染入口，不是数据请求入口。

**务必用圆形模拟器测试。** 方形屏和圆形屏的裁剪区域差异会让布局在真机上直接报废。模拟器里圆屏切角的视觉效果会暴露所有 padding 问题——在方形屏上看着完美的布局，切到圆屏可能第一行就没了。
