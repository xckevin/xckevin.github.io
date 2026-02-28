---
title: "Android动画深度解析：从原理到实践（5）：A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）"
excerpt: "「Android动画深度解析：从原理到实践」系列第 5/9 篇：A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 动画
  - UI
  - MotionLayout
series:
  name: "Android动画深度解析：从原理到实践"
  part: 5
  total: 9
seo:
  title: "Android动画深度解析：从原理到实践（5）：A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）"
  description: "「Android动画深度解析：从原理到实践」系列第 5/9 篇：A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）"
---
# Android动画深度解析：从原理到实践（5）：A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）

> 本文是「Android动画深度解析：从原理到实践」系列的第 5 篇，共 9 篇。在上一篇中，我们探讨了「核心组件解析（Core Component Analysis）」的相关内容。

## 第三部分：主流动画类型深度剖析与选型

在掌握了 Android 动画的基础原理和系统架构之后，我们现在需要深入了解 Android 平台提供的各种主流动画实现方式。每种方式都有其独特的原理、优势、劣势和适用场景。作为资深开发者，深刻理解这些差异并能够在具体场景下做出明智的技术选型，是高效开发和打造优秀用户体验的关键。

### A. View Animation（补间动画 - Tween Animation）

**原理回顾**：View Animation 是 Android 早期的动画系统，它通过对View的绘制内容应用变换矩阵（Matrix Transformation）来实现视觉上的移动、缩放、旋转和透明度变化。关键在于，它不改变View对象本身的属性（如left, top, width, height, alpha等），仅仅是改变了它“看起来”的样子和位置。 
+ **优点:**
    - **使用简单:** 对于上述四种基本变换，其API相对直接，XML定义也比较简洁。
    - **历史悠久:** 在旧项目中可能仍有大量使用，需要能够理解和维护。
+ **缺点 (致命的):**
    - **作用范围极其有限:** 只能实现平移、缩放、旋转、透明度这四种效果，无法动画其他任何属性（如背景色、文字大小、自定义绘图属性等）。
    - **属性未变导致交互问题:** 这是最严重的问题。动画移动了View的视觉呈现，但其**事件响应区域（Hit Rect）仍然停留在原始位置**。用户点击移动后的View，可能无法触发事件，或者点击原始位置反而触发了事件，造成用户困惑。
    - **布局属性不变:** View的实际边界和在布局中的占位并未改变，可能导致动画效果与布局行为冲突。
    - **扩展性差:** 无法应用于非View对象，也难以实现复杂的动画逻辑和自定义插值（虽然可以设置Interpolator，但能力受限）。
    - **性能考量:** 虽然简单动画性能尚可，但其依赖于绘制缓存的机制有时可能不如属性动画高效，尤其是在复杂视图或需要频繁更新时。
+ **Kotlin 代码示例:**
    1. **XML 定义 (res/anim/translate_right.xml):**

```xml
<?xml version="1.0" encoding="utf-8"?>
<translate xmlns:android="http://schemas.android.com/apk/res/android"
    android:duration="500"
    android:fromXDelta="0%"
    android:toXDelta="100%"
    android:interpolator="@android:anim/accelerate_decelerate_interpolator"
    android:fillAfter="false" />
```

    1. **代码中加载并启动:**

```kotlin
import android.view.animation.AnimationUtils

// ... inside Activity or Fragment
val myView: View = findViewById(R.id.my_view)
val translateAnim = AnimationUtils.loadAnimation(context, R.anim.translate_right)
myView.startAnimation(translateAnim)
```

    1. **纯代码创建:**

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
    fillAfter = false // 动画结束后是否保持最后一帧状态 (绘制层面)
}
myView.startAnimation(translateAnim)
```

    - **结论**：强烈不推荐在新的开发中使用 View Animation。 其固有的缺陷（尤其是属性不变问题）使其难以适应现代复杂UI交互的需求。应全面转向属性动画。

### B. Property Animation（属性动画）

**原理回顾**：属性动画是 Android 3.0（API 11）引入的现代动画框架。其核心机制是通过计算属性在动画过程中的一系列中间值，并真实地、持续地更新目标对象的对应属性。这种更新通常通过Java反射调用属性的setter方法，或者通过更高效的Property对象来完成。 
    - **优点:**
        * **作用范围广泛:****可以动画任何对象（不限于View）的任何属性**，只要该属性有对应的setter方法（或可以通过Property对象访问）。例如，动画自定义View的绘图参数、改变Drawable的颜色、甚至动画非UI对象的数值属性。
        * **真实改变属性:** 动画过程中和结束后，对象的属性值是真实被修改的。这意味着View的位置、大小、透明度等都是其实际状态，**解决了View Animation的事件响应和布局问题**。
        * **高度灵活性与控制力:**
            + 支持复杂的插值 (Interpolator)。
            + 支持自定义属性类型估算 (TypeEvaluator)。
            + 支持关键帧 (Keyframe) 定义复杂动画路径。
            + 易于组合和编排 (AnimatorSet)。
        * **现代API的基础:** ViewPropertyAnimator, StateListAnimator, MotionLayout等现代动画相关API都构建在属性动画的基础之上。
    - **缺点:**
        * **初始复杂度:** 对于非常简单的动画，直接使用ObjectAnimator或ValueAnimator的模板代码可能比定义一个简单的View Animation XML稍多几行（但ViewPropertyAnimator极大地缓解了这个问题）。
        * **反射开销 (理论上):** ObjectAnimator默认使用反射查找和调用setter方法，理论上存在微小的性能开销。但在绝大多数情况下，这种开销可以忽略不计。对于性能极其敏感的场景，可以使用Property对象或ValueAnimator手动更新来避免反射。
    - **Kotlin 代码示例:**
        1. ValueAnimator (手动更新属性):常用于动画无法直接通过setter访问的属性，或者需要根据动画值执行复杂逻辑的场景。例如，动画自定义View的绘制半径或颜色。 

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
    duration = 1000 // 动画时长 1 秒
    addUpdateListener { animator ->
        val animatedValue = animator.animatedValue as Int
        myView.setBackgroundColor(animatedValue) // 手动更新背景色
    }
}
colorAnimation.start()
```

        1. ObjectAnimator (自动更新属性):最常用的属性动画类之一，用于直接动画对象已有的、符合命名规范的属性。 Kotlin

```kotlin
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder

// ...
val myView: View = findViewById(R.id.my_view)

// 动画单个属性：将View沿X轴平移100像素
val translationXAnim = ObjectAnimator.ofFloat(myView, "translationX", 0f, 100f).apply {
    duration = 500
}
// translationXAnim.start()

// 使用 PropertyValuesHolder 同时动画多个属性
val pvhAlpha = PropertyValuesHolder.ofFloat("alpha", 1f, 0f, 1f) // 透明度 1 -> 0 -> 1
val pvhScaleX = PropertyValuesHolder.ofFloat("scaleX", 1f, 1.5f, 1f) // X轴缩放 1 -> 1.5 -> 1
val multiAnim = ObjectAnimator.ofPropertyValuesHolder(myView, pvhAlpha, pvhScaleX).apply {
    duration = 1000
}
multiAnim.start()

// 注意: 属性名称字符串必须与目标对象中对应的 public setter 方法匹配
// 例如 "translationX" -> setTranslationX(float value)
// "backgroundColor" -> setBackgroundColor(int value) (通常在View上)
```

        1. ViewPropertyAnimator (View属性动画便捷方式):如第二部分所述，这是动画View标准属性的首选方式。 

```kotlin
myView.animate()
      .translationY(200f)
      .rotation(360f)
      .alpha(0f)
      .setDuration(800)
      .withEndAction {
          // 动画结束后恢复状态 (可选)
          myView.translationY = 0f
          myView.rotation = 0f
          myView.alpha = 1f
      }
      .start()
```

        1. AnimatorSet (组合动画): 

```kotlin
import android.animation.AnimatorSet

val fadeOut = ObjectAnimator.ofFloat(myView, "alpha", 1f, 0f).setDuration(300)
val moveUp = ObjectAnimator.ofFloat(myView, "translationY", 0f, -100f).setDuration(500)
val fadeIn = ObjectAnimator.ofFloat(myView, "alpha", 0f, 1f).setDuration(300)

val animatorSet = AnimatorSet()

// 方案一：先淡出和上移同时进行，然后淡入
// animatorSet.play(fadeOut).with(moveUp) // 同时播放 fadeOut 和 moveUp
// animatorSet.play(fadeIn).after(fadeOut) // 在 fadeOut (及 moveUp) 结束后播放 fadeIn

// 方案二：按顺序播放：淡出 -> 上移 -> 淡入
animatorSet.playSequentially(fadeOut, moveUp, fadeIn)

// 方案三：同时播放所有
// animatorSet.playTogether(fadeOut, moveUp, fadeIn)

animatorSet.start()
```

        * **结论**：属性动画是现代 Android 开发中实现动画效果的主力军。它功能强大、灵活且解决了 View Animation 的根本缺陷，应作为首选方案。ViewPropertyAnimator 则为常见的 View 属性动画提供了极其便利的接口。

---

> 下一篇我们将探讨「C. Drawable Animation」，敬请关注本系列。

**「Android动画深度解析：从原理到实践」系列目录**

1. 动画，不仅仅是点缀
2. 核心动画概念（Core Animation Concepts）
3. 系统架构概览（System Architecture Overview）
4. 核心组件解析（Core Component Analysis）
5. **A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）**（本文）
6. C. Drawable Animation
7. D. Physics-Based Animation（基于物理的动画）
8. E. MotionLayout
9. 如何选型
