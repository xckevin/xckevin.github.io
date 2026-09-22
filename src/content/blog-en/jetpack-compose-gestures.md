---
title: "Jetpack Compose Gestures: Pointer Input, Consumption, and Nested Scroll"
lang: en
translationKey: jetpack-compose-gestures
slug: jetpack-compose-gestures
excerpt: "Build reliable Compose interactions by choosing the right gesture API, understanding pointer consumption, and coordinating nested scrolling."
publishDate: '2026-05-16'
updatedDate: '2026-09-22'
tags:
- "Jetpack Compose"
- "Gestures"
- "Nested Scrolling"
- "PointerInput"
seo:
  title: "Compose Gestures: Pointer Input, Consumption, and Nested Scroll"
  description: "Choose Compose gesture APIs correctly, understand pointer consumption, and coordinate nested scrolling without touch conflicts."
---

**Start with Compose's highest-level API.** Use `clickable`, `scrollable`, `draggable`, or `transformable` when they fit; write `pointerInput` only when the gesture itself is custom. A swipe row inside a `LazyColumn` normally needs a horizontal detector on the row and the list's normal vertical scroll—not an emulation of View interception.

This distinction fixes a common migration failure: `PointerInputChange.consume()` records that part of a pointer change was handled. It does **not** remove the event from every parent. All handlers selected by hit testing still participate in the passes and can observe consumption. `nestedScroll`, separately, coordinates **scroll deltas and fling velocity** between scrolling parents and children.

## Choose the API before handling raw events

`Button` and `clickable` include semantics, keyboard support, focus behavior, and visual feedback. Prefer them for actions. Use a gesture modifier for a standard gesture on custom content. Use `pointerInput` and `awaitPointerEventScope` when the product needs a sequence Compose does not already model.

Do not put two top-level detectors one after another in one `pointerInput` block: each suspends for gestures, so the second is unreachable. Chain separate `pointerInput` modifiers when both are needed.

```kotlin
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

@Composable
fun SwipeActionRow() {
    var offsetPx by remember { mutableFloatStateOf(0f) }
    val maxOffsetPx = 192f

    Box(
        Modifier
            .fillMaxWidth()
            .height(64.dp)
            .offset { IntOffset(offsetPx.roundToInt(), 0) }
            .background(Color.LightGray)
            .pointerInput(Unit) {
                detectHorizontalDragGestures { change, dragAmount ->
                    // The detector has crossed touch slop. Claim the horizontal delta.
                    change.consume()
                    offsetPx = (offsetPx + dragAmount).coerceIn(-maxOffsetPx, maxOffsetPx)
                }
            }
    )
}
```

The example now moves the row within `-192px..192px`. A product should derive that boundary from the action width and layout density rather than treating 192 as universal. Keep rapidly changing state inside the swipe component and expose a committed action instead of continuously mutating screen-level state.

## What pointer passes and consumption actually mean

For a pressed pointer, Compose hit-tests the initial down event and keeps that hit chain for the rest of the gesture (hover is an exception). Events travel through `Initial`, `Main`, and `Final` passes. Parents are visited first in `Initial` and children first in `Main`; `Final` lets an ancestor react after descendants have handled the change.

Consumption is cooperative communication. A handler should check whether another handler consumed a change when it needs exclusive behavior, and consume only the portion it owns after it recognizes the gesture. Consuming `Down` speculatively makes taps, long presses, selection, and accessibility interactions harder to compose. For an observer such as analytics, `awaitFirstDown(requireUnconsumed = false)` can inspect an already-consumed down event, but it must not treat observation as ownership.

This is why hand-written "parent handles vertical in Initial, child handles horizontal in Main" is rarely a general nested-scroll solution. It silently replaces the built-in fling, overscroll, touch-slop, and accessibility behavior. Use it only for a deliberately custom interaction and test diagonal drags, cancellation, mouse, stylus, and multi-touch.

## Nested scroll is delta negotiation

`LazyColumn`, `verticalScroll`, `scrollable`, and `draggable` already participate in nested scrolling where appropriate. If a component has a genuine parent-child scroll policy—for example, a collapsing toolbar—attach a `NestedScrollConnection` to the parent and return exactly the distance it consumes. Do not return an invented value just to block the child.

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Offset

private object ObserveOnlyConnection : NestedScrollConnection {
    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset = Offset.Zero
}

@Composable
fun Feed(items: List<String>) {
    Column(Modifier.fillMaxSize().nestedScroll(ObserveOnlyConnection)) {
        LazyColumn { items(items, key = { it }) { SwipeActionRow() } }
    }
}
```

For a collapsing header, clamp the header's offset, return only the clamped amount consumed in `onPreScroll`/`onPostScroll`, and also implement the matching fling callbacks. If the child only scrolls vertically and a row only swipes horizontally, Compose's normal slop and consumption behavior is often enough; add an explicit direction lock only after reproducing a diagonal-drag defect.

## Transform gestures: keep the coordinate model explicit

`detectTransformGestures` reports centroid, pan, zoom, and rotation deltas. Apply zoom and rotation around the reported centroid, constrain the resulting scale and translation, and decide product behavior when pointer count changes. The callback does not expose a stable "two fingers only" contract; when that rule matters, implement the gesture with `awaitPointerEventScope` and inspect the active changes yourself. For a standard transformable surface, prefer `transformable`, which participates in Compose's interaction model.

## A practical debugging path

1. Reproduce the conflict with a UI test using `performTouchInput`, including diagonal motion and cancellation.
2. Replace a raw detector with `clickable`, `draggable`, or `scrollable` if it can express the behavior.
3. Inspect consumption at the handler that misbehaves; do not infer it from which callback ran.
4. Add `nestedScroll` only when two scroll containers must divide a delta or fling.

The [Compose phases guide](/en/blog/jetpack-compose-phases-composition-layout-draw/) explains why fast-changing gesture state should be read in the appropriate phase. For a scrolling feed, apply the item identity and measurement guidance in [LazyColumn performance](/en/blog/jetpack-compose-lazycolumn-performance/). More related material is collected in [Jetpack Compose](/en/jetpack-compose/) and [Android performance](/en/android-performance/).

## Official references

- [Pointer input in Compose](https://developer.android.com/develop/ui/compose/touch-input/pointer-input)
- [Understand gestures and event consumption](https://developer.android.com/develop/ui/compose/touch-input/pointer-input/understand-gestures)
- [Scroll modifiers](https://developer.android.com/develop/ui/compose/touch-input/scroll/scroll-modifiers)
