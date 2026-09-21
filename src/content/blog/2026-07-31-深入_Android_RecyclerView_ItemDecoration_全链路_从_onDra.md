---
title: 深入 Android RecyclerView ItemDecoration 全链路
excerpt: 深入解析 RecyclerView ItemDecoration 的完整工作机制：从 onDraw/onDrawOver 分层绘制、getItemOffsets 布局介入，到粘性头部、时间轴等复合装饰的工程实现与性能优化。
publishDate: '2026-07-31'
tags:
- Android
- RecyclerView
- ItemDecoration
- 性能优化
- 自定义View
seo:
  title: 深入 Android RecyclerView ItemDecoration 全链路
  description: 深入解析 Android RecyclerView ItemDecoration 的完整机制，涵盖 onDraw/onDrawOver 分层绘制、getItemOffsets 布局介入、粘性头部与时间轴工程实现，以及性能优化最佳实践。
slug: android-recyclerview-itemdecoration
translationKey: android-recyclerview-itemdecoration
---

接手过一个聊天应用的时间轴需求：消息列表左侧要画一条竖线串联时间节点。第一反应是改 Item 布局，结果竖线在快速滑动时断裂闪烁——每个 Item 独立绘制，无法保证线条连续性。换用 ItemDecoration 统一在 Canvas 上绘制后，问题立刻消失。

**ItemDecoration 不只是加分割线，它是依附于 RecyclerView 视口的装饰引擎。** 粘性头部、时间轴、分组标签这类复合 UI，都得走它的绘制链路。

## onDraw 与 onDrawOver 的分层绘制

RecyclerView 的 `draw()` 方法里有三处关键调用：

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

时序很明确：**onDraw 在 Item 之前执行，onDrawOver 在 Item 之后。** 画在 onDraw 里的内容会被 Item 遮盖，画在 onDrawOver 里的内容会遮盖 Item。

普通分割线应该画在 onDraw 中——它出现在两个 item 的间隙里，被 item 边界自然裁剪。粘性头部则必须用 onDrawOver，因为它要悬浮在所有 item 之上。

两者拿到的都是全屏 Canvas。RecyclerView 在调用前会裁剪到 padding 区域，但在 onDrawOver 中你依然可以突破这个边界。个人习惯在绘制前手动 `save()` + `clipRect()`，绘制后 `restore()`，避免嵌套布局时污染外部。

## getItemOffsets：被低估的布局入口

很多人只写 onDraw，忽略了 getItemOffsets。它才是 ItemDecoration 接入测量阶段的关键：

```kotlin
override fun getItemOffsets(
    outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State
) {
    outRect.set(0, 0, 0, dividerHeight) // 为 item 底部预留分割线空间
}
```

outRect 给 item 套了一层"额外间距"。**它增大的是 item 之间的间隙，不是 item 本身。** LayoutManager 在 `layoutDecoratedWithMargins()` 时自动累加这些偏移量。

踩过的一个坑：GridLayoutManager 中均匀设置 outRect，导致首列和末列到边缘的距离不一致。应该用 span 信息动态分配：

```kotlin
val spanIndex = (view.layoutParams as GridLayoutManager.LayoutParams).spanIndex
val spanCount = (parent.layoutManager as GridLayoutManager).spanCount
outRect.left = spacing * spanIndex / spanCount
outRect.right = spacing * (spanCount - 1 - spanIndex) / spanCount
```

网格布局中，左间距分配给靠左的列，右间距分配给靠右的列，这样视觉上各列间距均匀。

## 粘性头部的工程实现

粘性头部（Sticky Header）的核心思路：**监听滚动位置，在 onDrawOver 中判断屏幕顶部的第一个可见 item 属于哪个分组，据此绘制对应的头部。**

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

**推动式吸顶**的逻辑：下一组 header 顶上来时，当前 header 被"推"出去而非直接消失。实现方式就是上面代码里的 `it.top - headerHeight` 偏移。如果直接切换显示/隐藏，视觉上会有跳变，不如这种推动效果顺畅。

点击事件需要额外处理。ItemDecoration 画出来的内容不在视图树里，必须通过 RecyclerView 的 `addOnItemTouchListener` 手动分发：

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

## 时间轴装饰：连续线条的绘制策略

时间轴装饰的挑战在于：**竖线必须在 item 之间无缝衔接。** 用 ItemDecoration 的 onDraw 天然适合，所有 item 的线条都在同一个 Canvas 上绘制：

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

这段代码有一个前提：**屏幕可见的 item 是连续的。** 如果中间有被回收的空白区间，线条会断开。更稳健的做法是让每个 item 自己画一段竖线（理解为"线段片段"），通过 getItemOffsets 和对齐逻辑在视觉上拼成一条。

我当时的思路是：在 getItemOffsets 里给左侧预留 60dp 时间轴区域，Adapter 侧不再管竖线，全部交给 ItemDecoration。这样即使 item 内容高度差异很大，竖线依然连续。唯一需要特殊处理的是首尾 item——第一个不画上方线段，最后一个不画下方线段。

## 性能敏感点

ItemDecoration 的 onDraw/onDrawOver 在每次 RecyclerView 重绘时都触发——滚动、数据更新、动画播放，无一例外。几个容易踩的坑：

**对象创建**：Paint、Path、Rect 在构造时初始化，永远别在 onDraw 里 new。见过有人在 onDrawOver 里每次 `new Paint()`，列表帧率从 60 掉到 40。

**Canvas 裁剪**：clipRect 有开销。如果绘制范围固定在左侧 60dp 内，用 `canvas.translate()` 做坐标偏移比 clipRect 高效。

**条件跳过量绘**：粘性头部只在分组变化时才需重绘。缓存上一个 groupId：

```kotlin
private var lastGroupId = -1

override fun onDrawOver(c: Canvas, parent: RecyclerView, state: State) {
    val groupId = getVisibleGroupId(parent)
    if (groupId == lastGroupId) return   // 同一分组，跳过
    lastGroupId = groupId
    // 执行绘制...
}
```

**多 Decoration 的顺序**：按 `addItemDecoration()` 的顺序依次回调。同时用分割线 + 粘性头部时，确保粘性头部后添加——它在 onDrawOver 里，需要盖在 onDraw 的分割线上面。

## 设计思路

ItemDecoration 三种能力对应三层设计：

- `getItemOffsets` → **空间分配**：为装饰预留物理空间，介入布局测量
- `onDraw` → **背景装饰**：绘制在 item 之下，如分割线、时间轴线
- `onDrawOver` → **前景覆盖**：绘制在 item 之上，如粘性头部、浮动标签

遇到复杂装饰需求时，先判断它属于哪一层，再选对应方法。大部分场景 onDraw 够用，需要悬浮效果才上 onDrawOver。

ItemDecoration 本质是无状态的——它不持有数据，只根据 RecyclerView 当前状态做绘制决策。保持这种无状态性，逻辑更清晰，出 bug 的概率更低。如果确实需要缓存计算结果（比如分组位置映射表），把数据放在 Adapter 中通过回调传入，别在 Decoration 里维护可变状态。
