---
title: 深入 Android Compose Canvas 自定义绘制全链路：从 DrawScope 绘图模型到声明式数据可视化图表的架构设计与实战
excerpt: 深入拆解 Compose Canvas 的 DrawScope 绘图模型与坐标映射机制，并给出声明式图表组件的图层化架构设计。
publishDate: '2026-02-25'
tags:
- Android
- Jetpack Compose
- Canvas
- 数据可视化
- 自定义绘制
seo:
  title: 深入 Android Compose Canvas 自定义绘制全链路：从 DrawScope 绘图模型到声明式数据可视化图表的架构设计与实战
  description: 深入拆解 Compose Canvas 的 DrawScope 绘图模型、坐标映射、路径绘制与文本排印机制，并给出声明式图表组件的图层化架构设计。
---

在项目里需要做一个雷达图组件时，我遇到了一个尴尬的场景：Compose 提供了 Canvas，但官方示例只画了几条线和圆。当你需要做一个真正可用的数据可视化图表——带坐标轴、刻度标签、数据点标记——Canvas 的 API 模型和声明式 UI 之间就开始打架了。

我从 DrawScope 的绘图模型出发，逐步拆解坐标变换、路径绘制、文本排印的底层机制，最后给出一套声明式图表组件的架构设计。

## DrawScope：Compose Canvas 的绘图沙箱

Compose 的 Canvas 不同于 Android View 系统的 `onDraw(Canvas)`。它的核心是 **DrawScope**，一个函数式作用域对象，所有绘图 API 都作为 DrawScope 的扩展函数存在。

```kotlin
Canvas(modifier = Modifier.fillMaxSize()) {
    drawRect(Color.Red, topLeft = Offset(100f, 100f), size = Size(200f, 200f))
    drawCircle(Color.Blue, radius = 50f, center = center)
}
```

和 View 系统相比，有两件事一开始就要搞清楚：

第一，**绘制状态隔离**。每次 Canvas 重组，DrawScope 都是全新实例，没法像 `canvas.save()` 那样跨帧持久化变换状态。

第二，**像素坐标系**。DrawScope 的 `size` 返回的是 px 而非 dp，坐标系原点在左上角，Y 轴向下增长——这点在画图表时反复坑人。

直接在 Canvas lambda 里堆绘制逻辑会迅速失控，必须在 DrawScope 之上构建抽象层。

## 坐标变换：从数据空间到像素空间

图表的第一道坎是坐标映射。雷达图的指标评分范围是 0-100，需要把数值映射到 Canvas 的像素坐标系。

DrawScope 提供了 `drawContext.transform` 矩阵，但直接操作底层矩阵做坐标映射是过度设计。更务实的做法是自己维护一个 Viewport 映射器：

```kotlin
class ChartViewport(
    val canvasSize: Size,
    val dataRangeX: ClosedFloatingPointRange<Float>,
    val dataRangeY: ClosedFloatingPointRange<Float>,
    val padding: Float = 32f
) {
    val chartWidth = canvasSize.width - padding * 2
    val chartHeight = canvasSize.height - padding * 2

    fun toPixelX(dataX: Float): Float {
        val ratio = (dataX - dataRangeX.start) / (dataRangeX.endInclusive - dataRangeX.start)
        return padding + ratio * chartWidth
    }

    fun toPixelY(dataY: Float): Float {
        val ratio = (dataY - dataRangeY.start) / (dataRangeY.endInclusive - dataRangeY.start)
        return padding + chartHeight - ratio * chartHeight // Y 轴翻转
    }
}
```

`toPixelY` 做了 Y 轴翻转——数据空间的 Y 轴向上增长，Canvas 向下。折线图和柱状图里，忘了这一步图表直接上下颠倒。

雷达图是极坐标，转换逻辑不同：

```kotlin
fun polarToPixel(angle: Float, value: Float, center: Offset, maxRadius: Float): Offset {
    val rad = Math.toRadians(angle.toDouble()).toFloat()
    val ratio = value / 100f
    val x = center.x + maxRadius * ratio * cos(rad)
    val y = center.y + maxRadius * ratio * sin(rad)
    return Offset(x, y)
}
```

踩过一个坑：`cos/sin` 的浮点精度在接近 0°、90°、180°、270° 时会产生亚像素偏移，边缘肉眼可见锯齿。用 `roundToInt()` 对关键轴点做像素级对齐就能解决。

## 路径绘制：Path API 与混合渲染

Compose 的 `Path` 提供了流畅的构建器 API：

```kotlin
val linePath = Path().apply {
    moveTo(startX, startY)
    dataPoints.forEach { pt ->
        lineTo(viewport.toPixelX(pt.x), viewport.toPixelY(pt.y))
    }
}
drawPath(
    path = linePath,
    color = Color(0xFF4A90D9),
    style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
)
```

图表还需要填充区域，比如折线图下方的渐变面积。组合路径比预想的简单：

```kotlin
val areaPath = Path().apply {
    addPath(linePath)
    lineTo(viewport.toPixelX(lastX), baseline)
    lineTo(viewport.toPixelX(firstX), baseline)
    close()
}
drawPath(
    path = areaPath,
    brush = Brush.verticalGradient(
        colors = listOf(Color(0x404A90D9), Color(0x004A90D9))
    )
)
```

`Brush.verticalGradient` 和 `drawPath` 天然集成，不用像 View 系统那样手动创建 Shader 绑定 Paint。

雷达图需要绘制多边形闭合路径和网格同心多边形。实践中有效的做法是先画网格层，再画数据层，避免路径交叉导致的 Z-order 混乱。

## 文本排印：TextMeasurer 与 drawText

Compose 1.5+ 引入了 `TextMeasurer` 和 `drawText`，替代了已弃用的 `drawIntoCanvas` + `nativeCanvas` 方案：

```kotlin
val textMeasurer = rememberTextMeasurer()

Canvas(modifier = Modifier.fillMaxSize()) {
    val label = textMeasurer.measure(
        text = "100",
        style = TextStyle(fontSize = 12.sp, color = Color.Gray)
    )
    drawText(
        textLayoutResult = label,
        topLeft = Offset(
            x = toPixelX(100f) - label.size.width / 2,
            y = toPixelY(0f) + 4.dp.toPx()
        )
    )
}
```

几点容易踩坑的地方：

`rememberTextMeasurer()` 要放在 Canvas 外部，否则每次重组都会创建新实例。`drawText` 的 `topLeft` 是文本左上角基准点，居中需要手动计算 `-width/2` 偏移。好消息是文本测量结果会被内部缓存，重复测量开销很低。

雷达图的多轴标签六个维度名称围绕中心旋转分布，每个标签的绘制角度和偏移需要单独计算：

```kotlin
dimensionLabels.forEachIndexed { i, label ->
    val angle = i * 60f // 六个轴，每个 60°
    val textResult = textMeasurer.measure(text = label, style = axisLabelStyle)
    val pos = polarToPixel(angle, maxValue + labelOffset, center, maxRadius)
    val adjustedX = pos.x - textResult.size.width / 2
    val adjustedY = pos.y - textResult.size.height / 2
    drawText(textLayoutResult = textResult, topLeft = Offset(adjustedX, adjustedY))
}
```

每个标签根据所在象限微调 `topLeft`，避免文字压在轴上。

## 声明式图表组件架构

有了上述基础，可以构建一套可组合的图层架构。核心思路是把绘制逻辑拆分为独立图层，每个图层实现为一个 DrawScope 扩展函数：

```kotlin
@Composable
fun RadarChart(
    data: RadarData,
    modifier: Modifier = Modifier,
    config: RadarChartConfig = RadarChartConfig.default()
) {
    val textMeasurer = rememberTextMeasurer()

    Canvas(modifier = modifier) {
        val center = Offset(size.width / 2, size.height / 2)
        val maxRadius = minOf(size.width, size.height) / 2 - config.padding

        drawRadarGrid(center, maxRadius, config)            // 网格层
        drawRadarAxes(center, maxRadius, config)             // 坐标轴层
        drawRadarDataArea(center, maxRadius, data)           // 数据区域层
        drawRadarLabels(center, maxRadius, config, textMeasurer) // 标签层
    }
}
```

每层职责单一：

```kotlin
fun DrawScope.drawRadarGrid(
    center: Offset, maxRadius: Float, config: RadarChartConfig
) {
    val levelCount = 5
    val axisCount = config.dimensions.size
    val angleStep = 360f / axisCount
    
    for (level in 1..levelCount) {
        val radius = maxRadius * (level / levelCount.toFloat())
        val path = Path()
        for (i in 0 until axisCount) {
            val angle = i * angleStep - 90f // 从顶部开始
            val rad = Math.toRadians(angle.toDouble()).toFloat()
            val px = center.x + radius * cos(rad)
            val py = center.y + radius * sin(rad)
            if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
        }
        path.close()
        drawPath(path, color = config.gridColor, style = Stroke(1f))
    }
}
```

图层独立可测——改网格颜色不会波及数据区域。不需要数据点填充时直接去掉对应图层即可。所有图层跑在同一张 Canvas 上，避免了多次 Canvas 叠加的布局开销。

做折线图或柱状图时，架构思路完全一致，替换对应的图层实现就能复用。

## 性能边界与工程取舍

在实际项目中，我更倾向于把坐标轴渲染和数据显示分开。坐标轴、刻度标签计算量大但变化频率低，用 `remember` 缓存：

```kotlin
val ticks = remember(config.yRange) {
    calculateYTicks(config.yRange, tickCount = 5)
}
val tickLabels = remember(ticks) {
    textMeasurer.measureTickLabels(ticks)
}
```

一个常见的反模式是把数据映射逻辑写进 DrawScope 内部。DrawScope 只应该做纯粹的像素绘制——数据归一化、极坐标转换这些在 Composable 函数体中完成，传入 DrawScope 的应该是已经算好的像素坐标。

对于实时更新的监控面板（每秒 10 帧往上），序列化 `Path` 对象到 `remember` 是收益最高的优化。路径复制的开销远低于每一帧重新构建 200 个点的 `lineTo` 调用。

Compose Canvas 的绘制模型延续了 Skia 引擎的经典范式，通过 DrawScope 把命令式绘制包装成了函数式调用。坐标映射、路径组合、文本排印、图层架构，每一步都有明确的边界和职责，剩下的就是根据具体图表类型搭积木。
