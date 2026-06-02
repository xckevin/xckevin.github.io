---
title: Compose 自定义 Layout：MeasurePolicy、固有尺寸与瀑布流实战
excerpt: 深入解析 Jetpack Compose 自定义布局核心机制：从 MeasurePolicy 单次测量模型、固有尺寸协商，到 SubcomposeLayout 按需组合，并通过自适应网格与瀑布流实战演示完整实现思路与调试技巧。
publishDate: '2026-05-13'
tags:
- Jetpack Compose
- Android
- Kotlin
- 自定义布局
- UI 性能
seo:
  title: Compose 自定义 Layout：MeasurePolicy、固有尺寸与瀑布流实战
  description: 深入 Jetpack Compose 自定义布局系统，涵盖 MeasurePolicy 测量约束、IntrinsicSize 固有尺寸协商、SubcomposeLayout 按需组合，以及自适应网格与瀑布流的完整实战实现。
---

做 Compose 图片流时遇到一个需求：图片宽度固定，高度自适应，得像瀑布流一样紧密排列。`LazyVerticalStaggeredGrid` 只能处理等高或按比例缩放，做不了原生不规则瀑布流。翻遍标准库，没有现成方案。

那就自己写一个 Layout。

## MeasurePolicy：Compose 布局的骨架

Compose 的测量模型和传统 View 系统完全不同。View 系统是两次遍历：`measure` → `layout`，宽高在 measure 阶段就确定了。Compose 走的是单次测量约束传递：父节点给子节点一个 `Constraints`，子节点在约束范围内确定自己的尺寸，父节点再根据子节点尺寸摆放位置。

核心接口 `MeasurePolicy`：

```kotlin
@Composable
fun CustomLayout(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Layout(
        content = content,
        modifier = modifier,
        measurePolicy = { measurables, constraints ->
            // 1. 测量所有子元素
            val placeables = measurables.map { measurable ->
                measurable.measure(constraints)
            }
            // 2. 确定容器尺寸（不能大于 constraints 的最大值）
            val width = constraints.maxWidth
            val height = placeables.sumOf { it.height }
            // 3. 摆放子元素
            layout(width, height) {
                var y = 0
                placeables.forEach { placeable ->
                    placeable.placeRelative(0, y)
                    y += placeable.height
                }
            }
        }
    )
}
```

这段代码实现了一个简单的垂直排列容器，行为和 `Column` 一致。`layout()` 返回的宽高必须在 `constraints` 范围内，否则直接抛异常——我一开始反复踩这个坑，排查后才意识到 Compose 对约束边界的检查是硬性的。

`measurable.measure(constraints)` 传入的是父容器给的约束。如果想让子元素按自身需求决定尺寸，就需要固有尺寸测量。

## 固有尺寸协商：让子元素"表达意愿"

假设你做一个表单布局，标签列要对齐到最宽标签的宽度。用普通的 `Row` 做不到——每个标签不知道其他标签多宽。

这时候 `IntrinsicSize` 派上用场：

```kotlin
@Composable
fun AlignedForm(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Layout(
        content = content,
        modifier = modifier,
        measurePolicy = { measurables, constraints ->
            // 询问每个子元素的固有最大宽度
            val maxIntrinsicWidth = measurables.maxOf { measurable ->
                measurable.maxIntrinsicWidth(constraints.maxHeight)
            }
            // 用这个宽度统一测量所有子元素
            val placeables = measurables.map { measurable ->
                measurable.measure(
                    Constraints.fixedWidth(maxIntrinsicWidth)
                )
            }
            val totalHeight = placeables.sumOf { it.height }
            layout(maxIntrinsicWidth, totalHeight) {
                var y = 0
                placeables.forEach { placeable ->
                    placeable.placeRelative(0, y)
                    y += placeable.height
                }
            }
        }
    )
}
```

`maxIntrinsicWidth(height)` 的含义是：在高度给定的前提下，完整展示内容所需的最小宽度。Compose 提供了四个固有尺寸查询：`minIntrinsicWidth`、`maxIntrinsicWidth`、`minIntrinsicHeight`、`maxIntrinsicHeight`。

`Text` 组件的固有宽度有一个坑：遇到超长英文单词会按不换行计算，导致测量值偏大。我在表单标签场景中撞过这个问题，最后对标签加了 `softWrap = true` + `maxLines = 1` 的组合约束才解决。如果你也遇到标签列宽异常，大概率是同一回事。

## SubcomposeLayout：按需组合的异步布局

当子元素尺寸依赖其他子元素的测量结果时，`MeasurePolicy` 就不够了——所有子元素在 `measure` 阶段是"同时"处理的。

`SubcomposeLayout` 支持分批次组合和测量，`BoxWithConstraints` 和 `LazyColumn` 都基于它实现。它的机制是：先组合一批子元素，拿到测量结果，再根据结果决定下一批的组合策略。

```kotlin
@Composable
fun AdaptiveColumn(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    SubcomposeLayout(modifier) { constraints ->
        // 第一批：先测量一个典型子元素，推算每行能放几个
        val measureResult = subcompose("scout", content).map {
            it.measure(constraints)
        }
        // 基于第一批结果，决定后续布局策略
        // 实际使用时可以分更多批次
        val totalHeight = measureResult.sumOf { it.height }
        layout(constraints.maxWidth, totalHeight) {
            var y = 0
            measureResult.forEach { placeable ->
                placeable.placeRelative(0, y)
                y += placeable.height
            }
        }
    }
}
```

`SubcomposeLayout` 的性能代价很大——每多一个批次就多一次完整的组合遍历。我的判断是：能用 `Layout` + 固有尺寸解决的，绝对不要上 `SubcomposeLayout`。只有确实需要"用前面的测量结果决定后面怎么组合"时，它才是正确的选择。

## 实战：自适应网格

回到开头的问题。一个简单的自适应网格：每个单元格宽度固定 120dp，根据容器宽度自动计算列数，子元素高度自适应。

```kotlin
@Composable
fun AdaptiveGrid(
    modifier: Modifier = Modifier,
    cellWidth: Dp = 120.dp,
    content: @Composable () -> Unit
) {
    Layout(
        content = content,
        modifier = modifier
    ) { measurables, constraints ->
        val cellWidthPx = cellWidth.roundToPx()
        // 根据容器宽度动态计算列数
        val columns = max(1, constraints.maxWidth / cellWidthPx)
        val actualCellWidth = constraints.maxWidth / columns
        val itemConstraints = Constraints(
            minWidth = actualCellWidth,
            maxWidth = actualCellWidth
        )
        val placeables = measurables.map { it.measure(itemConstraints) }
        // 按行累加高度
        val rows = (placeables.size + columns - 1) / columns
        val rowHeights = IntArray(rows)
        placeables.forEachIndexed { index, placeable ->
            val row = index / columns
            rowHeights[row] = max(rowHeights[row], placeable.height)
        }
        val totalHeight = rowHeights.sum()
        layout(constraints.maxWidth, totalHeight) {
            var y = 0
            placeables.forEachIndexed { index, placeable ->
                if (index % columns == 0 && index > 0) {
                    y += rowHeights[index / columns - 1]
                }
                val x = (index % columns) * actualCellWidth
                placeable.placeRelative(x, y)
            }
        }
    }
}
```

三十行左右的代码，已经可以替代 `LazyVerticalGrid` 的大部分非懒加载场景。`Constraints` 构造时只限制宽度，高度由子元素自行决定——这是实现自适应的核心。

## 实战：瀑布流

自适应网格的每行高度由该行最高的单元格决定。瀑布流不同：每个单元格紧贴排列，优先填入当前累计高度最小的列。

```kotlin
@Composable
fun WaterfallLayout(
    modifier: Modifier = Modifier,
    columns: Int = 2,
    content: @Composable () -> Unit
) {
    Layout(
        content = content,
        modifier = modifier
    ) { measurables, constraints ->
        val columnWidth = constraints.maxWidth / columns
        val itemConstraints = Constraints(maxWidth = columnWidth)
        val placeables = measurables.map { it.measure(itemConstraints) }

        // 维护每列当前累计高度
        val columnHeights = IntArray(columns)
        // 记录每个子元素被分配到哪个列
        val placements = mutableListOf<Pair<Int, Int>>() // (column, yOffset)

        placeables.forEach { placeable ->
            val shortestColumn = columnHeights.indices.minBy { columnHeights[it] }
            placements.add(shortestColumn to columnHeights[shortestColumn])
            columnHeights[shortestColumn] += placeable.height
        }

        val totalHeight = columnHeights.max()
        layout(constraints.maxWidth, totalHeight) {
            placeables.forEachIndexed { index, placeable ->
                val (column, y) = placements[index]
                placeable.placeRelative(column * columnWidth, y)
            }
        }
    }
}
```

瀑布流的核心就是 `minBy` 这一行：每次选高度最小的列放元素，标准的贪心策略。配合 `verticalScroll` 就能得到一个非懒加载的瀑布流页面。如果需要处理大规模数据，`LazyLayout` 可以改造——不过实现复杂度翻倍，这里不展开了。

## 调试 Layout 的两个工具

写自定义 Layout 时，有两个调试手段经常用到。

第一个是 `Modifier.layoutId`，给不同子元素打标签：

```kotlin
Layout(
    content = {
        Box(Modifier.layoutId("header")) { Header() }
        Box(Modifier.layoutId("body")) { Body() }
    }
) { measurables, constraints ->
    val header = measurables.first { it.layoutId == "header" }
    val body = measurables.first { it.layoutId == "body" }
    // 分别测量，不同策略
}
```

第二个是 `Placeable.PlacementScope` 里的坐标验证。元素位置不对时，在 `placeRelative` 之前打日志输出坐标，通常能快速定位。调试自定义布局最怕逻辑看着没问题但位置总歪，十有八九是坐标系计算出了偏差。

## 一条核心原则

写过多个自定义 Layout 之后，我总结出一条经验：优先在 `measure` 阶段解决问题，不要在 `layout` 阶段过度补偿。

如果你发现自己在 `layout` 阶段反复调偏移量来弥补测量阶段的不足，那说明测量策略已经出了问题。子元素的测量结果决定了 `width` 和 `height`，摆放阶段只能改位置，不能改尺寸。用 `placeRelative` 做偏移"微调"，其实是在掩盖上游的错误。

我的实践是先给容器和子元素加半透明背景——`Modifier.background(Color.Red.copy(alpha = 0.3f))`——直观看到每个元素的真实边界。边界和预期对不上，就回头修正测量参数，不在摆放阶段硬调。
