---
title: "Building a Custom RecyclerView LayoutManager: Layout, Caching, Scroll, and Animation"
lang: en
translationKey: android-recyclerview-custom-layoutmanager
slug: android-recyclerview-custom-layoutmanager
excerpt: "An end-to-end guide to writing a custom RecyclerView LayoutManager: the Fill algorithm, three-tier cache, scroll state machine, dead-reckoning, and animation tradeoffs."
publishDate: '2026-06-12'
tags:
- "Android"
- "RecyclerView"
- "LayoutManager"
- "Performance"
- "Custom View"
seo:
  title: "Custom RecyclerView LayoutManager: Layout to Animation Guide"
  description: "Build a custom RecyclerView LayoutManager: fill algorithm, Scrap/Cache/Pool tiers, viewport orchestration, and predictive animations."
  pageType: article
---

I needed a horizontal carousel where the center item is enlarged and the sides fade out. `LinearLayoutManager` with `PagerSnapHelper` handles centering, but the scale effect required wrapping everything in `ViewPager2` and using a `PageTransformer` — two layers of nesting plus scroll conflicts tanked the frame rate.

The decision: write a custom LayoutManager. That sent me through RecyclerView's entire layout engine.

## The Fill Algorithm

RecyclerView's core design decouples data from layout. The Adapter handles data binding; the LayoutManager positions items on screen; the `Recycler` bridges them.

The key entry point is `onLayoutChildren()`, called on initial layout and on data changes. Most custom implementations live in this method: recycle views that left the viewport and fill new ones in.

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

This pulls each item from the `Recycler`, measures it, and lays it out horizontally. Simple, but there's no recycling — add enough items and OOM is inevitable.

RecyclerView's answer is the Fill mechanism: only lay out items inside and near the viewport; `detach` or `remove` the rest. "Detach" doesn't mean "destroy" — a detached View goes into `mAttachedScrap` and is reused with zero cost. A truly removed View falls into `mCachedViews` (max 2) or `RecycledViewPool` (grouped by ViewType).

## Three-Tier Cache: Scrap, Cache, Pool

Understanding the cache hierarchy is table stakes for a hand-written LayoutManager — it directly determines scroll smoothness.

`Recycler.getViewForPosition()` searches in this order:

- **mAttachedScrap**: detached-but-not-removed views; matched by position and reused with no rebinding
- **mCachedViews**: recently removed views (default 2); reused on position match without rebinding
- **mViewCacheExtension**: developer-defined cache; almost nobody uses it
- **RecycledViewPool**: `SparseArray<ArrayList<ViewHolder>>` grouped by ViewType; requires `onBindViewHolder`
- **onCreateViewHolder**: fallback creation

A pitfall I hit: calling `detachAndScrapAttachedViews(recycler)` in `onLayoutChildren` marks all scrapped views' positions as `NO_POSITION`. Then calling `getViewForPosition(i)` in the loop misses the Scrap cache and falls through to the Pool or fresh creation.

The fix is either to walk `getScrapList()` and match manually, or to trust the Recycler's internal lookup — when you call `getViewForPosition`, the Recycler does search Scrap by position internally, as long as you haven't overridden `supportsPredictiveItemAnimations()` to return false (which causes Scrap to be skipped).

## Viewport Orchestration: Beyond Fill

Back to the requirement — center-enlarged items. Fill alone isn't enough; you also need to control each item's relative position and scale.

The approach: compute an anchor position in `onLayoutChildren`, then fine-tune the offset with `scrollHorizontallyBy`:

```java
@Override
public void onLayoutChildren(RecyclerView.Recycler recycler, RecyclerView.State state) {
    detachAndScrapAttachedViews(recycler);
    
    int startX = getPaddingLeft();
    int centerY = getHeight() / 2;
    
    // center the first item
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
        
        // scale based on distance from center
        float distanceFromCenter = Math.abs(left + itemWidth / 2f - getWidth() / 2f);
        float scale = 1f - Math.min(distanceFromCenter / maxDistance, 0.4f);
        child.setScaleX(scale);
        child.setScaleY(scale);
        
        offset += itemWidth + itemSpacing;
    }
}
```

The scale computed in `onLayoutChildren` is only the initial state. During scroll, the scale must follow — and that's where the scroll state machine comes in.

## Scroll State Machine and Dead Reckoning

RecyclerView scroll has three phases, exposed via `OnScrollListener`:

- `SCROLL_STATE_IDLE`: at rest
- `SCROLL_STATE_DRAGGING`: finger dragging
- `SCROLL_STATE_SETTLING`: fling or snap animation

The return value of `scrollHorizontallyBy(int dx, Recycler recycler, State state)` tells RecyclerView whether to keep feeding touch events. If the return is less than `dx`, you've hit the edge.

```java
@Override
public int scrollHorizontallyBy(int dx, RecyclerView.Recycler recycler, RecyclerView.State state) {
    int consumed = 0;
    
    // recycle views that left the viewport on the left
    while (dx > 0 && getChildCount() > 0 && getDecoratedRight(getChildAt(0)) - dx < 0) {
        removeAndRecycleView(getChildAt(0), recycler);
    }
    // recycle views that left the viewport on the right
    while (dx < 0 && getChildCount() > 0 && getDecoratedLeft(getChildAt(getChildCount() - 1)) - dx > getWidth()) {
        removeAndRecycleView(getChildAt(getChildCount() - 1), recycler);
    }
    
    consumed = Math.min(Math.abs(dx), maxHorizontalScroll());
    offsetChildrenHorizontal(-consumed * Integer.signum(dx));
    fillViews(recycler, state);
    
    // update each item's scale
    for (int i = 0; i < getChildCount(); i++) {
        updateChildScale(getChildAt(i));
    }
    
    return consumed;
}
```

`fillViews` immediately fills new views from both ends after recycling, ensuring the viewport never goes blank. This "recycle-then-fill" pattern is effectively dead reckoning — **predict the scroll direction, proactively recycle the invisible end and fill the visible end**.

One easily overlooked point: `canScrollHorizontally()` must return true, or RecyclerView won't route touch events to the LayoutManager at all.

## Predictive Animation Tradeoffs

RecyclerView's `ItemAnimator` supports predictive animation — animating an item from its old position to its new one on data change. This requires the LayoutManager to compute the old position during the pre-layout phase of `onLayoutChildren`.

Pre-layout is detected via `State.isPreLayout()`. If your custom LayoutManager doesn't handle this mode, ItemAnimator animations silently break.

```java
@Override
public void onLayoutChildren(RecyclerView.Recycler recycler, RecyclerView.State state) {
    if (state.isPreLayout()) {
        // lay out with old data, ignoring post-animation positions
        layoutWithOldState(recycler);
    } else {
        layoutNormal(recycler);
    }
}
```

If you don't intend to support pre-layout animation, just turn it off:

```java
@Override
public boolean supportsPredictiveItemAnimations() {
    return false;
}
```

The cost: no transition animation on dataset changes. For most custom-layout scenarios that's a worthwhile trade — especially in scrollable layouts where ItemAnimator animations tend to produce visual bugs.

## Debugging Toolkit and Performance Red Lines

Writing a custom LayoutManager is where RecyclerView usage goes wrong most often. Three diagnostic directions I keep coming back to:

**View leaks**: enable StrictMode, then check after scrolling whether the Activity is released properly. The typical issue is calling `removeAndRecycleView` too few times — ViewHolders that are neither on screen nor in the pool.

**Excessive measurement**: log around `measureChildWithMargins`. More than 10 measurements per frame is a red flag — usually a broken Fill loop that repeatedly recycles and rebuilds the same position.

**Frame-rate monitoring**: capture a systrace frame and check `onLayoutChildren` duration. **Anything over 8ms must be optimized.** On 120Hz devices the frame budget for measure + layout is roughly 8ms.

One often-overlooked red line: don't load Bitmaps or do I/O inside `scrollHorizontallyBy`. This method runs every frame during scroll — any expensive operation means dropped frames. Hand data loading to the Adapter; the LayoutManager's only job is to place already-bound Views at the right coordinates.

The LayoutManager's core responsibility is orchestration — it doesn't produce Views, it decides where they live and for how long. Once that boundary is clear, what caching, scrolling, and animation each should do stops being confusing.
