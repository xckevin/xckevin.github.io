---
title: "Jetpack Compose Modifier Internals: From Modifier.Node to Layout and Drawing"
lang: en
translationKey: jetpack-compose-modifier-node
slug: jetpack-compose-modifier-node
excerpt: "A deep dive into the Compose Modifier chain, the shift from composed to Modifier.Node, how declarative modifier pipelines are built, and where performance gains come from."
publishDate: '2026-05-15'
tags:
- "Jetpack Compose"
- "Android"
- "Kotlin"
- "Modifier.Node"
- "Performance"
seo:
  title: "Jetpack Compose Modifier Internals: Modifier.Node, Layout, Drawing, and Input"
  description: "Understand Compose Modifier chains, Modifier.Node, layout measurement, drawing, pointer input, lifecycle hooks, and performance migration."
---

Last week I debugged a Compose layout bug where `clickable` refused to respond. After a long investigation, the cause was simply Modifier order: `padding` was placed before `clickable`, so the clickable area was pushed outside the range I expected.

The bug itself was not complicated, but it made me revisit a detail that is easy to overlook: how does a Modifier chain actually work? And what real problem did the newer `Modifier.Node` architecture solve compared with the older approach?

## The essence of a Modifier chain: wrappers from left to right

When writing Compose, Modifier code looks straightforward:

```kotlin
Box(
    modifier = Modifier
        .size(100.dp)
        .background(Color.Red)
        .padding(16.dp)
        .clickable { /* do something */ }
)
```

At runtime, `size` wraps `background`, `background` wraps `padding`, and so on. After the `Box` is wrapped layer by layer, events travel from outside to inside, while drawing happens from inside to outside.

Modifier order sensitivity is not syntax sugar. It is a real nested structure. With `Modifier.clickable().padding()`, the padding area is clickable. With `Modifier.padding().clickable()`, the padding area does not respond to clicks.

In the old implementation, each `.xxx()` call returned a `CombinedModifier`, which internally maintained a linked list:

```kotlin
class CombinedModifier(
    private val outer: Modifier,
    private val inner: Modifier
) : Modifier {
    override fun <R> foldIn(initial: R, operation: (R, Element) -> R): R {
        return inner.foldIn(outer.foldIn(initial, operation), operation)
    }
}
```

This approach worked for years, but it has two obvious weaknesses in large list scenarios.

## The pain of the old model: hidden composed costs

In early Compose code, many custom Modifiers were written like this:

```kotlin
fun Modifier.customBackground(): Modifier = composed {
    val color = LocalContentColor.current
    this.then(
        Modifier.drawBehind { drawRect(color) }
    )
}
```

The code feels natural, but `composed` has a side effect: its lambda runs again on every recomposition and creates a new Modifier instance. Modifier equality uses `equals`, and a new instance means the layout phase may consider the Modifier "changed" even when its content has not changed.

In a `LazyColumn`, items recompose frequently while scrolling, and `composed` can cause many invalid recompositions and measurements. In one project, rewriting a `composed` Modifier as `Modifier.Node` improved list scrolling from about 47fps to a stable 58fps.

`composed` also misses the skip optimization available to the Modifier chain. The Compose runtime can diff and skip parts of the chain, but nodes created by `composed` are represented as `Modifier.Element`; the runtime cannot understand their semantics, so that whole optimization path is bypassed.

## Modifier.Node: giving Modifier identity back to the framework

Compose 1.3 introduced `Modifier.Node`, and it has been the officially recommended implementation style since 2024. The core idea is to make each Modifier an independent stateful node that the framework can recognize and manage.

Compare the two styles. Old style:

```kotlin
fun Modifier.oldStyle() = this.then(
    object : DrawModifier {
        override fun ContentDrawScope.draw() {
            drawRect(Color.Red)
            drawContent()
        }
    }
)
```

New style:

```kotlin
fun Modifier.newStyle() = this then RedRectNode()

private class RedRectNode : DrawModifierNode, Modifier.Node() {
    override fun ContentDrawScope.draw() {
        drawRect(Color.Red)
        drawContent()
    }
}
```

They look similar at first glance, but the underlying mechanism is completely different. `Modifier.Node` is a lightweight tree node whose reference is owned directly by the framework. That brings three benefits:

- **Precise invalidation tracking**: only the Node that actually changes is invalidated, without involving the whole chain
- **Memory optimization**: Nodes can be reused and pooled, reducing GC pressure
- **Type recognition**: the framework knows the exact node type, such as `DrawModifierNode` or `SemanticsModifierNode`, and can schedule it precisely in the relevant phase

## Building the chain: from declaration to node tree

During the first composition of a Composable, the Modifier chain is built in three steps.

### 1. Declaration phase: build the Modifier linked list

The chain calls in code compile down to a linked list of `then()` calls. Factory functions such as `size()` and `background()` return either `Modifier.Element` or `Modifier.Node`.

### 2. Layout phase: convert the linked list into a node tree

When a `LayoutNode` is created, Compose traverses the Modifier chain, identifies all `Modifier.Node` subclass instances, and builds parent-child relationships. Non-Node `Modifier.Element` instances from the old API are wrapped in a generic Node.

This conversion happens inside `LayoutNode.setModifier()`. The simplified flow looks like this:

```kotlin
// Simplified framework-internal logic
fun setModifier(modifier: Modifier) {
    val oldNodes = nodes.toList()
    // 1. Flatten the Modifier chain and extract all nodes
    val newNodes = flattenModifierChain(modifier)
    // 2. Diff and reuse unchanged nodes
    val diffResult = diffNodeLists(oldNodes, newNodes)
    // 3. Trigger attach/detach lifecycle callbacks for added or removed nodes
    applyDiff(diffResult)
}
```

The diff step is the key optimization. `Modifier.Node` has a stable type identity, so the framework compares nodes one by one and updates only the changed parts. This is exactly what `composed` cannot do.

### 3. Measure and draw phases: traverse nodes by phase

After the node tree is built, each phase traverses only the relevant node types:

```
Measure phase: process LayoutModifierNode and adjust constraints
Layout phase: process LayoutModifierNode and set position and size
Draw phase: process DrawModifierNode and draw in order
Semantics phase: process SemanticsModifierNode and build the accessibility tree
Input phase: process PointerInputModifierNode and dispatch touch events
```

Each phase visits only Nodes that implement the corresponding interface. Irrelevant nodes are skipped directly. With type-based filtering, the framework does not need to perform broad type checks in every phase.

## A custom Modifier.Node in practice

I once wrote a circular clip Modifier for avatar components:

```kotlin
class CircleClipNode : Modifier.Node(), DrawModifierNode {
    override fun ContentDrawScope.draw() {
        val radius = minOf(size.width, size.height) / 2f
        clipPath(Path().apply {
            addOval(Rect(Offset.Zero, size))
        }) {
            this@draw.drawContent()
        }
    }
}

fun Modifier.circleClip() = this then CircleClipNode()
```

If the Modifier needs state, such as switching a corner radius based on a value:

```kotlin
class RadiusClipNode(
    var radius: Float = 0f
) : Modifier.Node(), DrawModifierNode {
    override fun ContentDrawScope.draw() {
        // ...clip with radius
    }
}

@Composable
fun Modifier.radiusClip(radius: Float) = this then RadiusClipNode().apply {
    // Assign directly without triggering recomposition
    this.radius = radius
}
```

Here `apply { this.radius = radius }` does not read state inside a Composable scope. It assigns directly to a Node property. During the layout phase, the framework detects whether `radius` changed and runs the redraw logic itself.

That is the advantage of the Node model: state changes do not have to go through recomposition. The framework handles them directly. Removing that recomposition hop matters in high-frequency scenarios such as animation and gestures.

## Easy-to-miss detail: attach and detach lifecycle

`Modifier.Node` includes lifecycle callbacks:

```kotlin
class MyNode : Modifier.Node() {
    override fun onAttach() {
        // Called when the node is attached to the layout tree; initialize resources here
    }

    override fun onDetach() {
        // Called when the node is removed from the layout tree; clean up resources
    }

    override fun onReset() {
        // Called when the node is recycled for reuse; reset state
    }
}
```

This is useful for Modifiers that manage resources. I previously wrote a `blurNode` that created a `RenderEffect` in `onAttach` and released it in `onDetach`. Implementing the same behavior with `composed` required `DisposableEffect`, which coupled the code more tightly to composition.

Another benefit appears in `LazyColumn`: when an item scrolls offscreen and later returns, `onAttach` and `onDetach` precisely control resource creation and release. That is cleaner than relying on recomposition timing through `composed`.

## When should composed still be used?

At this point you may wonder whether every `composed` Modifier should be replaced with `Modifier.Node`. There is one case where `composed` is still hard to replace: **reading Composable local values inside a Modifier chain**.

```kotlin
fun Modifier.themedStyle(): Modifier = composed {
    val shape = LocalShapes.current
    val color = LocalContentColor.current
    Modifier.background(color, shape)
}
```

This is awkward for `Modifier.Node`, because a Node is not in a Composable scope. But if the `CompositionLocal` read can be moved into the Composable itself, Node is still preferred:

```kotlin
@Composable
fun ThemedBox() {
    val shape = LocalShapes.current
    val color = LocalContentColor.current
    Box(modifier = Modifier.backgroundNode(color, shape))
}
```

This separates state reads from Modifier implementation. The Node remains responsible only for layout and drawing logic.

## Migration strategy

If an existing project uses a lot of `composed`, migrating everything at once is not realistic. I replace it gradually by performance hotspot:

1. **Item Modifiers in LazyColumn/LazyRow** - highest priority, because scroll performance improvements are immediately visible
2. **Animation-related high-frequency Modifiers** - Node avoids recomposition on every animation frame
3. **Modifiers containing external resources** - attach/detach lifecycle gives precise resource management
4. **Other Modifiers** - leave them alone unless they naturally come up during iteration

The migration cost is not high. Most `composed` lambdas can be split into a Node class and a Composable function. The interface mapping is also clear: `DrawModifier` -> `DrawModifierNode`, `LayoutModifier` -> `LayoutModifierNode`, and `PointerInputModifier` -> `PointerInputModifierNode`.

---

Modifier is one of the easiest Compose topics to think you understand. The chain-call syntax feels so natural that it hides the fact that every `.` represents a real wrapper. Understanding how this chain is built and executed helps you locate Modifier-order bugs quickly and avoid wrong turns when designing custom Modifiers. The Node architecture gives control back to the framework: developers declare what they want, while Compose handles reuse, invalidation, and scheduling.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping](/en/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/en/blog/jetpack-compose-gestures/)
- [Jetpack Compose animations: AnimationSpec, springs, and Transition](/en/blog/jetpack-compose-animation/)
<!-- /seo-internal-links -->
