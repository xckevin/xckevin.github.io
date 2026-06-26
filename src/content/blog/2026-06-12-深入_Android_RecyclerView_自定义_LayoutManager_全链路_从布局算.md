---
title: 深入 Android RecyclerView 自定义 LayoutManager 全链路：从布局算法到动画协同的视口管理引擎
slug: android-recyclerview-custom-layoutmanager
translationKey: android-recyclerview-custom-layoutmanager
excerpt: 从首项居中放大需求出发，深入解析 RecyclerView 自定义 LayoutManager 的 Fill 布局算法、三级缓存漏斗、滚动状态机与航位推算，以及动画协同机制，并给出调试三板斧与性能红线。
publishDate: '2026-06-12'
tags:
- Android
- RecyclerView
- LayoutManager
- 性能优化
- 自定义View
seo:
  title: 深入 Android RecyclerView 自定义 LayoutManager 全链路：从布局算法到动画协同的视口管理引擎
  description: 深入解析 RecyclerView 自定义 LayoutManager 全链路实现，涵盖 Fill 布局算法、缓存分层（Scrap/Cache/Pool）、视口编排、滚动状态机与预测性动画协同，附性能优化与调试指南。
---

项目中接了个需求：实现一个首项居中放大、两侧渐隐的横向滑动控件。LinearLayoutManager 的 `PagerSnapHelper` 能处理居中，但缩放效果只能在外层套 `ViewPager2` 后用 PageTransformer 做——两层嵌套加上滑动冲突，帧率直接崩了。

当时的选择是自己写一个 LayoutManager。这促使我把 RecyclerView 的布局引擎完整走了一遍。

## LayoutManager 的布局算法：Fill 机制

RecyclerView 的核心设计是把数据与布局解耦。Adapter 负责数据绑定，LayoutManager 负责在屏幕上摆放 Item，两者通过 `Recycler` 衔接。

LayoutManager 最关键的入口是 `onLayoutChildren()`，它在首次布局和数据变更时调用。大多数自定义实现的核心逻辑都在这个方法里：回收不再可见的 View，将新 View 填充到视口内。

```java
@Override
public void onLayoutChildren(RecyclerView.Recycler recycler, RecyclerView.State state) {
    detachAndScrapAttachedViews(recycler);
    
    int offset = 0;
    for (int i = 0; i < getItemCount(); i++) {
        View child = recycler.getViewForPosition(i);
        addView(child);
        measureChildWithMargins(child, 0, 0);
        
        int width = getDecoratedMeasuredWidth(child);
        int height = getDecoratedMeasuredHeight(child);
        layoutDecorated(child, offset, 0, offset + width, height);
        offset += width;
    }
}
```

这段代码把每个 Item 从 `Recycler` 取出、测量、按横排摆放。简单直接，但没有回收逻辑——Item 一多，OOM 是早晚的事。

RecyclerView 的做法是 Fill 机制：只布局视口内和边缘的几个 Item，超出视口的 `detach` 或 `remove` 掉。「detach」不等于「销毁」——detach 的 View 进入 `mAttachedScrap` 缓存，复用时零开销。真正被 remove 的 View 则掉入 `mCachedViews`（上限 2 个）或 `RecycledViewPool`（按 ViewType 分组复用）。

## 缓存分层：Scrap、Cache、Pool 三级漏斗

理解缓存层级是手写 LayoutManager 的基本功，直接决定了滑动流畅度。

`Recycler.getViewForPosition()` 的查找顺序：

- **mAttachedScrap**：被 detach 但未移除的 View，匹配 position 直接复用，无需重新绑定
- **mCachedViews**：最近 remove 的 View（默认 2 个），位置匹配则直接复用
- **mViewCacheExtension**：开发者自定义缓存，几乎没人用
- **RecycledViewPool**：按 ViewType 分组的 SparseArray<ArrayList<ViewHolder>>，需要重新调用 `onBindViewHolder`
- **onCreateViewHolder**：兜底创建

我踩过的坑：`onLayoutChildren` 中调用 `detachAndScrapAttachedViews(recycler)` 时，所有 scrapped view 的 position 被标记为 `NO_POSITION`。紧接着在循环中调用 `getViewForPosition(i)`，Scrap 缓存命中不了，结果走 Pool 或重建。

修复方式是 `getScrapList()` 手动遍历匹配，或者信任 Recycler 的内部查找——调用 `getViewForPosition` 时，Recycler 内部会优先从 Scrap 中按 position 查找，前提是你没重写 `supportsPredictiveItemAnimations()` 返回 false 导致 Scrap 被跳过。

## 视口编排：脱离 Fill 的布局控制

回到那个需求——首项居中放大。仅靠 fill 机制不够，还需要控制每个 Item 的相对位置和缩放比例。

思路是在 `onLayoutChildren` 中计算 anchor（锚点）位置，然后用 `scrollHorizontallyBy` 精确控制偏移：

```java
@Override
public void onLayoutChildren(RecyclerView.Recycler recycler, RecyclerView.State state) {
    detachAndScrapAttachedViews(recycler);
    
    int startX = getPaddingLeft();
    int centerY = getHeight() / 2;
    
    // 首个 item 居中偏移
    int offset = getWidth() / 2 - itemWidth / 2;
    
    for (int i = 0; i < getItemCount(); i++) {
        View child = recycler.getViewForPosition(i);
        addView(child);
        measureChildWithMargins(child, 0, 0);
        
        int left = startX + offset;
        int top = centerY - getDecoratedMeasuredHeight(child) / 2;
        int right = left + getDecoratedMeasuredWidth(child);
        int bottom = top + getDecoratedMeasuredHeight(child);
        
        layoutDecorated(child, left, top, right, bottom);
        
        // 根据距中心的距离计算缩放
        float distanceFromCenter = Math.abs(left + itemWidth / 2f - getWidth() / 2f);
        float scale = 1f - Math.min(distanceFromCenter / maxDistance, 0.4f);
        child.setScaleX(scale);
        child.setScaleY(scale);
        
        offset += itemWidth + itemSpacing;
    }
}
```

scale 的计算放在 `onLayoutChildren` 里只是初始状态，滑动时缩放必须跟着变化——这就需要滚动状态机介入。

## 滚动状态机与航位推算

RecyclerView 的滚动分三个阶段，由 `OnScrollListener` 暴露：

- `SCROLL_STATE_IDLE`：静止
- `SCROLL_STATE_DRAGGING`：手指拖拽中
- `SCROLL_STATE_SETTLING`：惯性滑动或 snap 动画中

`scrollHorizontallyBy(int dx, Recycler recycler, State state)` 的返回值决定了 RecyclerView 是否继续投喂触摸事件。返回的值小于 dx，说明已经滚到底。

```java
@Override
public int scrollHorizontallyBy(int dx, RecyclerView.Recycler recycler, RecyclerView.State state) {
    int consumed = 0;
    
    // 回收左侧超出视口的 View
    while (dx > 0 && getChildCount() > 0 && getDecoratedRight(getChildAt(0)) - dx < 0) {
        removeAndRecycleView(getChildAt(0), recycler);
    }
    // 回收右侧超出视口的 View
    while (dx < 0 && getChildCount() > 0 && getDecoratedLeft(getChildAt(getChildCount() - 1)) - dx > getWidth()) {
        removeAndRecycleView(getChildAt(getChildCount() - 1), recycler);
    }
    
    consumed = Math.min(Math.abs(dx), maxHorizontalScroll());
    offsetChildrenHorizontal(-consumed * Integer.signum(dx));
    fillViews(recycler, state);
    
    // 更新每个 Item 的 scale
    for (int i = 0; i < getChildCount(); i++) {
        updateChildScale(getChildAt(i));
    }
    
    return consumed;
}
```

`fillViews` 在回收之后立即从两端填充新 View，保证视口不出现空白。这个「回收-填充」模式实际上就是航位推算（dead reckoning）——**预判滚动方向，提前回收不可见端、填充可见端**。

还有一个容易忽略的点：`canScrollHorizontally()` 必须返回 true，否则 RecyclerView 不会把触摸事件交给 LayoutManager。

## 动画协同：Predictive Animation 的取舍

RecyclerView 的 ItemAnimator 支持预测性动画（predictive animation），在数据变更时动画显示 Item 从旧位置移动到新位置。这要求 LayoutManager 在 `onLayoutChildren` 的预布局（pre-layout）阶段计算旧位置。

预布局通过 `State.isPreLayout()` 判断。如果你的自定义 LayoutManager 不处理这个模式，ItemAnimator 的动画直接失效。

```java
@Override
public void onLayoutChildren(RecyclerView.Recycler recycler, RecyclerView.State state) {
    if (state.isPreLayout()) {
        // 按旧数据布局，不考虑动画后的位置
        layoutWithOldState(recycler);
    } else {
        layoutNormal(recycler);
    }
}
```

不打算支持预布局动画的话，可以直接关掉：

```java
@Override
public boolean supportsPredictiveItemAnimations() {
    return false;
}
```

代价是数据集变化时没有过渡动画。对于大多数自定义布局场景，这个取舍很划算——特别是滑动列表，非列表布局的 ItemAnimator 动画反而容易出视觉 bug。

## 调试三板斧与性能红线

手写 LayoutManager 是 RecyclerView 使用中最容易翻车的环节。三个我反复用到的排查方向：

**View 泄漏**：开启 StrictMode，滑动后检查 Activity 是否正常释放。典型问题是 `removeAndRecycleView` 没调够，ViewHolder 既不在屏幕上也没回池。

**过度测量**：在 `measureChildWithMargins` 前后打日志。每帧测量超过 10 次就有问题——通常是 fill 逻辑有误，反复回收和重建同一个 position。

**帧率监控**：用 systrace 抓一帧，看 `onLayoutChildren` 耗时。**超过 8ms 必须优化**，120Hz 设备的帧预算只有约 8ms 给 measure + layout。

一条容易被忽视的性能红线：`scrollHorizontallyBy` 中不要加载 Bitmap 或做 I/O。这个方法在滑动时每帧调用，任何耗时操作都直接掉帧。数据加载交给 Adapter，LayoutManager 只负责将已绑定的 View 放到正确位置。

LayoutManager 的核心职责就是编排——不生产 View，只决策它们的生死停留。理解了这个边界，缓存、滚动、动画各自该干什么就不会再搞混。
