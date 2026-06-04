---
title: "Jetpack Compose Advanced Applications and Internals, Part 2"
lang: en
translationKey: jetpack-compose-advanced-applications-internals-part2
slug: jetpack-compose-advanced-applications-internals-part2
excerpt: "Part 2 of Jetpack Compose Advanced Applications and Internals: advanced state management beyond remember and mutableStateOf."
publishDate: 2025-07-24
displayInBlog: false
tags:
  - Android
  - Jetpack Compose
  - UI
  - Declarative
series:
  name: "Jetpack Compose Advanced Applications and Internals"
  part: 2
  total: 3
seo:
  title: "Jetpack Compose Internals, Part 2: Advanced State Management"
  description: "Explore Compose state beyond remember and mutableStateOf, including Snapshot, state hoisting, state holders, derived state, and Effect APIs."
  pageType: article
---
> This is part 2 of the 3-part "Jetpack Compose Advanced Applications and Internals" series. In the previous article, we discussed "Introduction: The Declarative UI Paradigm Shift".

## 3. Advanced State Management: Beyond remember { mutableStateOf(...) }

Compose provides a rich and powerful set of state management mechanisms.

### 1. Basic state types

- **State&lt;T&gt; and MutableState&lt;T&gt;:** the basic state representation in Compose. Reading `.value` subscribes the current scope to recomposition. Writing `.value` triggers recomposition for `MutableState`.
- **remember:** keeps state, or any computed result, across recompositions.

### 2. Snapshot System - the core of concurrent state

- **Concept:** Compose state management is built on a Snapshot system similar to software transactional memory, or STM. All **writes** to MutableState first happen inside an **isolated snapshot** on the current thread. These modifications are invisible to other threads, and to other recompositions already in progress. Only when the snapshot is **applied**, usually by the Compose framework at the end of event handling or at the start of the next frame, do those changes become globally visible and trigger the corresponding recompositions.
- **Benefits:**
  - **Atomicity:** a group of state changes is either applied together or not applied at all.
  - **Isolation:** concurrent reads, such as those during recomposition, do not observe unapplied and inconsistent intermediate states.
  - **Consistency:** UI state remains consistent.
- **Foundation for advanced features:** the Snapshot system underpins advanced capabilities such as `derivedStateOf` and multi-threaded state mutation.

### 3. State Hoisting

- **Pattern:** lift State to the **lowest common ancestor** in the Composable hierarchy that needs access to it. Child components receive **immutable** state data as parameters and send events or mutation requests upward to the state owner through callbacks, usually lambdas.
- **Benefits:**
  - **Single Source of Truth:** state is managed in one place, avoiding duplicate state and inconsistency.
  - **Reusability:** child components do not own state, making them more generic and reusable.
  - **Testability:** child components are easier to preview and unit test by passing fake data and empty lambdas. The state management logic can also be tested independently at the hoisted location.

This is a **core pattern** for building maintainable UI in Compose.

### 4. ViewModel and state holder classes

- **ViewModel:** commonly acts as the screen-level state holder and business logic unit, following Android Architecture Components guidance. State in the ViewModel, often exposed through StateFlow, drives the entire screen UI.
- **State Holder Class:** for the state and UI logic of a specific complex Composable, such as a dropdown menu or editable list item, you can create a plain Kotlin class as its state holder. This class owns the relevant MutableState values and provides methods for handling events. The Composable creates and `remember`s the state holder instance, then delegates state and event handling to it. **Benefit:** the Composable itself stays simpler and only describes UI, while state logic is encapsulated, easier to test, and easier to reuse.

### 5. Derived and produced state

- **derivedStateOf { calculation }:**
  - **Scenario:** use it when a UI state value needs to be computed from one or more other State objects.
  - **Smart computation:** the `calculation` lambda is re-executed only when one of the State objects it reads internally **actually changes**. If a dependency triggers recomposition but its value is unchanged, `derivedStateOf` does not recalculate.
  - **Benefit:** avoids unnecessary and potentially expensive computation, improving performance. For example, compute whether a "select all" button should be enabled from list state.

- **produceState(initialValue, key1, ...) { ... }:**
  - **Scenario:** use it when non-Compose state, such as Flow, LiveData, or data fetched by a suspend function, must be converted into Compose State.
  - **Mechanism:** starts a coroutine tied to the Composition. Inside that coroutine scope, State can be updated with `value = ...`. If any key parameter changes, the current coroutine is cancelled and a new one is launched to produce state again.
  - **Benefit:** the standard way to bridge asynchronous data sources into the Compose state system. It automatically handles coroutine startup, cancellation, and restart.

- **Flow.collectAsState() / Flow.collectAsStateWithLifecycle():**
  - **Scenario:** convert Kotlin Flow, whether a cold flow or StateFlow/SharedFlow, into Compose State.
  - `collectAsState()`: simply collects the Flow and updates State whenever a new value arrives.
  - `collectAsStateWithLifecycle()` (recommended): collects Flow while respecting the component lifecycle, for example stopping collection on `onStop` and resuming on `onStart`, which avoids unnecessary background resource usage. It requires the `androidx.lifecycle.runtime.compose` dependency.

### 6. State saving and restoration with rememberSaveable

- **Scenario:** restore UI state after an Activity or process is recreated because of a configuration change, such as screen rotation, or system reclaim.
- **Usage:** use `rememberSaveable { mutableStateOf(...) }` instead of `remember`.
- **Requirement:** the state type must be storable in a Bundle, such as primitives, Parcelable, Serializable, or a type with a custom Saver.
- **Principle:** internally, it uses Android's `onSaveInstanceState` / `onCreate(savedInstanceState)` mechanism.

---

## 4. Side-Effect Handling: Interacting with the World Outside Compose

The core responsibility of a Composable function is describing UI. The function itself should be pure. Any operation that interacts with the outside world, such as network requests, database reads and writes, launching coroutines, or registering listeners, is a **side effect** and must be executed safely through dedicated Effect APIs.

### 1. Why Effect APIs are needed

Executing side effects directly in the body of a Composable function causes problems:

- **Unpredictable execution:** a Composable may run on every recomposition, causing side effects to be accidentally triggered multiple times.
- **Lifecycle issues:** side effects may need setup when a Composable enters Composition and cleanup when it leaves, such as registering and unregistering listeners. Code written directly in the function body cannot express this lifecycle.

### 2. Key Effect APIs

- **LaunchedEffect(key1, key2, ...) { block }:**
  - **Behavior:** when `LaunchedEffect` first enters Composition, or when any key parameter changes, it launches a new coroutine to execute suspend functions inside `block`. When a key changes or the Composable leaves Composition, the previous coroutine is automatically cancelled.
  - **Use cases:** execute **one-time** or **restartable** suspend operations related to Compose state or lifecycle. Examples include fetching user data by `userId`, showing a Snackbar when `scaffoldState` changes, or triggering an animation based on state.
  - **Key point:** key parameters determine when `block` runs again. `key1 = Unit` or `key1 = true` means run only once when entering Composition.

- **rememberCoroutineScope(): CoroutineScope:**
  - **Behavior:** obtains a CoroutineScope bound to the lifecycle of the current Composable call site.
  - **Use cases:** launch a coroutine from a **non-Composable context**, such as a button's `onClick` lambda, while keeping it synchronized with the UI lifecycle. The coroutine is automatically cancelled when the Composable leaves Composition.
  - **Compared with LaunchedEffect:** `LaunchedEffect` automatically launches a coroutine when the Composable enters Composition or when keys change. `rememberCoroutineScope` gives you a scope so you can manually `launch` a coroutine when needed, such as in an event callback.

- **DisposableEffect(key1, key2, ...) { onDispose { cleanup } }:**
  - **Behavior:** when `DisposableEffect` enters Composition or a key changes, it executes its main block, usually for setup. It **must** return an `onDispose` lambda. When the Composable leaves Composition, or a key change restarts the Effect, the `onDispose` lambda is executed.
  - **Use cases:** manage resources or callbacks that require **cleanup**. Examples include registering and unregistering a BroadcastReceiver, adding and removing a LifecycleObserver, or subscribing and unsubscribing from an external data source.
  - **Key point:** `onDispose` is the core of this API and performs the paired cleanup work.

- **SideEffect { block }:**
  - **Behavior:** code inside `block` is called **after every successful** recomposition.
  - **Use cases:** synchronize Compose state to an external object not managed by Compose, effectively "publishing" state. For example, update an analytics or logging library with the current Compose state value. **Its use cases are very limited, so use it carefully.**

- **produceState, also an Effect:** as discussed earlier, it converts asynchronous sources into State and essentially launches a managed coroutine.

- **rememberUpdatedState(value): State&lt;T&gt;:**
  - **Scenario:** in a long-running Effect, such as `LaunchedEffect` or `DisposableEffect`'s `onDispose`, you need access to the latest value passed into the Composable, not the stale value captured when the Effect started.
  - **Usage:** `val latestOnValueChange by rememberUpdatedState(onValueChange)`. Always use `latestOnValueChange` inside the Effect lambda.
  - **Benefit:** avoids stale lambdas or state values captured inside an Effect when the key has not changed.

---

---

> In the next article, we will explore "The Compose Layout Model: Declarative Measurement and Placement". Stay tuned for the rest of the series.

**"Jetpack Compose Advanced Applications and Internals" series**

1. Introduction: The Declarative UI Paradigm Shift
2. **Advanced State Management: Beyond remember { mutableStateOf(...) }** (this article)
3. The Compose Layout Model: Declarative Measurement and Placement
