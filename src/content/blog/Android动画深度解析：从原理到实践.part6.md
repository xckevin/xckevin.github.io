---
title: "Android动画深度解析：从原理到实践（6）：C. Drawable Animation"
excerpt: "「Android动画深度解析：从原理到实践」系列第 6/9 篇：C. Drawable Animation"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 动画
  - UI
  - MotionLayout
series:
  name: "Android动画深度解析：从原理到实践"
  part: 6
  total: 9
seo:
  title: "Android动画深度解析：从原理到实践（6）：C. Drawable Animation"
  description: "「Android动画深度解析：从原理到实践」系列第 6/9 篇：C. Drawable Animation"
---
# Android动画深度解析：从原理到实践（6）：C. Drawable Animation

> 本文是「Android动画深度解析：从原理到实践」系列的第 6 篇，共 9 篇。在上一篇中，我们探讨了「A. View Animation（补间动画 - Tween Animation）」的相关内容。

### C. Drawable Animation

Drawable 本身也可以承载动画信息，主要有两种形式：

        * **Frame Animation (帧动画):**
            + **原理:** 这是最简单的Drawable动画，它按顺序显示一系列静态的Drawable资源（通常是图片），就像播放电影胶片一样。
            + **定义:** 通常在XML文件（res/drawable/目录下）使用<animation-list>标签定义，每个<item>指定一个Drawable资源和该帧的持续时间。 

```xml
<animation-list xmlns:android="http://schemas.android.com/apk/res/android"
    android:oneshot="false"> <item android:drawable="@drawable/spinner_frame_1" android:duration="100" />
    <item android:drawable="@drawable/spinner_frame_2" android:duration="100" />
    <item android:drawable="@drawable/spinner_frame_3" android:duration="100" />
    </animation-list>
```

        * **使用:** 将此animation-list设置为View的背景或ImageView的src，然后获取AnimationDrawable对象并启动。 

```kotlin
val imageView: ImageView = findViewById(R.id.spinner_image)
imageView.setBackgroundResource(R.drawable.loading_spinner) // 或setImageResource
val animationDrawable = imageView.background as? AnimationDrawable // 或 imageView.drawable
animationDrawable?.start()

// 记得在合适的时候停止动画，例如Activity/Fragment onStop
// animationDrawable?.stop()
```

    - **优点:** 实现简单，适用于非常规律的、基于位图序列的动画（如简单的加载指示器、游戏精灵动作）。
    - **缺点:**
        * **资源体积大:** 如果帧数多或图片尺寸大，会显著增加APK大小。
        * **内存消耗:** 需要将所有帧的位图加载到内存中，可能导致OOM风险。
        * **伸缩性差:** 位图在不同分辨率屏幕上缩放可能失真或模糊。
        * **效果生硬:** 帧之间是瞬间切换，没有平滑过渡。
+ **AnimatedVectorDrawable (AVD):**
    - **原理:** 这是API 21引入的强大功能。它允许你动画VectorDrawable内部的属性，例如路径数据 (pathData - 实现形状变换/morphing)、颜色 (fillColor, strokeColor)、描边宽度 (strokeWidth)、旋转、位移等。动画的定义使用了属性动画（通常是ObjectAnimator）的机制。
    - **定义:** 通常涉及三个XML文件： 
        1. VectorDrawable XML (res/drawable/): 定义基础的矢量图形。通常会给需要动画的路径 (<path>) 或组 (<group>) 加上android:name属性，以便在动画中引用。
        2. ObjectAnimator 或 AnimatorSet XML (res/animator/): 定义如何动画VectorDrawable中的具名属性。例如，使用ObjectAnimator动画名为"myPath"的路径的pathData属性。
        3. AnimatedVectorDrawable XML (res/drawable/): 将VectorDrawable与一个或多个Animator关联起来。使用<target>标签指定要动画的VectorDrawable中的元素名称 (android:name) 以及要应用的Animator资源 (android:animation)。

```xml
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/ic_vector_start_shape"> <target
        android:name="path_name_in_vector" android:animation="@animator/path_morph_animator" /> <target
        android:name="group_name_in_vector"
        android:animation="@animator/group_rotation_animator"/>
</animated-vector>
```

    - **使用:** 将AnimatedVectorDrawable设置给ImageView（推荐使用app:srcCompat以便向后兼容），然后获取Drawable并启动。 

```kotlin
val imageView: ImageView = findViewById(R.id.animated_icon)
// 假设在布局中设置了 app:srcCompat="@drawable/avd_morphing_icon"
val drawable = imageView.drawable
if (drawable is Animatable) { // AVD实现了Animatable接口
    (drawable as Animatable).start()
}

// 同样需要适时stop
// if (drawable is Animatable) { (drawable as Animatable).stop() }
```

+ **优点:**
    - **矢量特性:** 无损缩放，文件体积小。
    - **动画平滑:** 利用属性动画机制，过渡自然流畅。
    - **表现力强:** 可以实现复杂的形状变换、颜色过渡、路径动画等。
    - **性能较好:** 渲染通常可以被硬件加速。
+ **缺点:**
    - **API要求:** 需要API 21+（虽然AppCompat库提供了一定的向后兼容支持）。
    - **创建复杂:** 手动编写AVD的XML（尤其是pathData动画）可能非常繁琐和困难。通常需要借助工具： 
        * Android Studio内置的Vector Asset Studio可以导入SVG。
        * Shape Shifter (web tool): 强大的在线AVD创建工具。
        * 设计师在Adobe After Effects等工具中设计动画，然后通过Lottie等库导出并在Android中使用（虽然Lottie不是直接使用AVD，但原理相似，都是矢量动画）。
+ **结论:** 对于需要高保真、可伸缩、效果丰富的图标动画或图形变换，AnimatedVectorDrawable是现代Android开发中的优秀选择。而帧动画则只适用于非常有限的、简单的位图序列场景。

---

> 下一篇我们将探讨「D. Physics-Based Animation（基于物理的动画）」，敬请关注本系列。

**「Android动画深度解析：从原理到实践」系列目录**

1. 动画，不仅仅是点缀
2. 核心动画概念（Core Animation Concepts）
3. 系统架构概览（System Architecture Overview）
4. 核心组件解析（Core Component Analysis）
5. A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）
6. **C. Drawable Animation**（本文）
7. D. Physics-Based Animation（基于物理的动画）
8. E. MotionLayout
9. 如何选型
