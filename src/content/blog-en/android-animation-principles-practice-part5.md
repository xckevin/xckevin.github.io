---
title: "Android Animation Deep Dive: From Principles to Practice (5): View Animation and Property Animation"
lang: en
translationKey: android-animation-principles-practice-part5
slug: android-animation-principles-practice-part5
excerpt: "Part 5 of the Android animation series: a practical comparison of View Animation, tween animation, Property Animation, and modern animation APIs."
publishDate: '2024-03-20'
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 5
  total: 9
seo:
  title: "Android View Animation vs Property Animation: Choosing the Right Tool"
  description: "Compare Android View Animation and Property Animation, including hit rect pitfalls, property updates, ObjectAnimator, ValueAnimator, and AnimatorSet."
  pageType: article
---

> This is part 5 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we looked at core animation components.

## Part 3: Deep Dive into Mainstream Animation Types and Selection

After understanding the foundational principles and system architecture of Android animation, the next step is to examine the major animation approaches available on the platform. Each approach has its own mechanics, strengths, weaknesses, and appropriate use cases. For experienced developers, understanding these differences and making the right technical choice for a specific scenario is essential for efficient implementation and a polished user experience.

### A. View Animation (Tween Animation)

**Principle recap**: View Animation is Android's early animation system. It applies matrix transformations to a View's drawn content to create visual movement, scaling, rotation, and opacity changes. The key point is that it does not change the actual properties of the View object, such as `left`, `top`, `width`, `height`, or `alpha`. It only changes how the View appears and where it appears to be.

- **Pros:**
    - **Simple to use:** For the four basic transformations above, the API is straightforward and the XML definition is concise.
    - **Historically common:** Older projects may still use it heavily, so developers still need to understand and maintain it.
- **Cons, including severe ones:**
    - **Extremely limited scope:** It only supports translation, scaling, rotation, and alpha. It cannot animate any other property, such as background color, text size, or custom drawing attributes.
    - **Interaction problems because properties do not change:** This is the most serious issue. The animation moves the visual presentation of the View, but its **event hit rectangle stays at the original position**. A user may tap the moved View and fail to trigger the event, or tap the original location and unexpectedly trigger it.
    - **Layout properties do not change:** The View's actual bounds and layout slot remain unchanged, which can conflict with layout behavior.
    - **Poor extensibility:** It cannot be applied to non-View objects, and it is difficult to build complex animation logic or advanced custom interpolation, even though an `Interpolator` can be configured.
    - **Performance considerations:** Simple animations are usually fine, but the drawing-cache-based mechanism can be less efficient than property animation in complex views or frequently updated scenes.
- **Kotlin examples:**

1. **XML definition (`res/anim/translate_right.xml`):**

```xml
<?xml version="1.0" encoding="utf-8"?>
<translate xmlns:android="http://schemas.android.com/apk/res/android"
    android:duration="500"
    android:fromXDelta="0%"
    android:toXDelta="100%"
    android:interpolator="@android:anim/accelerate_decelerate_interpolator"
    android:fillAfter="false" />
```

2. **Load and start it in code:**

```kotlin
import android.view.animation.AnimationUtils

// ... inside Activity or Fragment
val myView: View = findViewById(R.id.my_view)
val translateAnim = AnimationUtils.loadAnimation(context, R.anim.translate_right)
myView.startAnimation(translateAnim)
```

3. **Create it entirely in code:**

```kotlin
import android.view.animation.TranslateAnimation
import android.view.animation.AccelerateDecelerateInterpolator

// ...
val translateAnim = TranslateAnimation(
    Animation.RELATIVE_TO_SELF, 0f, // fromXType, fromXValue
    Animation.RELATIVE_TO_SELF, 1.0f, // toXType, toXValue
    Animation.RELATIVE_TO_SELF, 0f, // fromYType, fromYValue
    Animation.RELATIVE_TO_SELF, 0f  // toYType, toYValue
).apply {
    duration = 500
    interpolator = AccelerateDecelerateInterpolator()
    fillAfter = false // Whether to keep the final drawn frame after the animation ends
}
myView.startAnimation(translateAnim)
```

- **Conclusion:** View Animation is strongly discouraged for new development. Its inherent flaws, especially the mismatch between visual state and actual properties, make it a poor fit for modern, complex UI interactions. Property animation should be the default replacement.

### B. Property Animation

**Principle recap**: Property Animation is the modern animation framework introduced in Android 3.0, API 11. Its core mechanism is to calculate intermediate values for a property during the animation and continuously update the target object's real property. This update usually happens through Java reflection by calling the property's setter, or through a more efficient `Property` object.

- **Pros:**
    - **Broad scope:** **It can animate any property of any object, not just Views**, as long as the property has a corresponding setter method or can be accessed through a `Property` object. Examples include custom View drawing parameters, Drawable colors, and even numeric properties of non-UI objects.
    - **Real property updates:** During and after the animation, the object's property values are actually changed. That means View position, size, alpha, and related values reflect the real state, **solving the event hit area and layout issues of View Animation**.
    - **High flexibility and control:**
        - Supports complex interpolation through `Interpolator`.
        - Supports custom type evaluation through `TypeEvaluator`.
        - Supports `Keyframe` for complex animation paths.
        - Is easy to compose and orchestrate with `AnimatorSet`.
    - **Foundation for modern APIs:** `ViewPropertyAnimator`, `StateListAnimator`, `MotionLayout`, and other modern animation-related APIs are built on top of property animation.
- **Cons:**
    - **Initial complexity:** For very simple animations, using `ObjectAnimator` or `ValueAnimator` directly may require a few more lines than a simple View Animation XML definition. `ViewPropertyAnimator` greatly reduces this problem.
    - **Reflection overhead, in theory:** By default, `ObjectAnimator` uses reflection to find and call setter methods. In theory, that has a small performance cost, but in most cases it is negligible. For extremely performance-sensitive cases, use a `Property` object or manually update values with `ValueAnimator` to avoid reflection.
- **Kotlin examples:**

1. **ValueAnimator, manually updating a property:** This is commonly used when the property cannot be accessed directly through a setter, or when complex logic must run based on the animated value. For example, animating a custom View's drawing radius or color.

```kotlin
import android.animation.ValueAnimator
import android.animation.ArgbEvaluator
import android.graphics.Color
import android.graphics.drawable.ColorDrawable

// ...
val myView: View = findViewById(R.id.my_view)
val colorFrom = (myView.background as? ColorDrawable)?.color ?: Color.RED
val colorTo = Color.BLUE

val colorAnimation = ValueAnimator.ofObject(ArgbEvaluator(), colorFrom, colorTo).apply {
    duration = 1000 // Animation duration: 1 second
    addUpdateListener { animator ->
        val animatedValue = animator.animatedValue as Int
        myView.setBackgroundColor(animatedValue) // Manually update the background color
    }
}
colorAnimation.start()
```

2. **ObjectAnimator, automatically updating a property:** One of the most commonly used property animation classes. It directly animates existing object properties that follow the expected naming conventions.

```kotlin
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder

// ...
val myView: View = findViewById(R.id.my_view)

// Animate one property: translate the View 100 pixels along the X axis
val translationXAnim = ObjectAnimator.ofFloat(myView, "translationX", 0f, 100f).apply {
    duration = 500
}
// translationXAnim.start()

// Animate multiple properties at the same time with PropertyValuesHolder
val pvhAlpha = PropertyValuesHolder.ofFloat("alpha", 1f, 0f, 1f) // Alpha: 1 -> 0 -> 1
val pvhScaleX = PropertyValuesHolder.ofFloat("scaleX", 1f, 1.5f, 1f) // X scale: 1 -> 1.5 -> 1
val multiAnim = ObjectAnimator.ofPropertyValuesHolder(myView, pvhAlpha, pvhScaleX).apply {
    duration = 1000
}
multiAnim.start()

// Note: the property name string must match a corresponding public setter on the target object.
// For example, "translationX" -> setTranslationX(float value)
// "backgroundColor" -> setBackgroundColor(int value), usually on View
```

3. **ViewPropertyAnimator, the convenient API for View property animation:** As discussed in Part 2, this is the preferred API for animating standard View properties.

```kotlin
myView.animate()
      .translationY(200f)
      .rotation(360f)
      .alpha(0f)
      .setDuration(800)
      .withEndAction {
          // Restore state after the animation ends, if needed
          myView.translationY = 0f
          myView.rotation = 0f
          myView.alpha = 1f
      }
      .start()
```

4. **AnimatorSet, composing animations:**

```kotlin
import android.animation.AnimatorSet

val fadeOut = ObjectAnimator.ofFloat(myView, "alpha", 1f, 0f).setDuration(300)
val moveUp = ObjectAnimator.ofFloat(myView, "translationY", 0f, -100f).setDuration(500)
val fadeIn = ObjectAnimator.ofFloat(myView, "alpha", 0f, 1f).setDuration(300)

val animatorSet = AnimatorSet()

// Option 1: fade out and move up at the same time, then fade in
// animatorSet.play(fadeOut).with(moveUp) // Play fadeOut and moveUp together
// animatorSet.play(fadeIn).after(fadeOut) // Play fadeIn after fadeOut, and moveUp, finish

// Option 2: play sequentially: fade out -> move up -> fade in
animatorSet.playSequentially(fadeOut, moveUp, fadeIn)

// Option 3: play all at the same time
// animatorSet.playTogether(fadeOut, moveUp, fadeIn)

animatorSet.start()
```

- **Conclusion:** Property Animation is the main tool for animation in modern Android development. It is powerful, flexible, and solves the fundamental problems of View Animation. It should be the default choice. `ViewPropertyAnimator` provides an especially convenient interface for common View property animations.

---

> In the next article, we will discuss "C. Drawable Animation." Stay tuned.

**"Android Animation Deep Dive: From Principles to Practice" series index**

1. Animation Is More Than Decoration
2. Core Animation Concepts
3. System Architecture Overview
4. Core Component Analysis
5. **A. View Animation (Tween Animation), B. Property Animation** (this article)
6. C. Drawable Animation
7. D. Physics-Based Animation
8. E. MotionLayout
9. How to Choose
