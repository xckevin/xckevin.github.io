---
title: "Customizing RecyclerView SnapHelper for Multi-Page Fling Snapping"
lang: en
translationKey: android-recyclerview-snaphelper
slug: android-recyclerview-snaphelper
excerpt: "A guide to RecyclerView's SnapHelper: how it intercepts flings, maps velocity to positions, and calculates final snapping offsets, with custom strategies."
publishDate: '2026-08-06'
tags:
- "Android"
- "RecyclerView"
- "SnapHelper"
seo:
  title: "RecyclerView SnapHelper: Fling Mapping and Snap Alignment"
  description: "How SnapHelper intercepts fling events, maps velocity to target positions, and computes snapping offsets, plus custom multi-page and alignment strategies."
  pageType: article
---

For horizontal card swiping, most developers reach for ViewPager2. But the requirement gets tricky when you need **both the feel of snapping to a single page and the ability to skip two pages in a single fast fling**. ViewPager2 hard-codes the ±1 page-offset behavior, and the answer lies in SnapHelper—if you are willing to take it apart.

SnapHelper is an abstract helper class for RecyclerView with a single responsibility: **correcting position after scrolling stops**, aligning a certain item to a specified anchor. The framework provides `LinearSnapHelper` (center snapping) and `PagerSnapHelper` (page snapping). Once you take apart the internal velocity mapping and alignment calculation, a custom snap policy is just a matter of changing the return values of two methods.

## How Fling Events Are Intercepted

When RecyclerView processes touch events, `ACTION_UP` triggers a fling:

```java
// RecyclerView.onTouchEvent 简化
case MotionEvent.ACTION_UP:
    mVelocityTracker.computeCurrentVelocity(1000, mMaxFlingVelocity);
    if (!fling((int) mVelocityTracker.getXVelocity(),
               (int) mVelocityTracker.getYVelocity())) {
        setScrollState(SCROLL_STATE_IDLE);
    }
```

`fling()` invokes whichever `OnFlingListener` is currently set. To be clear, RecyclerView **only supports one registered** `OnFlingListener` at a time: `setOnFlingListener()` directly replaces the previous one, and there is no mechanism that "iterates all OnFlingListeners and runs them in registration order." In fact, inside `SnapHelper.attachToRecyclerView()`, if an OnFlingListener is already present, it throws `IllegalStateException` rather than registering another one. SnapHelper registers itself in `attachToRecyclerView()` by calling `recyclerView.setOnFlingListener(this)`. This means once SnapHelper takes over fling, RecyclerView's built-in inertial scrolling no longer applies—the entire subsequent scroll process becomes your responsibility.

After the fling is intercepted, the core path is in `snapFromFling()`:

```java
// SnapHelper.snapFromFling()
private boolean snapFromFling(LayoutManager layoutManager,
        int velocityX, int velocityY) {
    int targetPos = findTargetSnapPosition(layoutManager, velocityX, velocityY);
    if (targetPos == RecyclerView.NO_POSITION) return false;
    mRecyclerView.smoothScrollToPosition(targetPos);
    return true;
}
```

The **two key methods each own one part of the job**: `findTargetSnapPosition` maps velocity to the target position, and `calculateDistanceToFinalSnap` computes the pixel offset needed for alignment once the target view has been laid out. Once you understand this division of labor, customization follows naturally.

## Mapping Velocity to Position

### PagerSnapHelper's Naive Strategy

PagerSnapHelper's velocity mapping is simpler than many people expect—it does not use physics formulas to compute the sliding distance; **it only looks at the velocity direction**:

```java
// PagerSnapHelper.findTargetSnapPosition 核心
int currentPos = helper.getPosition();  // 当前最接近锚点的 item
int target = currentPos + (velocityX > 0 ? 1 : -1);
target = Math.max(0, Math.min(target, itemCount - 1));
```

Velocity only determines the sign; the position is always ±1. This matches ViewPager2's behavior: no matter how fast you swipe, it only flips one page at a time. That is enough for most scenarios, but only advancing one page on a fast fling is indeed too conservative.

### An Extension Based on a Physical Model

To achieve "the faster the velocity, the more pages are crossed," you need to compute the sliding distance yourself inside `findTargetSnapPosition`:

```kotlin
override fun findTargetSnapPosition(
    layoutManager: LayoutManager, velocityX: Int, velocityY: Int
): Int {
    val currentView = findSnapView(layoutManager) ?: return NO_POSITION
    val currentPos = layoutManager.getPosition(currentView)

    // 用 SnapHelper 自带的 calculateScrollDistance（内部基于 Scroller.fling 仿真）
    // 估算本次 fling 的滑行距离，比自己推导公式更贴合真实滚动行为
    val distances = calculateScrollDistance(velocityX, velocityY)
    val distance = distances[0]
    val itemWidth = currentView.width  // 假设等宽
    val pageOffset = (distance / itemWidth.toFloat()).roundToInt()

    return (currentPos + pageOffset)
        .coerceIn(0, layoutManager.itemCount - 1)
}
```

`calculateScrollDistance` is a public method provided by the `SnapHelper` base class. Internally it uses `android.widget.Scroller.fling()` to simulate the system's coasting behavior and directly obtain the final displacement that the system itself would compute. This is more reliable than writing your own physics formula—`ViewConfiguration.getScrollFriction()` returns a **dimensionless friction coefficient, not a physically real coefficient of friction**. Its numerical meaning is defined by the internal scrolling model of `Scroller` (an empirically fitted deceleration curve, not the kinetic friction coefficient in Coulomb's law of friction), so you cannot directly apply projectile-motion formulas such as `v² / (2 · μ · g)`—multiplying by gravitational acceleration 9.8 makes no sense dimensionally there, and the resulting value has nothing to do with the actual sliding distance. If you do not want to use `calculateScrollDistance`, the more honest approach is to treat it as an **engineering empirical formula** that needs real-device tuning (for example, `distance = velocity * velocity / (2 * scrollFriction * someTunedConstant)`, and explicitly note that `someTunedConstant` is an empirically fitted value), rather than pretending it is a rigorous physics formula.

In my own projects, however, I do not use a physics formula; I use **velocity bucketing**—the coefficients of a physical model require repeated tuning on different devices, while graded thresholds are more controllable:

```kotlin
val absVel = abs(velocityX)
val offset = when {
    absVel > 4000 -> 3
    absVel > 1500 -> 2
    else -> 1
}
return (currentPos + if (velocityX > 0) offset else -offset)
    .coerceIn(0, layoutManager.itemCount - 1)
```

Just fine-tune the three thresholds according to the actual item width and the desired feel; it is less trouble than a physics formula.

## Computing Alignment: Center, Edge, or Offset

After the target position is found, `smoothScrollToPosition` triggers a layout pass and the target view gets laid out. SnapHelper then calls `calculateDistanceToFinalSnap` to compute the remaining offset:

```java
// LinearSnapHelper 居中计算（源码中 distanceToCenter / getHorizontalHelper 均为 private）
public int[] calculateDistanceToFinalSnap(
        LayoutManager layoutManager, View targetView) {
    int[] out = new int[2];
    if (layoutManager.canScrollHorizontally()) {
        out[0] = distanceToCenter(targetView, 
            getHorizontalHelper(layoutManager));
    }
    // ... 垂直同理
    return out;
}

private int distanceToCenter(View targetView, OrientationHelper helper) {
    int childCenter = helper.getDecoratedStart(targetView) 
        + helper.getDecoratedMeasurement(targetView) / 2;
    int containerCenter = helper.getStartAfterPadding() 
        + helper.getTotalSpace() / 2;
    return childCenter - containerCenter;
}
```

`childCenter - containerCenter`: when the child is to the left of the container center, the returned value is positive, indicating the distance still needed to scroll to the right. This value is passed to `SmoothScroller` to drive the final alignment animation.

**Custom alignment means changing this calculation logic**, but note that in `LinearSnapHelper` source code, `distanceToCenter` and `getHorizontalHelper` are both `private` methods. Subclasses cannot call them directly after inheriting, so you must reimplement equivalent logic yourself. For example, in an image viewer where the first page is left-aligned (to reveal a preview of the next page) and the remaining pages are centered, you can inherit directly from `SnapHelper` (rather than `LinearSnapHelper`) and compute the distance yourself using `View` measurement information, avoiding reliance on those private methods:

```kotlin
class MixedSnapHelper : LinearSnapHelper() {
    override fun calculateDistanceToFinalSnap(
        layoutManager: LayoutManager, targetView: View
    ): IntArray {
        val out = IntArray(2)
        val pos = layoutManager.getPosition(targetView)
        out[0] = if (pos == 0) {
            // 第 0 项左对齐
            targetView.left - layoutManager.paddingLeft
        } else {
            // 其余居中：不依赖父类 private 的 distanceToCenter，自己按 View 边界计算
            val recyclerView = targetView.parent as View
            val childCenter = targetView.left + targetView.width / 2
            val containerCenter = recyclerView.paddingLeft +
                (recyclerView.width - recyclerView.paddingLeft - recyclerView.paddingRight) / 2
            childCenter - containerCenter
        }
        return out
    }
}
```

## Three Production-Ready Considerations

### The ItemDecoration Offset Trap

When `calculateDistanceToFinalSnap` computes the child position, if an ItemDecoration modifies the item's drawing offset, the values of `targetView.left` and `getDecoratedStart()` will disagree. The alignment error comes from exactly that difference. The fix is simple: consistently use `getDecoratedStart` / `getDecoratedEnd` and avoid `left` / `right`.

### Target View Not Laid Out During Rapid Consecutive Swipes

When the user swipes rapidly and continuously, the previous alignment animation has not finished before the next fling arrives. In this case, the target item returned by `findTargetSnapPosition` may not have been laid out yet, causing `calculateDistanceToFinalSnap` to receive null. The way to handle it is to return `NO_POSITION` directly and let the current animation finish naturally instead of forcibly interrupting it.

### Controlling the Scroll Animation Curve

`smoothScrollToPosition` uses RecyclerView's default interpolator, and the deceleration curve cannot be configured. If you need a custom deceleration curve (for example, to imitate iOS spring-back), inherit directly from `RecyclerView.SmoothScroller`, override `calculateTimeForDeceleration` and `calculateSpeedPerPixel`, and trigger it with `layoutManager.startSmoothScroll(customScroller)`, completely bypassing SnapHelper's default animation.

`findTargetSnapPosition` controls which page the scrolling stops at, and `calculateDistanceToFinalSnap` controls which anchor the view aligns to—together these two methods cover 90% of custom requirements. The remaining 10% lives in SmoothScroller's animation curve, which is another topic.
