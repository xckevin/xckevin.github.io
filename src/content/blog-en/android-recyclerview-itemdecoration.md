---
title: "RecyclerView ItemDecoration: The Decorating Engine for Sticky Headers and Timelines"
lang: en
translationKey: android-recyclerview-itemdecoration
slug: android-recyclerview-itemdecoration
excerpt: "ItemDecoration is more than dividers. Learn how onDraw, onDrawOver, and getItemOffsets power sticky headers, timelines, and group labels in RecyclerView."
publishDate: '2026-07-31'
tags:
- "Android"
- "RecyclerView"
- "ItemDecoration"
seo:
  title: "RecyclerView ItemDecoration: Sticky Headers and Timelines"
  description: "How onDraw, onDrawOver, and getItemOffsets work in RecyclerView ItemDecoration, with practical examples for sticky headers, timelines, and performance."
  pageType: article
---

I once took over a timeline feature for a chat app: a vertical line on the left side of the message list had to connect time nodes. My first instinct was to modify the item layout, but the line broke and flickered during fast scrolling—each item was drawn independently, so the line could not remain continuous. After switching to ItemDecoration to draw it uniformly on the Canvas, the problem disappeared immediately.

**ItemDecoration is not just for drawing dividers; it is a decoration engine attached to the RecyclerView viewport.** Composite UI such as sticky headers, timelines, and group labels all have to go through its drawing pipeline.

## Layered Drawing with onDraw and onDrawOver

The `draw()` method of RecyclerView has three key calls:

```java
// RecyclerView.draw() 简化逻辑
public void draw(Canvas c) {
    super.draw(c);              // 1. 绘制自身背景
    for (ItemDecoration dec : mItemDecorations) {
        dec.onDraw(c, this);    // 2. 装饰层（底层）
    }
    // ... 绘制所有 Item View
    for (ItemDecoration dec : mItemDecorations) {
        dec.onDrawOver(c, this);// 3. 装饰层（顶层）
    }
}
```

The order is clear: **onDraw runs before items, and onDrawOver runs after items.** Content drawn in onDraw can be covered by items; content drawn in onDrawOver covers items.

Ordinary dividers should be drawn in onDraw—they appear in the gaps between two items and are naturally clipped by item boundaries. Sticky headers must use onDrawOver because they need to float above all items.

Both receive a full-screen Canvas. RecyclerView clips it to the padding area before invoking them, but in onDrawOver you can still draw beyond that boundary. I personally prefer to call `save()` + `clipRect()` manually before drawing and `restore()` afterward to avoid leaking drawing state into the outside world when layouts are nested.

## getItemOffsets: The Underestimated Layout Hook

Many developers only implement onDraw and ignore getItemOffsets. Yet it is the key way ItemDecoration participates in the measurement phase:

```kotlin
override fun getItemOffsets(
    outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State
) {
    outRect.set(0, 0, 0, dividerHeight) // 为 item 底部预留分割线空间
}
```

outRect adds an "extra spacing" layer around the item. **It enlarges the gaps between items, not the item itself.** The LayoutManager automatically accumulates these offsets when calling `layoutDecoratedWithMargins()`.

One pitfall I have hit: setting outRect uniformly in GridLayoutManager makes the first and last columns have inconsistent distances to the edges. Use span information to distribute spacing dynamically instead:

```kotlin
val spanIndex = (view.layoutParams as GridLayoutManager.LayoutParams).spanIndex
val spanCount = (parent.layoutManager as GridLayoutManager).spanCount
outRect.left = spacing * spanIndex / spanCount
outRect.right = spacing * (spanCount - 1 - spanIndex) / spanCount
```

In a grid layout, left spacing is assigned to columns closer to the left, and right spacing to columns closer to the right, so the visual gaps between columns are even.

## Sticky Header Implementation

The core idea for sticky headers is: **observe the scroll position, determine which group the first visible item at the top of the screen belongs to in onDrawOver, and draw the corresponding header.**

```kotlin
override fun onDrawOver(c: Canvas, parent: RecyclerView, state: State) {
    val firstPos = (parent.layoutManager as LinearLayoutManager)
        .findFirstVisibleItemPosition()
    if (firstPos == RecyclerView.NO_POSITION) return
    
    val groupId = getGroupId(firstPos)
    var headerTop = parent.paddingTop.toFloat()
    
    // 推动式吸顶：下一个头部上推时，当前头部跟随移动
    val nextHeaderPos = findNextGroupFirstPos(firstPos, groupId)
    if (nextHeaderPos != RecyclerView.NO_POSITION) {
        val nextChild = parent.findViewHolderForAdapterPosition(nextHeaderPos)?.itemView
        nextChild?.let {
            if (it.top < headerHeight) {
                headerTop = it.top - headerHeight
            }
        }
    }
    
    c.drawRect(0f, headerTop, parent.width.toFloat(), headerTop + headerHeight, bgPaint)
    c.drawText(groupTitle, textX, headerTop + textBaseY, textPaint)
}
```

The logic of **push-style sticky headers**: when the next group's header pushes up from below, the current header is "pushed" out rather than disappearing immediately. This is implemented by the `it.top - headerHeight` offset in the code above. If you simply toggle visibility, the transition will look abrupt; the push effect is smoother.

Click events need extra handling. Content drawn by ItemDecoration is not part of the view tree, so you must dispatch touches manually through RecyclerView's `addOnItemTouchListener`:

```kotlin
parent.addOnItemTouchListener(object : RecyclerView.SimpleOnItemTouchListener() {
    override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
        if (e.y < stickyHeaderHeight && e.action == MotionEvent.ACTION_UP) {
            handleStickyHeaderClick()
            return true
        }
        return false
    }
})
```

## Timeline Decoration: Drawing a Continuous Line

The challenge with timeline decoration is that **the vertical line must connect seamlessly between items.** ItemDecoration's onDraw is naturally suited for this because the lines for all items are drawn on the same Canvas:

```kotlin
override fun onDraw(c: Canvas, parent: RecyclerView, state: State) {
    val childCount = parent.childCount
    for (i in 0 until childCount) {
        val child = parent.getChildAt(i)
        val pos = parent.getChildAdapterPosition(child)
        val cy = child.top + child.height / 2f
        
        // 时间节点圆点
        c.drawCircle(timelineX + nodeRadius, cy, nodeRadius, circlePaint)
        
        // 连接线：从上一节点底部到当前节点顶部
        if (pos > 0) {
            val prevChild = parent.getChildAt(i - 1)
            val prevCy = prevChild.top + prevChild.height / 2f
            c.drawLine(timelineX + nodeRadius, prevCy + nodeRadius,
                       timelineX + nodeRadius, cy - nodeRadius, linePaint)
        }
    }
}
```

This code relies on one assumption: **the items visible on screen are contiguous.** If there is a recycled gap in between, the line will break. A more robust approach is to have each item draw its own vertical line segment, and use getItemOffsets and alignment logic to visually stitch them into a single line.

My approach at the time was to reserve a 60dp timeline area on the left in getItemOffsets and let ItemDecoration handle the line entirely, with the Adapter no longer involved. This way the vertical line remains continuous even when item heights vary greatly. The only special cases are the first and last items—the first should not draw an upper segment, and the last should not draw a lower segment.

## Performance-Sensitive Points

ItemDecoration's onDraw/onDrawOver runs on every RecyclerView redraw—scrolling, data updates, and animation playback are all included. Here are several common pitfalls:

**Object creation**: initialize Paint, Path, and Rect in the constructor; never call `new` in onDraw. I have seen someone call `new Paint()` on every onDrawOver, which dropped the list frame rate from 60 to 40.

**Canvas clipping**: clipRect has overhead. If drawing is confined to the left 60dp, using `canvas.translate()` for coordinate offset is more efficient than clipRect.

**Skip redundant drawing with conditions**: a sticky header only needs to be redrawn when the group changes. Cache the previous groupId:

```kotlin
private var lastGroupId = -1

override fun onDrawOver(c: Canvas, parent: RecyclerView, state: State) {
    val groupId = getVisibleGroupId(parent)
    if (groupId == lastGroupId) return   // 同一分组，跳过
    lastGroupId = groupId
    // 执行绘制...
}
```

**Order of multiple decorations**: callbacks are invoked in the order in which they were added with `addItemDecoration()`. When using both a divider and a sticky header, make sure the sticky header is added last—it runs in onDrawOver and needs to be drawn above the divider from onDraw.

## Design Approach

ItemDecoration's three capabilities map to a three-layer design:

- `getItemOffsets` → **Space allocation**: reserve physical space for decoration and participate in layout measurement
- `onDraw` → **Background decoration**: draw beneath items, such as dividers and timeline lines
- `onDrawOver` → **Foreground overlay**: draw above items, such as sticky headers and floating labels

When you encounter a complex decoration need, first decide which layer it belongs to, then choose the corresponding method. In most cases onDraw is enough; only use onDrawOver when you need a floating effect.

ItemDecoration is fundamentally stateless—it holds no data and only makes drawing decisions based on the current state of RecyclerView. Keeping it stateless makes the logic clearer and less bug-prone. If you truly need to cache computed results, such as a group position mapping table, put the data in the Adapter and pass it in through a callback instead of maintaining mutable state in the decoration.
