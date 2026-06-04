---
title: "Android Animation Deep Dive: From Principles to Practice (9): Choosing the Right Tool"
lang: en
translationKey: android-animation-principles-practice-part9
slug: android-animation-principles-practice-part9
excerpt: "Part 9 of the Android animation series: how to choose among property animation, MotionLayout, physics-based animation, AVD, transitions, and legacy options."
publishDate: '2024-03-20'
displayInBlog: false
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 9
  total: 9
seo:
  title: "Android Animation Selection Guide: MotionLayout, AVD, and Physics"
  description: "Choose the right Android animation API by target property, complexity, interactivity, performance, maintainability, and compatibility."
  pageType: article
---

> This is part 9 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we looked at "E. MotionLayout."

## Part 4: How to Choose the Right Animation Tool

- **Key decision factors:**
  1. **Animation target and property:**
     - What are you animating? Standard View properties such as translation, scale, rotation, and alpha? Layout properties such as width, height, and margins? Drawable properties such as color and shape? Custom drawing parameters in a custom View? A value on a non-UI object?
     - _Impact:_ View Animation is limited to four View transforms. Property Animation can target any property. AVD works inside `VectorDrawable`. MotionLayout focuses on constraints and View properties.
  2. **Effect complexity:**
     - Is this a simple standalone fade? Or do multiple animations need to be coordinated, sequentially or in parallel? Do you need to simulate physical motion such as bounce and damping? Does the whole screen layout structure need to change substantially?
     - _Impact:_ Use `ViewPropertyAnimator` for simple effects, `AnimatorSet` for multi-animation orchestration, Physics-Based Animation for physical effects, and MotionLayout for complex scene transitions.
  3. **Interactivity and interruptibility:**
     - Does the animation need to respond to touch, swipe, or other gestures? For example, should progress follow the user's finger? Can the user smoothly interrupt an in-flight animation and transition to a new state?
     - _Impact:_ Physics-Based Animation is naturally interruptible and responsive. MotionLayout strongly supports gesture-driven progress. Time-based Property Animation can be made interruptible with additional control logic, but it is more complex. View Animation is generally unsuitable for interactive scenes.
  4. **Performance requirements:**
     - Does the animation affect many objects? Does it run very frequently? Is the target View structurally complex or expensive to draw? What is the performance range of your target devices?
     - _Impact:_ Avoid known bottlenecks such as animations that repeatedly trigger layout. Use hardware layers judiciously. Prefer lighter implementations when possible, such as the optimizations built into `ViewPropertyAnimator`. AVD usually performs better than frame animation. Complex MotionLayout scenes still need performance testing.
  5. **Maintainability and development efficiency:**
     - Should animation logic be controlled imperatively in code or declared in XML? Which style better matches team conventions and project needs? How simple is the implementation? How easy is it to modify and debug?
     - _Impact:_ `ViewPropertyAnimator` keeps code concise. `ObjectAnimator` and `ValueAnimator` provide flexible code control. MotionLayout, `StateListAnimator`, and AVD provide declarative benefits such as logic separation and potential visual editing.
  6. **API level and compatibility:**
     - What minimum API level does the project require? Does the chosen animation type need a specific API level or support library?
     - _Impact:_ View Animation has the broadest compatibility, starting at API 1. Property Animation requires API 11+, which is rarely a practical issue now. AVD requires API 21+, with AppCompat compatibility support. Physics-Based Animation and MotionLayout require AndroidX libraries.

- **Scenario-based recommendations:**

| Scenario | Recommended animation type | Reason |
| --- | --- | --- |
| Simple View fade in/out, translation, rotation, or scale | `ViewPropertyAnimator` | Concise fluent API, optimized for Views, usually good performance, and little code. |
| Animating non-standard properties of a custom View, such as chart values or drawing parameters | `ObjectAnimator` if a setter exists, or `ValueAnimator` plus manual updates | Property Animation can target any property. `ValueAnimator` is the most flexible, while `ObjectAnimator` is more convenient when the target property fits. |
| Precisely coordinating multiple animations, including sequence, parallel execution, and delays | `AnimatorSet` | Strong orchestration that can combine any `Animator` objects. |
| Natural drag-release rebound, shake, and overshoot effects | Physics-Based Animation with `SpringAnimation` | Natural, interruptible, responsive effects without fixed durations. |
| Inertial list or content scrolling after release | Physics-Based Animation with `FlingAnimation` | Simulates friction-based deceleration for realistic motion. |
| Complex UI scene transitions, such as expand/collapse flows or `CoordinatorLayout`-style effects | MotionLayout | Declarative complex transitions, strong multi-View coordination, gesture-driven progress, and separated logic. |
| Automatic animation between two simple layout states, such as expanding a search box | `TransitionManager` from `androidx.transition` | Lightweight in-scene automatic transition framework for layout-property changes. This article did not expand on it, but it is a valid option. |
| Vector icon morphing, play/pause toggles, and similar icon animation | AnimatedVectorDrawable (AVD) | Vector benefits, including lossless scaling and small size, plus smooth expressive animation. |
| Visual feedback when a button is pressed or released, such as slight scale or shadow changes | `StateListAnimator`, or `ViewPropertyAnimator`/`ObjectAnimator` from touch listeners | `StateListAnimator` is the most convenient declarative option for standard state responses. Code control offers more flexibility. |
| Simple loading spinner or image-sequence animation | Frame Animation | Simple and direct, but watch its performance and resource costs. Prefer AVD or custom drawing when possible. |
| Very old compatibility projects or extremely simple temporary effects, not recommended for new projects | View Animation | Keep it mainly for understanding and maintaining legacy code. Avoid it in new features. |

**Core principle:** Prefer Property Animation and its derived APIs, including `ViewPropertyAnimator` and `StateListAnimator`. For complex scenes and interactions, evaluate MotionLayout and Physics-Based Animation. For vector graphics animation, embrace AVD. Use Frame Animation carefully, and leave View Animation behind in new code.

---

## Part 5: Deeper Thinking: Animation, User Experience, and Best Practices

Once we understand the technical implementation of animation, we still need to think at a higher level: how does animation serve user experience, and how do we keep animation excellent and reliable in real engineering work?

### A. The UX value of animation, reinforced and deepened

Animation is not just visual sugar. It is a language for interface communication. Good animation design can:

1. **Provide immediate, clear feedback:**
   - For example, `StateListAnimator` or a touch-responsive `SpringAnimation` gives a button a clear visual or haptic response when pressed, helping the user trust that the action was received. A loading indicator such as a spinning AVD tells the user the system is working and reduces waiting anxiety.
   - _Technical connection:_ the right animation type, such as the responsiveness of physics animation or the clarity of AVD, and the right parameters, such as a suitable interpolator, are critical.
2. **Guide attention and highlight important information:**
   - A slight bounce on a new notification, a subtle glow around an important action button, or avoidance animation from neighboring list items while one item expands can naturally guide the user's eye.
   - _Technical connection:_ `ObjectAnimator` can change color or scale, and `AnimatorSet` can coordinate multiple elements.
3. **Clarify state transitions and reduce cognitive load:**
   - Shared element transitions from a list page to a detail page, based on property animation, or complex layout transitions driven by MotionLayout help users understand how the interface changed instead of feeling like it jumped abruptly. A smoothly expanding panel, driven by `ValueAnimator` over height, helps users understand where content came from.
   - _Technical connection:_ MotionLayout is especially strong here. Changing alpha, position, and size with property animation is the foundation, though size changes should be used carefully.
4. **Build spatial hierarchy and clarify element relationships:**
   - Z-axis animation through `elevation` or `translationZ`, or parallax scrolling, can help users build a sense of virtual depth and understand front/back relationships and ownership between elements.
   - _Technical connection:_ `ObjectAnimator` can animate `translationZ`. MotionLayout can implement parallax effects conveniently.
5. **Add brand personality and delight:**
   - Distinctive micro-interactions, such as a particle effect on a like button or a playful refresh animation implemented with a custom Drawable or AVD, can communicate brand personality, surprise users, and strengthen emotional connection.
   - _Technical connection:_ AVD, custom Drawable animation, or even a particle-effect library can be used.

### B. Best practices and performance tuning

While implementing animation effects, you must account for their performance impact and keep the app smooth.

1. **Embrace Property Animation and leave View Animation behind:** this is the basic rule, for the reasons explained throughout the series.
2. **Use hardware layers wisely:**
   - **When to use them:** when you need to run frequent transform animations, such as translation, rotation, scale, or alpha, on a structurally complex View that is expensive to draw, consider enabling a hardware layer with `view.setLayerType(View.LAYER_TYPE_HARDWARE, null)`.
   - **Principle:** the system caches the View's drawing result into an offscreen buffer, or texture. Later transform and alpha animations can operate directly on that texture at the GPU level without rerunning `onDraw()` for the View and its children, which can greatly improve this category of animation.
   - **Costs:**
     - **GPU memory:** each hardware layer needs extra GPU memory to store its texture. Overuse can increase memory pressure or even cause OOM.
     - **Initial creation cost:** drawing the View into the hardware layer has its own time cost.
     - **Content update issues:** if View content changes after the hardware-layer cache is created, such as changed `TextView` text, but no `invalidate()` is triggered, the hardware layer may not update and may show incorrect content. Make sure the cache is correctly invalidated when content changes.
   - **Key rule:** after the animation ends, always set the layer type back to `View.LAYER_TYPE_NONE` to release GPU memory: `view.setLayerType(View.LAYER_TYPE_NONE, null)`. This usually belongs in `onAnimationEnd`.
   - **Summary:** hardware layers are powerful for performance, but use them precisely, temporarily, and only when needed. Do not enable them blindly.
3. **Avoid animating layout properties:**
   - **Reason:** animating properties such as `width`, `height`, `margin`, and `padding` triggers `requestLayout()`. That asks the view tree to remeasure and relayout upward through its ancestors, can affect many Views, and is an expensive operation that easily causes jank.
   - **Alternatives:**
     - If you only want to visually change position, prefer `translationX` and `translationY`.
     - If you only want to visually change size, prefer `scaleX` and `scaleY`.
     - If you truly need animated real layout changes, consider `TransitionManager` from `androidx.transition`, which automatically handles transitions caused by layout changes. Or use MotionLayout, which is designed for changes in layout constraints.
     - For height changes such as expand/collapse, you can use `ValueAnimator` to calculate the height, assign `view.layoutParams.height = animatedValue` in `onAnimationUpdate`, and call `view.requestLayout()`. This still triggers layout, but you control when it happens and can combine it with targeted optimizations, such as changing only one View's height and keeping the parent size fixed to avoid cascading effects.
4. **Optimize RecyclerView animation:**
   - Use `RecyclerView.ItemAnimator` to handle item add, remove, move, and update animations. The system provides `DefaultItemAnimator`.
   - You can implement a custom `ItemAnimator` for distinctive list effects.
   - **Note:** `onBindViewHolder` may run while item animations are in progress. Keep its work light to avoid jank during animation. Avoid creating complex objects or running expensive calculations in this method.
5. **Optimize Drawable animation:**
   - Prefer AnimatedVectorDrawable (AVD) over Frame Animation for better performance, smaller size, and lossless scaling.
   - Optimize path data in `VectorDrawable`, removing unnecessary nodes and complexity.
   - If you must use Frame Animation, keep the image sequence as small as possible, use as few frames as possible, and consider more efficient image formats such as WebP.
6. **Test on diverse devices:**
   - Animation performance varies greatly across device tiers. Test fully on low-end, mid-range, and high-end devices so the app stays smooth on mainstream devices in your target user base.
7. **Use profiling tools:**
   - **CPU Profiler:** check whether the UI thread has long blocks during animation, shown as red or yellow regions, and locate expensive methods.
   - **Memory Profiler:** observe allocations during animation and check for leaks, such as objects that remain alive after animation ends.
   - **GPU Rendering Profile, GPU rendering bars in Developer Options, Systrace, and Perfetto:** observe per-frame rendering time. Look for frames over 16 ms on a 60 Hz screen, usually shown as red or orange bars, and identify whether Measure/Layout, Draw, Sync & Upload, or another stage is too slow. This is a key tool for rendering-performance diagnosis.
8. **Keep animation concise and purposeful:**
   - Follow Material Design guidance for duration, usually short timings around 150 ms to 300 ms, and easing curves using `PathInterpolator` or standard interpolators.
   - Avoid animations that are too long, flashy, or distracting. Animation should serve function and experience, not exist for its own sake.
9. **Consider accessibility:**
   - Users may adjust animation duration scale in system settings, including Developer Options or accessibility settings, and may even turn animation off entirely by setting `Settings.Global.ANIMATOR_DURATION_SCALE` to `0`.
   - Make sure information carried by animation, such as a state change, is also conveyed through a visible static state when animation is disabled.
   - Design with motion-sensitive users in mind. Avoid excessive rotation, scaling, and rapid movement. Android native APIs have limited direct support for a "reduce motion" preference, but gentler and shorter animation is itself a form of inclusive design.

### C. Common pitfalls and solutions

1. **View Animation hit-area issues:**
   - _Pitfall:_ after the animation ends, the View's visual position changes, but click events still respond at the original position.
   - _Solution:_ **retire View Animation completely and use Property Animation.**
2. **Jank and stuttering:**
   - _Pitfall:_ animation playback is not smooth and has visible stutter.
   - _Root causes:_ expensive work on the main thread, such as IO, complex computation, or large object creation; overdraw; complex Measure/Layout/Draw work; frequent GC pauses; inefficient animation logic, such as heavy computation inside `onAnimationUpdate`.
   - _Solutions:_
     - Move expensive work off the UI thread with Kotlin Coroutines, RxJava, AsyncTask, or equivalent tools.
     - Optimize layout hierarchy, reduce redundant Views, and use `<merge>` and `<ViewStub>` where appropriate.
     - Check and reduce overdraw with the "Debug GPU overdraw" tool in Developer Options.
     - Use hardware layers only when needed and with care.
     - Avoid expensive work or large object creation inside animation callbacks.
     - Use profiling tools to locate bottlenecks and optimize precisely.
3. **Memory leaks:**
   - _Pitfall:_ `Animator` objects, especially listeners, hold references to short-lived objects such as Activity, Fragment, and View, preventing GC after those objects are destroyed.
   - _Root cause:_ non-static inner classes, anonymous inner classes, and lambda-form listeners can implicitly hold references to the outer class, such as an Activity. Long-running animations or animations that are not canceled correctly can leak.
   - _Solutions:_
     - **Use static inner classes plus `WeakReference`:** define listeners as static inner classes, hold the outer instance through a weak reference, and check the reference before use in callbacks.
     - **Remove listeners and cancel animations at lifecycle end:** in `Activity.onDestroy()`, `Fragment.onDestroy()`, or `Fragment.onDestroyView()`, call `animator.cancel()` and `animator.removeAllListeners()`.
     - Use `AnimatorListenerAdapter`. It provides empty implementations, so you only override the methods you need and can reduce anonymous inner-class complexity.
     - **Use Jetpack lifecycle-aware components:** bind animation logic to a `LifecycleObserver` so resources are cleaned automatically at the right lifecycle event, such as `ON_DESTROY`.
     - **For View-related listener cleanup:** use `View.addOnAttachStateChangeListener()` and remove listeners or cancel animation in `onViewDetachedFromWindow()`.
4. **Complex animation logic becomes hard to manage:**
   - _Pitfall:_ many animations have complex dependencies and nested callbacks, making code hard to read and maintain.
   - _Solutions:_
     - Use `AnimatorSet` orchestration fully, including `playTogether`, `playSequentially`, and the Builder API.
     - For complex state-transition-driven animation, consider a state-machine pattern to manage animation logic.
     - If the scene involves complex coordinated motion across the entire layout, evaluate MotionLayout and move orchestration into declarative XML.
5. **Overusing `fillAfter=true` in View Animation:**
   - _Pitfall:_ trying to use `fillAfter=true` to stop a View from jumping back after View Animation ends.
   - _Consequence:_ this only keeps the last frame at the drawing layer. The View's real properties and interactive area are still wrong. It treats the symptom and hides the deeper problem.
   - _Solution:_ **use Property Animation.**

---

## Conclusion: Animation Is Craft and Engineering

At this point, we have walked systematically through Android animation principles, architecture, mainstream animation types, selection strategy, UX value, best practices, and common pitfalls. Android animation is far more than simple API calls. It combines:

- **Understanding of the underlying rendering mechanism:** VSYNC and collaboration between Choreographer, the UI thread, and RenderThread.
- **Mastery of core concepts:** the roles of time, interpolators, evaluators, and keyframes.
- **Fluency with the toolbox:** from classic property animation to modern physics simulation, MotionLayout, and AVD.
- **Insight into user experience:** understanding how animation guides, confirms, and delights users.
- **Rigor in engineering practice:** performance optimization, memory management, code maintainability, and accessibility.

Mastering Android animation means having both a designer's sensitivity to detail and an engineer's rigor around system performance. It requires us to meet product needs while pursuing motion that is smooth, natural, and efficient.

As technology evolves, Android animation continues to move forward. Jetpack Compose, for example, brings a new declarative UI paradigm. Its built-in animation system, including `animate*AsState`, `Animatable`, and `Transition`, provides simpler and more powerful animation capabilities that fit the Compose UI model. This is another area we should keep studying and exploring.

I hope this deep dive gives you a useful reference for your Android animation journey. Master the art and science of animation, and use it to bring life to your apps and create experiences users genuinely admire.

---

**"Android Animation Deep Dive: From Principles to Practice" series**

1. Animation is more than decoration
2. Core Animation Concepts
3. System Architecture Overview
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. D. Physics-Based Animation
8. E. MotionLayout
9. **How to choose the right animation tool** (this article)
