---
title: "Jetpack Compose Gestures: PointerInput Event Pipeline and Nested Scrolling"
lang: en
translationKey: jetpack-compose-gestures
slug: jetpack-compose-gestures
excerpt: "A deep dive into Compose gesture handling, including PointerInput, event passes, gesture detectors, nested scrolling conflicts, direction locking, and transform pitfalls."
publishDate: '2026-05-16'
tags:
- "Jetpack Compose"
- "Gestures"
- "Nested Scrolling"
- "PointerInput"
- "Event Dispatch"
seo:
  title: "Jetpack Compose Gestures: PointerInput, Event Passes, and Nested Scrolling"
  description: "Analyze Compose PointerInput, gesture detection, event dispatch, Modifier pipelines, nested scrolling conflicts, and performance tradeoffs."
---

When migrating an old project from the View system to Compose, the first bug that really bothered me involved a vertical list with horizontally swipeable rows. If the finger moved at a slight angle, the vertical list and horizontal child item would stick together and jitter. In the View system, one line of `requestDisallowInterceptTouchEvent` would usually solve it. In Compose, that mental model does not apply.

Compose's gesture system is not syntax sugar over View touch dispatch. It is a separate architecture. I spent two weeks reading the related source code and organized the notes into this article.

## From View touch dispatch to the Compose event pipeline

View gesture handling depends on the recursive chain of `onInterceptTouchEvent` and `onTouchEvent`. The fatal weakness of that mechanism is that **interception decisions and event execution are coupled in one method**. A parent View has to synchronously decide whether to intercept at the moment it receives the event. The result is that nested scrolling logic gets scattered across multiple levels, and changing one place can affect the whole tree.

Compose makes a fundamental split: **hit testing, event consumption, and gesture detection are decoupled**.

After an event enters Compose, the flow is:

```
Native MotionEvent -> PointerInteropFilter -> LayoutNode hit testing
-> PointerInputFilter pipeline -> gesture detectors such as detectDragGestures
```

The first layer, `PointerInteropFilter`, converts Android's native `MotionEvent` into Compose's internal `PointerEvent`. The second layer performs hit testing against the `LayoutNode` tree using the touch coordinates. The third layer, the `PointerInputFilter` pipeline, is where logic registered through `Modifier.pointerInput` is queued and run.

## PointerInputFilter: the event pipeline

Behind the `pointerInput` modifier, Compose creates a `PointerInputFilter` and attaches it to the `LayoutNode`. The core implementation looks like this:

```kotlin
// androidx.compose.ui.input.pointer.PointerInteropFilter
internal class PointerInputFilter(
    private val layoutNode: LayoutNode,
    private val pointerInputHandler: PointerInputEventHandler
) {
    fun onPointerEvent(
        pointerEvent: PointerEvent,
        pass: PointerEventPass,
        bounds: IntSize
    ) {
        // Dispatch events according to the pass phase
        pointerInputHandler.invoke(pointerEvent, pass, bounds)
    }
}
```

The `PointerEventPass` parameter is often overlooked, but it is the key to understanding the gesture system. It defines three phases for event propagation through the Modifier chain:

- **Initial**: top-down propagation. Parents receive events before children and can make interception decisions.
- **Main**: the main gesture handling phase. Most detectors run here.
- **Final**: bottom-up propagation. Children receive events before parents, usually for cleanup.

The same event is processed by different Modifiers in priority order within the same frame. This is not the View system's one-time "intercept or not" decision. This design is the foundation for resolving nested scrolling conflicts.

## How declarative gesture APIs work internally

Compose provides three groups of gesture detection APIs: `detectTapGestures`, `detectDragGestures`, and `detectTransformGestures`. They all depend on `AwaitPointerEventScope`, a coroutine scope that lets you suspend inside a `pointerInput` block while waiting for a specific event sequence.

### Tap detection: the awaitFirstDown state machine

Internally, `detectTapGestures` is a state machine. Simplified:

```kotlin
suspend fun PointerInputScope.detectTapGestures(
    onTap: ((Offset) -> Unit)? = null,
    onDoubleTap: ((Offset) -> Unit)? = null,
    onLongPress: ((Offset) -> Unit)? = null,
) {
    awaitPointerEventScope {
        while (true) {
            val down = awaitFirstDown(requireUnconsumed = false)
            val upOrDrag = withTimeoutOrNull(
                viewConfiguration.longPressTimeoutMillis
            ) {
                waitForUpOrCancellation()
            }
            if (upOrDrag != null) {
                // Released before the long-press timeout: classify as tap
                onTap?.invoke(upOrDrag.position)
            } else {
                // Still pressed after timeout: enter the long-press branch
                onLongPress?.invoke(down.position)
                waitForUpOrCancellation()
            }
        }
    }
}
```

One pitfall here is `requireUnconsumed = false`. By default, `awaitFirstDown` only responds to unconsumed events. If an upstream Modifier has already consumed the Down event, your detector will never see it. For scenarios such as global analytics that need transparent listening, you must explicitly pass `false`; otherwise the event chain breaks in the middle. The official docs mention this briefly, but it cost me a lot of debugging time.

### Drag detection: consumption and mutual exclusion

After `detectDragGestures` starts, it loops over Move events and passes deltas to `onDrag`:

```kotlin
suspend fun PointerInputScope.detectDragGestures(
    onDragStart: (Offset) -> Unit = {},
    onDragEnd: () -> Unit = {},
    onDragCancel: () -> Unit = {},
    onDrag: (change: PointerInputChange, dragAmount: Offset) -> Unit
) {
    awaitPointerEventScope {
        val down = awaitFirstDown()
        onDragStart(down.position)
        var currentPointer = down
        while (true) {
            val event = awaitPointerEvent()
            val dragChange = event.changes.firstOrNull() ?: break
            if (dragChange.pressed) {
                dragChange.consume() // Key point: consume the event to stop it from passing through
                val dragAmount = dragChange.position - currentPointer.position
                onDrag(dragChange, dragAmount)
                currentPointer = dragChange
            } else {
                onDragEnd()
                break
            }
        }
    }
}
```

`dragChange.consume()` is the key operation for nested conflict handling. After a child consumes the event, the parent's `pointerInput` will not receive that event in the same pass.

But what if the parent consumes first in the Initial pass?

## Resolving nested scrolling conflicts

Compose handles nested scrolling much more cleanly than the View system: combine `nestedScroll` with `pointerInput` pass phases instead of relying on a child-to-parent reverse notification such as `requestDisallowInterceptTouchEvent`.

For the common scenario of "horizontal swipeable child + vertical scrolling list", the standard setup is:

1. Register `detectHorizontalDragGestures` on the horizontal child in the **Main pass**
2. Register `detectVerticalDragGestures` on the vertical list in the **Initial pass**

During vertical scrolling, the vertical detector in the Initial pass receives and consumes the event first, so the horizontal child has no event left in the Main pass. Horizontal scrolling works the same way in the opposite direction.

In real projects, pure pass separation is often not enough. When the user drags diagonally, both horizontal and vertical deltas can cross the threshold, so both sides respond and the UI jitters. My fix was to add direction locking:

```kotlin
Modifier.pointerInput(Unit) {
    awaitPointerEventScope {
        val down = awaitFirstDown()
        var directionLocked = false
        var lockedAxis: Axis? = null
        while (true) {
            val event = awaitPointerEvent()
            val change = event.changes.firstOrNull() ?: break
            val delta = change.position - down.position
            if (!directionLocked && (abs(delta.x) > touchSlop || abs(delta.y) > touchSlop)) {
                lockedAxis = if (abs(delta.x) > abs(delta.y)) Axis.Horizontal else Axis.Vertical
                directionLocked = true
            }
            if (lockedAxis == Axis.Horizontal) {
                // Handle horizontal drag
                change.consume()
            }
        }
    }
}
```

The idea is straightforward: **detect and lock the dominant drag axis in the Initial pass**, then dispatch in the Main pass according to the locked direction. Even with diagonal finger movement, only the dominant direction responds, eliminating jitter.

## Transform detection pitfalls with rotation and zoom

`detectTransformGestures` can recognize pan, rotation, and zoom at the same time. It is convenient, but it has traps. It computes transform parameters from changes in two touch points:

```kotlin
suspend fun PointerInputScope.detectTransformGestures(
    panZoomLock: Boolean = false,
    onGesture: (centroid: Offset, pan: Offset, zoom: Float, rotation: Float) -> Unit
) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitFirstDown()
            do {
                val currentEvent = awaitPointerEvent()
                val changes = currentEvent.changes
                if (changes.size >= 2) {
                    val centroid = changes.calculateCentroid()
                    // Compute pan, zoom, and rotation deltas relative to the previous frame
                    onGesture(centroid, pan, zoom, rotation)
                }
            } while (changes.any { it.pressed })
        }
    }
}
```

The problem appears when switching from two fingers to one. After a two-finger zoom, the user lifts one finger, and the remaining single finger is treated as a pan. The content can jump suddenly. The fix is to filter by pointer count in the `onGesture` callback:

```kotlin
onGesture = { centroid, pan, zoom, rotation ->
    if (changes.size >= 2) {
        // Two fingers: zoom and rotate
        scale *= zoom
    }
    // Pan regardless of pointer count
    offset += pan
}
```

## Practical lessons from projects

After iterating on three projects, these are the points that matter most:

- **Consume events at the right time**. Not consuming causes nested conflicts. Consuming too early prevents parent components from cooperating. Consuming in `onDragStart` is usually more reliable than consuming during `awaitFirstDown`, because the direction has already been determined.
- **Use the `velocity` parameter for fling animations instead of calculating it yourself**. The `onDragEnd` callback in `detectDragGestures` already includes velocity estimation. Combined with Compose's `animateDecay`, it produces better results than a hand-written decay curve. In an image viewer, replacing manual decay with `animateDecay` noticeably improved touch tracking.
- **For complex gestures, prefer composition over piling everything into one block**. Do not stuff multiple `detectXxx` calls into a single `pointerInput` block. Chain multiple independent gesture detectors with `Modifier.pointerInput`, so responsibilities are separate. Debugging and reuse become much easier, and changing one gesture behavior is less likely to affect unrelated logic.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping](/en/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose Modifier internals: Modifier.Node, layout, drawing, and event handling](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose animations: AnimationSpec, springs, and Transition](/en/blog/jetpack-compose-animation/)
<!-- /seo-internal-links -->
