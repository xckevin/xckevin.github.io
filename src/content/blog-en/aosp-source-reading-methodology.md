---
title: "AOSP Source Reading Methodology: From System Service Calls to Native Implementations"
lang: en
translationKey: aosp-source-reading-methodology
slug: aosp-source-reading-methodology
excerpt: "A practical methodology for reading AOSP source code, from Java API entry points and Binder calls to JNI jumps, native data flow, and debugging tools."
publishDate: '2026-02-16'
tags:
- "Android"
- "AOSP"
- "Source Reading"
- "JNI"
- "Native"
seo:
  title: "AOSP Source Reading from System Services to Native Code"
  description: "Trace AOSP code from Framework APIs through Binder, JNI, and native data flow, using dumpsys, AIDEGen, and targeted logging to debug faster."
  pageType: article
---

Three years ago, while debugging SurfaceFlinger composition jank, I followed `performTraversals` for two full days. The root cause ended up being the native-layer Gralloc buffer allocation strategy. After that, I started organizing a systematic way to read AOSP source code: not by brute-force IDE jumping, but by building a traceable path from Java to C++.

## Locating the entry point: from API to Binder call

The first step in reading AOSP source code is finding the right entry point. Do not start from a `main` function.

The Android Framework API layer is mostly a facade. System services do the real work. Take `ActivityManagerService` (AMS) as an example. When app code calls `startActivity`, it follows this path:

```java
// frameworks/base/core/java/android/app/Activity.java
public void startActivity(Intent intent) {
    // Instrumentation is the first relay point.
    Instrumentation.ActivityResult ar = mInstrumentation.execStartActivity(...);
}
```

After `Instrumentation.execStartActivity`, search for `ActivityTaskManager.getService()`. It returns the Binder proxy object for AMS. Two techniques matter here:

1. Search for the `getService()` method to locate where the Framework layer obtains a Binder proxy. This is the bridge from Framework code to the system service.
2. Record the parameter type passed to `Stub.asInterface`. It is generated from AIDL. Searching that class name takes you directly to the `.aidl` file.

```java
// Typical pattern: getService() + IXXX.Stub
IBinder b = ServiceManager.getService("activity_task");
return IActivityTaskManager.Stub.asInterface(b);
```

Once you find the corresponding `.aidl`, the method declarations and parameters are clear. The AIDL file is often clearer than the generated Java interface because it is the source definition, not generated output.

## Locating system service source code

AMS, WMS (`WindowManagerService`), and PKMS (`PackageManagerService`) live under `frameworks/base/services/`. The directory layout keeps you oriented:

```text
frameworks/base/services/
|-- core/java/com/android/server/   # Core service Java source
|   |-- am/                         # ActivityManager related
|   |-- wm/                         # WindowManager related
|   `-- pm/                         # PackageManager related
`-- core/jni/                       # Corresponding JNI layer
```

AMS actually executes `startActivity` in `ActivityStarter.java`. I usually read `execute()` or `executeRequest()` first. The main logic of a system service often converges in an entry method with a clear name.

For example, when debugging ANR, you care about what happens after `InputDispatchingTimedOut`. Searching that string leads to `notifyANR` in `InputManagerService.java`, but the real timeout decision happens in native code inside `InputDispatcher.cpp`.

## Tracing across JNI

The jump from Java to native code is defined by JNI function registration tables. Android uses two registration styles.

**Dynamic registration** is the mainstream approach. `onload.cpp` binds methods through `RegisterNatives`. Search for `RegisterNatives` plus the class name to locate it.

```cpp
// frameworks/base/services/core/jni/com_android_server_input_InputManagerService.cpp
static const JNINativeMethod methods[] = {
    {"nativeInit", "()J", (void*)nativeInit},
    {"nativeStart", "(J)V", (void*)nativeStart},
    // ...
};
```

Here, `nativeInit` is the C++ implementation of the Java method `private native long nativeInit()`. The function pointer in the array points directly to the same-named function in the `.cpp` file. The mapping is deterministic. You do not need to guess.

**Static registration** appears in older code. It follows the `Java_package_class_method` naming convention. Search globally for that function name.

When tracing across layers, write down the JNI function name at the Java native method declaration, then search under `core/jni/`. Do not rely too much on IDE symbol navigation. AOSP is huge, and local indexing often breaks. The command line is usually more reliable than the IDE.

## Native-layer source reading strategy

Once you enter the native layer, the amount of code jumps sharply. `SurfaceFlinger` alone has more than ten thousand lines. My strategy is to **follow data flow instead of control flow**.

For the graphics rendering pipeline, it is more useful to sketch the buffer flow than to read the `SurfaceFlinger.cpp` main loop line by line:

```text
App (dequeueBuffer) -> BufferQueue -> SurfaceFlinger (acquireBuffer) -> HWC (present)
```

Then search by function name. For example, searching `acquireBuffer` hits `BufferQueueProducer.cpp`, `BufferQueueCore.cpp`, and `SurfaceFlinger.cpp` at the same time. The call chain starts to connect naturally.

```bash
# Search by function name from the AOSP root. This is faster than IDE navigation.
grep -rn "acquireBuffer" frameworks/native/ --include="*.cpp"
```

At the native layer, you also need to understand HAL interfaces. HAL `.hal` files live under `hardware/interfaces/` and define the contract between client and server. `IXXX.hal` is the interface definition. The generated C++ code lives under `out/`.

## Three debugging tools

Reading source code eventually needs debugging and verification. I pick from three tools depending on the scenario.

**dumpsys** is the fastest state confirmation tool. For AMS issues, start with `adb shell dumpsys activity`. For WMS, start with `dumpsys window`. The output includes snapshots of key object state, and many problems can be located without adding logs.

**AIDEGen + Android Studio** is Google's official AOSP IDE setup. In practice, it only works reliably for specific modules. `frameworks/base` is usable, while code under `system/` often has incomplete indexing. My usage is limited: AIDEGen for Framework Java reading, command line for native code.

```bash
# Generate an IDE project. --depth limits dependency depth to avoid index explosion.
aidegen frameworks/base -s -depth 2
```

**Targeted custom logging** is the most reliable option when dumpsys is insufficient and breakpoints are not practical. Add `ALOGD` on the key path, then rebuild the module. It is slower, but the information density is high.

One trap I hit: after a single-module `mm` build, remember to run `adb sync`. Otherwise the new artifact never reaches the system partition, and you keep running old code. I turned this into a fixed script:

```bash
mmm frameworks/native/services/surfaceflinger && adb sync system && adb shell pkill surfaceflinger
```

## Building a mental model of source indexes

After enough reading, you realize that AOSP is large but structurally stable. I do not memorize exact code paths. I memorize **protocol boundaries between modules**:

- Java <-> Native: the JNI registration table is the only bridge
- App <-> System Service: Binder + AIDL defines the interface
- Framework <-> HAL: HIDL/AIDL for HAL, with `hardware/interfaces/` as the root
- Native Service <-> Driver: `/dev` nodes + `ioctl`; search by driver name

Whenever I receive a new problem, I first identify the layer based on protocol boundaries instead of blindly searching keywords. That is far more useful than memorizing source paths.
