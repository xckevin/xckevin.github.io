---
title: 深入 Android TV 与 Google TV 应用开发全链路：从 Leanback 导航架构到遥控器焦点管理的客厅大屏工程实践
slug: android-tv-google-tv-leanback-focus
translationKey: android-tv-google-tv-leanback-focus
excerpt: 从手机端到TV端的交互模型差异出发，系统梳理Android TV开发的焦点管理、Leanback架构、遥控器按键处理及跨端适配策略，分享一线工程实践经验。
publishDate: '2026-06-08'
tags:
- Android TV
- Google TV
- Jetpack Compose
- Leanback
- 交互设计
seo:
  title: 深入 Android TV 与 Google TV 应用开发全链路：从 Leanback 导航架构到遥控器焦点管理的客厅大屏工程实践
  description: 深入解析Android TV与Google TV应用开发全链路，涵盖D-Pad交互模型、Leanback导航架构、焦点管理三大核心问题及遥控器按键拦截等实战技巧。
---

三年前接手一个 TV 端视频应用时，我打开 Android Studio 新建了一个 Empty Activity，在模拟器里跑起来——遥控器按了半天，界面上什么都没发生。那个瞬间我才意识到：手机端那套 `onClick` 监听在 TV 上完全失效了。

TV 端的交互模型和手机端是两套体系。理解焦点系统，是所有 TV 应用开发的第一课。

## 方向键驱动的交互模型

手机端用户直接触摸屏幕上的目标控件，Touch 事件从 `dispatchTouchEvent` 一路向下传递。TV 端没有触摸屏，用户通过遥控器的上下左右键在控件之间移动，这要求系统维护一个**当前焦点的控件**，并在方向键按下时计算出下一个应该获得焦点的控件。

Android 的焦点查找算法默认基于**最近邻算法（Nearest Neighbor）**：从当前焦点控件的位置出发，沿方向键方向扫描距离最近的可见控件。规则布局下这个算法工作良好，但布局稍有复杂度就容易出错。

```kotlin
// 自定义焦点查找：指定当前焦点控件左方向的下一焦点
binding.detailCard.nextFocusLeftId = R.id.nav_menu
binding.detailCard.nextFocusRightId = R.id.detail_action_btn
```

更可靠的做法是显式指定 `nextFocusLeft/Right/Up/Down`。在网格布局中，直接标明相邻控件的 ID，完全绕过自动查找的不确定性。我在一个 4×6 的频道列表中试过自动查找，第三行第三个格子的右方向会跳到下一行而非同行的第四个——就因为第二个格子比第四个稍大，算法把距离算错了。

## Leanback 导航架构

Google 为 TV 端提供了一套专门的 Jetpack 库：**Leanback**。它用 `BrowseSupportFragment` 作为入口，内置了经典的左侧导航栏 + 右侧内容区的双栏布局。

```kotlin
class MainFragment : BrowseSupportFragment() {
    override fun onCreateHeaders(): Array<HeaderItem> {
        return arrayOf(
            HeaderItem(0, "推荐"),
            HeaderItem(1, "电影"),
            HeaderItem(2, "电视剧")
        )
    }
}
```

`BrowseSupportFragment` 接管了所有焦点逻辑：标题栏和侧边栏之间如何切换、内容区的焦点如何分发，都不需要手动处理。代价是样式定死——左侧导航栏必然是竖排文字列表，想把它改成横向标签页或底部 Tab 栏，只能绕过去。

Google TV 主界面后来转向了 Jetpack Compose for TV，导航结构更灵活。但如果你维护的是 View 体系的存量应用，`BrowseSupportFragment` 仍然是起手最快的方案。我的选择很明确：新项目直接用 Compose for TV，存量项目继续用 Leanback 打补丁。

Compose for TV 的导航靠 `TvLazyColumn` 和 `TvLazyVerticalGrid`，焦点管理由 Compose 的 `Modifier.focusable()` 自动处理，但嵌套滚动容器中仍需手动调焦。

## 焦点管理的三个核心问题

**问题一：D-Pad 按下无响应。** 控件没有设置 `android:focusable="true"`。TV 端所有可交互控件都需要声明自己是可聚焦的。`Button` 默认 `focusable` 为 true，但 `TextView`、`ImageView`、`LinearLayout` 默认不聚焦。

```xml
<ImageView
    android:id="@+id/poster"
    android:focusable="true"
    android:clickable="true"
    android:background="?attr/selectableItemBackground" />
```

`clickable` 也加上，否则点击事件（遥控器中间确认键）不会触发 `OnClickListener`。

**问题二：焦点丢失。** 界面刷新（RecyclerView 数据更新、Fragment 切换）后焦点跳到屏幕左上角或者直接消失。根本原因是 Adapter 的 `notifyDataSetChanged()` 重置了所有 ViewHolder，包括持有焦点的那个。

```kotlin
// 在 notify 前保存焦点位置
val focusedPosition = (layoutManager as GridLayoutManager)
    .findFirstVisibleItemPosition()
// 刷新数据
adapter.notifyItemRangeChanged(0, newList.size)
// 数据刷新后恢复焦点到原位置附近
recyclerView.post {
    recyclerView.findViewHolderForAdapterPosition(focusedPosition)
        ?.itemView?.requestFocus()
}
```

**问题三：焦点动画。** 电视屏幕上控件获得焦点时需要有清晰的视觉效果来提示用户。Leanback 默认会给一个放大的淡入动画，但自定义交互时需要用 `StateListDrawable` 或 `Animator` 手动实现。

我习惯给焦点控件加一层带圆角的半透明白色边框，用 `Animator` 在 150ms 内缩放 1.05 倍。效果干净利落，不像默认动画那样有延迟感。

## 遥控器的按键拦截与长按

遥控器把按键映射为标准 `KeyEvent`，但几个特殊键经常被系统抢走：

- **HOME 键** (`KEYCODE_HOME`)：应用层完全拦截不了，系统保留
- **BACK 键** (`KEYCODE_BACK`)：可以拦截，但 Google 不建议在 TV 应用中更改后退行为
- **音量键** (`KEYCODE_VOLUME_UP/DOWN`)：Android TV 12 之后默认走系统音量面板

长按场景在视频播放器中很常见——长按方向右键快进、长按左键后退。KeyEvent 对长按的处理方式是：**首次按下发送 `ACTION_DOWN`，持续按住每隔一定时间重复发送 `ACTION_DOWN`（带 `FLAG_LONG_PRESS` 标记），抬起时发送 `ACTION_UP`**。

```kotlin
override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
        if (event.repeatCount == 0) {
            // 首次按下：跳 10 秒
            player.seekTo(player.currentPosition + 10_000)
        } else if (event.repeatCount > 5) {
            // 长按加速：每次跳 30 秒
            player.seekTo(player.currentPosition + 30_000)
        }
        return true
    }
    return super.onKeyDown(keyCode, event)
}
```

踩过一个坑：`repeatCount` 的递增频率在不同厂商的遥控器上不一致，从 50ms 到 200ms 都有。做长按快进时不要用绝对计数，改用时间差判断。

## 从 Phone 到 TV 的适配策略

如果已经有一个 Phone 端应用，往 TV 端移植时最大的挑战不是功能逻辑，而是**交互和视觉**。

> **代码复用率：ViewModel 和 Repository 层 → 90%+，UI 层 → 几乎为 0。**

数据层完全共享。Room 数据库、Retrofit 网络请求、业务逻辑的 ViewModel 可以直接复用。TV 端新建一个 module，依赖共享的 data 和 domain 层，只重写 UI 层。

UI 层无法复用的原因：信息密度差异巨大。手机屏幕在 6-7 英寸之间，横向可以放 3-4 张海报；电视 55 英寸，横向最多放 6-8 张。卡片尺寸、间距、字体大小全部需要重设。Google 的 TV 端设计规范建议：**最小可点击区域 48dp × 48dp，正文最小字号 16sp**。

还有一个容易被忽略的适配点：手机端常见的下拉刷新在 TV 端完全不适用，改为在行尾放置一个"更多"按钮手动触发分页加载。播放器控制栏全屏时默认可见的 SeekBar 在 TV 端需要保持隐藏——遥控器用户首先靠看画面判断状态，而不是看进度条。

---

我维护的 TV 应用目前同时支持 Android TV（运营商盒子）和 Google TV（Chromecast with Google TV）。最深的体会是：TV 端开发的技术门槛不高，麻烦的是**交互逻辑在两种框架下都要各搞一套**，Leanback 一套，Compose for TV 又一套。如果项目周期允许，我建议直接上 Compose for TV 路线——Compose 的状态驱动模型天然适合焦点这种需要频繁切换的交互场景，而且 Google 的资源倾斜明显在新方案上。

说两个我自己日常用的提效方法。一个是建一个「遥控器调试面板」：开发机连蓝牙遥控器不现实，写一个 Dev 菜单用 `adb shell input keyevent` 模拟方向键和确认键，效率翻倍。另一个是，所有焦点相关 Bug 先去查 `focusable` 和 `focusableInTouchMode`——80% 的问题都是这两个属性没设对。
