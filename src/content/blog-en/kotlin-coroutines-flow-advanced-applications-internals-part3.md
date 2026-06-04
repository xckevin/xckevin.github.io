---
title: "Kotlin Coroutines and Flow: Advanced Usage and Internals (3): Dispatchers and Flow"
lang: en
translationKey: kotlin-coroutines-flow-advanced-applications-internals-part3
slug: kotlin-coroutines-flow-advanced-applications-internals-part3
excerpt: "Part 3 of the Kotlin Coroutines and Flow series, covering coroutine dispatchers, context switching, cold Flow, flowOn, and backpressure."
publishDate: '2025-03-30'
displayInBlog: false
tags:
- "Android"
- "Kotlin"
- "Kotlin Coroutines"
- "Kotlin Flow"
series:
  name: "Kotlin Coroutines and Flow: Advanced Usage and Internals"
  part: 3
  total: 5
seo:
  title: "Kotlin Coroutines and Flow Internals (3): Dispatchers and Flow"
  description: "Covers Kotlin coroutine dispatchers, withContext, cold Flow, builders, operators, flowOn, and backpressure strategies such as buffer and collectLatest."
  pageType: article
---
> This is part 3 of the five-part series "Kotlin Coroutines and Flow: Advanced Usage and Internals." In the previous article, we covered "Structured Concurrency: Ending Coroutine Leaks and Chaos."

## 3. Dispatchers: Where Coroutines Run

`CoroutineDispatcher` determines the thread or thread pool where coroutine code actually executes. It is part of `CoroutineContext`.

### 1. Standard Dispatchers

- **Dispatchers.Default:**
  - **Thread pool:** a JVM-shared background thread pool whose size is usually equal to the number of CPU cores, with a minimum of 2.
  - **Use case:** CPU-intensive computation, such as sorting, complex data parsing, and image processing, as long as the work does not involve blocking IO. Do not run blocking IO here.
- **Dispatchers.IO:**
  - **Thread pool:** a JVM-shared background thread pool that can create more threads on demand, with a relatively high upper bound such as 64 or more.
  - **Use case:** blocking IO operations such as network requests, file reads and writes, and database access. Because IO operations spend most of their time with threads blocked while waiting, additional threads improve concurrent throughput.
- **Dispatchers.Main:**
  - **Thread:** the Android application's main thread, or UI thread.
  - **Use case:** any operation that needs to interact with UI, such as updating Views, showing Toasts, or calling Android APIs that must run on the main thread.
  - **.immediate:** `Dispatchers.Main.immediate` is an optimization. If execution is already on the main thread, it tries to run coroutine code immediately instead of posting to the event queue first. This can reduce a small amount of latency, but its behavior needs care in complex cases.
- **Dispatchers.Unconfined:**
  - **Behavior:** when the coroutine starts, it runs on the **current caller thread**. After the first suspension point, it **resumes** on the thread that resumes the coroutine, meaning the thread that executes `continuation.resumeWith`. The execution thread may change between suspension and resumption.
  - **Use case:** **very limited.** Most application code does not need it. It may be used in certain very low-latency scenarios where the execution thread does not matter, or inside some framework and library implementations. **It can easily cause thread confusion and is not recommended for routine use.**

### 2. Switching Dispatchers: withContext(Dispatcher) { ... }

- **Purpose:** temporarily switch to a specified dispatcher inside a coroutine to execute a code block, then automatically switch back to the original dispatcher when the block completes. It is a `suspend` function.
- **Core use:** **wrap work that must run on a specific thread or thread pool, such as IO operations or CPU computation, while keeping caller code simple.** For example, a coroutine started in `viewModelScope` on the main thread can use `withContext(Dispatchers.IO)` to perform network or database work.
- **Return value:** `withContext` returns the result of its code block.

```kotlin
viewModelScope.launch { // Starts on Dispatchers.Main.immediate
    val userData = fetchUserData() // Calls suspend function below
    updateUi(userData) // Back on Main thread automatically
}

suspend fun fetchUserData(): UserData {
    // Switch to IO dispatcher for network call
    return withContext(Dispatchers.IO) {
        // This block runs on an IO thread
        val response = RetrofitClient.api.getUser()
        processResponse(response) // Still on IO thread
    } // Switches back to the original caller's dispatcher (Main) after block completes
}
```

---

## 4. Flow Deep Dive: Reactive Streams for the Coroutine Era

Flow is the core tool in the Kotlin coroutine ecosystem for handling asynchronous data streams.

### 1. Cold Stream Behavior

- By default, Flow is **cold**. This means the code inside a Flow builder such as `flow { ... }` starts running only when a **terminal operator**, such as `collect`, subscribes to it.
- **Each terminal operator triggers an independent Flow execution.** If there are multiple `collect` calls, the code inside `flow { ... }` runs multiple times.

### 2. Core Components

- **Builders:** create Flow instances, such as `flow { emit(T) }`, `flowOf(T...)`, `List<T>.asFlow()`, `channelFlow`, and `callbackFlow`.
- **Intermediate operators:** transform, filter, and combine Flows, returning a new Flow without triggering execution. Examples include `map`, `filter`, `transform`, `zip`, `combine`, `flatMapConcat`, `flatMapMerge`, `flatMapLatest`, `flowOn`, `buffer`, `conflate`, `catch`, and `onCompletion`. These operators are usually `suspend` functions or inline functions.
- **Terminal operators:** consume a Flow and trigger its execution. They are usually `suspend` functions. Examples include `collect`, `first`, `single`, `toList`, `toSet`, `count`, `reduce`, `fold`, and `launchIn(scope)`.

### 3. flowOn(Dispatcher): Specifying the Upstream Execution Thread

- **Key role:** changes the CoroutineContext, especially the Dispatcher, for the Flow builder and all intermediate operators **before it**.
- **Usage:** `myRepository.getData().map { ... }.flowOn(Dispatchers.IO).collect { ... }`. In this example, `getData()`, assuming it is implemented with `flow { ... }`, and `map` run on `Dispatchers.IO`, while `collect` runs in the caller's context, such as the main thread.
- **Compared with withContext:** `withContext` changes the context for a small block of code. `flowOn` affects the execution context of the entire upstream Flow.

### 4. Backpressure: What Happens When the Producer Is Faster Than the Consumer?

- **Default behavior:** suspension. When `collect` cannot keep up, upstream `emit` calls suspend and wait until `collect` finishes processing the current element.
- **Buffering, `buffer(capacity)`:**
  - Adds a buffer between producer and consumer, internally using Channel. The producer can emit quickly into the buffer until it is full, while the consumer takes data from the buffer for processing.
  - Allows producer and consumer to run concurrently, improving throughput.
  - `capacity`: buffer size. `Channel.BUFFERED` defaults to 64, `Channel.CONFLATED` keeps only the latest value, and `Channel.RENDEZVOUS` has capacity 0, similar to an unbuffered channel.
  - Be aware that the buffer can consume extra memory.
- **Conflation, `conflate()`:**
  - When the producer emits a new value while the consumer is still processing an old value, all unprocessed values in the buffer are **dropped**, and only the **latest** value is retained for the consumer.
  - Useful when only the latest state matters, such as UI updates.
- **Latest-only processing, `collectLatest { action }`:**
  - A terminal operator. When Flow emits a new value, if the suspending `action` for the **previous** value is still running, that previous action is **cancelled**, and a new action starts for the new value.
  - Useful when only the latest event needs a response, such as rapid user input that triggers search, where only the final query should be processed.

(Diagram: Flow backpressure strategies)

```plain
Producer:  --E1---E2---E3---E4---E5--> emit()

Collector:  | Process(E1) | Process(E2) | Process(E3) | ... -> collect() (Slow)

Default (Suspend):
Producer:  --E1(sus)E2(sus)E3(sus)E4---> emit() waits for collector

buffer(1): (Producer runs ahead slightly)
Buffer:    [E2] [E3]
Producer:  --E1---E2---E3---E4-------> emit() fills buffer then suspends
Collector:  | Process(E1) | Process(E2) | Process(E3) | ... -> collect() takes from buffer

conflate(): (Only latest matters)
Producer:  --E1---E2---E3---E4---E5--> emit() continuously
Collector:  | Process(E1) | Process(E3) | Process(E5) | ... -> collect() gets latest when ready

collectLatest(): (Cancel previous processing)
Producer:  --E1---E2---E3---E4---E5--> emit()
Collector Action: | Prc(E1) | Prc(E2) | Prc(E3)-cancel| Prc(E4)-cancel| Process(E5) | ...
```

---

---

> In the next article, we will cover "StateFlow and SharedFlow: Hot-Flow State and Event Buses."

**Kotlin Coroutines and Flow: Advanced Usage and Internals - Series Index**

1. Introduction: From Callback Hell to Structured Concurrency
2. Structured Concurrency: Ending Coroutine Leaks and Chaos
3. **Dispatchers: Where Coroutines Run** (this article)
4. StateFlow and SharedFlow: Hot-Flow State and Event Buses
5. Cancellation: Stopping Gracefully
