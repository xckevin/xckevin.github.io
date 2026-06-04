---
title: "Compose Custom Layout: MeasurePolicy, Intrinsics, and Waterfall Layouts"
lang: en
translationKey: jetpack-compose-custom-layout-measurepolicy
slug: jetpack-compose-custom-layout-measurepolicy
excerpt: "A deep dive into Jetpack Compose custom layout, from MeasurePolicy constraints and intrinsic measurement to SubcomposeLayout, adaptive grids, waterfall layouts, and debugging tips."
publishDate: '2026-05-13'
tags:
- "Jetpack Compose"
- "Android"
- "Kotlin"
- "Custom Layout"
- "UI Performance"
seo:
  title: "Compose Custom Layout: MeasurePolicy, Intrinsic Size, and Waterfall Grids"
  description: "Learn Compose custom layout with MeasurePolicy, constraints, intrinsic size, SubcomposeLayout, adaptive grids, waterfall layouts, and debugging."
  pageType: article
---

While building a Compose image feed, I ran into a requirement: fixed image width, adaptive height, and tight packing like a masonry or waterfall layout. `LazyVerticalStaggeredGrid` can handle equal-height items or proportional scaling, but not a fully irregular native waterfall layout. I searched through the standard library and found no ready-made solution.

So I wrote a custom Layout.

## MeasurePolicy: the backbone of Compose layout

Compose's measurement model is completely different from the traditional View system. The View system uses two traversals: `measure` followed by `layout`, and width plus height are determined during measurement. Compose uses single-pass constraint propagation: the parent gives each child a `Constraints` object, the child chooses its size within those constraints, and the parent then places the child based on that size.

The core interface is `MeasurePolicy`:

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
            // 1. Measure all children
            val placeables = measurables.map { measurable ->
                measurable.measure(constraints)
            }
            // 2. Decide the container size. It must not exceed the constraints.
            val width = constraints.maxWidth
            val height = placeables.sumOf { it.height }
            // 3. Place the children
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

This code implements a simple vertical container with behavior similar to `Column`. The width and height returned by `layout()` must stay within `constraints`, otherwise Compose throws immediately. I hit this repeatedly at first and only later realized that Compose enforces constraint boundaries strictly.

The `measurable.measure(constraints)` call receives the constraints passed down by the parent container. If you want a child to express its own desired size, you need intrinsic measurement.

## Intrinsic measurement: letting children express intent

Imagine a form layout where the label column should align to the width of the widest label. A normal `Row` cannot do that because each label does not know how wide the other labels are.

This is where `IntrinsicSize` helps:

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
            // Ask every child for its maximum intrinsic width
            val maxIntrinsicWidth = measurables.maxOf { measurable ->
                measurable.maxIntrinsicWidth(constraints.maxHeight)
            }
            // Measure every child with that shared width
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

`maxIntrinsicWidth(height)` means: given this height, what is the minimum width needed to fully show the content? Compose provides four intrinsic queries: `minIntrinsicWidth`, `maxIntrinsicWidth`, `minIntrinsicHeight`, and `maxIntrinsicHeight`.

There is a trap with the intrinsic width of `Text`: an extremely long English word is measured as unwrapped text, which can make the measured width much larger than expected. I ran into this in a form-label scenario and solved it by applying `softWrap = true` together with `maxLines = 1` to the labels. If your label column suddenly becomes abnormally wide, it is probably the same issue.

## SubcomposeLayout: on-demand composition for dependent layout

When the size of some children depends on the measured result of other children, `MeasurePolicy` is no longer enough because all children are handled "at the same time" during measurement.

`SubcomposeLayout` supports batched composition and measurement. `BoxWithConstraints` and `LazyColumn` are both built on top of it. The mechanism is: compose one batch of children, measure them, then use the result to decide the composition strategy for the next batch.

```kotlin
@Composable
fun AdaptiveColumn(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    SubcomposeLayout(modifier) { constraints ->
        // First batch: measure representative children and estimate how many fit per row
        val measureResult = subcompose("scout", content).map {
            it.measure(constraints)
        }
        // Decide the later layout strategy from the first batch result
        // Real layouts can use more batches
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

`SubcomposeLayout` is expensive. Every extra batch adds another full composition traversal. My rule is simple: if `Layout` plus intrinsic measurement can solve the problem, do not use `SubcomposeLayout`. It becomes the right choice only when you truly need earlier measurement results to decide what to compose later.

## Practice: adaptive grid

Back to the opening problem. A simple adaptive grid uses a fixed 120dp cell width, calculates the column count from the container width, and lets child height adapt naturally.

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
        // Dynamically calculate the column count from the container width
        val columns = max(1, constraints.maxWidth / cellWidthPx)
        val actualCellWidth = constraints.maxWidth / columns
        val itemConstraints = Constraints(
            minWidth = actualCellWidth,
            maxWidth = actualCellWidth
        )
        val placeables = measurables.map { it.measure(itemConstraints) }
        // Accumulate row heights
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

In about thirty lines, this replaces `LazyVerticalGrid` for many non-lazy-loading scenarios. The key is that the `Constraints` object fixes only width, while height is left for the child to decide.

## Practice: waterfall layout

An adaptive grid determines each row's height from the tallest cell in that row. A waterfall layout is different: each cell is tightly packed into the column with the smallest accumulated height.

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

        // Track each column's accumulated height
        val columnHeights = IntArray(columns)
        // Record which column each child is assigned to
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

The core of the waterfall layout is the `minBy` line: each item goes into the shortest column, a standard greedy strategy. Add `verticalScroll` and you have a non-lazy waterfall page. If you need large data sets, you can adapt this with `LazyLayout`, but the implementation complexity roughly doubles, so I will leave that out here.

## Two tools for debugging Layout

Two debugging techniques come up often when writing custom Layouts.

The first is `Modifier.layoutId`, which labels different child elements:

```kotlin
Layout(
    content = {
        Box(Modifier.layoutId("header")) { Header() }
        Box(Modifier.layoutId("body")) { Body() }
    }
) { measurables, constraints ->
    val header = measurables.first { it.layoutId == "header" }
    val body = measurables.first { it.layoutId == "body" }
    // Measure them separately with different strategies
}
```

The second is coordinate verification inside `Placeable.PlacementScope`. When an element is placed incorrectly, logging coordinates before `placeRelative` usually locates the issue quickly. The hardest custom-layout bugs are the ones where the logic looks right but positions are consistently off. In most cases, the coordinate calculation is wrong.

## One core principle

After writing several custom Layouts, I arrived at one rule: solve the problem during `measure` first, and avoid overcompensating during `layout`.

If you repeatedly tweak offsets during `layout` to compensate for weak measurement logic, the measurement strategy is already broken. Child measurement results determine `width` and `height`; placement can only change position, not size. Using `placeRelative` for tiny offset adjustments often hides the upstream mistake.

My practice is to give both the container and children translucent backgrounds, such as `Modifier.background(Color.Red.copy(alpha = 0.3f))`, so I can see each element's real bounds directly. When the bounds do not match the expectation, fix the measurement parameters instead of forcing the placement phase to compensate.
