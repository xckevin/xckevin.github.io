---
title: "Android Animation Deep Dive: From Principles to Practice (8): MotionLayout"
lang: en
translationKey: android-animation-principles-practice-part8
slug: android-animation-principles-practice-part8
excerpt: "Part 8 of the Android animation series: how MotionLayout uses MotionScene, ConstraintSet, Transition, and KeyFrames for complex interactive motion."
publishDate: '2024-03-20'
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 8
  total: 9
seo:
  title: "Android MotionLayout: Declarative Layout Transitions and MotionScene"
  description: "Learn how MotionLayout manages complex Android UI transitions with ConstraintSet states, MotionScene XML, KeyFrames, gestures, and declarative motion."
  pageType: article
---

> This is part 8 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we looked at Physics-Based Animation.

### E. MotionLayout

**Principle:** `MotionLayout` is a subclass of `ConstraintLayout` designed specifically to **manage complex motion and transitions between multiple Views inside a layout**. Its core idea is **declarative animation**: you define two or more layout states with `ConstraintSet`, then describe the `Transition` between those states in a `MotionScene` XML file. `MotionLayout` calculates and executes the animation required to move from one state to another.

- **Core components:**
    - **MotionLayout:** The layout container.
    - **MotionScene (XML):** The core file that defines animation behavior. It contains:
        - **ConstraintSet:** A set of constraints that defines the layout in a specific state, similar to a `ConstraintLayout` layout definition. Usually there are at least `start` and `end` states.
        - **Transition:** Defines the transition from one `ConstraintSet` to another. It can configure duration, `motionInterpolator`, trigger methods such as `OnClick` and `OnSwipe`, and more.
        - **KeyFrameSet, optional:** Defined inside a `Transition` to control intermediate View states during the transition. It includes several key types:
            - **KeyPosition:** Controls the motion path of a View at a specific progress point, enabling non-linear movement.
            - **KeyAttribute:** Controls standard View properties such as alpha, rotation, scale, translation, and elevation at a specific progress point.
            - **KeyCycle:** Controls periodic sinusoidal variation of View properties.
            - **KeyTimeCycle:** Similar to `KeyCycle`, but based on time instead of progress.
    - **Trigger mechanism:** Animations can be triggered from code with methods such as `transitionToState`, `transitionToStart`, and `transitionToEnd`, or by user interaction through `<OnSwipe>` or `<OnClick>` configured in a `Transition`. `MotionLayout` can drive animation progress directly from gestures, such as swipe progress.
- **Pros:**
    - **Handles complex scenes:** Well suited for coordinating many elements moving together or independently inside a layout, such as parts of `CoordinatorLayout`-style effects, expand and collapse animations, and onboarding animations.
    - **Strong interaction-driven support:** For animations that must update in real time based on user swipes or drags, `MotionLayout` provides powerful built-in support.
    - **Declarative:** Animation logic is separated from code and moved into XML, making layout and animation definitions clearer and easier to understand and maintain.
    - **Visual editing:** Android Studio provides MotionEditor, which can visually edit `ConstraintSet` and `Transition` definitions and preview the animation, lowering the barrier to entry.
    - **Constraint-based:** It inherits all the powerful layout capabilities of `ConstraintLayout`.
- **Cons:**
    - **Learning curve:** Compared with basic property animation, `MotionLayout` concepts and XML syntax require more learning.
    - **XML complexity:** In very complex scenes, a `MotionScene` XML file can become large and difficult to manage.
    - **Use-case fit:** For simple single-View animations, using `MotionLayout` may be excessive.
    - **Debugging:** Debugging complex `MotionScene` files, especially those involving `KeyFrame`, can be tricky.
- **Conceptual example, not complete code:** Imagine an animation where tapping a card expands a detail view.

1. **Layout (`activity_main.xml`):** The root layout is `MotionLayout`. It contains a list, `RecyclerView`, and a detail view, `CardView`. The detail view may be partially visible or completely hidden in the initial state.

```xml
<androidx.constraintlayout.motion.widget.MotionLayout
    android:id="@+id/motionLayout"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    app:layoutDescription="@xml/scene_card_expand"> <androidx.recyclerview.widget.RecyclerView
        android:id="@+id/recyclerView"
        ... />

    <androidx.cardview.widget.CardView
        android:id="@+id/detailCard"
        ... />

</androidx.constraintlayout.motion.widget.MotionLayout>
```

2. **MotionScene (`res/xml/scene_card_expand.xml`):**

```xml
<MotionScene xmlns:android="http://schemas.android.com/apk/res/android"
xmlns:app="http://schemas.android.com/apk/res-auto">                
        <Transition
            app:constraintSetStart="@+id/start"
            app:constraintSetEnd="@+id/end"
            app:duration="500">

            <OnClick app:targetId="@id/recyclerView" ... /> <KeyFrameSet>
                 <KeyAttribute
                     app:motionTarget="@id/detailCard"
                     app:framePosition="50" android:alpha="0.5" /> </KeyFrameSet>
        </Transition>

        <ConstraintSet android:id="@+id/start">
            <Constraint android:id="@id/detailCard" ... app:visibilityMode="ignore" android:visibility="gone"/>
             </ConstraintSet>

        <ConstraintSet android:id="@+id/end">
            <Constraint android:id="@id/detailCard" ... android:visibility="visible"/>
             </ConstraintSet>

    </MotionScene>
```

3. **Code in Activity or Fragment:** You may only need to update the detail card content when a list item is tapped, then call `motionLayout.transitionToEnd()` or `motionLayout.transitionToState(R.id.end)` to trigger the animation. `MotionLayout` handles the smooth transition of all View constraints and properties.

- **Conclusion:** `MotionLayout` is a powerful tool for building complex, interactive animations based on layout state transitions. It is especially useful for implementing complex Material Design motion patterns and scenarios where animation needs to be tightly coupled with user gestures.

### F. Start Choosing: There Is No Silver Bullet, Only Fit

After deeply examining the mainstream animation types above, we can see that Android offers multiple animation approaches: simple to complex, time-driven to physics-simulated, and code-controlled to declaratively defined.

**There is no "best" animation type. There is only the animation type that best fits the current requirement.**

Next, we will complete the discussion of animation selection, explore the relationship between animation and user experience, and summarize best practices, common pitfalls, and final conclusions.

---

---

> In the next article, we will discuss "How to Choose." Stay tuned.

**"Android Animation Deep Dive: From Principles to Practice" series index**

1. Animation Is More Than Decoration
2. Core Animation Concepts
3. System Architecture Overview
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. C. Drawable Animation
7. D. Physics-Based Animation
8. **E. MotionLayout** (this article)
9. How to Choose
