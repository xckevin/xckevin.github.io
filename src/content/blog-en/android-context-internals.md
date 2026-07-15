---
title: "Inside Android Context: ContextImpl and Component Lifecycles"
lang: en
translationKey: android-context-internals
slug: android-context-internals
excerpt: "A practical look at ContextImpl and the differences between Application, Activity, and Service contexts for resources, themes, windows, and lifecycle safety."
publishDate: '2026-06-27'
tags:
- "Android"
- "Android Framework"
- "Context"
- "Memory Leaks"
seo:
  title: "Android Context Internals: ContextImpl and Components"
  description: "Learn how Android Context works internally and avoid common context leaks, theme errors, and window-token failures."
  pageType: article
---

A very common crash: using `AlertDialog.Builder(context)` in Service, passing in `applicationContext`, and throwing `BadTokenException`. It will be normal if you change it to the Context of `Activity`. On the other hand, using `Activity`'s Context to hold singletons and start Services also creates the risk of memory leaks.

Behind these two situations is the same fact: **In the same App, the Context of different components is not the same thing**. They share a set of underlying mechanisms, but have subtle differences in behavior, which can cause problems if confused.

## Context's design philosophy: more than just "context"

Context is translated as "context", which may be the most accurately named class in the Android framework layer. It is not responsible for specific business logic, but describes "the environment in which the code is currently running" - what capabilities the system gives you, what resources you can access, and where your life cycle boundaries are.

From the design pattern point of view, Context is a typical Facade: it encapsulates the calling entrance of system services (PackageManager, WindowManager, AlarmManager, etc.) in an abstract class. The upper layer only deals with Context and does not directly touch ServiceManager.

```java
// Context is only an abstract interface; ContextImpl is the concrete implementation.
public abstract class Context {
    public abstract Resources getResources();
    public abstract SharedPreferences getSharedPreferences(String name, int mode);
    public abstract void startActivity(Intent intent);
    // ...more than 200 methods
}
```

The benefits of this design are clear: **The caller does not need to know whether it is running in an Activity or a Service, they all use the same set of APIs**. The price is that the differences are hidden in the implementation layer, and the troubleshooting path becomes longer when a problem occurs.

## ContextImpl internals: a delegate aggregate

All subclasses of Context (Activity, Service, Application) ultimately delegate to `ContextImpl`. Each subclass of ContextWrapper in the source code has an `mBase` field, which points to ContextImpl.

```java
class ContextImpl extends Context {
    final @NonNull ActivityThread mMainThread;
    final @NonNull LoadedApk mPackageInfo;
    private final @NonNull ResourcesManager mResourcesManager;
    private @Nullable Display mDisplay;  // The key distinction
    // ...
}
```

ContextImpl puts together several core capabilities:

- **ActivityThread**: main thread message loop, relay station for life cycle events
- **LoadedApk**: Runtime information after APK is loaded, including ClassLoader and resource path
- **ResourcesManager**: global singleton, manages the caching and reuse of all Resources objects
- **Display**: Determine which screen configuration the resource is loaded from

Among them, `Display` is the key to distinguish different Context types. Activity's ContextImpl will bind the Display of the current screen, and Application's ContextImpl has only one default Display. This is why when creating a Dialog on a non-default screen, you must use the Context of the Activity to which the screen belongs.

## Disassembly of Context differences among the three major components

The core issue among the Context differences between Application, Activity, and Service is not "can it be used", but whether the behavior is as expected after being used. The differences mainly lie in three aspects.

### Theme access

Application's Context **has no Theme configuration**, and its `getTheme()` returns the system default theme. Activity's Context will read configuration from AndroidManifest or `setTheme()`.

```kotlin
// Creating a Dialog with an Application Context can crash or apply the wrong theme.
val dialog = AlertDialog.Builder(applicationContext)
    .setTitle("Notice")  // This calls context.getTheme().
    .create()
```

I have actually stepped on this pitfall: in the click processing of push notifications, directly use `applicationContext` to pop up the Dialog, and some models directly crash. The correct approach is to hold a reference to the current activity on the top of the stack, or maintain a weak reference to the foreground activity in the Application.

### Resource loading (Resources)

The Resources object returned by `getResources()` may also be different in the same App. Android maintains separate Resources for each Context for two reasons:

1. **Screen density adaptation**: Different Displays may correspond to different densities, and Resources need to match
2. **Configuration change**: When the Activity is rebuilt, the Resources will be updated with the new Configuration, and the Application’s Resources will remain stable.

```java
// Simplified ContextImpl getResources logic
Resources getResources() {
    if (mResources != null) return mResources;
    // Choose Resources according to the Display and Configuration.
    mResources = mResourcesManager.getResources(
        this, mPackageInfo.getResDir(), mDisplay, ...);
    return mResources;
}
```

If you use ApplicationContext's `getResources()` to get strings or dimensions during Activity destruction and reconstruction, you will still get the old configuration. Usually the impact is not big, but problems will be exposed in multi-window and split-screen scenarios - the Resources of the ApplicationContext do not change when the Display changes.

### Window management (Window)

Only the Activity Context can create Dialog and operate Window. Dialog is essentially a child Window suspended above the Activity Window and requires the Token of the parent Window.

```java
// Context check in Dialog construction
Dialog(@NonNull Context context, ...) {
    // Only cast an Activity Context.
    mWindowManager = (WindowManager) context.getSystemService(WINDOW_SERVICE);
    final Window w = new PhoneWindow(mContext);
    w.setWindowManager(mWindowManager, null, null);
}
```

The Context of Service and Application does not have Window Token, so `BadTokenException` is inevitable. When doing screen adaptation, I also discovered a detail: even if you use Activity to create a Dialog, if the Activity has finished and the Token is invalid, it will still crash. Pay attention to life cycle windows.

## Typical pitfalls of resource access

### Trap 1: Drawable loading under multi-density screens

Problems may occur when the same image is transferred between screens of different densities. For example, if you use the Context of Activity A (density=2.0) to load a Bitmap and pass it to Activity B (density=1.5, different Display), scaling exceptions will occur when displayed directly.

```kotlin
// Incorrect: Resources from the current Context are tied to its Display density.
val drawable = ContextCompat.getDrawable(context, R.drawable.icon)

// Correct: when crossing displays, reload through the target Context.
val targetDrawable = ContextCompat.getDrawable(targetContext, R.drawable.icon)
```

The solution is not to "load without Context", but to make Drawable's loading Context and display Context consistent. Or use `BitmapFactory` with `Options(inDensity, inTargetDensity)` to control manually.

### Trap 2: Null pointer of getExternalFilesDir

I encountered a strange crash in a file management module: in the same piece of code, calling `getExternalFilesDir(null)` in Activity was normal, but calling it in Service returned null.

After tracing the source code, we found that `mDisplay` in Service's ContextImpl was null in some cases, causing `getExternalFilesDirs()` to throw NPE when internally obtaining the storage volume. Part of it has been fixed after Android 8.0, but it still reappears on custom ROMs.

The lesson is: **Context methods involving file paths, try to call** on the Application's Context, which is the Context instance with the longest life cycle and the most stable state.

### Trap Three: The Dilemma of Memory Leak

```kotlin
// This singleton retains an Activity Context → memory leak.
object ToastManager {
    var context: Context? = null  // If an Activity is passed in...
}

// Use the Application Context instead → safe, but with limited capabilities.
object ToastManager {
    val context: Context = MyApp.instance  // Safe, but cannot create a Dialog.
}
```

The trade-off here is clear: long-lived objects hold the ApplicationContext, and temporary UI operations hold the ActivityContext. A practical trick is to assign itself to the `currentActivity` weak reference field of Application in BaseActivity's `onCreate`, and determine whether it is alive before using it when needed.

## Context creation link

Understanding the creation process of Context can better grasp its life cycle boundaries. Take Activity as an example:
```
ActivityThread.handleLaunchActivity()
  → performLaunchActivity()
    → createBaseContextForActivity()  // Create ContextImpl and bind a Display.
    → Activity.attach(context, ...)   // Assign mBase.
    → Activity.onCreate()
```

The creation link of Service is similar, but `createBaseContextForService` will not bind Display:
```java
// The key difference in ActivityThread
private ContextImpl createBaseContextForActivity(ActivityClientRecord r) {
    ContextImpl appContext = ContextImpl.createActivityContext(
        this, r.packageInfo, r.activityInfo, r.token, displayId, ...);
    return appContext;
}

private ContextImpl createBaseContextForService(...) {
    // No displayId is passed, so mDisplay remains null.
    ContextImpl appContext = ContextImpl.createAppContext(this, packageInfo);
    return appContext;
}
```

The Context of Application is created earliest, completed in the `handleBindApplication` stage, and then throughout the entire process life cycle. **ApplicationContext is globally unique, and the Context of Activity and Service are created locally**, but they share the same LoadedApk instance.

## Practical suggestions

After many years of Android development, I have developed several fixed practices for using Context.

**ApplicationContext is passed in by default unless UI capabilities are explicitly required. ** The vast majority of system services (PackageManager, NotificationManager, ConnectivityManager) do not rely on the Context type. Using ApplicationContext can avoid 90% of memory leaks. When writing a tool class, the construction parameters are directly declared to receive Application instead of Context, which cuts off the possibility of passing Activity in during compilation.

**For operations involving Resources, the context remains consistent. ** Load Drawable, read strings.xml, get dimens, and use the Context of whomever is used to display it. A counterexample: ApplicationContext is used to load color values ​​in the ViewHolder of RecyclerView. The color is not updated when switching to night mode - because the Resources of ApplicationContext do not respond to Configuration changes.

**Understand Context's "capability decay" model. ** The Context capabilities of Application → Service → ContentProvider → BroadcastReceiver are decreasing. Application is the most complete but has no UI. The Context of BroadcastReceiver is `ReceiverRestrictedContext`, and even `registerReceiver` cannot be adjusted. Knowing the upper limit of Context for each component allows you to draw more accurate boundaries when designing the API.
