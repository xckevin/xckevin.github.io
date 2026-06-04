---
title: "Android System Services and the Framework Interaction Model"
lang: en
translationKey: android-system-services-framework-interaction
slug: android-system-services-framework-interaction
excerpt: "A deep dive into Android Framework system services, covering SystemServer startup, ServiceManager registration, AMS, WMS, PMS, getSystemService, Binder, and debugging."
publishDate: '2024-05-27'
tags:
- "Android"
- "Framework"
- "System Services"
- "Binder"
seo:
  title: "Android System Services: AMS, WMS, Binder, and Framework Calls"
  description: "Explore how Android Framework code reaches SystemServer services through Binder, ServiceManager, SystemServiceRegistry, AMS, WMS, and PMS."
  pageType: article
---

## Introduction: The Engine That Drives Android

If Binder is the nervous system of Android, then the **system services** running in the SystemServer process are the core engine that keeps the Android world moving. From managing application lifecycles with ActivityManagerService, drawing UI windows with WindowManagerService, parsing and managing application packages with PackageManagerService, controlling device power with PowerManagerService, and handling network connectivity with ConnectivityService, almost every core operating-system capability is implemented through these system services.

Applications and the Android Framework do not directly perform these low-level operations. They request system services through a well-defined interaction model. For an Android expert, knowing how to call `Context.getSystemService()` to obtain a manager object is far from enough. **A deep understanding of SystemServer startup, the internal responsibilities and principles of core system services, how the Framework layer finds and communicates with these services through Binder, and the impact of this model on performance, stability, and security is essential for system-level diagnosis, deep app optimization, understanding OS internals, and making advanced architecture decisions.**

This article explores that core interaction model, focusing on:

- **The birth of SystemServer:** Zygote's role and the SystemServer startup flow.
- **Service registration:** how system services expose interfaces through ServiceManager.
- **Core service analysis, including AMS, WMS, and PMS:** key responsibilities, internal mechanisms, and common problem domains from an expert perspective.
- **The bridge role of `getSystemService`:** the full path for obtaining Framework-layer service proxies and the mechanics of SystemServiceRegistry.
- **Model impact:** performance, stability, security, and debugging considerations.

## 1. Genesis: Zygote and SystemServer Startup

The home of Android system services is the **SystemServer** process. Understanding where it comes from is crucial for understanding the environment in which services run.

### 1. Zygote: the process incubator

- **Role:** Zygote is the parent process for all Android application processes and for the SystemServer process. It is started by `init` and is a key part of Android boot.
- **Core value:**
  - **Fast process creation:** during startup, Zygote preloads core Java classes such as `android.jar` and resources into memory. When a new app process or SystemServer needs to start, Zygote creates a child process through the `fork()` system call. The child inherits a copy of the parent process's memory space. Because Linux uses copy-on-write (COW), most read-only memory, such as class code and resources, can be shared between parent and child processes. This greatly accelerates process startup and saves memory.
  - **Java-world initialization:** Zygote starts an ART/Dalvik VM instance and initializes core libraries. Child processes do not need to repeat this expensive work.
- **Dual Zygote:** modern Android systems usually have two Zygotes: the main Zygote, used to spawn most apps and SystemServer, and the WebView Zygote, used to isolate and spawn WebView renderer processes.

### 2. SystemServer: the headquarters of system services

- **Birth:** the SystemServer process is the first child process forked from Zygote. That means it is born with Zygote's preloaded classes and resources, plus a running ART VM instance.
- **Entry point:** its Java entry point is the `main()` method of `com.android.server.SystemServer`.
- **Key initialization steps:**
  1. **Load native libraries:** load shared libraries that contain native system-service code, such as `libandroid_servers.so`.
  2. **Set up the main-thread Looper:** call `Looper.prepareMainLooper()` to set up the main thread's message loop, which is the foundation for SystemServer event and message handling.
  3. **Initialize SystemServiceManager:** create a `SystemServiceManager` instance, the core class that manages and starts individual system services later.
  4. **Start Bootstrap Services:** `SystemServiceManager` first starts a small group of the most fundamental services. Services started in this phase form the foundation for later service startup and system operation, for example:
     - ActivityManagerService (AMS): manages app processes and component lifecycles.
     - PowerManagerService (PMS): manages device power state.
     - PackageManagerService (PMS, partially initialized): handles package management, with part of its functionality started early.
     - DisplayManagerService: manages display devices.
  5. **Start Core Services:** after bootstrap services are ready, start a set of foundational core services.
  6. **Start Other Services / Third Party Services:** finally start the remaining services, including vendor or customized services. `SystemServiceManager` manages startup order by dependency and boot phase.

### 3. SystemServiceManager: the service lifecycle manager

- **Responsibility:** start and manage the various services inside SystemServer, usually subclasses of `SystemService`, in order and by phase.
- **Core methods:**
  - `startService(Class<T> serviceClass)` / `startService(String className)`: starts the specified service. `SystemServiceManager` creates the service instance and calls its `onStart()` method.
  - `startBootPhase(int phase)`: tells `SystemServiceManager` to enter the next startup phase, such as `PHASE_WAIT_FOR_DEFAULT_DISPLAY`, `PHASE_ACTIVITY_MANAGER_READY`, or `PHASE_BOOT_COMPLETED`. This triggers services registered for that phase to run their `onBootPhase()` callbacks, allowing services to perform specific work at different moments during system boot.
- **Significance:** it ensures service dependencies are satisfied so the system can start in an orderly and stable way.

### 4. The SystemServer thread model

- **Main thread, also called "system_server":** SystemServer core code runs on the main thread. Its Looper handles Binder calls, internal messages, and related work. **Stalls on the SystemServer main thread directly affect the responsiveness of many system functions and can even trigger a full system Watchdog timeout and restart.**
- **Dedicated threads:** to avoid blocking the main thread, many system services put expensive operations or high-priority response work on dedicated threads. Common examples include:
  - `"android.ui"`: commonly used by AMS/WMS for UI-related operations.
  - `"android.display"`: used by DisplayManagerService and related services.
  - `"ActivityManager"`: used internally by AMS.
  - `FgThread`: a general foreground task thread.
  - Binder thread pool: as the provider of many services, SystemServer owns a Binder thread pool for IPC calls from other processes.

**Diagram 4: SystemServer startup and service initialization flow**

```plain
+--------+     fork()    +---------------------+     Loads   +-------------------------+
| Zygote |-------------> |    SystemServer     |-----------> | libandroid_servers.so   |
+--------+               |  (Process)          |             +-------------------------+
                         |                     |
                         | main()              |
                         |  - Looper.prepare() |
                         |  - new SysSvcMgr()  |
                         +---------+-----------+
                                   |
                                   | Uses
                                   V
                         +---------------------+
                         | SystemServiceManager|
                         +---------+-----------+
                                   | startService() / startBootPhase()
                                   V
          +------------------------------------------------------+
          | Boot Phase 1: Bootstrap Services                     |
          | +-----------------+   +-------------------+   +-----+|
          | |      AMS        |-->| PowerManagerService |-->| ... ||
          | +-----------------+   +-------------------+   +-----+|
          +------------------------------------------------------+
                                   | Depends on / waits for
                                   V
          +------------------------------------------------------+
          | Boot Phase 2: Core Services                          |
          | +-----------------+   +-------------------+   +-----+|
          | |      WMS        |-->| PkgManagerService |-->| ... ||
          | | (Full Init)     |   | (Full Init)       |   +-----+|
          | +-----------------+   +-------------------+          |
          +------------------------------------------------------+
                                   |
                                   V
          +------------------------------------------------------+
          | Boot Phase N: Other Services / Boot Completed        |
          | +-----------------+   +-------------------+   +-----+|
          | | NetworkStatsSvc |-->| ConnectivityService |-->| ... ||
          | +-----------------+   +-------------------+   +-----+|
          +------------------------------------------------------+
                                   | System Ready
                                   V
```

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

## 4. The Bridge Between Framework and Service: Full `getSystemService` Path

How do application code and Framework code obtain proxy objects for system services running in the SystemServer process? `Context.getSystemService(String name)` is the standard entry point, and the mechanism behind it is worth a close look.

**Diagram: `getSystemService` flow**

```plain
+--------------------------+      +--------------------------+      +----------------------+      +--------------------+
|      Application /       |      |    ContextImpl           |      | SystemServiceRegistry|      | ServiceManager     |
|      Framework Code      | ---> | getSystemService(name)   | ---> |  .getFetcher(name)   | ---> | .getService(name)  |
+--------------------------+      +-------------+------------+      +----------+-----------+      +----------+---------+
                                                |                         |                           |
                                                | Checks cache            |                           | Binder call
                                                |                         |                           V
                                                |                         |                 +--------------------+
                                                |                         |                 | ServiceManager proc|
                                                |                         |                 |  (Lookup name)     |
                                                |                         |                 +----------+---------+
                                                |                         |                                     | Binder reply (IBinder)
                                                |                         |                                     V
                                                |                         | <----------------------- returns IBinder proxy <----
                                                |                         |
                                                |                         | Fetcher.createService() |
                                                |                         | - Wraps IBinder proxy   |
                                                |                         |   (e.g., Stub.asInterface)|
                                                |                         | - Creates Manager object|
                                                |                         V                         |
                                                | <------------------ returns Manager object --------'
                                                | Caches Manager object   |
                                                V                         |
Returns Manager object <-----------------------'                         |
(e.g., ActivityManager)                                                  |
```

### Detailed call flow

1. **Entry call:** code calls `context.getSystemService(Context.ACTIVITY_SERVICE)`. `context` is usually an instance of `ContextImpl`.
2. **ContextImpl handling:** `ContextImpl.getSystemService(String name)` is invoked.
3. **SystemServiceRegistry appears:** inside `ContextImpl`, work is delegated to the key class `android.app.SystemServiceRegistry`. In its static initializer, `SystemServiceRegistry` pre-registers all known system service names, such as `Context.ACTIVITY_SERVICE`, and the strategy for obtaining each service instance through `registerService()` and a Fetcher.

```java
// SystemServiceRegistry.java, conceptual snippet
registerService(Context.ACTIVITY_SERVICE, ActivityManager.class,
    new CachedServiceFetcher<ActivityManager>() {
        @Override
        public ActivityManager createService(ContextImpl ctx) throws ServiceNotFoundException {
            IBinder b = ServiceManager.getServiceOrThrow(Context.ACTIVITY_SERVICE); // Steps 4 and 5
            IActivityManager am = IActivityManager.Stub.asInterface(b);             // Step 6a
            return new ActivityManager(ctx.getOuterContext(), am);                  // Step 6b
        }});

registerService(Context.WINDOW_SERVICE, WindowManager.class,
    new CachedServiceFetcher<WindowManager>() {
        // ... similar logic using ServiceManager.getService("window") ...
    });
// ... registrations for other services ...
```

4. **Find the Fetcher:** `SystemServiceRegistry.getSystemService(ContextImpl ctx, String name)` finds the corresponding `ServiceFetcher`, usually a `CachedServiceFetcher` or `StaticServiceFetcher`, in its internal registry based on the incoming service name.
5. **Obtain the IBinder proxy:** the core logic of a `ServiceFetcher` is to obtain the service's `IBinder` proxy.
   - It usually calls `android.os.ServiceManager.getService(String name)` or `getServiceOrThrow()`.
   - `ServiceManager.getService()` internally sends a synchronous Binder call to the ServiceManager process, requesting the `IBinder` reference for the service named `name`.
   - The ServiceManager process looks up `name` in its registry. If found, it returns the corresponding `IBinder` reference information to the caller process, either application or Framework, through the Binder driver.
   - `ServiceManager.getService()` returns an `IBinder` proxy object, a `BpBinder`, representing the remote service entity.
6. **Create or wrap the Manager object:** after the `ServiceFetcher` obtains the `IBinder` proxy, it usually performs two steps:
   - **AIDL interface conversion:** call the corresponding AIDL interface's `Stub.asInterface(IBinder binder)` method to convert the raw `IBinder` proxy into a strongly typed AIDL interface proxy, such as `IActivityManager` or `IWindowManager`. This is standard Binder client usage.
   - **Wrap as a Manager:** create an app-facing manager class, such as `android.app.ActivityManager` or `android.view.WindowManager`, and pass the AIDL proxy from the previous step into its constructor. This Manager class provides developer-facing APIs and internally communicates with the system service through the AIDL proxy it holds.
7. **Cache:** `CachedServiceFetcher` caches the Manager object after first creation, usually in an array inside `ContextImpl`. Later calls to `getSystemService(name)` in the same process can return the cached Manager object directly, avoiding repeated ServiceManager lookups and object creation. `StaticServiceFetcher` is used for services that can create a singleton directly at registration time.
8. **Return result:** finally, `getSystemService()` returns the created or cached Manager object to the caller.

**This path clearly shows the complete journey from application-layer API, to low-level Binder communication, to the service entity, and finally back to a wrapped Manager object.**

## 5. Impact and Considerations of the Model

A deep understanding of the interaction model between the Framework and system services is essential for advanced Android engineers because it directly affects the following areas.

### 1. Performance

- **`getSystemService` cost:** the first call involves Binder IPC and has some cost. Later calls hit cache and are very fast. Understanding this helps avoid first-time service acquisition on performance-sensitive paths.
- **Service-call cost:** **every** method call to a system service through a Manager object eventually triggers a Binder transaction. This involves process context switches, data serialization and deserialization through Parcel, Binder driver processing, and related overhead. Pay special attention in high-frequency scenarios, such as repeatedly querying PackageManager inside a loop.
- **System-service bottlenecks:** if a single system service such as AMS or WMS processes slowly or hits lock contention, it can become a system-wide bottleneck and affect every app that depends on it. When analyzing system performance issues such as ANR and jank, you must consider system-service state and time cost, using Systrace or Perfetto to analyze the SystemServer process and Binder transactions.

### 2. Stability

- **SystemServer stability:** SystemServer is a single point of failure. A severe crash in any internal service can restart the SystemServer process and trigger a soft reboot of the device, often seen as a black screen followed by the boot animation. Understanding service dependencies helps locate the root cause of SystemServer crashes.
- **Abnormal service state:** internal state in some services can become incorrect because of bugs or unusual conditions, such as corrupted PMS `packages.xml` or inconsistent WMS window state, causing specific system functions to fail. `dumpsys` is a powerful tool for diagnosing these issues.
- **Client robustness:** although core system services are generally stable, applications can theoretically encounter `DeadObjectException` if SystemServer restarts during a call. Application-layer code should have some tolerance for this.

### 3. Security

- **Core of the permission model:** system services enforce Android's permission model. Apps declare permissions in the Manifest and users grant permissions, but the final enforcement happens when an app calls a system service through Binder. The service checks whether the operation is allowed based on the caller UID/PID and requested action. Understanding this is crucial when designing permission-dependent features and debugging `SecurityException`.
- **Attack surface:** Binder interfaces exposed by system services are potential attack surfaces. Service implementations must strictly validate client input to prevent malicious apps from using service vulnerabilities for privilege escalation or system damage.

### 4. Debugging and analysis

- **dumpsys:** `adb shell dumpsys <service_name>` is the most powerful command for viewing internal system-service state and debugging information. You should be fluent with commands such as `dumpsys activity`, `dumpsys window`, `dumpsys package`, `dumpsys power`, and `dumpsys input`.
- **Logcat:** pay attention to logs emitted by system services, usually under specific TAGs.
- **Systrace/Perfetto:** analyzing Binder interaction time between apps and system services, scheduling of the SystemServer main thread and Binder threads, and lock contention is the strongest approach for performance and ANR analysis.

## 6. Conclusion: Understand the Interaction, Control the System

The interaction model between Android system services and the Framework layer, built through Binder, is the foundation that allows the Android platform to run efficiently and in order. It is not a simple API call. It is a complex mechanism involving process management, IPC communication, service registration and discovery, lifecycle management, and permission control.

For Android experts, moving beyond the surface use of `getSystemService` and deeply understanding SystemServer startup and runtime behavior, the internals of core services such as AMS/WMS/PMS, the role of SystemServiceRegistry and ServiceManager in service acquisition, and the impact of all of this on performance, stability, and security is a key line between senior engineer and expert. This deeper understanding lets you handle complex system behavior, diagnose difficult performance issues or ANRs, and design architectures that interact with lower layers of the system with much more confidence.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Binder internals: from driver communication to the AIDL call chain](/en/blog/android-binder/)
- [Android process and thread model: Zygote, main thread, and Binder thread pools](/en/blog/android-process-thread-model-deep-dive/)
- [Android ContentProvider IPC: URI routing, cross-process access, and permission control](/en/blog/android-contentprovider-ipc/)
- [Android permission system: runtime permissions, interception paths, and security boundaries](/en/blog/android-permission-system-evolution/)
<!-- /seo-internal-links -->
