---
title: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析（2）：资源访问的典型陷阱"
excerpt: "「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列第 2/2 篇：资源访问的典型陷阱"
publishDate: 2026-06-27
displayInBlog: false
series:
  name: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析"
  part: 2
  total: 2
seo:
  title: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析（2）：资源访问的典型陷阱"
  description: "「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列第 2/2 篇：资源访问的典型陷阱"
---


> 本文是「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列的第 2 篇，共 2 篇。在上一篇中，我们探讨了「Context 的设计哲学：不止是"上下文"」的相关内容。

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

追源码发现，`getExternalFilesDirs()` 内部需要通过 `StorageManager` 查询外部存储卷的挂载状态，如果外部存储此时未挂载、或者调用发生在进程启动早期 `StorageManager` 尚未就绪，就会返回 null（而不是崩溃）。这跟 Context 是 Activity 还是 Service 无关，本质是存储卷状态或系统服务初始化时序的问题——如果代码没有对返回值做空判断就直接使用，才会引发后续的 NPE。Android 各版本对这块逻辑做过多次调整，但空值判断始终是调用方必须自己处理的。

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

> 补充一点容易搞混的细节：`ApplicationContext` 的 `Resources` 并不是完全静止不变的。系统级的配置变化（比如切换语言、系统夜间模式、屏幕旋转）会通过 `ResourcesManager` 统一更新所有已创建的 `Resources` 实例，Application 的 `Resources` 同样会跟着刷新。真正不会同步的，是 Activity 级别的**局部配置覆盖**——比如分屏、多窗口场景下某个 Activity 单独应用的 `overrideConfiguration`，这类局部覆盖只作用于该 Activity 自己的 Context，不会传播到 ApplicationContext。

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

**涉及 Resources 的操作，上下文保持一致。** 加载 Drawable、读取 strings.xml、获取 dimens，用谁显示就用谁的 Context 加载。一个反例：Activity 分屏或应用了局部 `overrideConfiguration` 时，用 ApplicationContext 加载的颜色值不会跟着该 Activity 的局部配置变化——因为局部覆盖只作用于对应 Activity 自己的 Context，不会传播到 ApplicationContext。

**理解 Context 的"能力衰减"模型。** Application → Service → ContentProvider → BroadcastReceiver 的 Context 能力是递减的。Application 最完整但无 UI，BroadcastReceiver 收到的 Context 是 `ReceiverRestrictedContext`，它并不是完全禁止 `registerReceiver`：如果传入的 `receiver` 参数为 `null`（只是为了取当前的 sticky broadcast），调用是被允许的；但一旦传入真正的 `BroadcastReceiver` 实例去注册监听，就会直接抛出 `ReceiverCallNotAllowedException`，`bindService` 同理也会被拒绝。知道每个组件的 Context 上限，设计 API 时才能画出更准确的边界。

---

**「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列目录**

1. Context 的设计哲学：不止是"上下文"
2. **资源访问的典型陷阱**（本文）
