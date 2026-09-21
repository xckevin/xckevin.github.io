---
title: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析（1）：Context 的设计哲学：不止是\"上下文\""
excerpt: "「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列第 1/2 篇：Context 的设计哲学：不止是\"上下文\""
publishDate: 2026-06-27
displayInBlog: false
series:
  name: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析"
  part: 1
  total: 2
seo:
  title: "深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析（1）：Context 的设计哲学：不止是\"上下文\""
  description: "「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列第 1/2 篇：Context 的设计哲学：不止是\"上下文\""
---


> 本文是「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列的第 1 篇，共 2 篇。

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

---

> 下一篇我们将探讨「资源访问的典型陷阱」，敬请关注本系列。

**「深入 Android Context 上下文全链路：从 ContextImpl 内部实现到三大组件上下文差异的运行时环境解析」系列目录**

1. **Context 的设计哲学：不止是"上下文"**（本文）
2. 资源访问的典型陷阱
