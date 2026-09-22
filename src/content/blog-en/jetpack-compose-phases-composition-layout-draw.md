---
title: "Compose Phases: Composition, Layout, Drawing, and State Reads"
lang: en
translationKey: jetpack-compose-phases-composition-layout-draw
slug: jetpack-compose-phases-composition-layout-draw
excerpt: "Understand Compose's composition, layout, and drawing phases, then place state reads where they invalidate the least work."
publishDate: '2026-01-15'
updatedDate: '2026-09-22'
tags:
- "Android"
- "Jetpack Compose"
- "Performance"
- "State Management"
seo:
  title: "Compose Phases: Composition, Layout, Drawing, and State Reads"
  description: "Learn how Compose phase-local state reads affect recomposition, layout, and drawing, with correct lambda modifier examples."
  pageType: article
---

**The place where state is read determines the earliest work Compose must invalidate.** Read text or structure in composition; read a position in layout; read pixels-only data while drawing. This is a performance tool after measurement, not a reason to force every value into a drawing lambda.

A frame generally proceeds in one direction:

```text
Composition (what exists) -> Layout (size and position) -> Drawing (pixels)
```

Compose tracks state reads in these restart scopes and can reuse work when inputs are unchanged. The model is localized, not magical: `LazyColumn`, `LazyRow`, and `BoxWithConstraints` are notable cases where child composition depends on a parent's layout constraints. Layout also contains separate measurement and placement restart scopes, so a placement read can restart placement without necessarily remeasuring that node.

## Match the state to the phase

This complete example puts three independent values in the phase that consumes them. Click once to change all three; examine each change independently when profiling.

```kotlin
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.offset

@Composable
fun PhaseAwareBadge() {
    var label by remember { mutableStateOf("Ready") }
    var offsetPx by remember { mutableIntStateOf(0) }
    var color by remember { mutableStateOf(Color.Magenta) }

    Column(Modifier.padding(16.dp)) {
        Button(onClick = {
            label = "Updated"       // read by Text during composition
            offsetPx += 12           // read in the offset lambda during placement
            color = Color.Cyan       // read in drawBehind during drawing
        }) { Text("Update") }

        Text(
            text = label,
            modifier = Modifier
                .offset { IntOffset(offsetPx, 0) }
                .drawBehind { drawCircle(color = color, radius = 8.dp.toPx()) }
                .background(Color.White)
        )
    }
}
```

The direct overload `Modifier.offset(x = someDp, y = 0.dp)` reads `someDp` during composition. The lambda overload shown above defers its read to layout placement. Likewise, `Modifier.graphicsLayer { alpha = alphaState }`, `drawBehind`, and `Canvas` read state during drawing and can skip both earlier phases for a pixels-only change. This only applies if that state is not also read earlier in the same affected path.

## Do not manufacture a cross-phase feedback loop

The common failure is: observe a child's size in `onSizeChanged` or `onGloballyPositioned`, write it into state, then use that state as a parent `padding`/`height` input. A layout pass writes state that requests composition and layout again; the first frame can be visually wrong and repeated changes can loop.

Use `Column`, `Row`, `Box`, a parent-data modifier, or a custom `Layout` so the nearest shared parent measures and places related children from one source of truth. Do not write state during composition after it has already been read there (“backwards write”); Compose may keep recomposing until it reaches a limit.

## Skipping: useful, version-dependent, and not the goal

Skipping applies to eligible restartable composables when their inputs compare unchanged. In the normal model, stable inputs compare with `equals`; unstable inputs can prevent eligibility. Kotlin 2.0.20 enables strong skipping by default: restartable composables can be skippable even with unstable inputs, using instance equality for those inputs, and compiler-generated memoization covers captured lambdas.

Strong skipping does not guarantee that a composable is skipped. A non-restartable/non-skippable composable, a new unstable object instance, changed state read by that scope, or a required layout/draw update can still run work. Do not add `@Stable`/`@Immutable` merely to chase a report: those annotations promise an observable-change contract. Check the compiler configuration and reports for the module actually being profiled, especially on Kotlin releases before 2.0.20.

## A disciplined optimization path

1. Record the real interaction in release mode and identify whether the cost is composition, measurement/placement, drawing, image decoding, or data work.
2. Keep correctness and readable state ownership first.
3. If a frequently changing value only moves content, use a lambda layout modifier; if it changes only pixels, consider a draw lambda or `graphicsLayer`.
4. Re-measure the same path. A phase change is an improvement only if it reduces the measured bottleneck.

The scrolling case study in [LazyColumn performance](/en/blog/jetpack-compose-lazycolumn-performance/) applies these rules to list state, keys, and measurement. For pointer-driven values, see [Compose gestures](/en/blog/jetpack-compose-gestures/). More related material is available in [Jetpack Compose](/en/jetpack-compose/) and [Android performance](/en/android-performance/).

## Official references

- [Jetpack Compose phases](https://developer.android.com/develop/ui/compose/phases)
- [Modifier breakdown by phase](https://developer.android.com/develop/ui/compose/performance/modifier-phases)
- [Strong skipping mode](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
- [Compose performance best practices](https://developer.android.com/develop/ui/compose/performance/bestpractices)
