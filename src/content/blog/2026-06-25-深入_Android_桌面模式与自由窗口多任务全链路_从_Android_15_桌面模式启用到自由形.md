---
title: Android 桌面模式与自由窗口：从 Display 分治到多实例并行
slug: android-desktop-mode-freeform-multitasking
translationKey: android-desktop-mode-freeform-multitasking
excerpt: 深入分析 Android 15 桌面模式与自由窗口的系统架构，涵盖 DisplayContent 分治、Task 窗口管理、多实例并行及输入事件派发机制，并总结实战中的适配要点。
publishDate: '2026-06-25'
tags:
- Android
- 桌面模式
- 自由窗口
- WindowManager
- 多实例并行
seo:
  title: Android 桌面模式与自由窗口：从 Display 分治到多实例并行
  description: 深入分析 Android 15 桌面模式与自由窗口的系统架构，从 Display 分治到多实例并行，涵盖窗口管理、输入事件派发与实战适配要点。
---

去年给平板应用做大屏适配，产品经理提了一个需求：能不能像 PC 一样，同时开两个文档对比编辑？我当时第一反应是——Android 的分屏只能左右切，Activity 重建那一套就够头疼了。

Android 15 把桌面模式（Desktop Mode）从开发者选项里拎了出来，搭配自由窗口（Freeform Window），这套机制才算真正可用。这篇文章从系统层梳理自由窗口的管理链路、多实例并行的架构要点，以及我在实际适配中踩过的坑。

## 桌面模式的本质：一个独立的 Display

桌面模式不是"把手机界面投到大屏"。系统层面会创建独立的**虚拟 Display** 和一个 **Launcher Task** 承载桌面环境。

核心入口在 `DesktopModeController`：

```java
// frameworks/base/services/core/java/com/android/server/wm/DesktopModeController.java
boolean isDesktopModeEnabled() {
    return mContext.getResources().getBoolean(
        com.android.internal.R.bool.config_enableDesktopMode)
        || Settings.Global.getInt(mContext.getContentResolver(),
            "force_desktop_mode_on_external_display", 0) == 1;
}
```

`config_enableDesktopMode` 是 AOSP 的编译开关，默认关闭。厂商或自定义 ROM 需要在 overlay 里打开。`force_desktop_mode_on_external_display` 是 runtime 开关，调试用。

外接显示器或触发桌面模式时，系统通过 `DisplayManager` 创建一个类型为 `TYPE_VIRTUAL` 或 `TYPE_EXTERNAL` 的 Display。这个 Display 拥有独立的 `DisplayContent`，和主屏窗口栈完全隔离。

桌面模式的 Display 和主屏 Display 共享同一个 WindowManager 服务，但 WindowManager 内部按 DisplayContent 分治——搞清楚这一点，后面多窗口管理的逻辑就通了。

## 自由窗口的窗口管理链路

自由窗口模式下，每个 Activity 对应一个 Task，Task 的 bounds 不再跟屏幕等大，而是可拖拽、可缩放、可层叠的矩形区域。

### Task 的 bounds 控制

窗口的位置和大小由 `Task#setBounds()` 控制，最终落到 `WindowContainer` 的 `mLastSurfacePosition` 和 `mSurfaceSize`：

```java
// Task.java (simplified)
void setBounds(Rect bounds) {
    mBounds.set(bounds);
    // 触发 WindowContainer 的 surface 重排
    onConfigurationChanged(newConfig);
    // 通知 SurfaceControl 更新位置
    getSyncTransaction().setPosition(getSurfaceControl(),
        bounds.left, bounds.top);
}
```

每次 bounds 变更都会触发 `Configuration` 分发到 Activity。和分屏不同的是：分屏的 bounds 由系统计算好，而自由窗口的 bounds 是用户拖拽实时产生的，频率高得多。

### 窗口的 Z-Order 与焦点管理

自由窗口容易被忽略的是 Z-Order（层叠顺序）。用户点击哪个窗口，哪个窗口就提到最顶层。`WindowManagerService` 通过 `DisplayContent#moveTaskToFront()` 处理：

```java
// DisplayContent.java
void moveTaskToFront(Task task) {
    // 调整 Task 在 mChildren 中的位置到最前
    positionChildAt(POSITION_TOP, task, true /* includingParents */);
    // 更新输入焦点
    mFocusedApp = task.topRunningActivity();
    // InputDispatcher 据此分发触摸事件
    mService.mInputManager.setFocusedApplication(...);
}
```

`mChildren` 是 `WindowContainer` 的子节点列表，本质上是一棵有序的窗口树。Z-Order 就是这个树的遍历顺序——越靠后的节点绘制在越上层。

调试时我发现一个细节：窗口缩放期间焦点切换有 50ms 的延迟过滤。如果用户快速拖拽缩放后立刻切换到另一个窗口，`InputDispatcher` 会给前窗口丢一个 `ACTION_CANCEL`，避免误触。这个逻辑藏在 `InputManagerService` 的 `transferTouchGesture` 里，不读源码很难猜到。

## 多实例并行：TaskFragment 的角色

多实例并行指同一个 Activity 可以启动多次，每个实例运行在独立 Task 里。这依赖 Android 12 引入的 **TaskFragment** 机制。

TaskFragment 是 Task 内部的子容器，一个 Task 可以有多个 TaskFragment，每个承载一个 Activity 栈。桌面模式下，`standard` 启动模式会让每个实例创建独立 Task：

```kotlin
// 桌面模式下多实例启动
val intent = Intent(this, DocumentActivity::class.java).apply {
    // FLAG_ACTIVITY_MULTIPLE_TASK 保证新 Task
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK 
        or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
}
startActivity(intent)
```

这里有个坑：`FLAG_ACTIVITY_NEW_TASK` 在非桌面模式下会复用已有 Task（如果 affinity 相同），`FLAG_ACTIVITY_MULTIPLE_TASK` 强制不复用。桌面模式下两个 flag 组合才是安全的。

### 配置变更与状态保存

多实例并行最大的挑战不是启动，是配置变更。窗口缩放会触发 `onConfigurationChanged`，但**不会重建 Activity**——分屏的 bounds 变化可能触发重建，自由窗口则不会，因为框架默认处理了 `configChanges` 的窗口尺寸变更。

如果用户在系统设置里调整了 DPI 或字体大小，多实例的 Activity 全部会收到 `onConfigurationChanged`。此时每个实例的 `Resources` 对象独立更新，互不干扰。

实际项目中，我给每个 DocumentActivity 实例绑定了一个 `ViewModel`，ViewModel 的生命周期跟 Task 绑定而非进程。用户关闭某个窗口时，对应 ViewModel 的 `onCleared()` 正确触发，不会泄漏。

## 输入事件的派发链路

多个自由窗口并存时，触摸事件如何准确落到用户点击的窗口？

`InputDispatcher` 收到触摸事件后，查询 `WindowManagerService` 获取当前焦点的窗口 region。然后根据触摸坐标（`MotionEvent` 的 x/y），从 Z-Order 最高层向下遍历窗口树，找到第一个包含触摸点的窗口：

```cpp
// InputDispatcher 伪代码
sp<InputChannel> findTouchedWindow(int32_t x, int32_t y) {
    // 从顶层向下遍历可触摸窗口
    for (auto& window : mWindows.reverse()) {
        if (!window->canReceiveKeys()) continue;
        if (window->touchableRegionContains(x, y)) {
            return window->getInputChannel();
        }
    }
    return nullptr;
}
```

这个遍历是 O(n) 的，窗口数少时影响不大。但用户开了十几个窗口后，每次触摸的遍历开销就会显现。Android 15 对此做了优化：用 R-Tree 索引窗口触摸区域，查询复杂度降到了 O(log n)。

## 适配中的几个实战问题

**问题一：DecorView 的 insets 处理**

自由窗口有独立的标题栏和阴影边框，由系统的 `DecorCaptionView` 绘制。如果自定义了 WindowInsets 处理逻辑，内容区域可能被标题栏遮挡。

解决办法：在 `onApplyWindowInsets` 里消费掉系统状态栏的 insets，只保留 caption bar 的 insets：

```kotlin
ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
    val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    // 自由窗口下消费系统栏但保留标题栏空间
    if (isFreeformWindow()) {
        rootView.setPadding(0, systemBars.top, 0, 0)
    }
    insets
}
```

**问题二：生命周期时序差异**

桌面模式下，用户通过外接显示器的任务栏关闭窗口时，Activity 的 `finish()` 来自 `DesktopModeTaskBarService`，而非用户直接操作。`onStop()` 和 `onDestroy()` 之间可能有超过 500ms 的延迟——系统会先播放窗口关闭动画再真正销毁。如果日志上报依赖 `onDestroy()` 触发，这个延迟会让上报时机偏移。

我的做法是把关键状态持久化提前到 `onStop()`，`onDestroy()` 只做资源释放。

**问题三：Surface 层级与硬件叠加**

多窗口同时渲染时，SurfaceFlinger 需要管理多个 Layer。窗口数超过硬件叠加层（通常是 4-6 层）限制后，多余的窗口走 GLES 合成，功耗和延迟明显增加。低端平板上开 8 个窗口，帧率肉眼可见地下降。这不是 Bug，是硬件限制，适配时得做好窗口数量的引导或降级策略。

---

桌面模式和自由窗口不是 Android 的"追赶 PC 功能"，而是系统对多 Display 架构的一次底层重构。掌握 `DisplayContent` 分治、`TaskFragment` 承载、`InputDispatcher` 的坐标派发这三条链路，就基本拿下了自由窗口的开发要点。

深度适配桌面模式，建议从三个点入手：规范 WindowInsets 处理、把状态保存提前到 `onStop()`、测试多窗口下的 Surface 合成表现。窗口内分栏、拖拽交换数据那是应用层的锦上添花，先把这三板斧吃透再说。
