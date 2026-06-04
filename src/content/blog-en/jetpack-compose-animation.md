---
title: "Jetpack Compose Animation Internals: AnimationSpec, Springs, and Transition"
lang: en
translationKey: jetpack-compose-animation
slug: jetpack-compose-animation
excerpt: "A deep dive into Compose animation internals, including spring physics, the Choreographer-to-Snapshot frame pipeline, and how Transition synchronizes multiple animated properties."
publishDate: '2026-05-09'
tags:
- "Jetpack Compose"
- "Android"
- "Animation"
- "Kotlin"
seo:
  title: "Jetpack Compose Animation Internals: AnimationSpec, Spring, and Transition"
  description: "Learn how Compose animations work through AnimationSpec, spring physics, Choreographer frame callbacks, Snapshot state, Transition, and performance choices."
---

The first time I used `animateDpAsState`, three lines of code gave a button a springy scale animation. Later, when I tried to drive position, alpha, and color at the same time in one component, the animation became janky and out of sync. Reading the source made the reason clear: Compose's animation system is not just a property interpolator. At its core, it is a physics engine.

## AnimationSpec: physical simulation of a damped oscillator

The default `animationSpec` for `animate*AsState` is `spring()`. This is not an easing function. It is a physical simulation of a damped harmonic oscillator.

There are two core parameters: `dampingRatio` and `stiffness`. The default source values are `dampingRatio = 1.0` (critical damping) and `stiffness ≈ 1500 N/m`. Each frame's position is calculated by `SpringSimulation`:

```kotlin
// Simplified animation-core SpringSimulation.kt
override fun getValueFromNanos(playTimeNanos: Long): AnimationResult {
    // Semi-implicit Euler integration
    val k = stiffness * -(lastDisplacement - finalPosition)  // F = -kx
    val c = dampingRatio * 2 * sqrt(stiffness)               // Damping coefficient
    val force = k - c * lastVelocity                         // Net force
    lastVelocity += force / mass * timeStep
    lastDisplacement += lastVelocity * timeStep
    return AnimationResult(lastDisplacement, lastVelocity)
}
```

Each frame is not "move from A to B by some percentage." Instead, Compose recalculates force, acceleration, velocity, and then performs one time integration step. Every animation frame depends on the velocity from the previous frame. The animation has memory; it is not a stateless tween.

Behavior across the three `dampingRatio` ranges:

- **< 1 (underdamped)**: oscillates around the target before settling; useful for emphasis
- **= 1 (critical damping)**: reaches the target as fast as possible without oscillation; recommended by Material Design
- **> 1 (overdamped)**: approaches the target slowly; rarely useful because it feels sluggish

## From Choreographer to Snapshot: the frame-driven state pipeline

`Animatable`, which underlies `animate*AsState`, holds two key objects: `AnimationState`, which records the current value and velocity, and `TargetBasedAnimation`, which uses `AnimationSpec` to calculate each frame's position.

The core frame callback chain looks like this:

```kotlin
suspend fun Animatable.animateTo(targetValue: T, animSpec: AnimationSpec<T>) {
    val animation = TargetBasedAnimation(animSpec, typeConverter, value, targetValue)
    val startTime = withFrameNanos { it }   // Suspend and wait for the next VSync
    while (!animation.isFinished) {
        val playTime = withFrameNanos { it } - startTime
        val result = animation.getValueFromNanos(playTime)  // Physics-engine calculation
        value = result.value       // Write to MutableState and trigger recomposition
    }
}
```

Under the hood, `withFrameNanos` uses `MonotonicFrameClock`, which connects to `Choreographer.postFrameCallback` on Android. When a VSync signal arrives, the suspended point resumes, receives `frameTimeNanos`, and passes it to `AnimationSpec` for physical calculation. The result is written directly into `MutableState`. The Snapshot system tracks dependencies automatically, invalidates Composables that read this state, and those Composables see the new value in the next recomposition.

The pipeline is: **VSync -> Choreographer -> withFrameNanos -> physical integration -> MutableState write -> Snapshot notifies recomposition -> Composable redraw**.

The animation system and UI system are fully decoupled through Snapshot State. The animation does not need to know who consumes its value. That is the practical value of declarative architecture.

## Transition: synchronized multi-property animation with one frame callback

For a single animated property, `animate*AsState` is enough. For coordinated multi-property animation, `updateTransition` is the right tool.

One pitfall I ran into was driving a button's position, scale, alpha, and color with four independent `animateFloatAsState` calls. Each property updated through its own Choreographer callback. Tiny timing differences accumulated across frames, and the animation no longer looked synchronized.

`Transition` solves this by creating one controlling target state. All child animations share the same frame callback:

```kotlin
val transition = updateTransition(targetState = currentPage, label = "page")
val offsetX by transition.animateDp(
    transitionSpec = { tween(300) }, label = "offsetX"
) { page -> pageToOffset(page) }
val alpha by transition.animateFloat(
    transitionSpec = { tween(300) }, label = "alpha"
) { page -> pageToAlpha(page) }
```

Internally, `Transition` maintains an `_animations` list. When `targetState` changes, it iterates through all child animations, creates a `TargetBasedAnimation` for each property, and updates them in batch inside the same `withFrameNanos` loop:

```kotlin
// Simplified internal frame loop in Transition
while (animations.any { !it.isFinished }) {
    val frameTime = withFrameNanos { it }
    for (anim in animations) {
        val result = anim.animation.getValueFromNanos(frameTime - anim.startTime)
        anim.value = result.value  // All properties are written in the same frame
    }
}
```

This is the essential difference between `Transition` and multiple independent `animate*AsState` calls: **it is synchronization, not just concurrency**.

## Performance boundaries and API choices

One detail from reading `animation-core`: `SpringSimulation` uses a fixed time step and does not adjust because frames are dropped. If the previous frame took too long, the next frame feeds a larger `playTime` into the physical model, so the calculated displacement may jump. This is not a bug. It is the physics engine responding correctly to a dropped frame, but visually it can look like a teleport.

My practical selection rules:

- Decorative animations such as button hover and scroll bounce: use `animate*AsState` with `spring()`. It is concise and feels physically natural.
- Coordinated multi-property animations such as page transitions and onboarding flows: use `Transition`. Do not stack several independent `animate*AsState` calls just to save a few lines.
- `Animatable` is a lower-level API that requires manual coroutine lifecycle management. It is worth using directly only when the target value needs to change in response to external events during the animation. Most use cases do not need it.

Compose animations feel easy to use because the physics engine, frame synchronization, and state management layers are packaged well. Understanding the mechanism has a concrete payoff: once you know that `spring(dampingRatio = 0.3f)` will produce multiple oscillations, you no longer need to tune parameters blindly.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping](/en/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
- [Jetpack Compose Modifier internals: Modifier.Node, layout, drawing, and event handling](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/en/blog/jetpack-compose-gestures/)
<!-- /seo-internal-links -->
