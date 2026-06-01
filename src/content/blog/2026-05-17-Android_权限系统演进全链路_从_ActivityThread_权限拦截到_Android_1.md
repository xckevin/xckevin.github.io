---
title: Android 权限系统演进全链路：从 ActivityThread 权限拦截到 Android 14 精细化管控的架构解析
excerpt: 深入解析 Android 权限三层拦截机制，梳理 Android 10 到 14 的权限管控演进与工程适配建议。
publishDate: '2026-05-17'
tags:
- Android
- 权限管理
- AppOps
- Android 14
- 架构解析
seo:
  title: "Android 权限系统原理：运行时权限、拦截链路与安全边界"
  description: "梳理 Android 权限系统从 Framework 拦截到运行时授权的完整链路，覆盖权限校验、兼容策略与安全工程实践。"
---

一个项目里踩过的坑：`ContextCompat.checkSelfPermission()` 返回 `GRANTED`，相机调用仍然崩，日志里躺着 `SecurityException`。同一台设备上另一个 App 却一切正常。

原因很简单：权限检查不止 `checkSelfPermission` 一条路。

## 三层拦截：一次权限检查要过的关卡

Android 的权限检查是三层递进式拦截。只查上层，底层照样能把你拦住。

**第一层：Context.checkSelfPermission**

最常用的 API。`ContextImpl` 中实现，直接查 `PackageManager` 里记录的授权状态。这层只看 AndroidManifest 声明的权限有没有被用户授予，不关心 AppOps。

```java
// ContextImpl.java
public int checkPermission(String permission, int pid, int uid) {
    return ActivityManager.getService().checkPermission(permission, pid, uid);
}
```

**第二层：ActivityThread 拦截**

应用调用受权限保护的 API 时，Binder 请求到达系统进程后，`ActivityManagerService` 做权限检查。这一步除了查询 PMS，还会过 AppOps 层。

**第三层：AppOpsService**

Android 4.3 引入的权限管控扩展层。它不改变授权状态，但能实时控制某个应用能否执行特定操作。权限在 PMS 层面显示"已授权"，AppOps 层面却可以是"拒绝"。

我那台设备上的问题就出在这里：另一个 App 通过 AppOps 管理器关掉了相机操作，PMS 层依然显示授权。所以 `checkSelfPermission` 查 PMS 拿到 `GRANTED`，实际调用时 AppOps 拒绝，直接抛 `SecurityException`。

## Runtime Permission 的全链路

`requestPermissions()` 到 `onRequestPermissionsResult()` 的调用链比看起来长不少。

`Activity.requestPermissions()` → `ActivityThread.getPackageManager()` → `PackageManagerService.grantRuntimePermission()` → 系统弹窗 → 用户操作 → `ActivityThread.handleRequestPermissionsResult()`

核心节点在弹窗阶段。`GrantPermissionsActivity` 展示权限请求 UI，用户点"允许"后才真正写入 PMS 数据库。有个容易被漏掉的点：

```java
// PermissionManagerService.java - grantRuntimePermission 的简化逻辑
if (AppOpsManager.noteOp(appOpCode, uid, packageName) != MODE_ALLOWED) {
    // AppOps 层面拒绝，但 PMS 仍可能标记为 GRANTED
    // 导致 checkSelfPermission 返回 GRANTED，实际调用却失败
}
```

**`PermissionChecker` 的价值**：`androidx.core.content.PermissionChecker` 比 `ContextCompat.checkSelfPermission` 多做了一件事——同时检查 AppOps。代码里换成 `PermissionChecker.checkSelfPermission()`，上面那个 bug 就不会出现。

```kotlin
// ✓ 同时查 PMS 和 AppOps
PermissionChecker.checkSelfPermission(context, Manifest.permission.CAMERA)

// ✗ 只查 PMS，有遗漏风险
ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
```

## Android 10 到 14：逐步收紧的权限管控

**Android 10 — 分区存储（Scoped Storage）**

媒体文件读写不再需要 `READ_EXTERNAL_STORAGE`，改用 `MediaStore` API。如果 App 强依赖文件路径访问，`requestLegacyExternalStorage` 标志只在 Android 10 有效，11 开始彻底失效。

**Android 11 — 一次性权限 + 权限自动重置**

用户可选"仅本次允许"。应用进程被杀后权限自动撤销。这意味着每次冷启动都要重新检查权限状态，授权结果不能缓存。

**Android 12 — 精确位置 vs 模糊位置**

定位权限拆成 `ACCESS_FINE_LOCATION` 和 `ACCESS_COARSE_LOCATION`。用户在授权弹窗中选"精确"或"模糊"，两者互斥——选了模糊后想切精确，得去设置页改。

```kotlin
// 12+ 必须同时请求两个权限
val permissions = arrayOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION
)
// 用户选择"模糊"时，FINE_LOCATION 不会授予
```

**Android 13 — 通知权限进入运行时申请**

`POST_NOTIFICATIONS` 从默认授予变为运行时权限。targetSdk 升到 33 后，不请求通知权限连 NotificationChannel 都创建不了。

**Android 14 — 照片/视频部分访问**

用户可选"选择照片"或"选择视频"，App 只能访问选中的那部分媒体。`READ_MEDIA_IMAGES` 和 `READ_MEDIA_VIDEO` 需要分开请求。Android 14 还禁止安装 targetSdkVersion 低于 23 的应用，等于强行要求适配 Runtime Permission。

## 工程适配建议

**用 `PermissionChecker` 替代 `ContextCompat.checkSelfPermission`**。改一行 import，换来 AppOps 层检查能力，成本最低。

**封装权限请求状态机**。别在每个 Activity 里散落 `requestPermissions` 调用。用单例管理请求队列，处理"弹窗过程中又发起新请求"的并发场景。我目前用 `MutableStateFlow<Map<String, PermissionState>>`，请求前先查状态避免重复弹窗。

**测试覆盖不同授权组合**。Android 14 的精细化权限让组合数量暴涨——位置有精确/模糊/拒绝 3 种，照片有全部/部分/拒绝 3 种。手动点弹窗测不过来，用 `adb` 直接构造场景：

```bash
# 构造 AppOps 层拒绝但 PMS 层授权的场景
adb shell pm grant com.example android.permission.CAMERA
adb shell appops set com.example CAMERA deny
```

权限系统从 6.0 的一刀切到 14 的精细化管控，趋势是让用户掌握更细粒度的控制权。适配的核心不是追着新 API 改代码，而是理解三层检查的判断逻辑——别被 PMS 层的 `GRANTED` 骗了，AppOps 才是真正说了算的那个。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：Android Framework](/android-framework/)
- [Android Binder 原理：从驱动通信到 AIDL 调用链路](/blog/binder-ipc机制深度解析-beyond-aidl/)/)
- [Android Framework 系统服务：AMS、WMS 与应用进程交互模型](/blog/android系统服务与framework层交互模型/)
- [Android 进程与线程模型：Zygote、主线程、Binder 线程池解析](/blog/android进程与线程模型深度剖析/)
- [Android ContentProvider 原理：URI 路由、跨进程访问与权限控制](/blog/2026-05-15-深入_android_contentprovider_跨进程数据共享_从_uri_路由到_conte/)
<!-- /seo-internal-links -->
