---
title: "Android Animation Deep Dive: From Principles to Practice (4): Core Components"
lang: en
translationKey: android-animation-principles-practice-part4
slug: android-animation-principles-practice-part4
excerpt: "Part 4 of the Android animation series, explaining View, View Animation, Animator, ValueAnimator, ObjectAnimator, AnimatorSet, and MotionLayout."
publishDate: '2024-03-20'
displayInBlog: false
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 4
  total: 9
seo:
  title: "Android Animation Deep Dive (4): View, Animator, and MotionLayout"
  description: "Analyze Android animation components including View, View Animation, Property Animation, Interpolator, TypeEvaluator, AnimatorSet, and MotionLayout."
  pageType: article
---
> This is part 4 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we covered "System Architecture Overview."

### 2. Core Component Analysis

Now let's examine the key components in the Android animation system one by one.

#### View

- **Role:** `View` and its subclasses, such as `TextView`, `ImageView`, `Button`, and custom Views, are the basic units of Android UI and the most common animation targets. Animations usually operate on View properties such as position (`translationX`, `translationY`), size (`scaleX`, `scaleY`), alpha (`alpha`), and rotation (`rotation`, `rotationX`, `rotationY`).
- **Interaction:** after the animation framework updates a View property, the View responds to the change. If the change affects drawing, such as color or alpha, the View calls `invalidate()` to request redraw. If the change affects size or layout position, `requestLayout()` may be needed to trigger measurement and layout again. The View performs actual drawing through the Canvas API, or generates drawing command lists under hardware acceleration.

#### Animation: View Animation (`android.view.animation`)

- **Historical background:** this is the early Android animation system, often called tween animation. It provides a relatively simple API for translation, scale, rotation, and alpha changes on Views.
- **How it works:** View Animation operates on the View's drawing cache or transformation matrix. It does not directly modify the real properties of the View object. For example, `TranslateAnimation` can make a View look like it moved, but if you call `getLeft()` or `getTop()`, the values have not changed. After the animation ends, the View jumps back to its original position unless additional handling is used. Even `fillAfter="true"` only preserves the last rendered frame; the underlying properties remain unchanged.
- **Core classes:**
  - `Animation`: base class for all View animations.
  - `TranslateAnimation`: controls position changes.
  - `ScaleAnimation`: controls scale changes.
  - `RotateAnimation`: controls rotation changes.
  - `AlphaAnimation`: controls alpha changes.
  - `AnimationSet`: combines multiple `Animation` objects so they can play together or in sequence.
- **Limitations:**
  - It only works on View objects.
  - It only supports the four basic transforms listed above.
  - Real properties do not change, so the interactive area remains in the original position. Even if the user sees the View moved to a new place, click events may still be handled at the original location.
  - It is hard to extend for complex animation logic and custom effects.
- **Current status:** because of these limitations, View Animation is not recommended for new projects, except for compatibility with very old code or extremely simple temporary visual effects. Modern Android development should prefer Property Animation.

#### Animator: Property Animation (`android.animation`)

- **Modern foundation:** Property Animation was introduced in Android 3.0 (API 11) to overcome the limitations of View Animation and provide more powerful, flexible animation. Its core idea is to directly modify the real property values of the target object.
- **`Animator`:** the abstract base class for all Property Animation classes. It defines common animation behavior such as `start()`, `cancel()`, `end()`, duration through `setDuration()`, interpolator through `setInterpolator()`, listeners through `addListener()`, and pause listeners through `addPauseListener()`.
- **`ValueAnimator`:**
  - **Core engine:** `ValueAnimator` is the core timing and value-calculation engine of the Property Animation system. It does not directly operate on any object or property.
  - **Responsibility:** it only calculates a sequence of smoothly changing values during playback, based on duration, interpolator, and evaluator. Those values can be `int`, `float`, `Object`, and other supported types.
  - **Usage:** add an `AnimatorUpdateListener` through `addUpdateListener()`. In `onAnimationUpdate(ValueAnimator animation)`, read the current value with `animation.getAnimatedValue()` and manually apply it to the target object's property.
  - **Flexibility:** because it is not bound to a specific object or property, `ValueAnimator` can drive nearly any numeric change, including non-UI logic.
- **`ObjectAnimator`:**
  - **Convenience wrapper:** `ObjectAnimator` is a subclass of `ValueAnimator`. It inherits timing and value calculation, then adds automatic target property updates.
  - **How it works:** when creating an `ObjectAnimator`, you specify the target object, property name as a string, and start/end values or keyframes. During playback, `ObjectAnimator` calculates the property value and uses Java reflection to find and call the corresponding setter on the target. For example, property name `"alpha"` maps to `setAlpha(float value)`. For better performance and to avoid reflection-related issues, you can provide a `Property` object instead of a property name string.
  - **`PropertyValuesHolder`:** use this when one `ObjectAnimator` needs to animate multiple properties of the same object at the same time. Each `PropertyValuesHolder` contains animation information for one property, such as property name, start/end values or keyframes, and evaluator. You can create multiple holders and pass them to `ObjectAnimator.ofPropertyValuesHolder(target, holders...)`.
  - **Common choice:** for standard View properties, `ObjectAnimator` is usually more convenient than `ValueAnimator`.

#### Interpolator

- **Role recap:** as discussed earlier, an `Interpolator` defines the animation's rate-of-change curve. It receives a linear time fraction from `0.0` to `1.0` and returns an interpolated fraction, which determines the animation's progress at any moment. It is a core concept shared by time-based animations, including View Animation and Property Animation. It operates at the `Animator` or `Animation` level and influences later value calculation.

#### TypeEvaluator

- **Role recap:** `TypeEvaluator` calculates the concrete intermediate value between start and end values based on the interpolated fraction returned by the interpolator. It handles type-specific interpolation, such as colors, coordinate points, or custom objects. It is usually used with `ValueAnimator` or `ObjectAnimator` and defines how the value itself changes.

#### AnimatorSet

- **Animation coordinator:** when multiple animations need to play together, or when they need to play in a specific order with delays and dependencies, use `AnimatorSet`.
- **Capabilities:**
  - **Composition:** add multiple `Animator` objects, including `ValueAnimator`, `ObjectAnimator`, or another `AnimatorSet`, into one `AnimatorSet`.
  - **Playback relationships:** define relationships among animations with a rich API:
    - `playTogether(Animator... items)` or `playTogether(Collection<Animator> items)`: play all specified animations at the same time.
    - `playSequentially(Animator... items)` or `playSequentially(List<Animator> items)`: play specified animations in order.
    - `play(Animator anim)`: returns a `Builder` for more detailed relationship control.
    - `Builder.with(Animator anim)`: play the current animation with the specified animation.
    - `Builder.before(Animator anim)`: play the current animation before the specified animation.
    - `Builder.after(Animator anim)`: play the current animation after the specified animation.
    - `Builder.after(long delay)`: wait for a delay before playing the current animation.
  - **Unified control:** set a total duration for the whole `AnimatorSet`, although each child animator usually has its own duration; set an interpolator, which overrides child interpolators; set a start delay with `setStartDelay()`; and add listeners for start, end, cancel, and repeat events of the whole set.
- **Use case:** complex multi-step, multi-element coordinated animation.

#### ViewPropertyAnimator

- **Convenient API:** `ViewPropertyAnimator` is a very convenient shortcut API for View property animation. It provides a fluent programming style for quickly creating and starting animations on common View properties.
- **How to get it:** call `animate()` on any View object.
- **Usage:** chain methods to specify target property values:

```kotlin
myView.animate()
      .translationX(100f) // Target X-axis translation
      .alpha(0.5f)       // Target alpha
      .setDuration(500)  // Animation duration
      .setInterpolator(AccelerateDecelerateInterpolator()) // Interpolator
      .setStartDelay(100) // Start delay
      .withEndAction { /* Work to run when the animation ends */ }
      .start()           // Start animation
```

- **Internal mechanism:** `ViewPropertyAnimator` is still based on Property Animation internally. One important advantage is that when you chain multiple property animations, such as `translationX` and `alpha`, it usually optimizes them into one or a small number of underlying `Animator` instances. This can be more efficient than manually creating multiple `ObjectAnimator` instances and placing them in an `AnimatorSet`, especially for synchronization and render-layer behavior.
- **Recommended scenarios:** for simple, simultaneous animation of common View properties such as translation, scale, rotation, and alpha, `ViewPropertyAnimator` should be the first choice because it is concise, readable, and can have performance advantages.

#### StateListAnimator (API 21+)

- **State-driven animation:** this component automatically triggers predefined animations based on View state changes such as pressed, enabled, selected, and focused. It is useful for standard UI feedback, such as a button scaling or lifting on press.
- **Definition:** it is usually defined in an XML resource under `res/animator/` with a `<selector>` tag. The `<selector>` contains multiple `<item>` elements. Each `<item>` uses `android:state_*` attributes such as `android:state_pressed="true"` to specify the View state it matches, then nests one or more `<objectAnimator>` elements or other animator types to define the animation for that state.

```xml
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <objectAnimator android:propertyName="translationZ"
                        android:duration="100"
                        android:valueTo="8dp"
                        android:valueType="floatType"/>
    </item>
    <item android:state_enabled="true">
        <objectAnimator android:propertyName="translationZ"
                        android:duration="100"
                        android:valueTo="2dp"
                        android:valueType="floatType"
                        android:startDelay="50"/>
    </item>
</selector>
```

- **How to apply it:**
  - In layout XML, apply it to a View with `android:stateListAnimator="@animator/button_state_animator"`.
  - In code, call `view.setStateListAnimator(AnimatorInflater.loadStateListAnimator(context, R.animator.button_state_animator))`.
- **Value:** it decouples state changes from animation responses, keeps code cleaner, and makes standard interaction feedback animation easier to manage and reuse.

#### MotionLayout (`androidx.constraintlayout.widget`)

- **Advanced animation orchestration:** although MotionLayout itself is a layout container and subclass of `ConstraintLayout`, it has powerful built-in animation orchestration. It can be treated as a heavyweight Android animation component designed for complex screen transitions and interaction-driven animation.
- **Architectural role:** MotionLayout sits at the developer API layer. It provides a declarative way to define transitions between two or more layout states, represented by `ConstraintSet`s. Details such as duration, interpolator, path, and trigger are defined in a separate `MotionScene` XML file.
- **Core capabilities:** MotionLayout can smoothly animate View constraint changes within its parent layout, including position and size, and View properties such as alpha and rotation. It is especially strong for gesture-driven animation progress, such as swipe-controlled transitions.
- **Relationship to other components:** internally, MotionLayout uses Property Animation mechanisms to implement smooth View property transitions. But it offers a higher-level abstraction, letting developers focus on states and transitions instead of low-level `Animator` objects. Later articles in the series will cover MotionLayout in more detail.

Understanding the responsibilities, capability boundaries, and relationships among these components is the foundation for building complex, efficient, maintainable Android animation. The right component or combination depends on the specific requirement: a simple property change, state feedback, a complex sequence, or an interactive scene transition.

---

> In the next article, we will cover "A. View Animation (Tween Animation)."

**"Android Animation Deep Dive: From Principles to Practice" series**

1. Animation is more than decoration
2. Core Animation Concepts
3. System Architecture Overview
4. **Core Component Analysis** (this article)
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. D. Physics-Based Animation
8. E. MotionLayout
9. How to Choose
