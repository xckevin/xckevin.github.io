---
title: "Android Animation Deep Dive: From Principles to Practice (3): Architecture"
lang: en
translationKey: android-animation-principles-practice-part3
slug: android-animation-principles-practice-part3
excerpt: "Part 3 of the Android animation series, mapping the developer API layer, animation framework, property updates, and rendering system."
publishDate: '2024-03-20'
displayInBlog: false
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 3
  total: 9
seo:
  title: "Android Animation Deep Dive (3): Animation System Architecture"
  description: "Map Android animation from developer APIs through Animator, Interpolator, TypeEvaluator, property updates, View invalidation, and rendering."
  pageType: article
---
> This is part 3 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we covered "Core Animation Concepts."

### 1. System Architecture Overview

The Android animation system is not a single monolithic block. It has evolved over time and consists of several layers and components. At a high level, its workflow can be described as follows:

1. **Developer API layer:** this is the layer developers interact with directly. We create, configure, and start animations by calling APIs. This includes the older `android.view.animation` package for View Animation, the modern `android.animation` package for Property Animation, and higher-level tools such as MotionLayout.
2. **Animation framework layer:** this layer is the core engine of the animation system. It contains key classes such as `Animator` and its subclasses `ValueAnimator` and `ObjectAnimator`, plus `Interpolator`, `TypeEvaluator`, `Keyframe`, and `AnimatorSet`. It handles timing, interpolation, value evaluation, animation composition, and animation management.
3. **Property update and view notification layer:** after the animation framework calculates a new property value, it must apply that value to the target object. For Property Animation, this usually means updating a property through reflection or by calling a setter directly. If the target is a View and the property change affects appearance or layout, the View system is notified through `invalidate()` or `requestLayout()`.
4. **Rendering system layer:** after a redraw or layout request is received, Android's rendering system turns the updated view state into pixels. As described in the first article, this involves Choreographer, UI thread measure/layout/draw, RenderThread display list processing, and GPU submission.

Here is a simplified ASCII diagram of the logical flow:

```plain
+------------------------+      +-------------------------+      +----------------------+
|   Developer API        |----->|  Animation Framework    |----->| Property Update and  |
| (View Animation API,   |      | (Animator, Interpolator,|      | View Notification    |
|  Property Animation,   |      |  Evaluator, Keyframe,   |      | (Setter/Getter via   |
|  ViewPropertyAnimator, |      |  AnimatorSet, etc.)     |      |  Reflection/Property,|
|  StateListAnimator,    |      +-------------------------+      |  View.invalidate(),  |
|  MotionLayout, etc.)   |                 |                      |  View.requestLayout())|
+------------------------+                 |                      +----------------------+
         |                                  | Calculates new value          | Updates target and notifies
         | Creates/configures animation     V                              V
         |                         +-------------------------+     +----------------------+
         |                         | Target Object Property  |<----| Rendering System     |
         +------------------------>| (for example, View      |     | (Choreographer,      |
                                   | properties or custom    |     |  UI Thread Measure/  |
                                   | object fields)          |     |  Layout/Draw,        |
                                   +-------------------------+     |  RenderThread, GPU)  |
                                                                  +----------------------+
                                                                          | Renders to screen
```

Notes:

- **Arrow direction:** mainly represents control flow and data flow.
- **Developer API layer:** this is where we write code, choose the animation mechanism, and configure parameters such as duration, interpolator, target object, and property.
- **Animation framework layer:** this is the runtime brain of the animation system. It calculates the property value that each frame should show based on time.
- **Property update and view notification layer:** this bridge connects calculated animation values to real object state. It applies the calculated value to the target object, usually by calling a setter, and tells the View system when refresh work is needed.
- **Target object property system:** this represents the animated object and the properties that can be modified.
- **Rendering system layer:** this ultimately draws the object's new state.

This model helps explain why animation implementation involves multiple cooperating system components, from high-level APIs down to low-level rendering.

---

> In the next article, we will cover "Core Component Analysis."

**"Android Animation Deep Dive: From Principles to Practice" series**

1. Animation is more than decoration
2. Core Animation Concepts
3. **System Architecture Overview** (this article)
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. D. Physics-Based Animation
8. E. MotionLayout
9. How to Choose
