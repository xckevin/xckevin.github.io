---
title: "Android LiveData Internals and a Safe Flow Migration"
lang: en
translationKey: android-livedata-lifecycle-flow-migration
slug: android-livedata-lifecycle-flow-migration
excerpt: "Explore LiveData lifecycle behavior and stale-event pitfalls, then migrate incrementally to StateFlow and SharedFlow."
publishDate: '2026-07-06'
tags:
- "Android"
- "Jetpack"
- "LiveData"
- "Kotlin Flow"
seo:
  title: "Android LiveData Internals and Flow Migration"
  description: "Understand LiveData lifecycle behavior and migrate safely to StateFlow and SharedFlow."
  pageType: article
---

Last year, when I took over the maintenance of an e-commerce project, QA raised a puzzling bug: after returning to the list page from the product details page, the list automatically refreshed and jumped to the top. After investigation, it was found that the list page observed the data in a global Repository through LiveData. Every time the Fragment was restored from the rollback stack, LiveData re-pushed the last data to the observer.

This is Data Backflow - the most common complaint in the LiveData community, but the root cause is much more complicated than the four words "sticky events" on the surface.

## Lifecycle-aware three-tier collaboration

LiveData's life cycle awareness relies on the cooperation of three components: `observe` serves as the binding entry, `LifecycleBoundObserver` acts as a state listener, and `activeStateChanged` triggers distribution.

When calling `observe(lifecycleOwner, observer)`, LiveData will create a wrapper class internally:

```kotlin
// LiveData.java core logic (simplified)
public void observe(@NonNull LifecycleOwner owner, @NonNull Observer<? super T> observer) {
    LifecycleBoundObserver wrapper = new LifecycleBoundObserver(owner, observer);
    ObserverWrapper existing = mObservers.putIfAbsent(observer, wrapper);
    if (existing != null && !existing.isAttachedTo(owner)) {
        throw new IllegalArgumentException("Cannot add the same observer...");
    }
    owner.getLifecycle().addObserver(wrapper);
}
```

Each `LifecycleOwner` can only be bound to one observer of the same type. `LifecycleBoundObserver` inherits `ObserverWrapper` and implements `LifecycleEventObserver`, which allows it to sense Lifecycle state changes:
```kotlin
class LifecycleBoundObserver extends ObserverWrapper implements LifecycleEventObserver {
    @Override
    public void onStateChanged(@NonNull LifecycleOwner source, @NonNull Lifecycle.Event event) {
        Lifecycle.State currentState = mOwner.getLifecycle().getCurrentState();
        if (currentState == DESTROYED) {
            removeObserver(mObserver); // auto cleanup
            return;
        }
        activeStateChanged(shouldBeActive());
    }
}
```

The judgment condition of `shouldBeActive()` is very simple: **Lifecycle is higher than or equal to STARTED, which means active**. Once DESTROYED is entered, the observer is automatically unbound - the bottom line for LiveData to prevent memory leaks.

## How activeStateChanged pushes out old data

`ObserverWrapper.activeStateChanged` is the real dispatch point:

```kotlin
void activeStateChanged(boolean newActive) {
    if (newActive == mActive) return;
    mActive = newActive;
    if (mActive) {
        dispatchingValue(this); // Immediately dispatch the current value to this observer.
    }
}
```

When returning from inactive to active, LiveData unconditionally calls `dispatchingValue(this)`, passing in the observer that just became active. `dispatchingValue` executes `observer.onChanged(mData)` after checking the version number - `mData` is the latest value held internally by LiveData, whether it was set one second ago or three hours ago.

**The source of sticky events is here: as long as the observer returns from inactive to active, LiveData defaults to thinking that you need the latest data. **

This is reasonable when the screen is rotated and rebuilt, but when the Fragment return stack is restored, the "latest data" may have been consumed before, and pushing it again will be a disaster.

## Three-level root causes of data backflow

### 1. Sticky design itself

LiveData is designed to be an "observable data holder", not an "event bus". It always holds the current value, and new subscribers receive this value immediately. In the horizontal and vertical screen rotation scenario, this design avoids the overhead of reloading data. But when the same observer is repeatedly resubscribed due to Lifecycle switching, the original design intention becomes a source of bugs.

### 2. ViewModel and Repository magnify the scope of the problem

The life cycle of ViewModel spans the destruction and reconstruction of Fragment, and the life cycle of Repository often covers the entire process. LiveData is placed in these two layers, and the data survival time far exceeds that of the UI layer. This is exactly what I saw in that e-commerce project:

```kotlin
object UserRepository {
    private val _user = MutableLiveData<User>()
    val user: LiveData<User> = _user

    fun login(name: String) {
        _user.value = User(name) // This value remains until it is replaced.
    }
}
```

Once set, any subsequent observers subscribed to `user` will receive this data - whether the UI needs it at the time or not.

### 3. Versioning prevents duplicates, not stale re-delivery

The source code of `setValue` reveals the limitations of LiveData's understanding of "consumption":

```kotlin
@MainThread
protected void setValue(T value) {
    mVersion++;              // Only the version number increments.
    mData = value;
    dispatchingValue(null);  // Dispatch to all active observers.
}
```

`mVersion` is compared with `mLastVersion` of each `ObserverWrapper` to prevent the same observer from receiving duplicate version data in the same active cycle. But it cannot solve the problem of "new observers should not receive historical values" - there is no concept of "destroy after consumption" in LiveData, `mData` exists forever.

## Three patching solutions and their costs

### SingleLiveEvent: Useful but has shortcomings

`SingleLiveEvent` provided by Google official Samples, the core uses `AtomicBoolean` to control event delivery:

```kotlin
class SingleLiveEvent<T> : MutableLiveData<T>() {
    private val mPending = AtomicBoolean(false)

    override fun observe(owner: LifecycleOwner, observer: Observer<in T>) {
        super.observe(owner) { t ->
            if (mPending.compareAndSet(true, false)) {
                observer.onChanged(t)
            }
        }
    }

    override fun setValue(value: T) {
        mPending.set(true)
        super.setValue(value)
    }
}
```

`compareAndSet` will only succeed once - if two observers are listening to the same `SingleLiveEvent` at the same time, only one will receive the event.

### Event Wrapper: Give consumption rights to the View layer

To wrap the event into a consumable container, the View layer explicitly calls `getContentIfNotHandled()`:

```kotlin
class Event<out T>(private val content: T) {
    private var hasBeenHandled = false

    fun getContentIfNotHandled(): T? {
        return if (hasBeenHandled) null
        else { hasBeenHandled = true; content }
    }

    fun peekContent(): T = content
}
```

The problem of multiple observers is solved, but the wrapper method must be called on the View side every time, and someone in the team always forgets.

### Manually skip the first value: simple and crude, but a minefield

```kotlin
var isFirstObserve = true
viewModel.data.observe(viewLifecycleOwner) {
    if (isFirstObserve) {
        isFirstObserve = false
        return@observe
    }
    // handler
}
```

Can save lives. But if the page does require the data to be loaded for the first time, this flag becomes entangled with the initialization logic and gets dirty quickly.

## StateFlow’s paradigm shift: data does not change due to the arrival of observers

Instead of patching LiveData, it’s better to change the idea directly. As a hot flow, StateFlow does not care when the observer arrives - its `value` is always synchronously checkable, but the collection behavior depends on the start time of Flow. **

The basic migration looks like this:

```kotlin
// Before migration
class MyViewModel : ViewModel() {
    private val _data = MutableLiveData<Result>()
    val data: LiveData<Result> = _data
}

// After migration
class MyViewModel : ViewModel() {
    private val _data = MutableStateFlow<Result>(Result.Loading)
    val data: StateFlow<Result> = _data
}
```

`observe` cannot be used on the Fragment side. StateFlow has no life cycle awareness:
```kotlin
viewLifecycleOwner.lifecycleScope.launch {
    viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.data.collect { result ->
            // Handle data.
        }
    }
}
```

The behavior of `repeatOnLifecycle(STARTED)` is: start the coroutine and start collecting when STARTED is reached, and cancel the coroutine when it is lower than STARTED. The result is similar to LiveData's active/inactive switching, but **cancellation is cancellation, and the old value will not be automatically replayed during recovery** - StateFlow does not have the historical baggage of being consumed. It only guarantees a strict correspondence between "who you are at this moment and what you have received."

If you think the writing is verbose, encapsulate an extension function:

```kotlin
fun <T> Flow<T>.observeWithLifecycle(
    owner: LifecycleOwner,
    state: Lifecycle.State = Lifecycle.State.STARTED,
    action: (T) -> Unit
) {
    owner.lifecycleScope.launch {
        owner.repeatOnLifecycle(state) {
            this@observeWithLifecycle.collect { action(it) }
        }
    }
}
```

**One-time events** (Navigation, Toast) must use SharedFlow instead of StateFlow:
```kotlin
private val _navigation = MutableSharedFlow<NavDirection>(
    replay = 0,
    extraBufferCapacity = 1,
    onBufferOverflow = BufferOverflow.DROP_OLDEST
)
val navigation: SharedFlow<NavDirection> = _navigation
```

`replay = 0` allows new subscribers to have zero historical data, fundamentally eliminating backwash.

## Keep or move: a practical decision-making framework

LiveData and Flow can coexist in the project, as long as the boundaries are clearly defined:

**Keep LiveData:**
- Simple single field binding combined with DataBinding’s `@{}` syntax sugar, requires fewer lines of collection code than Flow.
- XML DataBinding only supports automatic life cycle management of LiveData

**Use Flow instead:**
- Data requires chain operators such as `map`, `filter`, `combine` etc.
- One-time events, SharedFlow is naturally more elegant than various LiveData patches
- Use Room’s `Flow` return type to perform responsive queries
-Multiple data source merge, `combine` is much more intuitive than `MediatorLiveData`

In actual projects, I prefer to use Flow in the ViewModel layer to handle business logic, and only bridge out when the View layer needs DataBinding:

```kotlin
val uiState: LiveData<UiState> = combine(
    userRepo.observeUser(),
    settingsRepo.observeSettings()
) { user, settings ->
    UiState(user, settings)
}.asLiveData()
```

This is the key to incremental migration - the power of Flow's composition under the hood, while the outer layer remains LiveData compatible. When switching to Compose in the future, delete `.asLiveData()` and change it to `collectAsState()` directly, with no changes to the business logic.

## Several pitfalls not worth stepping on

**Don’t use `viewModelScope` in ViewModel to manually collect your own StateFlow. ** `stateIn` has already subscribed for you. Repeated collection will only add one more subscriber:

```kotlin
val data: StateFlow<Result> = flowDataSource
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), Result.Loading)
```

`WhileSubscribed(5000)` waits 5 seconds after all subscribers leave before canceling the upstream - data will not be lost when the configuration is changed, and resources will not be occupied like `Eagerly`.

**Don't set the initial value for MutableLiveData in the init block and then skip it in observe.** That intent is unclear and expensive to maintain. If an initial value is not required, use `SingleLiveEvent` directly or migrate to SharedFlow.

Looking back at LiveData, it was very decent in the era of callback hell in 2017 - the data holder with its own lifecycle management is much better than manual `removeCallbacks`. But as coroutines and Flow mature, its sticky semantics become a trap. Understanding the source code is not to apply patches, but to make more rational technology selections: Don’t accommodate LiveData in scenarios where Flow can be used. It will save much more time than writing these patch plans. **
