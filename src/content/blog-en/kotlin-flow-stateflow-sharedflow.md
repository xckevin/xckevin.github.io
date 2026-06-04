---
title: "Kotlin Flow Engineering: Cold Flows, Channels, StateFlow, and SharedFlow"
lang: en
translationKey: kotlin-flow-stateflow-sharedflow
slug: kotlin-flow-stateflow-sharedflow
excerpt: "A practical guide to Kotlin Flow's cold and hot stream models, Channel primitives, SharedFlow and StateFlow tradeoffs, and Android MVVM layer choices."
publishDate: '2026-04-23'
tags:
- "Kotlin"
- "Android"
- "Kotlin Coroutines"
- "Kotlin Flow"
- "Architecture"
seo:
  title: "Kotlin Flow Engineering: Cold Flows, StateFlow, SharedFlow, and Channels"
  description: "Explains Kotlin Flow cold streams, backpressure, Channel, StateFlow, SharedFlow, events, state, and Android architecture choices."
  pageType: article
---

While debugging a production issue, I found a screen whose UI state briefly flickered after a configuration change. The cause was `SharedFlow(replay = 0)`: the new subscriber missed the most recent state update. That bug pushed me to revisit Flow's cold/hot model and the selection logic for the three common hot-stream tools.

## Cold Flow: Lazy Evaluation and Subscriber Isolation

The defining behavior of a cold flow is this: **each collection triggers an independent execution**. A Flow is just a description of how to produce data. Without a collector, it does not run.

```kotlin
val coldFlow = flow {
    println("start producing")
    emit(1)
    emit(2)
}

// Two independent collections each trigger "start producing" once
coldFlow.collect { println(it) }
coldFlow.collect { println(it) }
```

This is similar to RxJava's `Observable.create()`. Flow is lighter, though. It is not built around a deep class hierarchy; it is based on suspend-function lambdas. Backpressure is naturally handled by coroutine suspension, so Flow does not need the `Flowable` versus `Observable` type split.

The backpressure strategy is hidden inside the suspending behavior of `emit`. When downstream is slower than upstream, `emit` suspends and waits. It does not OOM and it does not require a declared `BackpressureStrategy`. That is a real engineering advantage over RxJava.

## Channel Is the Primitive Behind Hot Streams

Before hot flows make sense, you need to understand `Channel`. A Channel is a coroutine communication primitive, essentially a suspending queue with capacity.

```kotlin
val channel = Channel<Int>(capacity = Channel.BUFFERED)

// Producer coroutine
launch { channel.send(1) }

// Consumer coroutine: only one consumer can receive each value
launch { println(channel.receive()) }
```

The key property of Channel is that **send and receive are one-to-one**. One message can be consumed by only one consumer. `SharedFlow` and `StateFlow` use Channel-like primitives internally to provide broadcast semantics, so multiple subscribers can observe the same data.

A common misconception is treating Channel and Flow as competing abstractions. Their boundaries are clear: **Channel is good for point-to-point event passing between coroutines; Flow is good for observer-oriented data streams**. In a ViewModel, you almost never expose a Channel directly to the UI layer, but the `channelFlow` builder lets a Flow borrow Channel's concurrency capabilities internally:

```kotlin
val concurrentFlow = channelFlow {
    launch { send(fetchFromNetwork()) }  // Concurrent production
    launch { send(fetchFromCache()) }
}
```

`channelFlow` solves the limitation that a normal `flow { }` block emits sequentially from a single coroutine.

## SharedFlow: Broadcast Semantics and Sticky-Event Traps

`SharedFlow` is a true hot flow. Values can be emitted and cached even when there are no subscribers.

```kotlin
val sharedFlow = MutableSharedFlow<Int>(
    replay = 1,         // New subscribers receive the latest historical value
    extraBufferCapacity = 64,  // Extra buffer capacity to reduce backpressure stalls
    onBufferOverflow = BufferOverflow.DROP_OLDEST
)
```

`replay` is the easiest parameter to misuse. With `replay = 0`, new subscribers receive no historical values. With `replay > 0`, you create a sticky event. That is dangerous for UI navigation events.

**One-time events such as Toasts and navigation should not use a replaying SharedFlow**, or a recreated screen may trigger navigation again. The usual pattern is `replay = 0` and emitting from the ViewModel:

```kotlin
// ViewModel
private val _navigationEvent = MutableSharedFlow<Screen>(replay = 0)
val navigationEvent = _navigationEvent.asSharedFlow()

fun navigateTo(screen: Screen) {
    viewModelScope.launch {
        _navigationEvent.emit(screen)
    }
}
```

Backpressure behavior depends on the scenario. For UI events, dropping the latest value is often safer than blocking a coroutine, so `DROP_LATEST` is a reasonable default for many UI-event paths.

## StateFlow: State Holding and How It Differs from LiveData

`StateFlow` is a specialized `SharedFlow`: **it forces `replay = 1`, requires an initial value, and deduplicates repeated values**. Its behavior is close to LiveData, but several differences matter.

```kotlin
val stateFlow = MutableStateFlow(UiState.Loading)

// Identical values do not trigger downstream collectors
stateFlow.value = UiState.Loading   // Does not emit
stateFlow.value = UiState.Success(data)  // Emits
```

Deduplication depends on `equals()`. This is fine when state is modeled with data classes. But if the state contains reference types such as `List` and you expect every assignment to emit, pay attention: two lists with the same contents return `true` from `equals`, so downstream will not be notified.

Compared with LiveData, `StateFlow` does not depend on the Android lifecycle framework and can be used in pure Kotlin modules. It supports the full Flow operator chain, so `map`, `filter`, and `combine` can operate directly on state streams. Reads and writes through `value` are thread-safe and do not need extra synchronization. In real projects, combining several data sources into one UI state is straightforward:

```kotlin
val uiState = combine(
    userRepository.userFlow,
    settingsRepository.settingsFlow
) { user, settings ->
    UiState(user = user, darkMode = settings.darkMode)
}.stateIn(
    scope = viewModelScope,
    started = SharingStarted.WhileSubscribed(5000),
    initialValue = UiState.Loading
)
```

`stateIn` converts a cold flow into a hot flow. `SharingStarted.WhileSubscribed(5000)` means upstream collection stops 5 seconds after the last subscriber leaves. That 5000 ms window conveniently covers Activity recreation during configuration changes and avoids unnecessary refetching.

## Choosing Flow Types Across MVVM Layers

The three stream types map cleanly to MVVM layers.

**The Repository layer** should expose cold flows. Database queries and network requests are naturally cold: each subscription triggers an independent request, and coroutine suspension handles backpressure. Room's `Flow<T>` DAO return type follows this model.

**The ViewModel layer** converts cold streams into hot streams. Use `stateIn` or `shareIn` to turn Repository flows into streams that keep UI state available. The rule is: **use StateFlow for UI state, and `SharedFlow(replay = 0)` for one-time events**.

```kotlin
class FeedViewModel(repo: FeedRepository) : ViewModel() {

    // UI state: StateFlow has an initial value and supports configuration-change recovery
    val feedState = repo.feedFlow()
        .map { FeedUiState(items = it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), FeedUiState.Loading)

    // One-off events: SharedFlow with replay=0 prevents duplicate delivery
    private val _errorEvent = MutableSharedFlow<String>(replay = 0)
    val errorEvent = _errorEvent.asSharedFlow()
}
```

**The UI layer, whether Fragment or Compose, should only collect and render.** It should not host business logic. Bind collection to the lifecycle with `repeatOnLifecycle(Lifecycle.State.STARTED)`:

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.feedState.collect { state ->
            updateUi(state)
        }
    }
}
```

`repeatOnLifecycle` is safer than `launchWhenStarted`. The latter only suspends the coroutine when the lifecycle is stopped, while upstream may keep running. The former cancels collection and restarts it when the lifecycle returns to the foreground. For continuous sources such as location updates or sensors, that difference matters.

## Practical Decisions

**Channel vs SharedFlow**: In a ViewModel, prefer `SharedFlow(replay = 0)` over exposing Channel-based events. Flow has a richer operator ecosystem, and `SharedFlow` has clearer semantics for multiple subscribers. Keep Channel for internal coroutine communication, such as coordinating concurrent work inside `channelFlow`.

**The default value of `replay`**: Treat it as a parameter you must decide deliberately, not something to casually set to `1`. Before setting it, ask: does a new subscriber need historical data? What happens if it misses the latest value?

**Repository boundaries**: Do not use `MutableStateFlow` as a data source in the Repository layer. Database and network lifecycles should be managed by the ViewModel's `viewModelScope`; the Repository should describe data, not own UI-facing state. Once that boundary gets blurry, state management quickly becomes tangled. I have seen that pattern fail across multiple projects.

Understand the core differences between cold and hot flows, Channel's point-to-point semantics, and `replay`'s sticky behavior. Once those three concepts are clear, most Flow-related engineering decisions converge naturally.

<!-- seo-internal-links -->

## Further Reading

- [Back to the Kotlin and Coroutines topic](/en/kotlin-coroutines/)
- [Kotlin `suspend` internals: CPS, Continuation, and state-machine bytecode](/en/blog/kotlin-suspend-state-machine/)
- [Advanced Kotlin Coroutines and Flow usage](/blog/kotlin-coroutines-与-flow-的高级应用与原理/)
- [Kotlin K2 compiler: unified frontend, type inference, and Android build impact](/en/blog/kotlin-k2-compiler-android/)
<!-- /seo-internal-links -->
