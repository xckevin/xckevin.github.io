---
title: "Android Animation Deep Dive: From Principles to Practice (6): Drawable Animation"
lang: en
translationKey: android-animation-principles-practice-part6
slug: android-animation-principles-practice-part6
excerpt: "Part 6 of the Android animation series: how Frame Animation and AnimatedVectorDrawable work, where they fit, and what tradeoffs to watch for."
publishDate: '2024-03-20'
tags:
- "Android"
- "Animation"
- "UI"
- "MotionLayout"
series:
  name: "Android Animation Deep Dive: From Principles to Practice"
  part: 6
  total: 9
seo:
  title: "Android Drawable Animation: Frame Animation and AnimatedVectorDrawable"
  description: "Learn how Android Drawable Animation works through frame sequences and AnimatedVectorDrawable, including XML setup, usage patterns, strengths, and limits."
  pageType: article
---

> This is part 6 of the nine-part series "Android Animation Deep Dive: From Principles to Practice." In the previous article, we looked at View Animation, also known as tween animation.

### C. Drawable Animation

A `Drawable` can also carry animation information. There are two main forms.

- **Frame Animation:**
    - **Principle:** This is the simplest form of Drawable animation. It displays a sequence of static Drawable resources, usually images, one after another, similar to film frames.
    - **Definition:** It is usually defined in an XML file under `res/drawable/` with the `<animation-list>` tag. Each `<item>` specifies one Drawable resource and the duration of that frame.

```xml
<animation-list xmlns:android="http://schemas.android.com/apk/res/android"
    android:oneshot="false"> <item android:drawable="@drawable/spinner_frame_1" android:duration="100" />
    <item android:drawable="@drawable/spinner_frame_2" android:duration="100" />
    <item android:drawable="@drawable/spinner_frame_3" android:duration="100" />
    </animation-list>
```

- **Usage:** Set the `animation-list` as a View background or an `ImageView` source, then obtain the `AnimationDrawable` object and start it.

```kotlin
val imageView: ImageView = findViewById(R.id.spinner_image)
imageView.setBackgroundResource(R.drawable.loading_spinner) // Or setImageResource
val animationDrawable = imageView.background as? AnimationDrawable // Or imageView.drawable
animationDrawable?.start()

// Remember to stop the animation at the right time, such as Activity or Fragment onStop.
// animationDrawable?.stop()
```

- **Pros:** Simple to implement. Suitable for very regular bitmap-sequence animations, such as simple loading indicators or game sprite actions.
- **Cons:**
    - **Large resource size:** Many frames or large images can significantly increase APK size.
    - **Memory usage:** All frame bitmaps must be loaded into memory, which can increase the risk of OOM.
    - **Poor scalability:** Bitmaps may become distorted or blurry when scaled across different screen densities.
    - **Abrupt visual effect:** Frames switch instantly, with no smooth transition between them.

- **AnimatedVectorDrawable (AVD):**
    - **Principle:** This is a powerful feature introduced in API 21. It lets you animate properties inside a `VectorDrawable`, such as path data for shape morphing, `fillColor`, `strokeColor`, `strokeWidth`, rotation, and translation. Its animation definitions use the property animation mechanism, usually through `ObjectAnimator`.
    - **Definition:** It usually involves three XML files:
        1. **VectorDrawable XML (`res/drawable/`):** Defines the base vector graphic. Paths (`<path>`) or groups (`<group>`) that need animation are usually given an `android:name` so the animation can reference them.
        2. **ObjectAnimator or AnimatorSet XML (`res/animator/`):** Defines how to animate named properties inside the `VectorDrawable`. For example, an `ObjectAnimator` can animate the `pathData` property of a path named `"myPath"`.
        3. **AnimatedVectorDrawable XML (`res/drawable/`):** Connects the `VectorDrawable` with one or more animators. A `<target>` tag specifies the element name inside the `VectorDrawable` through `android:name`, and the animator resource through `android:animation`.

```xml
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/ic_vector_start_shape"> <target
        android:name="path_name_in_vector" android:animation="@animator/path_morph_animator" /> <target
        android:name="group_name_in_vector"
        android:animation="@animator/group_rotation_animator"/>
</animated-vector>
```

- **Usage:** Set the `AnimatedVectorDrawable` on an `ImageView`, preferably with `app:srcCompat` for backward compatibility, then obtain the Drawable and start it.

```kotlin
val imageView: ImageView = findViewById(R.id.animated_icon)
// Assume app:srcCompat="@drawable/avd_morphing_icon" is set in the layout.
val drawable = imageView.drawable
if (drawable is Animatable) { // AVD implements the Animatable interface.
    (drawable as Animatable).start()
}

// Stop it at the appropriate lifecycle point as well.
// if (drawable is Animatable) { (drawable as Animatable).stop() }
```

- **Pros:**
    - **Vector characteristics:** Scales without quality loss and keeps file size small.
    - **Smooth animation:** Uses the property animation mechanism for natural transitions.
    - **Strong expressiveness:** Supports complex shape morphing, color transitions, path animation, and related effects.
    - **Good performance:** Rendering can usually be hardware accelerated.
- **Cons:**
    - **API requirement:** Requires API 21+, although AppCompat provides some backward compatibility support.
    - **Creation complexity:** Writing AVD XML manually, especially `pathData` animation, can be tedious and difficult. Tools are usually needed:
        - Android Studio's built-in Vector Asset Studio can import SVG files.
        - Shape Shifter, a web tool, is a powerful online AVD authoring tool.
        - Designers can create animations in tools such as Adobe After Effects and export them for Android through libraries such as Lottie. Lottie does not directly use AVD, but the principle is similar: vector animation.
- **Conclusion:** For high-fidelity, scalable, expressive icon animation or graphic transformation, `AnimatedVectorDrawable` is an excellent choice in modern Android development. Frame animation should be reserved for very limited, simple bitmap-sequence scenarios.

---

> In the next article, we will discuss "D. Physics-Based Animation." Stay tuned.

**"Android Animation Deep Dive: From Principles to Practice" series index**

1. Animation Is More Than Decoration
2. Core Animation Concepts
3. System Architecture Overview
4. Core Component Analysis
5. A. View Animation (Tween Animation), B. Property Animation
6. **C. Drawable Animation** (this article)
7. D. Physics-Based Animation
8. E. MotionLayout
9. How to Choose
