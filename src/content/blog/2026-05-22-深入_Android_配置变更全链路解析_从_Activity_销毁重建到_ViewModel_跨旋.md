---
title: 深入 Android 配置变更全链路解析：从 Activity 销毁重建到 ViewModel 跨旋转存活的技术内幕
excerpt: 从 ActivityThread 源码出发，深入解析 Android 配置变更引发的 Activity 销毁重建全链路，揭示 ViewModel 跨旋转存活的 NonConfigurationInstances 保留机制及其与 SavedStateHandle 的本质区别。
publishDate: '2026-05-22'
tags:
- Android
- ViewModel
- 配置变更
- Activity生命周期
- 源码分析
seo:
  title: 深入 Android 配置变更全链路解析：从 Activity 销毁重建到 ViewModel 跨旋转存活的技术内幕
  description: 深入剖析 Android 配置变更的完整链路：从 ActivityThread.handleRelaunchActivity 入口到 NonConfigurationInstances 保留 ViewModel，再到 ViewModel 与 SavedStateHandle 的边界划分，结合实战案例详解技术内幕。
---

做组件化改造时遇到过一个诡异现象：横屏状态下进入某个二级页面，竖屏退出后返回首页，ViewModel 里的数据全丢了。排查一圈发现，不是 ViewModel 的问题，而是我对配置变更（Configuration Change）的重建链路理解有盲区。

这个盲区藏在 ActivityThread 的源码里，一行关键代码串联起了销毁和重建的完整链路。

## 触发：谁决定重建 Activity

`ActivityThread.handleRelaunchActivity` 是整个流程的入口。系统检测到配置变化（旋转、语言切换、深色模式等）后，通过 Binder 调用将 `RELAUNCH_ACTIVITY` 消息投递到主线程：

```java
// ActivityThread.java
public void handleRelaunchActivity(ActivityClientRecord tmp, ...) {
    // 如果 Activity 声明了 android:configChanges，走这里
    if (tmp.activity != null && !tmp.activity.mFinished) {
        handleRelaunchActivityInner(r, configChanges, tmp.pendingResults, ...);
    }
}
```

关键判断在 `handleRelaunchActivityInner` 里：如果该 Activity 在 `AndroidManifest` 中声明了对应的 `configChanges`（如 `orientation|screenSize`），则走 `handleConfigurationChanged` 回调，不重建。否则，进入重建流程——先销毁，再创建。

这是 Android 一直以来的设计逻辑：配置变化时，系统默认你需要重新加载所有资源（布局、图片、字符串），最直接的做法就是从头走一遍生命周期。

## 销毁时的"遗产"保留

重建流程分两步：`handleDestroyActivity` → `handleLaunchActivity`。核心机制藏在销毁阶段的这个方法里：

```java
// ActivityThread.java - performDestroy
NonConfigurationInstances retainNonConfigurationInstances() {
    Object activity = onRetainNonConfigurationInstance();  // ①
    HashMap<String, Object> children = onRetainNonConfigurationChildInstances();
    FragmentManagerNonConfig fragments = mFragments.retainNestedNonConfig();
    // ... 聚集所有需要跨重建保留的对象
    return new NonConfigurationInstances(activity, children, fragments, ...);
}
```

`onRetainNonConfigurationInstance()` 是一个模板方法，Activity 子类可以重写它，返回一个对象。这个对象会被系统保存下来，在新 Activity 创建时原样传回去。

AndroidX 的 `ComponentActivity` 利用这个机制做了关键操作：

```java
// ComponentActivity.java (简化)
public final Object onRetainNonConfigurationInstance() {
    Object custom = onRetainCustomNonConfigurationInstance();
    ViewModelStore viewModelStore = mViewModelStore;  // ②
    if (viewModelStore == null) {
        // 没有 ViewModel 就不需要保留
        return custom;
    }
    return new NonConfigurationInstances(custom, viewModelStore);
}
```

`mViewModelStore` 是一个 `HashMap<String, ViewModel>` 容器，持有当前 Activity 内所有通过 `ViewModelProvider` 创建的 ViewModel 实例。销毁时，这个容器被整体打包进 `NonConfigurationInstances` 对象，存入 `ActivityClientRecord`，等待重建时取用。

`onRetainCustomNonConfigurationInstance()` 是对开发者的扩展点——你可以在 Activity 里重写这个方法返回任意对象，实现自定义的状态保留。

## 新 Activity 如何继承"遗产"

销毁完成后，`handleLaunchActivity` 开始创建新 Activity。在 `performLaunchActivity` 中会调用 `Activity.attach`，传入上一步保留的 `NonConfigurationInstances`：

```java
// Activity.java
final void attach(Context context, ActivityThread aThread, ...,
                  NonConfigurationInstances lastNonConfigurationInstances) {
    // ...
    mLastNonConfigurationInstances = lastNonConfigurationInstances;  // ③
}
```

`mLastNonConfigurationInstances` 被存为 Activity 的成员变量。之后在 `Activity.onCreate` 中，`ViewModelProvider` 构建时通过 `getLastNonConfigurationInstance()` 拿到旧的 `ViewModelStore`：

```java
// ComponentActivity.getViewModelStore()
public ViewModelStore getViewModelStore() {
    if (mViewModelStore == null) {
        NonConfigurationInstances nc =
            (NonConfigurationInstances) getLastNonConfigurationInstance();  // ④
        if (nc != null) {
            mViewModelStore = nc.viewModelStore;  // 直接复用
        }
        if (mViewModelStore == null) {
            mViewModelStore = new ViewModelStore();
        }
    }
    return mViewModelStore;
}
```

如果拿到的 `nc.viewModelStore` 不为空，就直接复用旧的 Store。ViewModel 从头到尾没有被销毁，只是换了一个宿主 Activity。

## ViewModel 与 SavedStateHandle 的边界

很多人把 ViewModel 的存活和 `onSaveInstanceState` 混为一谈。两者是两条完全不同的通道：

- **ViewModel 保留**：依赖 `onRetainNonConfigurationInstance`，数据在内存中，进程被杀后丢失
- **SavedStateHandle**：依赖 `onSaveInstanceState`，序列化到 Bundle，走跨进程持久化

实际项目中踩过一个坑：在 ViewModel 里把 UI 状态都存到了 SavedStateHandle，旋转后发现数据还在，就以为 ViewModel 本身也能抗进程杀死。结果低内存设备杀掉后台进程后，ViewModel 数据全丢——SavedStateHandle 恢复了，但两套数据的同步逻辑没写好，导致 UI 展示不一致。

正确的分工是：ViewModel 存运行时状态（已加载的列表数据、当前选中项），SavedStateHandle 存可序列化的关键状态（编辑框文本、筛选条件）。后者作为前者的兜底，进程重建时 ViewModel 从 SavedStateHandle 重新初始化。

## 自定义配置变更处理

如果不想 Activity 重建，最简单的方法是在 Manifest 声明 `configChanges`：

```xml
<activity android:name=".VideoPlayerActivity"
    android:configChanges="orientation|screenSize|keyboardHidden" />
```

然后重写 `onConfigurationChanged` 自行处理 UI 适配。这种方式的代价是系统不再自动切换资源。如果你依赖 `res/layout-land` 之类的资源限定符，声明后需要手动处理布局切换。

我倾向于另一种方案：利用 ViewModel + 重建机制，把重建当作"免费的状态重置"。旋转后重新 inflate 布局，自动适配横竖屏资源目录，ViewModel 保证数据不丢失。代码量更少，也更贴合框架的设计意图。

Fragment 这里容易出问题：配置变更期间 Fragment 默认也会被销毁重建。如果用 `setRetainInstance(true)`（已废弃）或在 `FragmentFactory` 中做保留逻辑，Fragment 内部状态和 ViewModel 的一致性需要单独保证——保留 Fragment 但重建 View 时，`onDestroyView` 和 `onCreateView` 之间的状态同步是常见 bug 来源。

回到开头那个问题。根因是二级页面声明了 `configChanges="orientation"` 不走重建，而首页没有声明。横屏进二级、竖屏退出后，首页缺少重建触发，没有重新 inflate 资源。ViewModel 中的数据键对了，但视图状态没跟上。修法很简单：统一 `configChanges` 策略，或者在 `onResume` 里手动检查资源状态。
