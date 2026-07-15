---
title: 深入 Android Context 上下文全链路：从 ContextImpl 内部实现到四大组件上下文差异的运行时环境解析
slug: android-context-internals
translationKey: android-context-internals
excerpt: 深入解析 Android Context 内部实现，拆解 Application、Activity、Service 三大组件 Context 在主题、资源加载和窗口管理上的关键差异，提供避免内存泄漏与 BadTokenException 的实践指南。
publishDate: '2026-06-27'
tags:
- Android
- Context
- 源码解析
- 内存管理
- 架构设计
seo:
  title: 深入 Android Context 上下文全链路：从 ContextImpl 内部实现到四大组件上下文差异的运行时环境解析
  description: 深度解析 Android Context 上下文机制：从 ContextImpl 内部实现到 Application、Activity、Service 三大组件的上下文差异，涵盖主题访问、资源加载、窗口管理等核心区别，附实战避坑指南。
---

一个很常见的崩溃：在 Service 里用 `AlertDialog.Builder(context)`，传入的是 `applicationContext`，抛了 `BadTokenException`。换成 `Activity` 的 Context 就正常。反过来，用 `Activity` 的 Context 去持有单例、启动 Service，又埋下内存泄漏的隐患。

这两种情况背后是同一个事实：**同一 App 里，不同组件的 Context 不是同一个东西**。它们共享一套底层机制，但行为上有微妙差异，搞混了就出问题。

## Context 的设计哲学：不止是"上下文"

Context 被翻译为"上下文"，这可能是 Android 框架层命名最精准的一个类。它不负责具体业务逻辑，而是描述"代码当前运行在什么环境里"——系统给了你哪些能力、你能访问哪些资源、你的生命周期边界在哪里。

从设计模式看，Context 是典型的 Facade：把系统服务的调用入口（PackageManager、WindowManager、AlarmManager 等）统一封装在一个抽象类里，上层只跟 Context 打交道，不直接碰 ServiceManager。

```java
// Context 只是抽象接口，真正的实现在 ContextImpl
public abstract class Context {
    public abstract Resources getResources();
    public abstract SharedPreferences getSharedPreferences(String name, int mode);
    public abstract void startActivity(Intent intent);
    // ... 200+ 个方法
}
```

这套设计的收益很明确：**调用方不需要知道自己运行在 Activity 还是 Service 里，都用同一套 API**。代价是差异被藏在了实现层，出问题时排查路径变长。

## ContextImpl 内部：一个委托聚合体

所有 Context 的子类（Activity、Service、Application）最终都委托给 `ContextImpl`。源码里每个 ContextWrapper 的子类都有一个 `mBase` 字段，指向的就是 ContextImpl。

```java
class ContextImpl extends Context {
    final @NonNull ActivityThread mMainThread;
    final @NonNull LoadedApk mPackageInfo;
    private final @NonNull ResourcesManager mResourcesManager;
    private @Nullable Display mDisplay;  // 关键差异点
    // ...
}
```

ContextImpl 把几个核心能力拼在一起：

- **ActivityThread**：主线程消息循环，生命周期事件的中转站
- **LoadedApk**：APK 加载后的运行时信息，包括 ClassLoader、资源路径
- **ResourcesManager**：全局单例，管理所有 Resources 对象的缓存和复用
- **Display**：决定资源从哪个屏幕配置加载

其中 `Display` 是区分不同 Context 类型的关键。Activity 的 ContextImpl 会绑定当前屏幕的 Display，Application 的 ContextImpl 只有一个默认 Display。这也是为什么在非默认屏幕上创建 Dialog，必须使用该屏幕所属 Activity 的 Context。

## 三大组件的 Context 差异拆解

Application、Activity、Service 的 Context 差异，核心问题不是"能不能用"，而是**用了之后行为是否符合预期**。差异主要在三个方面。

### 主题（Theme）访问

Application 的 Context **没有 Theme 配置**，它的 `getTheme()` 返回的是系统默认主题。Activity 的 Context 会从 AndroidManifest 或 `setTheme()` 读取配置。

```kotlin
// 用 Application Context 创建 Dialog —— 崩溃或样式错乱
val dialog = AlertDialog.Builder(applicationContext)
    .setTitle("提示")  // 这里会调用 context.getTheme()
    .create()
```

实际踩过这个坑：推送通知的点击处理里，直接用 `applicationContext` 弹出 Dialog，部分机型直接闪退。正确做法是持有当前栈顶 Activity 的引用，或者在 Application 里维护一个前台 Activity 的弱引用。

### 资源加载（Resources）

`getResources()` 返回的 Resources 对象在同一 App 里也可能不同。Android 为每个 Context 维护独立的 Resources，有两个原因：

1. **屏幕密度适配**：不同 Display 可能对应不同 density，Resources 需要匹配
2. **Configuration 变更**：Activity 重建时 Resources 会随新 Configuration 更新，Application 的 Resources 保持稳定

```java
// ContextImpl 中的 getResources 逻辑（简化）
Resources getResources() {
    if (mResources != null) return mResources;
    // 关键：根据 Display 和 Configuration 决定用哪份 Resources
    mResources = mResourcesManager.getResources(
        this, mPackageInfo.getResDir(), mDisplay, ...);
    return mResources;
}
```

如果在 Activity 销毁重建期间用 ApplicationContext 的 `getResources()` 获取字符串或尺寸，拿到的仍是旧配置。通常影响不大，但多窗口、分屏场景下会暴露问题——Display 变了 ApplicationContext 的 Resources 没跟着变。

### 窗口管理（Window）

只有 Activity 的 Context 能创建 Dialog 和操作 Window。Dialog 本质是一个悬浮在 Activity Window 之上的子 Window，需要父 Window 的 Token。

```java
// Dialog 构造中的上下文校验
Dialog(@NonNull Context context, ...) {
    // 只对 Activity Context 做类型转换
    mWindowManager = (WindowManager) context.getSystemService(WINDOW_SERVICE);
    final Window w = new PhoneWindow(mContext);
    w.setWindowManager(mWindowManager, null, null);
}
```

Service 和 Application 的 Context 没有 Window Token，`BadTokenException` 是必然的。做屏幕适配时还发现一个细节：即使你用 Activity 创建 Dialog，如果 Activity 已经 finish，Token 失效了，一样崩溃。要注意生命周期窗口。

## 资源访问的典型陷阱

### 陷阱一：多密度屏幕下的 Drawable 加载

同一张图片在不同 density 的屏幕之间传递时容易出问题。比如用 Activity A（density=2.0）的 Context 加载 Bitmap，传递给 Activity B（density=1.5，不同 Display），直接显示会出现缩放异常。

```kotlin
// 错误：用当前 Context 的 Resources 加载，密度绑定在当前 Display
val drawable = ContextCompat.getDrawable(context, R.drawable.icon)

// 正确：跨 Display 时，用目标 Context 重新加载
val targetDrawable = ContextCompat.getDrawable(targetContext, R.drawable.icon)
```

解决方案不是"不用 Context 加载"，而是**让 Drawable 的加载 Context 和显示 Context 保持一致**。或者用 `BitmapFactory` 配合 `Options(inDensity, inTargetDensity)` 手动控制。

### 陷阱二：getExternalFilesDir 的空指针

在一个文件管理模块中遇到过诡异的 crash：同一段代码，在 Activity 里调用 `getExternalFilesDir(null)` 正常，在 Service 里调用返回 null。

追源码发现，Service 的 ContextImpl 里 `mDisplay` 在某些情况下为 null，导致 `getExternalFilesDirs()` 内部获取存储卷时抛出 NPE。Android 8.0 之后修复了一部分，但自定义 ROM 上仍有复现。

教训是：**涉及文件路径的 Context 方法，尽量在 Application 的 Context 上调用**，它是生命周期最长、状态最稳定的 Context 实例。

### 陷阱三：内存泄漏的两难

```kotlin
// 这个单例持有 Activity Context → 泄漏
object ToastManager {
    var context: Context? = null  // 如果传入 Activity...
}

// 改用 Application Context → 安全但功能受限
object ToastManager {
    val context: Context = MyApp.instance  // 安全，但不能创建 Dialog
}
```

这里的取舍很明确：**长生命周期对象持有 ApplicationContext，临时 UI 操作持有 ActivityContext**。一个实用技巧是在 BaseActivity 的 `onCreate` 里把自身赋值给 Application 的 `currentActivity` 弱引用字段，需要时判断是否存活再使用。

## Context 的创建链路

理解 Context 的创建过程，能更好地把握它的生命周期边界。以 Activity 为例：

```
ActivityThread.handleLaunchActivity()
  → performLaunchActivity()
    → createBaseContextForActivity()  // 创建 ContextImpl，绑定 Display
    → Activity.attach(context, ...)   // 注入 mBase
    → Activity.onCreate()
```

Service 的创建链路类似，但 `createBaseContextForService` 不会绑定 Display：

```java
// ActivityThread 中的关键差异
private ContextImpl createBaseContextForActivity(ActivityClientRecord r) {
    ContextImpl appContext = ContextImpl.createActivityContext(
        this, r.packageInfo, r.activityInfo, r.token, displayId, ...);
    return appContext;
}

private ContextImpl createBaseContextForService(...) {
    // 不传 displayId，mDisplay 保持 null
    ContextImpl appContext = ContextImpl.createAppContext(this, packageInfo);
    return appContext;
}
```

Application 的 Context 创建最早，在 `handleBindApplication` 阶段完成，之后贯穿整个进程生命周期。**ApplicationContext 是全局唯一的，Activity 和 Service 的 Context 是局部创建的**，但它们共享同一个 LoadedApk 实例。

## 实践建议

做了多年 Android 开发，对 Context 的使用沉淀了几条固定做法。

**默认传入 ApplicationContext，除非明确需要 UI 能力。** 绝大多数系统服务（PackageManager、NotificationManager、ConnectivityManager）不依赖 Context 类型，用 ApplicationContext 能避免 90% 的内存泄漏。写工具类时，构造参数直接声明接收 Application 而非 Context，在编译期就切断传入 Activity 的可能。

**涉及 Resources 的操作，上下文保持一致。** 加载 Drawable、读取 strings.xml、获取 dimens，用谁显示就用谁的 Context 加载。一个反例：RecyclerView 的 ViewHolder 里用 ApplicationContext 加载颜色值，夜间模式切换时颜色不更新——因为 ApplicationContext 的 Resources 不响应 Configuration 变更。

**理解 Context 的"能力衰减"模型。** Application → Service → ContentProvider → BroadcastReceiver 的 Context 能力是递减的。Application 最完整但无 UI，BroadcastReceiver 的 Context 是 `ReceiverRestrictedContext`，连 `registerReceiver` 都不能调。知道每个组件的 Context 上限，设计 API 时才能画出更准确的边界。
