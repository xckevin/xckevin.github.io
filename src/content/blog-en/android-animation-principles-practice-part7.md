---
title: "Android Animation Deep Dive: From Principles to Practice (7): Physics-Based Animation"
lang: en
translationKey: android-animation-principles-practice-part7
slug: android-animation-principles-practice-part7
excerpt: "Part 7 of the Android animation series: how SpringAnimation and FlingAnimation create natural, interruptible, interaction-driven motion."
publishDate: '2024-03-20'
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 7
  total: 9
seo:
  title: "Android Physics-Based Animation: Springs, Fling, and Interactive Motion"
  description: "Understand Android physics-based animation with SpringAnimation, FlingAnimation, stiffness, damping ratio, friction, and interruptible UI motion."
  pageType: article
---

> This is part 7 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we looked at Drawable Animation.

### D. Physics-Based Animation

**Principle:** Unlike traditional time-driven animations, where you specify a duration and interpolation curve, physics-based animation, provided by the `androidx.dynamicanimation.animation` library, **simulates real-world physical forces and properties** to drive property changes. Examples include spring force, damping, and friction. The animation behavior is determined by physical parameters rather than a fixed timeline.

- **Core idea:** The animation process is more natural and more responsive. For example, a spring animation can adjust its trajectory at any moment when the target value changes, and it can be naturally interrupted or affected by user interaction such as dragging.
- **Representative classes:**
    - **SpringAnimation:**
        - Simulates a virtual spring force applied to a property, pulling it toward a final target position, `finalPosition`.
        - Key parameters:
            - `SpringForce.setStiffness()`: the spring **stiffness**. A higher value means a harder spring, faster rebound, and higher oscillation frequency.
            - `SpringForce.setDampingRatio()`: the **damping ratio**, which controls how quickly oscillation decays.
                - `DAMPING_RATIO_HIGH_BOUNCY` (> 1): insufficient damping in the original description, resulting in strong oscillation and overshoot.
                - `DAMPING_RATIO_MEDIUM_BOUNCY` (slightly less than 1): medium bounciness with moderate overshoot.
                - `DAMPING_RATIO_LOW_BOUNCY` (close to 1): slight bounciness with limited overshoot.
                - `DAMPING_RATIO_NO_BOUNCY` (== 1): critical damping, reaching the target as quickly as possible without overshoot.
                - > 1: overdamping, reaching the target slowly without oscillation.
        - **Use cases:** Elastic feedback on press and release, snap-back after drag release, springy list item entry or exit, and interaction animations that need natural transitions and interruption support.
    - **FlingAnimation:**
        - Simulates an object that receives an initial velocity, such as from a fast swipe or fling gesture, and then gradually slows down under **friction** until it stops.
        - Key parameters:
            - `setStartVelocity()`: sets the initial velocity.
            - `setFriction()`: sets the friction coefficient. A higher value means faster deceleration.
            - `setMinValue()` and `setMaxValue()`: set property boundaries. The animation stops when it reaches a boundary.
        - **Use cases:** Inertial scrolling for lists or content areas, and fly-out animations after swipe-to-delete on cards.
- **Pros:**
    - **Natural and fluid results:** Motion follows real-world physical intuition.
    - **Highly interruptible and responsive:** Animations can be interrupted at any time by a new target value or user input, then transition smoothly into the new state.
    - **No preset duration required:** Duration is dynamically determined by physical parameters and the initial state.
- **Cons:**
    - **Less precise control:** Exact end time and intermediate values are results of physical calculation, so they are hard to predict or control precisely. This is not a good fit for cases that require strict synchronization or a specific value at a specific timestamp.
    - **Parameter tuning:** It often takes repeated tuning of stiffness, damping ratio, and friction to achieve the desired visual feel.
- **Kotlin example with SpringAnimation:**

```kotlin
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import android.view.MotionEvent
import android.view.View

// ... inside a class with access to myView
var startX = 0f
var startY = 0f
lateinit var springX: SpringAnimation
lateinit var springY: SpringAnimation

fun setupPhysicsAnimation(myView: View) {
    // Create spring animations for the X and Y axes.
    springX = SpringAnimation(myView, DynamicAnimation.TRANSLATION_X)
    springY = SpringAnimation(myView, DynamicAnimation.TRANSLATION_Y)

    // Configure the spring force. Tune these parameters for different effects.
    val springForce = SpringForce().apply {
        finalPosition = 0f // Initial target position is the origin.
        stiffness = SpringForce.STIFFNESS_MEDIUM // Medium stiffness
        dampingRatio = SpringForce.DAMPING_RATIO_MEDIUM_BOUNCY // Medium bounciness
    }
    springX.spring = springForce
    springY.spring = springForce.setFinalPosition(0f) // Reuse the same force for Y.

    // Listen for touch events to implement drag and release rebound.
    myView.setOnTouchListener { v, event ->
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.rawX - v.translationX
                startY = event.rawY - v.translationY
                // Cancel the animation on press so the user can drag freely.
                springX.cancel()
                springY.cancel()
                true
            }
            MotionEvent.ACTION_MOVE -> {
                // Update View translation to follow the finger.
                v.translationX = event.rawX - startX
                v.translationY = event.rawY - startY
                true
            }
            MotionEvent.ACTION_UP -> {
                // On release, start spring animation to return the View to the origin.
                springX.start()
                springY.start()
                true
            }
            else -> false
        }
    }
}
```

- **Conclusion:** For scenarios that need **natural physical effects, interaction responsiveness, and interruption support**, physics-based animation is an excellent choice. It can significantly improve the vividness and realism of UI motion.

---

> In the next article, we will discuss "E. MotionLayout." Stay tuned.

**"Android Animation Deep Dive: From Principles to Practice" series index**

1. Animation Is More Than Decoration
2. Core Animation Concepts
3. System Architecture Overview
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. **D. Physics-Based Animation** (this article)
8. E. MotionLayout
9. How to Choose
