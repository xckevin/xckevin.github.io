---
title: "Android Configuration Changes: Activity Recreation and ViewModel Survival"
lang: en
translationKey: android-configuration-changes-viewmodel
slug: android-configuration-changes-viewmodel
excerpt: "A source-level walkthrough of Android configuration changes, from ActivityThread relaunch handling to NonConfigurationInstances, ViewModelStore retention, and the boundary with SavedStateHandle."
publishDate: '2026-05-22'
tags:
- "Android"
- "ViewModel"
- "Configuration Changes"
- "Activity Lifecycle"
- "Source Analysis"
seo:
  title: "Android Configuration Changes: Activity Recreation and ViewModel Survival"
  description: "Trace Android configuration changes from ActivityThread relaunch to ViewModelStore retention and SavedStateHandle boundaries."
  pageType: article
---

During a modularization project, I ran into a strange bug: from landscape mode, I opened a secondary page, switched back to portrait while exiting it, and returned to the home page with all ViewModel data gone. After digging through it, the issue was not ViewModel itself. The gap was in my understanding of the configuration-change recreation path.

That gap is hidden in `ActivityThread` source code. One key line connects the full destroy-and-recreate path.

## Trigger: who decides whether to recreate the Activity

`ActivityThread.handleRelaunchActivity` is the entry point for the whole flow. After the system detects a configuration change, such as rotation, locale change, or dark-mode change, it posts a `RELAUNCH_ACTIVITY` message to the main thread through Binder:

```java
// ActivityThread.java
public void handleRelaunchActivity(ActivityClientRecord tmp, ...) {
    // If the Activity declares android:configChanges, this path is used.
    if (tmp.activity != null && !tmp.activity.mFinished) {
        handleRelaunchActivityInner(r, configChanges, tmp.pendingResults, ...);
    }
}
```

The important decision happens inside `handleRelaunchActivityInner`: if the Activity declares the matching `configChanges` values in `AndroidManifest`, such as `orientation|screenSize`, the system calls `handleConfigurationChanged` and does not recreate the Activity. Otherwise, it enters the recreation path: destroy first, then create again.

This has always been Android's design. When configuration changes, the system assumes you may need to reload every resource: layouts, drawables, strings, and qualifiers. The most direct way to do that is to run the lifecycle from the beginning.

## What gets retained during destruction

The recreation path has two steps: `handleDestroyActivity` followed by `handleLaunchActivity`. The core mechanism lives in this method during destruction:

```java
// ActivityThread.java - performDestroy
NonConfigurationInstances retainNonConfigurationInstances() {
    Object activity = onRetainNonConfigurationInstance();  // 1
    HashMap<String, Object> children = onRetainNonConfigurationChildInstances();
    FragmentManagerNonConfig fragments = mFragments.retainNestedNonConfig();
    // ... collect all objects that should survive recreation
    return new NonConfigurationInstances(activity, children, fragments, ...);
}
```

`onRetainNonConfigurationInstance()` is a template method. An Activity subclass can override it and return any object. The system saves that object and passes it back unchanged when the new Activity instance is created.

AndroidX `ComponentActivity` uses this mechanism for the crucial ViewModel retention step:

```java
// ComponentActivity.java (simplified)
public final Object onRetainNonConfigurationInstance() {
    Object custom = onRetainCustomNonConfigurationInstance();
    ViewModelStore viewModelStore = mViewModelStore;  // 2
    if (viewModelStore == null) {
        // No ViewModel means there is nothing to retain.
        return custom;
    }
    return new NonConfigurationInstances(custom, viewModelStore);
}
```

`mViewModelStore` is a `HashMap<String, ViewModel>` container that holds every ViewModel created for the current Activity through `ViewModelProvider`. During destruction, this container is packed into a `NonConfigurationInstances` object, stored in `ActivityClientRecord`, and held until recreation.

`onRetainCustomNonConfigurationInstance()` is the extension point for developers. You can override it in an Activity and return any custom object to retain your own non-configuration state.

## How the new Activity inherits the retained state

After destruction completes, `handleLaunchActivity` starts creating the new Activity. During `performLaunchActivity`, the framework calls `Activity.attach` and passes in the retained `NonConfigurationInstances` from the previous step:

```java
// Activity.java
final void attach(Context context, ActivityThread aThread, ...,
                  NonConfigurationInstances lastNonConfigurationInstances) {
    // ...
    mLastNonConfigurationInstances = lastNonConfigurationInstances;  // 3
}
```

`mLastNonConfigurationInstances` is stored as a member field on the new Activity. Later, when `ViewModelProvider` is created inside `Activity.onCreate`, it obtains the old `ViewModelStore` through `getLastNonConfigurationInstance()`:

```java
// ComponentActivity.getViewModelStore()
public ViewModelStore getViewModelStore() {
    if (mViewModelStore == null) {
        NonConfigurationInstances nc =
            (NonConfigurationInstances) getLastNonConfigurationInstance();  // 4
        if (nc != null) {
            mViewModelStore = nc.viewModelStore;  // Reuse the old store directly.
        }
        if (mViewModelStore == null) {
            mViewModelStore = new ViewModelStore();
        }
    }
    return mViewModelStore;
}
```

If `nc.viewModelStore` is not null, the old store is reused directly. The ViewModel was never destroyed. It simply receives a new host Activity.

## The boundary between ViewModel and SavedStateHandle

Many developers conflate ViewModel survival with `onSaveInstanceState`. They are completely different channels:

- **ViewModel retention** depends on `onRetainNonConfigurationInstance`; the data stays in memory and is lost if the process is killed
- **SavedStateHandle** depends on `onSaveInstanceState`; the data is serialized into a Bundle and can survive process recreation

I have hit this in a real project. We stored all UI state in `SavedStateHandle` inside the ViewModel. After rotation, the data was still there, so it was easy to assume the ViewModel itself could survive process death. Then a low-memory device killed the background process. The ViewModel data disappeared. `SavedStateHandle` restored its part, but the synchronization logic between the two data sets was incomplete, so the UI became inconsistent.

The right division is: ViewModel stores runtime state, such as loaded list data and the current selection. `SavedStateHandle` stores key serializable state, such as text-field content and filter conditions. The latter is the fallback for the former. When the process is recreated, the ViewModel initializes itself again from `SavedStateHandle`.

## Custom configuration-change handling

If you do not want the Activity to be recreated, the simplest option is to declare `configChanges` in the manifest:

```xml
<activity android:name=".VideoPlayerActivity"
    android:configChanges="orientation|screenSize|keyboardHidden" />
```

Then override `onConfigurationChanged` and handle UI adaptation manually. The cost is that the system no longer switches resources for you automatically. If you depend on resource qualifiers such as `res/layout-land`, you must handle the layout switch yourself after declaring `configChanges`.

I usually prefer the other approach: use ViewModel with the normal recreation mechanism, and treat recreation as a free state reset. After rotation, the layout is inflated again, landscape and portrait resource directories are applied automatically, and ViewModel keeps the data alive. It requires less code and better matches the framework design.

Fragment behavior is a common source of bugs here. During a configuration change, Fragments are also destroyed and recreated by default. If you use `setRetainInstance(true)`, which is now deprecated, or add retention logic in `FragmentFactory`, you must separately guarantee consistency between the Fragment's internal state and its ViewModel. Retaining the Fragment while recreating its View is a frequent source of state-sync bugs between `onDestroyView` and `onCreateView`.

Back to the opening issue. The root cause was that the secondary page declared `configChanges="orientation"` and did not recreate, while the home page did not declare it. After entering the secondary page in landscape and exiting in portrait, the home page missed the expected recreation trigger and did not reinflate the right resources. The ViewModel data keys were correct, but the view state had not caught up. The fix was simple: make the `configChanges` strategy consistent, or manually check resource state in `onResume`.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [What is Android Binder? A practical guide to the Binder IPC model](/en/blog/android-binder/)

<!-- /seo-internal-links -->
