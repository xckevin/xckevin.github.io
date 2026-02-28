---
title: "Android 系统服务与 Framework 层交互模型（2）：服务注册：让世界发现我——ServiceManager"
excerpt: "「Android 系统服务与 Framework 层交互模型」系列第 2/3 篇：服务注册：让世界发现我——ServiceManager"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Framework
  - 系统服务
  - Binder
series:
  name: "Android 系统服务与 Framework 层交互模型"
  part: 2
  total: 3
seo:
  title: "Android 系统服务与 Framework 层交互模型（2）：服务注册：让世界发现我——ServiceManager"
  description: "「Android 系统服务与 Framework 层交互模型」系列第 2/3 篇：服务注册：让世界发现我——ServiceManager"
---
# Android 系统服务与 Framework 层交互模型（2）：服务注册：让世界发现我——ServiceManager

> 本文是「Android 系统服务与 Framework 层交互模型」系列的第 2 篇，共 3 篇。在上一篇中，我们探讨了「引言：驱动 Android 世界的引擎」的相关内容。

## 二、服务注册：让世界发现我——ServiceManager

SystemServer 内部启动了众多服务，但这些服务如何被系统其他部分（如应用程序、Framework 代码）找到并使用呢？答案是 **ServiceManager**。

1. **角色重述：** ServiceManager 是 Android 的 Binder 服务注册中心。它本身是一个独立运行的 Native 进程（通常由 init 启动），并持有特殊的 Binder 句柄「0」。
2. **addService(String name, IBinder service)：**
   - 当 SystemServer 中的一个系统服务（如 AMS）初始化完成并准备好对外提供服务时，它会调用 `android.os.ServiceManager.addService()` 方法；
   - 这个方法内部会通过 Binder IPC 调用到 ServiceManager 进程；
   - 参数 `name` 是服务的唯一字符串标识符（如 "activity"、"window"、"package"）；
   - 参数 `service` 是该服务实现的 IBinder 接口（即其 Binder 实体对象，如 AMS 实例）；
   - ServiceManager 进程收到请求后，会在其内部维护的一个映射表（通常是 svcinfo 列表）中添加一条记录，将服务名称 `name` 与其对应的 IBinder 引用信息关联起来；
   - **示例：** `ServiceManager.addService(Context.ACTIVITY_SERVICE, activityManagerServiceInstance)`；
3. **权限控制：** 向 ServiceManager 注册服务通常需要特定的系统级权限（如 `android.permission.REGISTER_SYSTEM_SERVICE`），防止恶意应用注册伪造的系统服务；
4. **生命周期：** 注册到 ServiceManager 的服务实例通常与 SystemServer 进程的生命周期绑定，即 SystemServer 存活，服务就存活。

## 三、核心系统服务剖析

理解几个最核心的系统服务的工作原理和内部机制至关重要。

### 1. ActivityManagerService（AMS）——「应用程序与组件的总调度师」

- **核心职责精要：**
  - **进程管理：** 负责应用程序进程的启动（通过请求 Zygote fork）、生命周期管理、优先级调度（计算和设置 oom_adj 值，影响进程被杀顺序）、进程状态（前台、可见、服务、缓存等）维护；
  - **Activity 管理：** 管理 Activity 的生命周期状态转换、任务栈（Task Stack）和返回栈（Back Stack）、处理 Intent 启动请求（startActivity）、解析 launchMode 和 taskAffinity、协调转场动画（与 WMS 配合）；
  - **Service 管理：** 管理 startService 启动的服务的生命周期、bindService 绑定服务的连接管理；
  - **Broadcast 管理：** 接收 sendBroadcast 请求，根据 IntentFilter 查找匹配的 Receiver，并按顺序（有序广播）或并行（无序广播）分发广播；
  - **ContentProvider 管理：** 协调 ContentProvider 的启动和进程共享；
  - **权限检查：** 在处理来自应用的 IPC 请求时（如 startActivity、bindService），执行关键的权限检查（常与 PMS 协作获取权限信息）；
- **关键内部概念：**
  - ActivityStackSupervisor：管理所有的 Activity 栈；
  - ActivityStack：代表一个任务栈，包含多个 TaskRecord；
  - TaskRecord：代表一个任务（一组相关的 Activity）；
  - ActivityRecord：代表一个 Activity 实例及其状态；
  - ProcessRecord：代表一个运行中的应用程序进程及其状态（包含运行的组件、内存使用情况、优先级等）；
  - BroadcastQueue：管理广播的分发队列；
- **常见问题域：**
  - **ANR：** 应用主线程阻塞导致无法响应 AMS 的生命周期调用、广播处理超时；或者 AMS 本身处理缓慢（如广播风暴、锁竞争）导致无法及时响应应用请求；
  - **进程被杀：** OOM Killer 根据 AMS 计算的 oom_adj 值决定杀进程的顺序。理解 adj 值的计算规则有助于分析应用保活和后台行为；
  - **启动模式异常：** launchMode 和 taskAffinity 的复杂组合导致 Activity 栈行为不符合预期；
  - **广播丢失/延迟：** 广播队列处理瓶颈，或静态广播在应用被强制停止后无法接收。

### 2. WindowManagerService（WMS）——「窗口与显示的绘制协调者」

- **核心职责精要：**
  - **窗口管理：** 维护系统中所有窗口（Window）的状态和层级关系（WindowState）。处理应用通过 `WindowManager.addView()` 添加窗口、`removeView()` 移除窗口的请求。计算窗口的大小、位置和可见性；
  - **Surface 管理：** 为每个可见窗口向 **SurfaceFlinger**（Android 的图形混合器，运行在独立进程）请求分配图形缓冲区（Surface）。应用绘制的内容最终会提交到这个 Surface；
  - **输入事件中转：** 接收来自 InputManagerService（IMS）的原始输入事件，根据窗口焦点和布局信息，将事件派发给目标窗口；
  - **屏幕管理：** 处理屏幕旋转、壁纸管理、锁屏窗口、系统 UI（状态栏、导航栏）的布局和显示；
  - **动画协调：** 管理窗口动画（启动、退出、切换）和屏幕内容过渡动画，与 SurfaceFlinger 协作实现；
- **关键内部概念：**
  - DisplayContent：代表一个物理或虚拟显示屏及其上的窗口；
  - WindowToken / AppWindowToken：用于将属于同一个应用组件（如 Activity）的多个窗口（如主窗口、对话框窗口）组织在一起的令牌；
  - WindowState：代表一个具体的窗口及其属性（大小、位置、层级、可见性、SurfaceControl 等）；
  - WindowManagerPolicy（PhoneWindowManager 实现）：定义窗口管理的核心策略，如系统 UI 布局、按键处理、屏幕方向决策等；
- **常见问题域：**
  - **Window Leaked：** Activity 或 Service 销毁时未能正确移除其添加的窗口（`WindowManager.removeView`）导致内存泄漏和视觉残留；
  - **UI 卡顿/Jank：** 窗口布局计算复杂或耗时；窗口动画与应用绘制冲突；输入事件派发延迟；
  - **触摸事件异常：** 窗口层级或 FLAG 设置不当导致触摸事件被拦截或无法到达目标视图；
  - **悬浮窗权限与显示问题：** 应用添加悬浮窗（TYPE_APPLICATION_OVERLAY）需要特殊权限，且可能与其他窗口冲突。

### 3. PackageManagerService（PMS）——「应用程序世界的户籍警」

- **核心职责精要：**
  - **包管理：** 负责 APK 的扫描、解析（AndroidManifest.xml）、安装、更新、卸载。维护系统中所有已安装应用的信息；
  - **信息数据库：** 将解析到的包信息（组件、权限、签名等）持久化存储在 `/data/system/` 目录下的核心文件（如 packages.xml、packages.list）中。应用通过 PackageManager API 查询到的信息最终来源于此；
  - **权限管理：** 解析 Manifest 中声明的权限（`<uses-permission>`、`<permission>`）；管理权限的授予状态（安装时、运行时）；提供权限检查接口给 AMS 等服务使用；
  - **Intent 解析：** 根据 Intent（特别是 Action、Category、Data）和已安装应用的 IntentFilter 信息，查找能够响应该 Intent 的组件（Activity、Service、Receiver）；
  - **签名校验：** 在安装或更新应用时，验证 APK 签名的一致性，保障应用来源的可靠性和数据安全（sharedUserId 依赖签名一致）；
- **关键内部概念：**
  - PackageParser（现在是 PackageParsing 相关类）：负责解析 APK 文件和 Manifest；
  - PackageSetting / PackageUserState：存储每个包的安装状态、权限状态、启用/禁用状态等信息，区分用户；
  - Computer（内部类）：负责计算和缓存包信息，优化查询性能；
  - InstallPackageHelper、DeletePackageHelper：处理安装和卸载的具体流程；
  - 与 installd 守护进程的交互：PMS 本身不直接执行文件操作和 dex 优化，而是通过 Socket 与以 root 权限运行的 installd 进程通信来完成这些敏感操作；
- **常见问题域：**
  - **应用安装失败：** 签名冲突、存储空间不足、解析错误、权限问题；
  - **启动缓慢：** 系统启动时 PMS 需要扫描所有应用包，如果应用数量多或解析耗时，会拖慢首次启动速度（Android P 之后有优化）；
  - **权限问题：** targetSdkVersion 变化导致的运行时权限行为变更；权限状态不一致；
  - **Intent 无法解析：** IntentFilter 编写错误或不匹配；应用被禁用或未安装。

### 4. 其他关键服务（掠影）

- **PowerManagerService（PMS）：** 管理 WakeLock、Doze 模式、屏幕亮度等，对应用后台行为和功耗影响巨大；
- **SurfaceFlinger（SF）：**（独立进程）负责将所有窗口的 Surface 内容进行混合，并通过 Hardware Composer（HWC）或 OpenGL 渲染到最终的显示屏。WMS 是其主要客户；
- **InputManagerService（IMS）：** 读取输入设备事件，进行初步处理，然后分发给 WMS；
- **ConnectivityService：** 管理网络连接（Wi-Fi、移动数据）；
- **NotificationManagerService：** 管理状态栏通知；
- **LocationManagerService：** 管理定位服务。

重要的是理解这种**面向特定领域、由专门服务负责并通过 Binder 暴露接口**的设计模式。

---

> 下一篇我们将探讨「Framework 与 Service 的桥梁：getSystemService 全链路解析」，敬请关注本系列。

**「Android 系统服务与 Framework 层交互模型」系列目录**

1. 引言：驱动 Android 世界的引擎
2. **服务注册：让世界发现我——ServiceManager**（本文）
3. Framework 与 Service 的桥梁：getSystemService 全链路解析
