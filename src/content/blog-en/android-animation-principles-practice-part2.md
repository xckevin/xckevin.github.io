---
title: "Android Animation Deep Dive: From Principles to Practice (2): Core Concepts"
lang: en
translationKey: android-animation-principles-practice-part2
slug: android-animation-principles-practice-part2
excerpt: "Part 2 of the Android animation series, explaining time, interpolators, keyframes, TypeEvaluator, and property animation frame calculation."
publishDate: '2024-03-20'
displayInBlog: false
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 2
  total: 9
seo:
  title: "Android Animation Deep Dive (2): Interpolators, Keyframes, Evaluators"
  description: "Understand Android animation core concepts: elapsed fraction, interpolators, keyframes, TypeEvaluator, and how property animation values are calculated."
  pageType: article
---
> This is part 2 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we covered "Animation is more than decoration."

### 2. Core Animation Concepts

Before looking at specific animation types, we need a few concepts that run through the entire Android animation system, especially Property Animation.

#### Time and Interpolator

Animation is change over time. The framework needs to know where the animation is on its timeline and how to compute the property value for that moment.

- **Time:** an animation usually has a configured total duration. During playback, the system tracks elapsed time since the animation started. The ratio of elapsed time to total duration is the elapsed fraction, usually from `0.0` to `1.0`. It increases linearly from the beginning to the end.
- **Interpolator:** if property values changed directly according to the elapsed fraction, every animation would move at a constant speed and often feel mechanical. Real-world motion usually involves acceleration, deceleration, bounce, and other timing behavior. An interpolator transforms the linear elapsed fraction into an interpolated fraction. That output is usually in the `0.0` to `1.0` range, although interpolators such as `AnticipateOvershootInterpolator` may go beyond it. In practice, the interpolator defines the animation's velocity curve.

Android provides several built-in interpolators in the `android.view.animation` package. Property Animation uses them as well for historical reasons:

- `LinearInterpolator`: output equals input, producing constant-speed motion. It is plain but useful for precise synchronization or loops.
- `AccelerateInterpolator`: starts slowly and accelerates, similar to an object speeding up under force. Its curve is roughly `f(x) = x^factor`, with `factor` usually greater than or equal to `2`.
- `DecelerateInterpolator`: starts quickly and decelerates, similar to an object slowing under resistance. Its curve is roughly `f(x) = 1 - (1 - x)^factor`.
- `AccelerateDecelerateInterpolator`: starts and ends slowly, moving faster in the middle. It is one of the most common interpolators and approximates natural acceleration and deceleration with a sine/cosine curve.
- `AnticipateInterpolator`: moves slightly backward before moving toward the target, similar to a wind-up motion.
- `OvershootInterpolator`: passes the target slightly, then settles back, simulating inertia.
- `AnticipateOvershootInterpolator`: combines anticipation and overshoot, first winding up backward, then passing the target and returning.
- `BounceInterpolator`: simulates an object hitting a surface and bouncing near the end.
- `CycleInterpolator`: repeats a sine-wave pattern for a configured number of cycles.

**Custom interpolators**

- You can implement `Interpolator` or the more convenient `TimeInterpolator` interface for custom easing logic.
- `PathInterpolator` on API 21+ is especially powerful. It can define an interpolation curve using SVG path syntax or cubic Bezier control points, which makes it a good fit for precise custom timing. Many Material Design easing curves can be expressed this way.

Interpolator choice has a large effect on animation feel. The right curve makes movement feel vivid, natural, and physically plausible. The wrong curve makes it stiff, strange, or slow.

#### Keyframe

Simple animations may only need a start value and an end value. More complex motion may need a property to grow, shrink, then return to its initial value. An interpolator alone is not always precise enough for that. This is where keyframes come in.

**A keyframe defines the specific state, or property value, that an animation should reach at a specific point in time.** The Property Animation framework lets you define a series of keyframes for the same property. During playback, the framework interpolates between neighboring keyframes.

In Android Property Animation, the `Keyframe` class in `android.animation` represents a single keyframe. A `Keyframe` contains two main pieces of information:

1. **Fraction:** where this keyframe sits within the total animation duration, from `0.0` to `1.0`.
2. **Value:** the property value at that point in time.

You can create multiple `Keyframe` objects, combine them into a `PropertyValuesHolder`, and apply that holder to `ValueAnimator` or `ObjectAnimator`.

For example, an alpha animation that moves through `0 -> 1 -> 0.5 -> 1` can be represented as:

- Keyframe 0: fraction `0.0`, value `0.0f`
- Keyframe 1: fraction `0.5`, value `1.0f`
- Keyframe 2: fraction `0.8`, value `0.5f`
- Keyframe 3: fraction `1.0`, value `1.0f`

The system calculates intermediate values from these keyframes and optional interpolators. You can even set different interpolators for different keyframe intervals.

**Why keyframes matter**

- **Complex paths:** animation is no longer limited to a simple start-to-end model. It can express multi-stage, non-linear changes.
- **Precise control:** you can set an exact property value at any point in the timeline.
- **Unified model:** even the simplest property animation with only `startValue` and `endValue` can be treated as a special case with two keyframes, at fraction `0.0` and fraction `1.0`.

#### TypeEvaluator

An interpolator tells the animation how far along it should be. But how does the framework compute the concrete intermediate value between two values, such as two colors or two coordinates? That is the job of `TypeEvaluator`.

**`TypeEvaluator` uses the current interpolated fraction, start value, and end value to calculate the concrete property value for the current frame.** Its core method is:

```java
public T evaluate(float fraction, T startValue, T endValue)
```

- `fraction`: the interpolated fraction calculated by the interpolator. It is usually from `0.0` to `1.0`, but it can exceed that range.
- `startValue`: the start value for the current animation interval.
- `endValue`: the end value for the current animation interval.
- return value `T`: the calculated current property value.

Android provides built-in evaluators for common property types:

- `IntEvaluator`: calculates values between two `int` values, usually with `startValue + fraction * (endValue - startValue)`.
- `FloatEvaluator`: calculates values between two `float` values with the same formula.
- `ArgbEvaluator`: calculates transitions between two ARGB colors by interpolating the A, R, G, and B channels separately, then combining them into a new color. This is the key to color transition animation.
- `PointFEvaluator`: calculates the intermediate coordinate between two `PointF` values by interpolating `x` and `y` separately.

Evaluators are necessary because the animation framework does not know how to interpolate arbitrary types by itself. It does not inherently know how to compute a middle color between two colors or a transition state between two custom objects. `TypeEvaluator` gives developers a way to teach the framework how to interpolate a specific type.

When you need to animate a non-standard type, such as a custom `MyObject`, or use special interpolation logic, implement your own `TypeEvaluator`. For example, if an object should move from point A to point B along a curve instead of a straight line, you can create a custom path evaluator that receives the start point, end point, and path, then calculates the object's position on that path in `evaluate()`.

In a typical Property Animation frame:

1. The system gets the current **elapsed fraction**.
2. The **Interpolator** receives the elapsed fraction and returns the **interpolated fraction**, which determines the animation's speed curve.
3. The **TypeEvaluator** receives the interpolated fraction plus the start and end values, or neighboring keyframe values, and calculates the current concrete property value.
4. The animation framework applies that calculated value to the target object's property.

Understanding these three concepts, time and interpolator for rate control, keyframes for timeline nodes, and evaluator for value calculation, is essential for mastering Android Property Animation. Together, they form the flexible foundation of the property animation system.

---

## Part 2: Android animation system architecture and core components

After understanding the fundamentals of Android animation and its relationship with the rendering pipeline, we need to look deeper into the system architecture: which core components make up the Android animation framework and how they work together. Understanding those roles and interactions is the basis for using the animation framework effectively, building complex effects, diagnosing issues, and optimizing performance.

---

> In the next article, we will cover "System Architecture Overview."

**"Android Animation Deep Dive: From Principles to Practice" series**

1. Animation is more than decoration
2. **Core Animation Concepts** (this article)
3. System Architecture Overview
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. D. Physics-Based Animation
8. E. MotionLayout
9. How to Choose
