---
layout: post
title: 完美解决ListView, GridView在ScrollView显示不完全问题
---

> 在Android中，ListView, GridView是很好容器，用于规则展示条目，并且在超出范围时可以上下滑动展示更多。一般的，都是拿来单独使用。
> 有时候，我们需要把他们放在ScrollView中，不需要他们的滑动效果，仅仅用作展示效果，但是这个时候ListView,GridView往往展示不完全。


####解决办法

- GridView

        public class GridViewInScrollView extends GridView {
        
            public GridViewInScrollView(Context context, AttributeSet attrs) {
                super(context, attrs);
            }
        
            public GridViewInScrollView(Context context) {
                super(context);
            }
        
            public GridViewInScrollView(Context context, AttributeSet attrs, int defStyle) {
                super(context, attrs, defStyle);
            }
        
            @Override
            public void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                int expandSpec = MeasureSpec.makeMeasureSpec(Integer.MAX_VALUE >> 2,
                        MeasureSpec.AT_MOST);
                super.onMeasure(widthMeasureSpec, expandSpec);
            }
        }
- ListView

        public class ListViewInScrollView extends ListView {
        
            public ListViewInScrollView(Context context, AttributeSet attrs) {
                super(context, attrs);
            }
        
            public ListViewInScrollView(Context context) {
                super(context);
            }
        
            public ListViewInScrollView(Context context, AttributeSet attrs, int defStyle) {
                super(context, attrs, defStyle);
            }
        
            @Override
            public void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                int expandSpec = MeasureSpec.makeMeasureSpec(Integer.MAX_VALUE >> 2,
                        MeasureSpec.AT_MOST);
                super.onMeasure(widthMeasureSpec, expandSpec);
            }
        }

####分析

关键的代码就是复写了**OnMeasure**方法，在这个方法里面利用**MeasureSpec**构建一个测量高度。先解释下[**MeasureSpec**这个类](http://developer.android.com/reference/android/view/View.MeasureSpec.html)：
> A MeasureSpec encapsulates the layout requirements passed from parent to child. Each MeasureSpec represents a requirement for either the width or the height. A MeasureSpec is comprised of a size and a mode. There are three possible modes:

>UNSPECIFIED
The parent has not imposed any constraint on the child. It can be whatever size it wants.
>EXACTLY
The parent has determined an exact size for the child. The child is going to be given those bounds regardless of how big it wants to be.
>AT_MOST
The child can be as large as it wants up to the specified size.
MeasureSpecs are implemented as ints to reduce object allocation. This class is provided to pack and unpack the &lt;size, mode&gt; tuple into the int.


**MeasureSpec**是一个帮助类，帮助记录测量的属性和数值。一个int的测量值可以分成两个部分，后16位标识模式，前16位标识大小。三种模式在上面都有解释。在ListView的源码中可以看到，在**onMeasure**方法中对AT_MOST模式做了特殊处理，调用了**measureHeightOfChildren**方法测量显示高度。这个方法中计划了每一个view和高度和divider的高度以及ListView的padding，最终累加返回一个准确的高度。GridView也是一样的道理。