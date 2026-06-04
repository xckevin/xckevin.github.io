---
title: "Inside Android ViewModel: ViewModelStore Retention and SavedStateHandle Recovery"
lang: en
translationKey: android-viewmodel-savedstatehandle
slug: android-viewmodel-savedstatehandle
excerpt: "Trace ViewModel from ViewModelStore retention to SavedStateHandle process recreation, and separate configuration-change survival from process-death recovery."
publishDate: '2026-05-08'
tags:
- "Android"
- "ViewModel"
- "Architecture"
- "Kotlin"
- "Jetpack"
seo:
  title: "Inside Android ViewModel: ViewModelStore and SavedStateHandle"
  description: "Understand how ViewModel survives configuration changes and how SavedStateHandle restores state after Android process death."
  pageType: article
---

During a modularization refactor, I cached a set of user data in a ViewModel on page A. After navigating to page B, performing an operation, and returning to page A, the ViewModel data was occasionally `null`. My first reaction was: ViewModel is supposed to survive configuration changes, so why did the data disappear?

After two days of debugging, I found that this was not the same problem at all. The device was under memory pressure, the Activity process had been killed, and while ViewModel does survive configuration changes, its data is empty after process death unless SavedStateHandle is configured. That leads to ViewModel's two lifetimes: **configuration-change survival** and **process-death recovery**. They rely on completely different internal mechanisms.

## ViewModelStore: who holds your ViewModel

ViewModel does not survive by magic. Its lifetime depends on a container called **ViewModelStore**. Every time you call `ViewModelProvider.get()`, the simplified flow looks like this:

```kotlin
// Simplified logic inside ViewModelProvider
fun <T : ViewModel> get(key: String, modelClass: Class<T>): T {
    var viewModel = store.get(key)  // Try the store first.
    if (viewModel != null) return viewModel as T
    // Create a new one if none exists.
    viewModel = factory.create(modelClass)
    store.put(key, viewModel)
    return viewModel
}
```

ViewModelStore is essentially a HashMap. The key is the ViewModel class name, and the value is the instance. The key question is: **who holds this store, and how long does that holder live?**

In an Activity, ViewModelStore is managed by `ComponentActivity.getViewModelStore()`:

```java
// Core ComponentActivity logic, simplified
public ViewModelStore getViewModelStore() {
    if (mViewModelStore == null) {
        NonConfigurationInstances nc =
            (NonConfigurationInstances) getLastNonConfigurationInstance();
        if (nc != null) {
            mViewModelStore = nc.viewModelStore;  // Restore from the old instance.
        }
        if (mViewModelStore == null) {
            mViewModelStore = new ViewModelStore();  // First creation.
        }
    }
    return mViewModelStore;
}
```

When a configuration change happens, such as rotation, the Activity is destroyed and recreated. The Android framework calls `onRetainNonConfigurationInstance()`. **ComponentActivity puts the ViewModelStore into a NonConfigurationInstances object here**, and the system bridges that object to the new Activity instance. The new Activity retrieves the store through `getLastNonConfigurationInstance()`.

During this whole process, the ViewModelStore itself is not destroyed. A different Activity instance simply becomes its holder. That is the essence of configuration-change survival: **the store is passed across instances, not serialized**.

## When ViewModel is cleared

When an Activity finishes normally, `ComponentActivity` registers a LifecycleObserver in its constructor:

```kotlin
// Inside the ComponentActivity constructor
lifecycle.addObserver(LifecycleEventObserver { _, event ->
    if (event == Lifecycle.Event.ON_DESTROY) {
        if (!isChangingConfigurations) {  // Key check
            viewModelStore.clear()
        }
    }
})
```

This is why ViewModel does not die during rotation: `isChangingConfigurations` is true, so `clear()` is skipped. During a normal back navigation, the value is false, the store is cleared, and every ViewModel receives `onCleared()`.

The Fragment case is similar, but the store hangs off the Fragment's `mViewModelStore` field and is bridged through `FragmentManagerViewModel`, a special ViewModel attached to the host Activity.

## SavedStateHandle: the entry point for process-death recovery

After the process is killed, the in-memory HashMap inside ViewModelStore is gone. At that point, recovery depends on **SavedStateHandle**.

SavedStateHandle is essentially a **key-value data container** backed by a regular `HashMap<String, Object>`. It is deeply integrated with Android's native `SavedStateRegistry`:

```kotlin
// Simplified SavedStateHandle internals
class SavedStateHandle {
    private val regular = mutableMapOf<String, Any?>()
    private val savedStateProviders = mutableMapOf<String, SavedStateRegistry.SavedStateProvider>()
    private var restoredState: Bundle? = null  // Snapshot used during restore.
}
```

`regular` stores normal data, `savedStateProviders` stores lazily serialized data for large-state scenarios, and `restoredState` is the Bundle restored by the system after process restart.

The full call chain looks like this:

1. In your ViewModel, you save data through `savedStateHandle.set("user_id", "123")`
2. When the Activity reaches `onSaveInstanceState`, `SavedStateRegistry` iterates over all registered providers
3. SavedStateHandle's `SavedStateProvider` serializes the `regular` HashMap into a Bundle
4. The system writes the Bundle to persistent storage outside the process
5. After process restart, the system passes the Bundle back to the Activity
6. `SavedStateRegistry` passes the Bundle back into SavedStateHandle's `restoredState`

```kotlin
// SavedStateHandle data restore logic
fun <T> get(key: String): T? {
    // Prefer restoredState, which came from process recovery.
    if (restoredState?.containsKey(key) == true) {
        return restoredState?.get(key) as? T
    }
    return regular[key] as? T  // Then read runtime data.
}
```

`set()` writes into `regular`, while `get()` prefers `restoredState`. That priority prevents restored data from being overwritten by runtime data too early.

## The ViewModel + SavedStateHandle construction path

To give a ViewModel a SavedStateHandle, use `SavedStateViewModelFactory` or AndroidX's `viewModels()` delegate. When the factory creates a ViewModel, the flow is:

```kotlin
// Simplified SavedStateViewModelFactory.create()
fun <T : ViewModel> create(modelClass: Class<T>): T {
    // 1. Get the SavedStateRegistry.
    val controller = SavedStateRegistryController.create(owner)
    
    // 2. Create a dedicated SavedStateHandle for the new ViewModel.
    val handle = SavedStateHandle.createHandle(
        controller.getSavedStateProvider(),  // Source of restored data.
        controller.getRestoredState()        // Already-restored Bundle.
    )
    
    // 3. Reflectively call the constructor that accepts SavedStateHandle.
    return modelClass.getConstructor(
        SavedStateHandle::class.java
    ).newInstance(handle)
}
```

This means **SavedStateHandle is already bound to restored data when the ViewModel is constructed**. The ViewModel can read state from the handle immediately during initialization, without any extra restore callback.

In real projects, I usually consume the handle directly in the constructor:

```kotlin
class UserViewModel(
    private val savedStateHandle: SavedStateHandle
) : ViewModel() {
    val userId: String = savedStateHandle.get<String>("user_id") ?: ""
    
    fun setUser(user: User) {
        savedStateHandle.set("user_id", user.id)
        savedStateHandle.set("user_name", user.name)
    }
}
```

There is no need to write a separate `restoreState()` method or worry about ordering, because the handle already contains restored data at construction time.

## SavedStateRegistry coordination across layers

SavedStateHandle works because `SavedStateRegistry` coordinates the save and restore path. It does not only work at the Activity layer; Fragments have their own setup too.

When Activity `onSaveInstanceState` is triggered, the flow is:

1. **Activity layer**: `SavedStateRegistryController.performSave(outBundle)` collects data from every registered provider and writes it into the Bundle
2. **Fragment layer**: FragmentManager iterates through all Fragments and asks each Fragment's SavedStateRegistry to save
3. **ViewModel layer**: each ViewModel's SavedStateHandle acts as a SavedStateRegistry provider and serializes its `regular` HashMap

Restore runs in the opposite direction:

1. Activity `onCreate(Bundle)` passes the savedInstance Bundle into SavedStateRegistry
2. The registry dispatches data to the matching SavedStateHandle
3. The ViewModel reads from the bound SavedStateHandle during construction

One easy trap: **SavedStateHandle data for a Fragment ViewModel is ultimately written into the host Activity's savedInstance Bundle too**. If Activity `onSaveInstanceState` is not called, for example during `finish()`, the Fragment ViewModel's data will not be saved either.

## Serialization and performance boundaries

SavedStateHandle serializes data through Bundle. So what can it store, and what should it avoid?

Supported types:

- Primitive types: Int, Long, Float, Double, Boolean, String, CharSequence
- Arrays: IntArray, LongArray, BooleanArray, and similar types
- Parcelable and Serializable
- Bundle, including nested Bundles

Unsupported types:

- Arbitrary Object instances; prefer Parcelable
- Lambda and function types, which crash directly
- LiveData and Flow, which have no meaningful serialization form

The data-size limit is the same as `onSaveInstanceState`; the official guidance is to stay under **500 KB**. Going beyond that can cause `TransactionTooLargeException`. I once stored a full RecyclerView data list in SavedStateHandle and crashed immediately on a low-end device. The right approach is to store only key identifiers in the handle and restore full data from a database or file.

```kotlin
// Correct: store only the key ID.
savedStateHandle.set("current_item_id", itemId)
// Restore full data from local cache.

// Wrong: store the entire object list.
savedStateHandle.set("items", largeItemList)  // May exceed the Bundle limit.
```

SavedStateHandle also supports lazy serialization through `setSavedStateProvider`:

```kotlin
savedStateHandle.setSavedStateProvider("large_data") {
    Bundle().apply {
        // Runs only during an actual save, delaying serialization.
        putParcelable("data", expensiveToSerializeObject)
    }
}
```

This keeps the data out of the resident `regular` HashMap and invokes the provider only during save. It is useful for large data, expensive serialization, or data that is rarely accessed.

## Where the two lifelines meet

Looking back at the complete ViewModel lifecycle, there are two protection lines:

**Configuration-change line**: ViewModelStore -> NonConfigurationInstances -> new Activity. This is a pure in-memory handoff with no serialization. This line does not care what is stored inside the ViewModel.

**Process-death line**: SavedStateHandle -> SavedStateRegistry -> `onSaveInstanceState` Bundle -> system persistence. This line requires serializable data and has a size limit.

The two lines meet at ViewModel creation time. When the new Activity is created, a new ViewModel is created only if the target ViewModel does not already exist in ViewModelStore. If restored Bundle data exists at the same time, SavedStateHandle loads it during construction, so even a new ViewModel instance can access old state.

The boundary case is: **both lines are triggered during rotation**. `onSaveInstanceState` carries SavedStateHandle data, and ViewModelStore is also passed through NonConfigurationInstances. During restore, because the ViewModel in ViewModelStore is still alive, no new instance is created, so the restored SavedStateHandle data is not actually used. That data matters only after **real process death**.

## Debugging methods

When investigating ViewModel data loss, there are several good entry points.

**Confirm whether this is a configuration change or process death**. Log from the ViewModel's `onCleared()`. If it is called during rotation, ViewModelStore handoff is broken. If it is not called but data is still missing, the problem is in the SavedStateHandle path.

**Do not kill only the Activity and expect savedInstance recovery to prove process death**. To test process death, enable "Don't keep activities" in Developer options, or kill the process with `adb` and restore from Recents. Do not only rotate the screen; that does not test the process-death path.

**Log SavedStateHandle data in the ViewModel `init` block**:

```kotlin
init {
    val restored = savedStateHandle.get<String>("user_id")
    Log.d("VM", "init restoredUserId=$restored")
}
```

If the log is null even though the data was previously set, the SavedStateRegistry save path is broken. Check whether `onSaveInstanceState` was called, or whether the Bundle exceeded the size limit.

A simple way to inspect Bundle size:

```kotlin
override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    // Check the serialized size.
    val parcel = Parcel.obtain()
    parcel.writeBundle(outState)
    Log.d("SaveState", "Bundle size: ${parcel.dataSize() / 1024}KB")
    parcel.recycle()
}
```
