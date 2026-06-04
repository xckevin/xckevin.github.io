---
title: "Why Does Compose Recompose So Often? From Stability to State Read Placement"
lang: en
translationKey: compose-recomposition
slug: compose-recomposition
excerpt: "A practical guide to frequent Jetpack Compose recomposition, including unstable parameters, where state is read, derivedStateOf misuse, and list item design."
publishDate: '2026-06-01'
tags:
- "Jetpack Compose"
- "Android"
- "Performance"
seo:
  title: "Why Compose Recomposes So Often: Stability and State Read Optimization"
  description: "Explains frequent Jetpack Compose recomposition, covering stability inference, unstable parameters, state read placement, derivedStateOf, and validation."
---

Frequent recomposition usually does not mean "Compose is slow." More often, state is being read too high in the tree, parameters are not stable, or objects are being recreated in ways that prevent the runtime from skipping work.

The key idea is simple: after state changes, Compose re-executes the Composables that read that state, but it tries to skip subtrees whose parameters are stable and unchanged. Problems usually come from two places: the affected area is too large, or Compose cannot confidently tell that the inputs are stable.

## State read location controls recomposition scope

The most common issue is reading frequently changing state in a parent and then passing derived values through multiple child components. List scroll state, text field input, countdown timers, and playback progress are typical examples. If they are read at the screen root, the whole screen becomes a recomposition candidate.

A better approach is to move the state read down to the place that actually needs it. If only one button needs `loading`, the whole screen should not read `loading`. If only the list header needs scroll offset, every item should not be aware of scroll state.

This is one of the most important ideas in Compose performance work: the goal is not to eliminate recomposition, but to shrink the area affected by it.

## Why stability matters

The Compose runtime needs to decide whether a Composable call can be skipped. If the parameter types are stable and the old and new parameter values are equal, it can skip the call. If a parameter is unstable, the runtime has to be more conservative.

Common sources of instability include:

- Plain mutable classes without clear immutable semantics.
- Mutable collections such as `MutableList` and `MutableMap`.
- New lambdas or objects created on every recomposition.
- Java models or third-party models whose stability is not known to Compose.

Do not overuse `@Stable` and `@Immutable`. They are not performance magic. They are contracts you make with Compose: either changes to the type are trackable, or the type is immutable. If the object can quietly change from the outside, adding the annotation only makes UI bugs harder to diagnose.

## Lists amplify recomposition problems

In a `LazyColumn`, if items do not have stable keys, Compose has a harder time reusing existing item state when data is inserted, removed, or reordered. The symptoms can include more recomposition, lost scroll state, images reloading, or text field state jumping between rows.

List items should also avoid creating complex temporary objects inside the `items` block. Mapping a new list, creating a formatter, or assembling a large object on every recomposition can make item parameters look like they are constantly changing.

Recommended practices:

- Provide stable keys to `items`.
- Prepare UI models in the ViewModel layer; let Composables focus on rendering.
- Cache expensive objects with `remember`, using accurate keys.
- Pass frequently changing state only to the items that actually need it.

## derivedStateOf is not a universal fix

`derivedStateOf` is useful when it compresses high-frequency input changes into low-frequency output changes. For example, a scroll index may change every frame, while "should the back-to-top button be visible" only changes when it crosses the false/true boundary. That is a good use case.

Wrapping simple string concatenation or a basic field read in `derivedStateOf` only adds complexity. It is even worse when `derivedStateOf` is created in the wrong place and rebuilt on every recomposition, which removes the caching benefit and makes the code harder to read.

The decision rule is straightforward: consider `derivedStateOf` only when the inputs change many times and the output changes only a few times.

## How to confirm recomposition is the problem

Do not rely only on how the UI feels. Android Studio's Compose Layout Inspector can show recomposition counts, and Perfetto or system traces can show whether the main thread is being dominated by Compose runtime work, measure/layout, or draw. For suspected hotspots, you can temporarily add logs or use Compose compiler metrics to inspect stability inference.

If a screen janks but recomposition counts are low, the issue may be layout measurement, image decoding, main-thread I/O, or RenderThread work. If recomposition counts are high but each recomposition is cheap, recomposition still may not be the bottleneck. Recomposition is a signal, not a conclusion.

## Engineering guardrails

Compose projects benefit from a few baseline rules: keep UI state as immutable as practical; require keys for lists; avoid reading high-frequency state at the screen root; move complex calculations into the ViewModel or `remember`; do not make shared components accept huge mutable objects; and keep recomposition observation tools available for performance-sensitive screens.

Frequent recomposition is rarely a single isolated bug. It is usually a state design and component boundary problem. Putting state in the right place is more effective than sprinkling `remember` across every Composable.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping recomposition](/blog/2026-05-07-jetpack_compose_重组性能全链路调优_从_stability_推断到_deriveds/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
<!-- /seo-internal-links -->
