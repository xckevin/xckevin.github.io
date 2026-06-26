---
title: "Inside the Android View Drag-and-Drop System: From DragShadowBuilder to Cross-Window ClipData"
lang: en
translationKey: android-view-drag-drop-system
slug: android-view-drag-drop-system
excerpt: "An end-to-end walkthrough of Android's drag-and-drop internals: startDragAndDrop, DragEvent dispatch, the DragShadow render layer, and cross-window ClipData transport."
publishDate: '2026-06-11'
tags:
- "Android"
- "Drag and Drop"
- "DragShadowBuilder"
- "ClipData"
- "WindowManager"
seo:
  title: "Android Drag-and-Drop Internals: DragShadowBuilder to ClipData"
  description: "Guide to Android drag-and-drop: startDragAndDrop, DragEvent dispatch, DragShadow surface, cross-window ClipData, and Compose integration."
  pageType: article
---

While building a cross-window image drag-and-drop feature, I hit a strange bug: dragging within the same Activity worked fine, but the moment the finger crossed into another window the DragShadow vanished and ClipData came back null. After hours of digging, the culprit was the target window's WindowManager flags. That rabbit hole took me through the entire drag-and-drop pipeline.

## The startDragAndDrop Call Chain

`View.startDragAndDrop()` has a longer internal call chain than its signature suggests.

```java
public final boolean startDragAndDrop(ClipData data, DragShadowBuilder shadowBuilder,
        Object myLocalState, int flags) {
    View.DragShadowBuilder shadow = new View.DragShadowBuilder(this);
    try {
        return sCascadedDragDrop
                ? startDrag(this, shadowBuilder, data, flags)
                : false;
    } catch (Exception e) {
        Log.e(TAG, "Failed to start drag", e);
        return false;
    }
}
```

Each of the three parameters controls a distinct path:

- **DragShadowBuilder**: defines the visual feedback that follows the finger, rendered on an independent Surface
- **ClipData**: the Parcelable cross-process data carrier that determines what the target window receives
- **myLocalState**: an in-process local state reference; the target can't access it across windows

`startDrag` creates an `ACTION_DRAG_STARTED` event and routes it through `ViewRootImpl` to WindowManagerService. WMS enters a global drag-and-drop state machine — only one drag operation is allowed at a time. Calling `startDragAndDrop` during an active drag returns false immediately.

## DragEvent Dispatch Path

DragEvent dispatch doesn't traverse the Activity's View tree hierarchy. WMS injects events through a dedicated InputChannel directly into the target window's `ViewRootImpl`, then down through `ViewGroup.dispatchDragEvent()`.

This is fundamentally different from touch events — drag events and `ACTION_DOWN/UP` don't share an input channel. The lifecycle of each stage:

- `ACTION_DRAG_STARTED`: drag begins; all visible windows receive it, letting the system "ask" which windows want to participate
- `ACTION_DRAG_ENTERED`: the finger crosses into a window's bounds; cross-window coordinates are mapped by WMS
- `ACTION_DRAG_LOCATION`: position updates during the drag; sampled from a different source than ordinary `ACTION_MOVE`
- `ACTION_DROP`: sent to the window under the finger on release
- `ACTION_DRAG_ENDED`: the entire drag ends, successful or not; the source window cleans up here

A detail that's easy to miss: returning `true` from `ACTION_DRAG_STARTED` signals willingness to receive the drag. Only then will you get `ENTERED`, `LOCATION`, and `DROP`. A window that returns `false` is excluded entirely from drag targets.

## The DragShadow's Independent Render Layer

The most commonly overridden DragShadowBuilder callbacks are `onProvideShadowMetrics` and `onDrawShadow`. You might intuit that the Shadow is drawn as an overlay on the source window. It isn't.

WMS creates a temporary Surface at the top of the Display's z-order, above all app windows. The DragShadow is drawn directly on this Surface and follows the finger's coordinates.

```kotlin
class ScaledDragShadow(view: View, private val scale: Float = 1.2f) : View.DragShadowBuilder(view) {
    override fun onProvideShadowMetrics(outSize: Point, outTouchPoint: Point) {
        super.onProvideShadowMetrics(outSize, outTouchPoint)
        outTouchPoint.set(outSize.x / 2, outSize.y / 2)
    }

    override fun onDrawShadow(canvas: Canvas) {
        canvas.scale(scale, scale)
        super.onDrawShadow(canvas)
    }
}
```

This is why the Shadow stays visible across windows — it doesn't live on the source window's drawing surface. But WMS refreshes this Surface based on input-event sampling frequency, not Choreographer's VSYNC. On low-end devices, if `onDrawShadow` does heavy work like `clipPath` with a shadow layer, the drag will visibly drop frames.

I hit a pitfall here once: in `onDrawShadow` I used `canvas.concat(matrix)` for rotation, and on some devices the Shadow jittered. The root cause was that WMS's Surface composition timing varies across GPUs, and the rotation matrix and finger coordinates fell out of sync by a small margin.

## Cross-Window ClipData Transport

The core of cross-window drag-and-drop is ClipData serialization. `ClipData` implements Parcelable and crosses process boundaries via Binder. The full flow:

1. Source window calls `startDragAndDrop` → WMS records the global drag state and holds the ClipData reference
2. Finger moves over the target window → WMS computes the coordinate offset and injects `ACTION_DRAG_ENTERED` into the target's `ViewRootImpl`
3. Target reads data via `event.getClipData()` — the instance received in `ENTERED` and `LOCATION` is the same deserialized object; it's not re-transmitted each time
4. On release, WMS sends `ACTION_DROP`; after the target consumes the data, WMS sends `ACTION_DRAG_ENDED` to the source

`myLocalState` is unavailable in cross-window scenarios. When I need to pass non-serialized intermediate state during a drag, I use an in-process singleton Map keyed by the ClipDescription's label:

```kotlin
object DragStateCache {
    private val cache = ConcurrentHashMap<String, Any>()

    fun put(label: String, state: Any) = cache.put(label, state)
    fun get(label: String): Any? = cache[label]
    fun remove(label: String) = cache.remove(label)
}
```

For a window to receive external drags, its `DecorView` must pass WMS policy checks. A common trap: `FLAG_NOT_TOUCHABLE` or `FLAG_NOT_FOCUSABLE` causes WMS to intercept drag events, so even with an `OnDragListener` set, nothing arrives.

## Bridging with RecyclerView and Compose

`ItemTouchHelper`'s drag-to-reorder is a completely different mechanism from system drag-and-drop. `ItemTouchHelper` uses `onTouchEvent` + Canvas translation and never touches DragEvent. Its drag behavior is locked inside the RecyclerView.

For cross-control drag-and-drop, you have to bridge manually in a long-press callback:

```kotlin
view.setOnLongClickListener {
    val clip = ClipData.newPlainText("id", item.id)
    val shadow = View.DragShadowBuilder(view)
    view.startDragAndDrop(clip, shadow, item, 0)
    true
}
```

The drop-side receiver:

```kotlin
targetView.setOnDragListener { _, event ->
    if (event.action == DragEvent.ACTION_DROP) {
        val id = event.clipData.getItemAt(0).text.toString()
        handleDrop(id)
    }
    true // must return true on DRAG_STARTED
}
```

On the Compose side, the API wraps the underlying calls with a cleaner declarative surface. `Modifier.dragAndDropSource` and `Modifier.dragAndDropTarget` provide the entry points:

```kotlin
Modifier.dragAndDropSource {
    detectTapGestures(
        onLongPress = {
            startTransfer(DragAndDropTransferData(
                clipData = ClipData.newPlainText("key", value)
            ))
        }
    )
}

Modifier.dragAndDropTarget {
    shouldStartDragAndDrop { it.clipData.description.label == "key" }
    target {
        val event = awaitDragAndDropEvent()
        if (event is DragAndDropEvent.Drop) {
            val text = event.clipData.getItemAt(0).text
            // handle drop
        }
    }
}
```

`awaitDragAndDropEvent` is a suspend function dispatched inside the PointerInput coroutine. Doing heavy work inside the callback blocks gesture processing, so launch business logic into a separate coroutine. On Android 12+, `DRAG_FLAG_GLOBAL` enables cross-Activity drags, but cross-app drag is still gated by the target window declaring a matching `MIME_TYPE`.

The drag-and-drop system's internals aren't complex — at its core it's a global state machine, a dedicated input channel, and a temporary Surface. What eats your time is understanding how WMS flags and policies interact. Once those primitives are clear, every business requirement becomes a composition of them.
