---
title: "Compose Canvas Custom Drawing: From DrawScope to Declarative Chart Architecture"
lang: en
translationKey: android-compose-canvas-drawscope-declarative-charts
slug: jetpack-compose-canvas-drawscope
excerpt: "A deep dive into Compose Canvas, DrawScope, coordinate mapping, path drawing, text layout, and a layered architecture for declarative chart components."
publishDate: '2026-02-25'
tags:
- "Android"
- "Jetpack Compose"
- "Canvas"
- "Data Visualization"
- "Custom Drawing"
seo:
  title: "Compose Canvas Custom Drawing: DrawScope, Coordinate Mapping, and Charts"
  description: "Learn Compose Canvas drawing with DrawScope, coordinate mapping, paths, text layout, and a layered architecture for declarative chart components."
  pageType: article
---

While building a radar chart component for a project, I ran into an awkward gap: Compose gives you `Canvas`, but the official examples mostly draw a few lines and circles. Once you need a real data visualization chart with axes, tick labels, and data point markers, the Canvas API model starts to clash with declarative UI.

Starting from DrawScope's drawing model, I will walk through coordinate transforms, path drawing, and text layout, then end with an architecture for declarative chart components.

## DrawScope: the drawing sandbox for Compose Canvas

Compose Canvas is different from the Android View system's `onDraw(Canvas)`. Its core is **DrawScope**, a functional scope object where all drawing APIs are exposed as DrawScope extension functions.

```kotlin
Canvas(modifier = Modifier.fillMaxSize()) {
    drawRect(Color.Red, topLeft = Offset(100f, 100f), size = Size(200f, 200f))
    drawCircle(Color.Blue, radius = 50f, center = center)
}
```

Compared with the View system, two things need to be clear from the beginning.

First, **drawing state is isolated**. Every Canvas recomposition gets a fresh DrawScope instance. You cannot persist transform state across frames the way you might with `canvas.save()`.

Second, **the coordinate system is pixel based**. DrawScope's `size` is in px, not dp. The origin is the top-left corner, and the Y axis grows downward. This is a repeated source of charting bugs.

If you pile all drawing logic directly into the Canvas lambda, it quickly becomes unmanageable. You need an abstraction layer on top of DrawScope.

## Coordinate transforms: from data space to pixel space

The first challenge in charts is coordinate mapping. In a radar chart, metric scores may range from 0 to 100, and those values need to be mapped into the Canvas pixel coordinate system.

DrawScope provides the `drawContext.transform` matrix, but directly manipulating the low-level matrix for chart mapping is usually over-engineering. A more pragmatic approach is to maintain your own viewport mapper:

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
        return padding + chartHeight - ratio * chartHeight // Invert the Y axis
    }
}
```

`toPixelY` inverts the Y axis: data space usually grows upward, while Canvas grows downward. In line charts and bar charts, forgetting this step flips the chart vertically.

A radar chart uses polar coordinates, so the conversion logic is different:

```kotlin
fun polarToPixel(angle: Float, value: Float, center: Offset, maxRadius: Float): Offset {
    val rad = Math.toRadians(angle.toDouble()).toFloat()
    val ratio = value / 100f
    val x = center.x + maxRadius * ratio * cos(rad)
    val y = center.y + maxRadius * ratio * sin(rad)
    return Offset(x, y)
}
```

One pitfall I hit: the floating-point precision of `cos` and `sin` creates subpixel offsets near 0, 90, 180, and 270 degrees. On chart edges, the aliasing is visible. Pixel-aligning key axis points with `roundToInt()` fixes it.

## Path drawing: Path API and blended rendering

Compose's `Path` provides a fluent builder API:

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

Charts also need filled areas, such as the gradient area below a line chart. Composing the path is simpler than it first appears:

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

`Brush.verticalGradient` integrates naturally with `drawPath`. There is no need to manually create a Shader and bind it to Paint as you would in the View system.

A radar chart needs closed polygon paths for the data area and concentric polygons for the grid. In practice, the reliable approach is to draw the grid layer first, then the data layer, so path intersections do not create confusing Z-order behavior.

## Text layout: TextMeasurer and drawText

Compose 1.5+ introduced `TextMeasurer` and `drawText`, replacing the deprecated `drawIntoCanvas` plus `nativeCanvas` approach:

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

There are a few easy mistakes here.

`rememberTextMeasurer()` should live outside the Canvas block. Otherwise, every recomposition creates a new instance. `drawText` uses the text's top-left corner as its anchor, so centering requires manually subtracting `width / 2`. The good news is that text measurement results are internally cached, so repeated measurement is cheap.

For a radar chart, six dimension labels are distributed around the center. Each label's drawing angle and offset need to be calculated separately:

```kotlin
dimensionLabels.forEachIndexed { i, label ->
    val angle = i * 60f // Six axes, 60 degrees each
    val textResult = textMeasurer.measure(text = label, style = axisLabelStyle)
    val pos = polarToPixel(angle, maxValue + labelOffset, center, maxRadius)
    val adjustedX = pos.x - textResult.size.width / 2
    val adjustedY = pos.y - textResult.size.height / 2
    drawText(textLayoutResult = textResult, topLeft = Offset(adjustedX, adjustedY))
}
```

Each label also needs a small quadrant-specific adjustment to `topLeft` so the text does not sit directly on the axis.

## Declarative chart component architecture

With those foundations in place, you can build a composable layered architecture. The core idea is to split drawing logic into independent layers, each implemented as a DrawScope extension function:

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

        drawRadarGrid(center, maxRadius, config)            // Grid layer
        drawRadarAxes(center, maxRadius, config)            // Axis layer
        drawRadarDataArea(center, maxRadius, data)          // Data area layer
        drawRadarLabels(center, maxRadius, config, textMeasurer) // Label layer
    }
}
```

Each layer has one responsibility:

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
            val angle = i * angleStep - 90f // Start from the top
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

Layers are independently testable. Changing the grid color does not affect the data area. If you do not need point markers, you can remove that layer directly. All layers run on the same Canvas, avoiding the layout cost of stacking multiple Canvas components.

For line charts or bar charts, the architecture stays the same. You swap in the corresponding layer implementations and reuse the structure.

## Performance boundaries and engineering tradeoffs

In real projects, I prefer to separate axis rendering from data rendering. Axes and tick labels are expensive to calculate but change infrequently, so cache them with `remember`:

```kotlin
val ticks = remember(config.yRange) {
    calculateYTicks(config.yRange, tickCount = 5)
}
val tickLabels = remember(ticks) {
    textMeasurer.measureTickLabels(ticks)
}
```

A common anti-pattern is putting data mapping logic inside DrawScope. DrawScope should only perform pixel drawing. Data normalization and polar coordinate conversion should happen in the Composable function body, and DrawScope should receive already computed pixel coordinates.

For real-time monitoring dashboards that update at 10 frames per second or more, caching `Path` objects with `remember` is often the highest-value optimization. Copying a path is far cheaper than rebuilding 200 `lineTo` calls every frame.

Compose Canvas inherits the classic Skia drawing model, then wraps imperative drawing commands in functional DrawScope calls. Coordinate mapping, path composition, text layout, and layered architecture each have a clear boundary and responsibility. From there, the work is mostly assembling the right pieces for each chart type.
