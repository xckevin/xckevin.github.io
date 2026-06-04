---
title: "Android Fragment Lifecycle and FragmentManager: Transactions, Back Stack, and State Recovery"
lang: en
translationKey: android-fragment-fragmentmanager
slug: android-fragment-fragmentmanager
excerpt: "A deep dive into Fragment transaction async execution, back-stack state recovery, ViewModel lifecycle coordination, commitNow, onSaveInstanceState timing, and common NPE and leak traps."
publishDate: '2026-05-26'
tags:
- "Android"
- "Fragment"
- "ViewModel"
- "Jetpack"
- "Lifecycle"
seo:
  title: "Android Fragment Lifecycle and FragmentManager: Transactions to State Recovery"
  description: "Why are Fragment transactions asynchronous? How does the back stack restore state? Learn Fragment lifecycle, ViewModel, commitNow, and state pitfalls."
  pageType: article
---

Last week I investigated a production crash. The stack pointed to an NPE caused by accessing a View after `FragmentManager.executePendingTransactions()`. The code looked reasonable: immediately after `commit()`, `findFragmentByTag()` returned a non-null Fragment instance, but its View was still null.

That issue exposed one of the most important and most error-prone facts in the Fragment framework: **transactions are not synchronous**.

## The asynchronous nature of FragmentTransaction

`FragmentTransaction.commit()` is easy to misunderstand. The method name suggests "commit and apply immediately," but in reality it only enqueues the operation into a transaction queue, `mPendingActions`. The actual execution happens at the next idle point of the main thread message queue.

```kotlin
// This code has a hidden risk
supportFragmentManager.commit {
    replace(R.id.container, MyFragment())
}
val fragment = supportFragmentManager.findFragmentById(R.id.container) as MyFragment
fragment.updateContent(data) // fragment.view may still be null
```

After `commit()` returns, the Fragment instance has been created, and `onAttach()` plus `onCreate()` may already have run, but **`onCreateView()` has not been called yet**. The Fragment object exists; the view tree has not been built.

FragmentManager handles the flow like this:

1. `commit()` -> transaction enters `mPendingActions`
2. The main-thread Looper finishes the current message
3. `FragmentManager.execPendingActions()` is triggered
4. Queued transactions execute one by one -> `onCreateView()` -> `onViewCreated()`

If you need to manipulate the View immediately after committing, use `commitNow()`:

```kotlin
supportFragmentManager.commitNow {
    replace(R.id.container, MyFragment())
}
// The view is created now, so it is safe to operate on it
```

`commitNow()` executes the transaction synchronously and skips queue scheduling. The cost is that it cannot be added to the back stack because it bypasses that state-management path.

## The tradeoff between back stack and state saving

The back stack is carefully designed, but it can be hard to debug when it breaks. Its core logic is that `addToBackStack()` marks a transaction as reversible, and when the user presses Back, the system executes the inverse operations.

The unintuitive part: **popBackStack does not destroy and recreate the Fragment from scratch. It restores it from saved state**.

```kotlin
supportFragmentManager.commit {
    replace(R.id.container, FragmentA())
    addToBackStack("tag_a")
}
// After user interaction, FragmentA is replaced by FragmentB
supportFragmentManager.commit {
    replace(R.id.container, FragmentB())
    addToBackStack("tag_b")
}
// Back press -> popBackStack -> FragmentA is restored
```

When `popBackStack()` runs, FragmentA's state, including `savedInstanceState`, was never truly lost. Internally, `FragmentManager` keeps an `mBackStack` list. Each entry stores the reverse operations for the transaction, the inverse of each Op, plus a full state snapshot of the Fragment.

That is why after `popBackStack`, Fragment's `onCreateView()` is called again but `savedInstanceState` is not null. It looks like recreation, but it is actually restoration.

One trap I hit: after `popBackStack()`, the Fragment instance returned by `findFragmentByTag()` was **the same Java object** as before. If it holds a reference to an old View and does not clear it in `onDestroyView()`, strange View operation errors can follow.

```kotlin
class MyFragment : Fragment() {
    private var rootView: View? = null
    
    override fun onCreateView(...): View {
        return if (rootView == null) {
            rootView = inflater.inflate(R.layout.fragment_my, container, false)
        } else {
            // After onDestroyView, rootView still points to the old View
            // Rebuild it or handle the reference correctly
            rootView
        }
    }
    
    override fun onDestroyView() {
        super.onDestroyView()
        rootView = null // This line is often missed
    }
}
```

## ViewModel and Lifecycle coordination

A configuration change such as rotation recreates the Fragment, but the ViewModel needs to survive. This is one of the most common tensions in the Fragment lifecycle.

Jetpack handles it by decoupling the ViewModel lifecycle from the Fragment's View lifecycle:

- **ViewModel is bound to `Fragment.getViewModelStore()`**, whose owner is the Fragment instance itself
- When the Fragment is recreated for a configuration change, `ViewModelStore` is retained if retention is in effect, or handled automatically by the Navigation component
- When `onDestroy()` is called, `ViewModelStore` is not necessarily cleared; `clear()` runs only for destruction not caused by a configuration change

```
Fragment created -> onCreate() -> ViewModelProvider gets or creates ViewModel
      ↓
onCreateView() -> View is created, LiveData observes View state
      ↓
Configuration change -> onDestroyView() -> View destroyed (ViewModel survives)
      ↓
onCreateView() -> New View created -> LiveData rebound
```

The core fact: **a ViewModel lives longer than a Fragment's View**. Passing View references into a ViewModel is therefore an anti-pattern. After a configuration change, the ViewModel can hold an invalid View reference.

```kotlin
// Anti-pattern: ViewModel holds a View reference
class MyViewModel : ViewModel() {
    var textView: TextView? = null // Becomes a dangling reference after rotation
}

// Correct approach: expose data through LiveData/StateFlow and let the View layer observe it
class MyViewModel : ViewModel() {
    private val _text = MutableLiveData<String>()
    val text: LiveData<String> get() = _text
}
```

"Do not pass Views into ViewModel" sounds simple, but real projects still violate it repeatedly, especially when code needs to call View methods such as `requestFocus()` or `smoothScrollToPosition()` and someone stores a reference for convenience.

The difference between `Fragment.getViewLifecycleOwner()` and the Fragment itself as a LifecycleOwner is also easy to miss. The former is active from `onCreateView()` to `onDestroyView()`. The latter is active from `onCreate()` to `onDestroy()`. If you launch a coroutine from `this.lifecycleScope` inside `onCreateView()`, it may keep touching an invalid View after the View has been destroyed but before the Fragment itself is destroyed:

```kotlin
// Correct approach: use viewLifecycleOwner to scope the coroutine
viewLifecycleOwner.lifecycleScope.launch {
    // The coroutine is automatically canceled when onDestroyView runs
    viewModel.data.collect { updateUI(it) }
}
```

## The onSaveInstanceState timing trap

`onSaveInstanceState()` follows a complex set of rules in Fragment. A common misconception is that it only runs when the Activity goes into the background, but it has broader triggers:

1. When the Activity's `onSaveInstanceState()` runs, it cascades to every Fragment
2. After a transaction is committed with `addToBackStack()`, execution of that transaction can trigger state saving
3. When a Fragment enters the back stack, the system must save its state for later restoration

One issue cost half a day to debug: a Fragment saved a complex object in `onSaveInstanceState()`, but one field was null after restoration. The reason was that the object did not implement `Parcelable` or `Serializable`, and the Fragment framework silently skipped that field during serialization without throwing an exception.

```
FragmentStateManager.saveState()
  → Fragment.mSavedFragmentState = Bundle()
  → Fragment.performSaveInstanceState(mSavedFragmentState)
      → onSaveInstanceState(outState) // Your code runs here
  → FragmentState is serialized into Bundle
```

My rule: store only **simple Parcelable data or primitive values** in `onSaveInstanceState()`. Put complex objects in ViewModel, and handle serialization logic separately when it is truly needed.

## Practical lessons

After many years of Android development, Fragment-related issues still account for a noticeable share of production crashes. A few lessons keep proving useful:

**Transaction synchronicity**: use `commitNow()` when you need to operate on the View immediately. Use `commit()` when you need back-stack behavior. You must choose one. `commitNow()` cannot be combined with `addToBackStack()`; the API enforces it.

**View reference lifecycle**: clear all View references in `onDestroyView()`. Use `viewLifecycleOwner` instead of `this` as the owner for LiveData observation and coroutine scopes, so the framework cancels work at the right time.

**State-saving granularity**: separate configuration changes from process death. Use ViewModel for the former; use `onSaveInstanceState` plus Parcelable for the latter. Do not abandon `onSaveInstanceState` completely just because ViewModel exists.

The Fragment framework was designed in 2011 and carries a lot of historical baggage. Understanding its transaction queue, back stack, and state recovery mechanisms is not about admiring the design. It is about finding root causes quickly when things break. Production crashes do not wait, and Fragment has taught Android developers that lesson for years.
