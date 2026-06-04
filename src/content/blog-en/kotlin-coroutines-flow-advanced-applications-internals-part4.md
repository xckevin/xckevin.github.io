---
title: "Kotlin Coroutines and Flow: Advanced Usage and Internals (4): StateFlow and SharedFlow"
lang: en
translationKey: kotlin-coroutines-flow-advanced-applications-internals-part4
slug: kotlin-coroutines-flow-advanced-applications-internals-part4
excerpt: "Part 4 of the Kotlin Coroutines and Flow series, covering StateFlow, SharedFlow, Channel, callbackFlow, channelFlow, and exception handling."
publishDate: '2025-03-30'
displayInBlog: false
tags:
- "Android"
- "Kotlin"
- "Kotlin Coroutines"
- "Kotlin Flow"
series:
  name: "Kotlin Coroutines and Flow: Advanced Usage and Internals"
  part: 4
  total: 5
seo:
  title: "Kotlin Coroutines and Flow Internals (4): StateFlow and SharedFlow"
  description: "Explains StateFlow, SharedFlow, Channel, callbackFlow, channelFlow, one-shot events, and coroutine and Flow exception handling patterns."
  pageType: article
---
> This is part 4 of the five-part series "Kotlin Coroutines and Flow: Advanced Usage and Internals." In the previous article, we covered "Dispatchers: Where Coroutines Run."

## 5. StateFlow and SharedFlow: Hot-Flow State and Event Buses

Cold flows are not suitable for every scenario. For example, you may need multiple subscribers to receive the same data stream without re-executing upstream work, or you may need to represent an observable current state.

### 1. StateFlow<T>: A Hot Flow for State Representation

**Characteristics:**

- **Hot flow:** it has a value as long as it exists, regardless of whether there are collectors.
- **State container:** holds one single, latest state value.
- **Initial value:** an initial value must be provided when it is created.
- **Immediate access:** a new collector immediately receives the current latest state value.
- **Value comparison:** emits a new value only when `equals()` returns false compared with the previous value, which provides de-duplication.
- **Conflation:** its internal mechanism ensures collectors receive only the latest state, while intermediate states produced too quickly are conflated, similar to `conflate()`.

**MutableStateFlow<T>:** a mutable StateFlow that provides the `value` property for reading and writing, `update { ... }` for atomic updates, and `tryEmit()` for non-suspending attempted emission.

**Use case:** **one of the best practices for exposing state from a ViewModel to the UI layer.** You can convert a cold flow to StateFlow with `stateIn(scope, SharingStarted.WhileSubscribed(5000), initialValue)`, or use `MutableStateFlow` directly, then collect it in the UI layer with `collectAsStateWithLifecycle`.

### 2. SharedFlow<T>: A General-Purpose Hot Flow and Event Bus

**Characteristics:**

- **Hot flow:** exists independently of collectors.
- **Broadcast:** can broadcast values to all current collectors.
- **Highly configurable:** constructor parameters control its behavior:
  - **replay:** an `Int` that controls how many recently emitted values are replayed to **newly joined** collectors. `0` means no replay, so new collectors receive only later values. `1` or higher is used to cache historical values.
  - **extraBufferCapacity:** an `Int` that provides extra buffer space for active collectors beyond the replay cache, useful for handling backpressure. `0` means there is no extra buffer.
  - **onBufferOverflow:** a `BufferOverflow` strategy for new `emit` operations when the buffer, meaning `replay + extraBufferCapacity`, is full: `SUSPEND`, which is the default; `DROP_OLDEST`; or `DROP_LATEST`.

**MutableSharedFlow<T>:** a mutable SharedFlow that provides `emit()` for suspending emission and `tryEmit()` for non-suspending attempted emission. `subscriptionCount: StateFlow<Int>` can observe the current number of active collectors.

**Use cases:**

- **Event bus:** broadcasting events such as user actions or background notifications to multiple listeners. Handling one-shot events needs special care, as discussed below.
- **Hot streams that need historical replay.**
- Implementing custom StateFlow-like behavior with specific configuration.

**Key considerations:**

- **Parameter selection:** the choices for `replay`, `extraBufferCapacity`, and `onBufferOverflow` are critical to SharedFlow behavior. They must be set carefully according to concrete requirements, otherwise they can cause lost events, memory leaks if the cache is too large, or deadlocks if the `SUSPEND` strategy is used and no collector consumes values.
- **Single-shot events:** if SharedFlow is used for events that **must be handled exactly once**, such as showing a Toast or navigating, be especially careful. Configuration changes can make the UI layer resubscribe, and if `replay > 0`, it may receive and process an old event again. Common solutions include: (1) use Channel instead; (2) mark events as consumed downstream with some mechanism; (3) combine this with an Event wrapper class.

---

## 6. Channel: The Messenger Between Coroutines

Channel is another hot-flow-like primitive provided by coroutines, or more precisely, a communication primitive. It is similar to a thread-safe blocking queue, but it uses `suspend` functions for sending and receiving.

### 1. Characteristics

- Hot: data is passed between sender and receiver.
- `send(element)`: suspends the sender until the element is received by `receive()` or placed in a buffer.
- `receive()`: suspends the receiver until an element is available in the Channel.
- Supports different capacities and strategies: `RENDEZVOUS`, with zero capacity where send and receive must pair; `BUFFERED`, with finite capacity; `CONFLATED`, which keeps only the latest value; and `UNLIMITED`, which has unlimited capacity and must be used carefully because of memory risk.

### 2. Builders

`Channel<E>(capacity)`, `produce<E>(context, capacity) { ... }`, which returns `ReceiveChannel<E>`.

### 3. callbackFlow<T> { ... } / channelFlow<T> { ... }

- **Purpose:** bridge callback-based APIs or actively pushed data logic into a cold Flow.
- **Mechanism:** internally creates a Channel. It provides a ProducerScope, which extends CoroutineScope and implements SendChannel, so you can safely call `send()` or `trySend()` inside it to emit data. You must call `awaitClose { cleanup_logic }`; it runs when the Flow is cancelled or closed, unregistering callbacks or cleaning up resources to **prevent leaks**.
- **Difference:** `channelFlow` is the more general version of `callbackFlow`. `callbackFlow` has optimizations for callback APIs, such as ensuring send safety.

### 4. Use Cases

Producer-consumer patterns between coroutines, scenarios that need precise control over send and receive synchronization, and bridging callback APIs.

---

## 7. Advanced Exception Handling: Handling Failure Gracefully

Structured concurrency has important implications for coroutine exception handling.

### 1. Basic try-catch

Using `try-catch` inside a `launch` or `async` block can catch exceptions thrown by the code inside that block, including called `suspend` functions. This is the most direct handling style.

### 2. Structured Concurrency Propagation

- **Default Job:** if a coroutine that is not a direct child of a SupervisorJob has an uncaught exception, the exception propagates **upward** to the parent Job. This cancels the parent Job and all sibling Jobs. Eventually, the exception may crash the application.
- **async exceptions:** if a coroutine started by `async` throws an exception, that exception is **held** until `await()` is called. If `await()` is never called, the exception may appear to be lost, unless the parent scope is cancelled.

### 3. CoroutineExceptionHandler: The Last Line of Defense

- **Role:** a CoroutineContext element used to handle **uncaught** exceptions, meaning exceptions that were not caught by `try-catch` and propagated to a scope boundary or `GlobalScope`.
- **Purpose:** **logging and error reporting.** It **cannot** stop cancellation of the coroutine or its scope.
- **Where to install it:** usually on a **top-level scope**, such as `GlobalScope`, `viewModelScope`, or `lifecycleScope`, or on a top-level `launch` builder. Installing it on a child coroutine or an intermediate non-SupervisorJob scope is usually ineffective, because the exception cancels the parent first.

### 4. supervisorScope and Exception Isolation

Inside `supervisorScope { ... }`, failure of a **direct child coroutine** **does not** propagate to the `supervisorScope` itself or to sibling child coroutines. A failed child coroutine must handle its exception **itself**, either through `try-catch` or by installing a `CoroutineExceptionHandler` on its `launch` builder.

### 5. Flow Exception Handling

- **Downstream try-catch:** the caller of `collect` can use `try-catch` to catch exceptions from `collect` itself, all upstream operators, and the Flow builder.
- **catch { e -> emit(...) } operator:**
  - **Catches only upstream exceptions:** catches only exceptions from its **upstream**, including the builder and previous operators.
  - **Provides recovery or transformation:** can emit a fallback value, log the error, or throw a different exception inside the `catch` block.
  - **Does not catch downstream exceptions:** the `catch` operator **cannot** catch exceptions that happen downstream, such as inside `collect`.
- **onCompletion { cause: Throwable? -> ... } operator:**
  - The `onCompletion` block runs whether the Flow completes normally or terminates because of an exception.
  - The `cause` parameter is non-null when termination is caused by an exception; otherwise it is null.
  - **Use:** execute cleanup logic, similar to `finally`, whether the flow succeeds or fails.

---

---

> In the next article, we will cover "Cancellation: Stopping Gracefully."

**Kotlin Coroutines and Flow: Advanced Usage and Internals - Series Index**

1. Introduction: From Callback Hell to Structured Concurrency
2. Structured Concurrency: Ending Coroutine Leaks and Chaos
3. Dispatchers: Where Coroutines Run
4. **StateFlow and SharedFlow: Hot-Flow State and Event Buses** (this article)
5. Cancellation: Stopping Gracefully
