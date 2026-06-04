---
title: "Advanced Kotlin Coroutines and Flow (5): Cancellation: Stopping Gracefully"
lang: en
translationKey: kotlin-coroutines-flow-advanced-applications-internals-part5
slug: kotlin-coroutines-flow-advanced-applications-internals-part5
excerpt: "Part 5 of the Advanced Kotlin Coroutines and Flow series: cancellation, graceful shutdown, testing, comparisons, pitfalls, and best practices."
publishDate: 2025-03-30
displayInBlog: false
tags:
  - Android
  - Kotlin
  - Coroutines
  - Flow
series:
  name: "Advanced Kotlin Coroutines and Flow"
  part: 5
  total: 5
seo:
  title: "Kotlin Coroutines and Flow Cancellation, Testing, and Pitfalls"
  description: "Learn coroutine cancellation, NonCancellable cleanup, coroutine and Flow testing, RxJava comparisons, and common Android coroutine pitfalls."
  pageType: article
---
> This is part 5 of the five-part series "Advanced Kotlin Coroutines and Flow." In the previous article, we covered "StateFlow and SharedFlow: Hot Stream State and Event Buses."

## 8. Cancellation: Stopping Gracefully

Coroutine cancellation is also based on structured concurrency and cooperative mechanisms.

### 1. Propagation

Cancellation requests propagate downward from a parent `Job` to all child `Job`s. You trigger this by calling `scope.cancel()` or `job.cancel()`.

### 2. Cooperative Cancellation

Coroutine code must **actively** check cancellation state and respond to it before it can be cancelled effectively.

- **Built-in checkpoints:** All **suspending functions** in the `kotlinx.coroutines` library, such as `delay`, `yield`, `withContext`, `channel.receive`, and Flow operators, check internally whether the current coroutine has been cancelled. If it has, they throw a `CancellationException`.
- **Manual checks:** For long-running, CPU-intensive loops that **do not** call suspending functions, you must **manually** check cancellation state:
  - `if (!isActive) return` or `if (!isActive) throw CancellationException()`
  - `ensureActive()`: throws `CancellationException` if the coroutine has been cancelled.
  - `yield()`: suspends the current coroutine, allows other coroutines to run, and checks cancellation state at the same time.
- **CancellationException:** This is the standard signal for coroutine cancellation. It is usually treated as normal control flow, and default exception handlers such as `CoroutineExceptionHandler` usually ignore it.

### 3. NonCancellable Context

- **Use case:** Running cleanup work that must finish inside a `finally` block or `onCompletion`, such as releasing file handles or closing network connections, even after the coroutine has already been cancelled.
- **Usage:** `withContext(NonCancellable) { // cleanup code }`. Inside this block, the coroutine temporarily stops responding to cancellation requests. **Use this carefully and avoid long-running work.**

:::danger
Pay close attention:

- **Do not catch blindly:** If you write `catch (e: Exception)` in coroutine code, make sure you rethrow `CancellationException` with `throw e`. Otherwise the coroutine will effectively "pretend it did not hear" the cancellation signal and keep running, wasting resources or causing memory leaks.
- **Non-cancellable suspend functions:** If a coroutine is stuck inside a suspend function that does not check cancellation state, such as some I/O operations, it may not respond to cancellation promptly.
:::

---

## 9. Testing Coroutines and Flow

The `kotlinx-coroutines-test` library provides strong testing support.

### 1. runTest { ... }

- **Core test builder:** Replaces `runBlockingTest`. It provides a `TestScope` that runs on a `TestDispatcher`.
- **Virtual time:** By default, time-related suspending functions such as `delay` complete immediately through virtual time advancement, so tests do not need to actually wait.
- **Dispatcher control:** You can inject and control `TestDispatcher` implementations, such as `StandardTestDispatcher` and `UnconfinedTestDispatcher`, to manage coroutine execution order and timing.

### 2. TestCoroutineScheduler

Provides finer control over virtual time, including `advanceTimeBy` and `runCurrent`.

### 3. Testing Flow

- Collect a Flow directly inside `runTest`.
- Use the third-party **Turbine** library (`app.cash.turbine:turbine`) for a cleaner and more powerful Flow testing API, including `flow.test { awaitItem(), expectNoEvents(), awaitComplete(), ... }`.

### 4. Dependency Injection

The **best practice** is to inject `CoroutineDispatcher` instances into classes such as ViewModels and repositories instead of directly using `Dispatchers.IO`. This makes it easy to replace them with a `TestDispatcher` in tests.

---

## 10. Coroutines vs. RxJava vs. Threads

- **Coroutines vs. Threads:** Coroutines are lighter, easier to manage, less prone to leaks because of structured concurrency, and usually produce cleaner code.
- **Coroutines vs. RxJava:**
  - **Similarities:** Both handle asynchronous data streams.
  - **Differences:**
    - **Paradigm:** Coroutines are based on suspending functions and look closer to synchronous code; RxJava is based on the observer pattern and chained operators.
    - **Conciseness:** Coroutines usually require less boilerplate.
    - **Structured concurrency:** Coroutines provide stronger built-in support.
    - **Operators:** RxJava has an extremely rich operator ecosystem; Flow's operator set is also continuing to improve.
    - **Learning curve:** Coroutines are generally considered easier to get started with.
  - **Interoperability:** The `kotlinx-coroutines-rx3` library, or the RxJava 2 equivalent, provides conversion APIs such as `Flow.asObservable()` and `Observable.asFlow()`.

For new projects, especially Kotlin-based ones, Coroutines + Flow are usually the preferred choice. For projects that already contain a large amount of RxJava code, gradual migration or mixed usage is often practical.

---

## 11. Common Pitfalls and Best Practices

- **Blocking a dispatcher:** Running blocking I/O on `Dispatchers.Default`, or running long CPU-intensive work on `Dispatchers.IO`.
- **Overusing GlobalScope:** This can cause potential leaks and make tests difficult. Prefer `viewModelScope`, `lifecycleScope`, or a custom scope.
- **Forgetting cancellation checks:** Running long loops without suspending functions and without checking `isActive`.
- **Improper exception handling:** Assuming `CoroutineExceptionHandler` can prevent cancellation; failing to catch `async` exceptions because they were never awaited; leaving child coroutine exceptions unhandled inside `supervisorScope`.
- **Incorrect SharedFlow configuration:** Misunderstanding replay, buffer, or overflow behavior, causing lost events or behavior that does not match expectations, especially for "one-time events."
- **Forgetting awaitClose in callbackFlow/channelFlow:** This leaks callbacks or listeners.
- **Overusing Dispatchers.Unconfined:** This makes thread behavior difficult to predict.
- **Hard-coding dispatchers:** This hurts testability. Dispatchers should be injected through DI.
- **Collecting Flow in the UI layer without collectAsStateWithLifecycle:** This can cause unnecessary resource consumption in the background.
- **Choosing StateFlow and SharedFlow incorrectly:** Using `StateFlow` for event streams that require guaranteed delivery, which may lose events, or using `SharedFlow` for state where only the latest value matters, which is less efficient and may emit old values.

---

## 12. Conclusion: A Modern Tool for Concurrent Programming

Kotlin Coroutines and Flow give Android developers a powerful, modern, and elegant solution for asynchronous programming. Through lightweight coroutines, transformative structured concurrency, flexible dispatchers, and feature-rich reactive streams through Flow, they greatly simplify how concurrent code is written, managed, and tested, and they address many of the pain points of older approaches.

Mastering Coroutines and Flow means more than using the APIs skillfully. It also means deeply understanding the **nature of suspension and resumption, state machine transformations, structured concurrency lifecycles and exception propagation, the right use cases and performance impact of different dispatchers, Flow's cold and hot stream models and backpressure strategies, the subtle configuration and use cases of StateFlow and SharedFlow, and the many details of coroutine cancellation and exception handling**.

Only by mastering these advanced principles and practices can you confidently build Android applications that are high performance, highly concurrent, and highly stable in the face of increasingly complex business logic and user experience requirements. This is an essential core skill for modern senior Android engineers.

---

**Advanced Kotlin Coroutines and Flow Series**

1. Introduction: Leave Callback Hell Behind and Embrace Structured Concurrency
2. Structured Concurrency: Avoid Coroutine Leaks and Chaos
3. Dispatchers: Where Coroutines Run
4. StateFlow and SharedFlow: Hot Stream State and Event Buses
5. **Cancellation: Stopping Gracefully** (this article)
