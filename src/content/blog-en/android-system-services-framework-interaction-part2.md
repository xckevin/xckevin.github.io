---
title: "Android System Services and the Framework Interaction Model (2): ServiceManager"
lang: en
translationKey: android-system-services-framework-interaction-part2
slug: android-system-services-framework-interaction-part2
excerpt: "Part 2 of the Android system services series: ServiceManager registration plus the responsibilities and failure modes of AMS, WMS, and PMS."
publishDate: '2024-05-27'
displayInBlog: false
tags:
- "Android"
- "Framework"
- "System Services"
- "Binder"
series:
  name: "Android System Services and the Framework Interaction Model"
  part: 2
  total: 3
seo:
  title: "Android ServiceManager, AMS, WMS, and PMS Explained"
  description: "Understand how Android services register with ServiceManager and how AMS, WMS, PMS, and other core services expose system capabilities."
  pageType: article
---

> This is part 2 of the three-part series "Android System Services and the Framework Interaction Model." In the previous article, we looked at "Introduction: the engine that drives Android."

## 2. Service Registration: Letting the World Discover Me, ServiceManager

SystemServer starts many services internally, but how do other parts of the system, such as applications and Framework code, find and use them? The answer is **ServiceManager**.

1. **Role recap:** ServiceManager is Android's Binder service registry. It is itself a separate native process, usually started by `init`, and it owns the special Binder handle `0`.
2. **`addService(String name, IBinder service)`:**
   - When a system service inside SystemServer, such as AMS, finishes initialization and is ready to expose service externally, it calls `android.os.ServiceManager.addService()`.
   - Internally, this method uses Binder IPC to call into the ServiceManager process.
   - The `name` parameter is the service's unique string identifier, such as `"activity"`, `"window"`, or `"package"`.
   - The `service` parameter is the service's implemented `IBinder` interface, meaning its Binder entity object, such as the AMS instance.
   - After ServiceManager receives the request, it adds a record to its internal mapping, usually a `svcinfo` list, associating the service name `name` with its corresponding `IBinder` reference information.
   - **Example:** `ServiceManager.addService(Context.ACTIVITY_SERVICE, activityManagerServiceInstance)`.
3. **Permission control:** registering a service with ServiceManager usually requires specific system-level permissions, such as `android.permission.REGISTER_SYSTEM_SERVICE`, to prevent malicious apps from registering fake system services.
4. **Lifecycle:** a service instance registered with ServiceManager is usually tied to the lifecycle of the SystemServer process. If SystemServer is alive, the service is alive.

## 3. Core System Services

Understanding the operating principles and internal mechanisms of several core system services is essential.

### 1. ActivityManagerService (AMS): the dispatcher for applications and components

- **Core responsibilities:**
  - **Process management:** starts application processes by requesting Zygote fork, manages process lifecycles, handles priority scheduling by calculating and setting `oom_adj` values that affect kill order, and maintains process states such as foreground, visible, service, and cached.
  - **Activity management:** manages Activity lifecycle state transitions, task stacks and back stacks, handles `Intent` launch requests such as `startActivity`, resolves `launchMode` and `taskAffinity`, and coordinates transition animation with WMS.
  - **Service management:** manages the lifecycle of services started by `startService` and the connection management of services bound through `bindService`.
  - **Broadcast management:** receives `sendBroadcast` requests, finds matching receivers through `IntentFilter`, and dispatches broadcasts sequentially for ordered broadcasts or in parallel for unordered broadcasts.
  - **ContentProvider management:** coordinates ContentProvider startup and process sharing.
  - **Permission checks:** performs critical permission checks while handling IPC requests from apps, such as `startActivity` and `bindService`, often collaborating with PMS to obtain permission information.
- **Key internal concepts:**
  - `ActivityStackSupervisor`: manages all Activity stacks.
  - `ActivityStack`: represents a task stack and contains multiple `TaskRecord` objects.
  - `TaskRecord`: represents a task, meaning a group of related Activities.
  - `ActivityRecord`: represents an Activity instance and its state.
  - `ProcessRecord`: represents a running application process and its state, including running components, memory usage, and priority.
  - `BroadcastQueue`: manages broadcast dispatch queues.
- **Common problem domains:**
  - **ANR:** the app main thread may block and fail to respond to AMS lifecycle calls or broadcast handling timeouts. AMS itself may also process slowly, for example because of broadcast storms or lock contention, and fail to respond to app requests in time.
  - **Process kills:** OOM Killer uses the `oom_adj` values calculated by AMS to determine process kill order. Understanding `adj` calculation helps analyze process keep-alive and background behavior.
  - **Abnormal launch modes:** complex combinations of `launchMode` and `taskAffinity` can produce unexpected Activity stack behavior.
  - **Lost or delayed broadcasts:** broadcast queues can bottleneck, or static broadcasts may not be received after an app is force-stopped.

### 2. WindowManagerService (WMS): the coordinator for windows and display rendering

- **Core responsibilities:**
  - **Window management:** maintains the state and hierarchy of all windows in the system through `WindowState`. It handles app requests to add windows through `WindowManager.addView()` and remove windows through `removeView()`, and calculates each window's size, position, and visibility.
  - **Surface management:** requests graphics buffers, or Surfaces, from **SurfaceFlinger**, Android's graphics compositor running in a separate process, for every visible window. App drawing is eventually submitted to this Surface.
  - **Input-event routing:** receives raw input events from InputManagerService (IMS) and dispatches them to the target window based on window focus and layout information.
  - **Screen management:** handles screen rotation, wallpaper, lock-screen windows, and the layout and display of system UI such as the status bar and navigation bar.
  - **Animation coordination:** manages window animations, including launch, exit, switch, and screen-content transition animations, and collaborates with SurfaceFlinger to implement them.
- **Key internal concepts:**
  - `DisplayContent`: represents a physical or virtual display and the windows on it.
  - `WindowToken` / `AppWindowToken`: tokens used to group multiple windows belonging to the same app component, such as an Activity's main window and dialog windows.
  - `WindowState`: represents a concrete window and its properties, including size, position, layer, visibility, and `SurfaceControl`.
  - `WindowManagerPolicy`, implemented by `PhoneWindowManager`: defines core window-management policies, such as system UI layout, key handling, and screen-orientation decisions.
- **Common problem domains:**
  - **Window leaked:** an Activity or Service fails to remove a window it added through `WindowManager.removeView` when destroyed, causing memory leaks and visual residue.
  - **UI jank:** window layout calculation may be complex or expensive; window animation may conflict with app drawing; input-event dispatch may be delayed.
  - **Touch-event issues:** incorrect window hierarchy or flag settings may intercept touch events or prevent them from reaching the target View.
  - **Overlay-window permission and display issues:** adding overlay windows with `TYPE_APPLICATION_OVERLAY` requires special permission and may conflict with other windows.

### 3. PackageManagerService (PMS): the registry officer for the app world

- **Core responsibilities:**
  - **Package management:** scans, parses, installs, updates, and uninstalls APKs, including `AndroidManifest.xml`, and maintains information about all installed apps.
  - **Information database:** persists parsed package information, such as components, permissions, and signatures, in core files under `/data/system/`, such as `packages.xml` and `packages.list`. Information returned through the PackageManager API ultimately comes from this database.
  - **Permission management:** parses permissions declared in the Manifest, including `<uses-permission>` and `<permission>`, manages granted permission state at install time and runtime, and provides permission-check interfaces to services such as AMS.
  - **Intent resolution:** finds components, including Activity, Service, and Receiver, that can handle an `Intent` based on its Action, Category, Data, and installed app `IntentFilter` information.
  - **Signature verification:** verifies APK signature consistency during install or update, protecting source reliability and data security. `sharedUserId` depends on matching signatures.
- **Key internal concepts:**
  - `PackageParser`, now represented by PackageParsing-related classes: parses APK files and Manifests.
  - `PackageSetting` / `PackageUserState`: stores per-package installation state, permission state, enabled/disabled state, and user-specific information.
  - `Computer`: an internal class responsible for calculating and caching package information to optimize query performance.
  - `InstallPackageHelper` and `DeletePackageHelper`: handle the concrete install and uninstall flows.
  - Interaction with the `installd` daemon: PMS does not directly perform file operations or dex optimization. It communicates over a Socket with `installd`, which runs with root privileges, to complete these sensitive operations.
- **Common problem domains:**
  - **App install failure:** signature conflicts, insufficient storage, parsing errors, and permission problems.
  - **Slow startup:** during system boot, PMS must scan all app packages. Many apps or expensive parsing can slow first startup, though Android P and later include optimizations.
  - **Permission issues:** runtime permission behavior can change with `targetSdkVersion`, and permission state can become inconsistent.
  - **Intent cannot be resolved:** `IntentFilter` definitions may be wrong or unmatched, or the app may be disabled or not installed.

### 4. Other key services, briefly

- **PowerManagerService (PMS):** manages WakeLocks, Doze mode, screen brightness, and other power behaviors, with major impact on background work and power consumption.
- **SurfaceFlinger (SF):** a separate process that composites all window Surface content and renders it to the final display through Hardware Composer (HWC) or OpenGL. WMS is its main client.
- **InputManagerService (IMS):** reads input-device events, performs initial processing, and dispatches them to WMS.
- **ConnectivityService:** manages network connectivity, including Wi-Fi and mobile data.
- **NotificationManagerService:** manages status-bar notifications.
- **LocationManagerService:** manages location services.

The important point is to understand this design pattern: **each domain has a specialized service responsible for it, and that service exposes an interface through Binder.**

---

> In the next article, we will look at "The bridge between Framework and Service: the full `getSystemService` path."

**"Android System Services and the Framework Interaction Model" series**

1. Introduction: the engine that drives Android
2. **Service registration: letting the world discover me, ServiceManager** (this article)
3. The bridge between Framework and Service: the full `getSystemService` path
