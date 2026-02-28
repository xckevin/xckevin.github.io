---
title: "Android动画深度解析：从原理到实践（2）：核心动画概念（Core Animation Concepts）"
excerpt: "「Android动画深度解析：从原理到实践」系列第 2/9 篇：核心动画概念（Core Animation Concepts）"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - 动画
  - UI
  - MotionLayout
series:
  name: "Android动画深度解析：从原理到实践"
  part: 2
  total: 9
seo:
  title: "Android动画深度解析：从原理到实践（2）：核心动画概念（Core Animation Concepts）"
  description: "「Android动画深度解析：从原理到实践」系列第 2/9 篇：核心动画概念（Core Animation Concepts）"
---
# Android动画深度解析：从原理到实践（2）：核心动画概念（Core Animation Concepts）

> 本文是「Android动画深度解析：从原理到实践」系列的第 2 篇，共 9 篇。在上一篇中，我们探讨了「动画，不仅仅是点缀」的相关内容。

### 2. 核心动画概念（Core Animation Concepts）

在深入了解具体的动画类型之前，我们需要掌握几个贯穿于整个 Android 动画体系（尤其是属性动画）的核心概念。

        * 时间与插值器 (Time and Interpolator)动画的核心是“变化”，而“变化”总是发生在“时间”维度上。动画框架需要知道当前动画进行到了哪个时间点，以及如何根据这个时间点来计算属性的值。 
            + **时间 (Time)：** 动画通常有一个设定的总时长 (duration)。动画运行时，系统会跟踪从动画开始到当前时刻所经过的时间。这个流逝的时间与总时长的比例（通常在0.0到1.0之间），我们称之为“时间因子”或“流逝时间比例”（elapsed fraction）。这是一个线性增长的值，从动画开始的0.0匀速增加到动画结束的1.0。 
            + 插值器 (Interpolator)： 如果动画属性值完全按照时间因子线性变化，那么所有动画看起来都会是匀速的，这往往显得机械而不自然。现实世界中的物体运动很少是匀速的，它们会有加速、减速、反弹等各种效果。插值器的作用就是改变动画的变化速率。它是一个函数，输入是线性的时间因子（0.0到1.0），输出是一个“插值因子”（interpolated fraction），这个输出因子也通常在0.0到1.0的范围内（但某些插值器如AnticipateOvershootInterpolator会超出这个范围）。这个插值因子决定了属性值应该在起始值和结束值之间“前进”多少。本质上，插值器定义了动画的“速度曲线”。 Android提供了多种内置的插值器，位于android.view.animation包下（历史原因，属性动画也使用它们）： 
                - LinearInterpolator：线性插值器。输出=输入，匀速变化。效果平淡，但适用于需要精确同步或循环的场景。
                - AccelerateInterpolator：加速插值器。开始慢，然后逐渐加速。模拟物体受力加速的效果。其曲线类似于 f(x) = x^factor (factor通常>=2)。
                - DecelerateInterpolator：减速插值器。开始快，然后逐渐减速。模拟物体克服阻力停止的效果。曲线类似于 f(x) = 1 - (1-x)^factor。
                - AccelerateDecelerateInterpolator：加减速插值器（默认）。开始和结束慢，中间快。这是最常用的插值器之一，模仿自然加速和减速的过程，效果平滑。基于正弦/余弦曲线 (cos((x+1)*PI)/2 + 0.5)。
                - AnticipateInterpolator：预期插值器。动画开始前会先向反方向移动一小段距离，然后再快速朝目标方向移动。模拟“蓄力”动作。
                - OvershootInterpolator：过冲插值器。动画会超过目标值一点，然后再回弹到目标值。模拟惯性效果。
                - AnticipateOvershootInterpolator：预期过冲插值器。结合了Anticipate和Overshoot的效果，先反向蓄力，然后冲过头再回来。
                - BounceInterpolator：反弹插值器。在动画结束时模拟物体撞击地面并反弹几次的效果。
                - CycleInterpolator：循环插值器。动画会在指定周期内重复指定的次数。输出值呈正弦波形。

**自定义插值器：**

        * 可以通过实现Interpolator接口（或更方便的TimeInterpolator接口）来自定义插值逻辑。
        * PathInterpolator (API 21+) 是一个强大的工具，允许你使用SVG路径语法或两个控制点定义复杂的贝塞尔曲线（Bezier Curve）作为插值曲线，可以创建非常精细和定制化的速度效果。Material Design规范中推荐的缓动曲线（Easing Curves）很多就可以通过PathInterpolator实现。

插值器的选择对动画的“感觉”影响巨大。合适的插值器能让动画显得生动、自然、符合物理直觉，而不合适的则可能让动画显得僵硬、怪异或拖沓。 

+ 关键帧 (Keyframe)简单的动画可能只需要定义一个开始值和一个结束值。但如果想要实现更复杂的动画路径，例如一个属性先加速变大，然后减速变小，最后再匀速回到初始值，仅仅依靠插值器可能难以精确控制。这时就需要引入关键帧的概念。 **关键帧（Keyframe）定义了动画在某个特定时间点应该达到的特定状态（属性值）。** 属性动画框架允许你为同一个属性定义一系列的关键帧。动画在运行时，会在相邻的关键帧之间进行插值计算。 在Android属性动画中，Keyframe类（位于android.animation包）用于表示单个关键帧。一个Keyframe对象包含两个主要信息： 
    1. **时间点 (Fraction)：** 这个关键帧位于动画总时长的哪个比例位置（0.0到1.0之间）。
    2. **属性值 (Value)：** 在该时间点，动画属性应该具有的值。

你可以创建多个Keyframe对象，然后将它们组合到一个PropertyValuesHolder对象中，再将PropertyValuesHolder应用于ValueAnimator或ObjectAnimator。 例如，要让一个View的alpha值在动画过程中经历 0 -> 1 -> 0.5 -> 1 的变化： 

    - Keyframe 0: fraction = 0.0, value = 0.0f
    - Keyframe 1: fraction = 0.5, value = 1.0f
    - Keyframe 2: fraction = 0.8, value = 0.5f
    - Keyframe 3: fraction = 1.0, value = 1.0f

系统会根据这些关键帧和可选的插值器（可以为每个关键帧区间设置不同的插值器）来计算中间过程的值。 **关键帧的重要性：**

+ **定义复杂路径：** 使得动画不再局限于简单的“起点到终点”模式，可以实现多阶段、非线性的复杂变化。
+ **精确控制：** 可以在动画过程中的任意时间点精确设定属性值。
+ **概念统一：** 实际上，即使是最简单的属性动画（只定义startValue和endValue），也可以看作是拥有两个关键帧（fraction 0.0 和 fraction 1.0）的特例。
+ 估值器 (TypeEvaluator)我们已经知道，插值器（Interpolator）根据时间因子输出了一个插值因子（interpolated fraction），这个因子告诉我们动画在起点和终点之间“进度”应该是多少（考虑了速度变化）。但是，如何根据这个进度因子，计算出两个属性值（比如起始颜色和结束颜色，或者起始坐标和结束坐标）之间的具体中间值呢？这就是估值器（TypeEvaluator）的任务。 **TypeEvaluator 的职责是：根据插值器计算出的当前插值因子 (fraction)，以及动画的起始值 (startValue) 和结束值 (endValue)，计算出属性在当前时刻应该具有的具体值。** TypeEvaluator是一个接口，其核心方法是： 

```java
public T evaluate(float fraction, T startValue, T endValue)
```

+ fraction: 由插值器计算得出的插值因子（通常在0.0到1.0之间，但可能超出）。
+ startValue: 动画区间的起始属性值。
+ endValue: 动画区间的结束属性值。
+ 返回值 T: 计算出的当前属性值。

Android系统提供了一些内置的估值器，用于处理常见的属性类型： 

+ IntEvaluator: 用于计算两个int整数之间的值。计算方式通常是 startValue + fraction * (endValue - startValue)。
+ FloatEvaluator: 用于计算两个float浮点数之间的值。计算方式同上。
+ ArgbEvaluator: 用于计算两个ARGB颜色值之间的过渡色。它会分别对A、R、G、B四个分量进行插值计算，然后组合成一个新的颜色值。这是实现颜色渐变动画的关键。
+ PointFEvaluator: 用于计算两个PointF（包含x, y坐标的浮点型点）对象之间的中间点坐标。分别对x和y进行插值。

为什么需要估值器？因为动画框架本身并不知道如何对任意类型的对象或属性进行“插值”。它不知道如何计算两个颜色值之间的中间色，或者两个自定义对象状态之间的过渡状态。TypeEvaluator提供了一种机制，让开发者可以告诉动画框架如何处理特定类型的属性插值。 自定义估值器：当你需要动画一个非标准类型（如自定义的MyObject）或者需要一种特殊的插值逻辑时（例如，不是简单的线性插值，而是基于某种模型的计算），就需要实现自己的TypeEvaluator。例如，如果你想让一个对象沿着一条特定的曲线（而非直线）从点A移动到点B，你可以创建一个自定义的PathEvaluator，它接收起始点、结束点和一个路径对象，然后在evaluate方法中根据fraction计算出物体在路径上对应位置的坐标点。 总结关系：在一个典型的属性动画帧计算中： 

1. 系统获取当前动画的**时间因子**（elapsed fraction）。
2. **插值器 (Interpolator)** 接收时间因子，输出**插值因子**（interpolated fraction），决定了动画的“速度”。
3. **估值器 (TypeEvaluator)** 接收插值因子、动画的起始值和结束值（或者相邻关键帧的值），计算出属性的**当前具体值**。
4. 动画框架将计算出的值设置给目标对象的属性。

理解这三个核心概念——时间与插值器（控制速率）、关键帧（定义路径节点）、估值器（计算中间值）——对于深入掌握和灵活运用Android属性动画至关重要。它们共同构成了属性动画强大而灵活的基础。 

---

## 第二部分：Android 动画系统架构与核心组件

在理解了 Android 动画的基础原理以及与渲染管线的关系之后，我们需要进一步深入其系统架构，了解构成 Android 动画框架的核心组件以及它们是如何协同工作的。掌握这些组件的角色和交互方式，是有效运用动画框架、实现复杂效果、进行问题排查和性能优化的基础。

---

> 下一篇我们将探讨「系统架构概览（System Architecture Overview）」，敬请关注本系列。

**「Android动画深度解析：从原理到实践」系列目录**

1. 动画，不仅仅是点缀
2. **核心动画概念（Core Animation Concepts）**（本文）
3. 系统架构概览（System Architecture Overview）
4. 核心组件解析（Core Component Analysis）
5. A. View Animation（补间动画 - Tween Animation）、B. Property Animation（属性动画）
6. C. Drawable Animation
7. D. Physics-Based Animation（基于物理的动画）
8. E. MotionLayout
9. 如何选型
