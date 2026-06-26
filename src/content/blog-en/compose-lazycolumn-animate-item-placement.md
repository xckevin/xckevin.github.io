---
title: "Inside Jetpack Compose List Animations: From animateItem to Declarative Choreography"
lang: en
translationKey: compose-lazycolumn-animate-item-placement
slug: compose-lazycolumn-animate-item-placement
excerpt: "A practical walkthrough of animateItem internals, key stability, recomposition scoping, and frame-rate tuning for LazyColumn."
publishDate: '2026-06-10'
tags:
- "Android"
- "Jetpack Compose"
- "Kotlin"
- "Performance"
- "Animation"
seo:
  title: "Inside Jetpack Compose List Animations: animateItem Internals"
  description: "How animateItem works under the hood, key stability, recomposition scoping, and frame-rate tuning for smooth LazyColumn animations."
  pageType: article
---

I was building a chat list reordering feature. When a new message got pinned to the top, older ones shifted down. QA reported "severe animation jank — it slides like a slideshow." The root cause: we hadn't passed a `key`, so Compose treated every shifted message as a brand-new Composable and the animation engine sat idle.

Adding `Modifier.animateItem()` fixed the worst of it, but low-end devices still stuttered. Chasing the source code revealed that the implementation is far more layered than the one-liner suggests.

## How animateItem Works

`animateItem` is a `Modifier` extension. The surface API is trivial:

```kotlin
LazyColumn {
    items(messages, key = { it.id }) { msg ->
        MessageItem(
            msg,
            modifier = Modifier.animateItem(
                placementSpec = tween(300)
            )
        )
    }
}
```

One line, and items animate when they're added, removed, or moved. Internally, three layers cooperate.

**Layer 1: position-delta capture.** An `Animatable` instance records the item's offset within the `PlacementScope`. Every time LazyColumn's `measure` pass recomputes child positions, the modifier detects that the same `key` has moved and stores the delta `(dx, dy)`.

**Layer 2: animation-driven layout offset.** The real work happens at `place` time. Compose has already positioned the element at its new coordinates; `animateItem` then applies a visual offset to pull it back toward the old position and animates that offset back to zero over time.

**Layer 3: coordination with LazyLayout.** LazyColumn is backed by `LazyLayout`, which only measures and places children inside the visible viewport. If an item slides off-screen mid-animation, the animation is cut short — this is passive optimization, not a bug. The item-animation node tracks placement changes locally; there is no extra global state manager.

## Why Declarative Animation Struggles Here

Declarative animation promises "describe the target state, the framework interpolates." Inside LazyColumn, that promise hits two obstacles.

**Obstacle 1: lifecycle mismatch between composition and animation.**

By default, LazyColumn releases an item's Composition when it scrolls out of view. If the `animateItem` animation hasn't finished by then, the Composable is disposed and the animation dies. Keeping a small beyond-bounds window can help on Compose versions that expose that tuning hook:

```kotlin
LazyColumn(
    // keep 3 off-screen items alive so animations can finish
    beyondBoundsItemCount = 3
) { ... }
```

But that's a workaround. I prefer to keep list animations under 300ms and pair them with a moderate scroll velocity so the animation completes inside the visible window, without relying on a retained buffer.

**Obstacle 2: contention with scroll events.**

When the user scrolls during an animation, LazyColumn juggles two coordinate systems at once: the animation offset and the scroll offset. Mishandle this and you get visual jumps.

Compose's solution is to keep the offsets on different layers. `animateItem` applies item-level visual movement; scroll translation is managed by `LazyListState` at the LazyLayout container level. The two offsets stack on different layers without interfering. That's why animations and scrolling don't fight each other.

## Three Strategies for Stable Frame Rates

Field-tested fixes for real-world jank.

### Strategy 1: key is the animation's identity card

Without a `key`, Compose identifies items by position index. When an item moves, the framework sees "the old one is gone, this is a different one" — no animation, just a swap.

With a `key`, the framework recognizes "same item, new position" and triggers the item-animation modifier to compute the delta and start the animation.

A common anti-pattern is keying on index: `key = { items.indexOf(it) }`. That's equivalent to no key at all. Use a stable business identifier — a database primary key, for example.

### Strategy 2: scope your recompositions

The more complex an item's content, the more a recomposition costs. `animateItem` is cheap only when the item body stays cheap; if the item reads a lot of state or does heavy computation, 60fps is gone.

My usual pattern:

```kotlin
@Composable
fun MessageItem(msg: Message, modifier: Modifier) {
    var expanded by remember { mutableStateOf(false) }

    Column(modifier) {
        // Static content: unaffected by animation, doesn't recompose on animation frames
        MessageContent(msg.text)

        // Dynamic content: recomposes only when expanded changes, outside animation frames
        if (expanded) {
            MessageDetail(msg)
        }
    }
}
```

The goal is to keep animation frames from triggering heavy recompositions inside the item. Placement and alpha animations should stay in the modifier/layout/draw pipeline as much as possible; they should not force the item body to recompose on every frame.

### Strategy 3: pick the right AnimationSpec

Different scenarios call for different curves:

| Scenario | Recommended Spec | Why |
|----------|------------------|-----|
| Reordering | `tween(250)` | Snappy, no drag |
| Deleting an item | `spring(dampingRatio = 0.5f)` | Bounce signals "removed" |
| Adding an item | `tween(300, easing = FastOutSlowInEasing)` | Gentle entrance, not abrupt |

On low frame rates: `tween` is time-based, so even if frames drop the animation still finishes within its duration — it just loses intermediate frames and looks rougher. `spring` simulates a physical spring using real time; the same applies. For lists I lean toward `tween`, because users have low tolerance for list animation — finishing fast matters more than transitioning smoothly.

## The Big Picture of LazyColumn Animation Choreography

LazyColumn's animation choreography is three cooperating layers:

1. **LazyLayout layer**: decides "which items exist" — when to create and destroy them
2. **Placement layer**: decides "where each item goes" — computes layout coordinates
3. **Graphics layer**: decides "how to transition visually" — drives translation and alpha via `graphicsLayer`

`animateItem` mostly runs on layer 3. It has limited influence over layout — the item is already assigned its new position, and what you see is a visual transition for placement plus optional fade-in/fade-out. One practical consequence: adjacent items don't reserve old-layout space for the animating one. They move according to the new layout immediately.

When I built a long-press drag-to-reorder feature, I assumed `animateItem` would handle it. It doesn't. Drag-to-reorder requires an item to temporarily "float" under pointer control, while `animateItem` reacts to committed list changes. The correct approach is to use `detectDragGestures` to manually control the dragged item's offset during the drag, then update the data source on release and let `animateItem` take over the settle animation.

## Three Diagnostic Checkpoints

When debugging Compose list animation issues, check in this order — it covers most cases.

**Check 1: is the `key` stable?** Log each item's key inside `LazyListScope` and confirm it doesn't change before and after a move. This is the root cause of 90% of "animation doesn't work" reports.

**Check 2: is `beyondBoundsItemCount` large enough?** When items are tall (more than a third of the screen) and the animation exceeds 300ms, set this to at least 3–5. The cost is slightly more memory; on modern devices it's imperceptible.

**Check 3: does the `animationSpec`'s `durationMillis` fit the scenario?** Don't use the default `spring()` for list reordering — when many items move at once, the bounce compounds into a visual mess. A 250–350ms `tween` is the safe zone.
