---
title: "Kotlin Coroutines and Flow: Advanced Usage and Internals (2): Structured Concurrency"
lang: en
translationKey: kotlin-coroutines-flow-advanced-applications-internals-part2
slug: kotlin-coroutines-flow-advanced-applications-internals-part2
excerpt: "Part 2 of the Kotlin Coroutines and Flow series, covering structured concurrency, scopes, Job hierarchies, supervision, and Android scopes."
publishDate: '2025-03-30'
displayInBlog: false
tags:
- "Android"
- "Kotlin"
- "Kotlin Coroutines"
- "Kotlin Flow"
series:
  name: "Kotlin Coroutines and Flow: Advanced Usage and Internals"
  part: 2
  total: 5
seo:
  title: "Kotlin Coroutines and Flow Internals (2): Structured Concurrency"
  description: "Explains structured concurrency in Kotlin Coroutines, including CoroutineScope, Job hierarchies, SupervisorJob, lifecycle scopes, and cancellation."
  pageType: article
---
> This is part 2 of the five-part series "Kotlin Coroutines and Flow: Advanced Usage and Internals." In the previous article, we covered "Introduction: From Callback Hell to Structured Concurrency."

## 2. Structured Concurrency: Ending Coroutine Leaks and Chaos

This is the core advantage that distinguishes coroutines from other concurrency models such as raw threads and `GlobalScope`.

### 1. Core Idea

A coroutine's lifecycle should be bound to the scope that executes it. When that scope ends, all coroutines launched inside it should be cancelled automatically. This greatly simplifies resource management and prevents coroutine leaks.

### 2. Core Concepts

- **CoroutineScope:** defines a coroutine scope. Every scope has an associated CoroutineContext, which usually contains a Job.
- **Job:** represents a cancellable unit of work with lifecycle states such as Active, Completing, Completed, Cancelling, and Cancelled. Jobs can be organized into parent-child hierarchies.

### 3. Key Principles of Structured Concurrency

- **Scope constraint:** coroutines must be started inside a CoroutineScope by using builders such as `launch` and `async`.
- **Lifecycle binding:** a coroutine's lifecycle is controlled by the Job in its CoroutineScope. Cancelling the scope's Job **recursively cancels** all child Jobs and their coroutines.
- **Parent-child relationship:**
  - **The parent waits for its children:** a parent Job can enter the completed state only after all of its child Jobs have completed.
  - **A child failure collapses the parent by default:** if a child coroutine, when it is not a direct child under a SupervisorJob, fails with an uncaught exception, it cancels its parent Job. The parent then cancels all other child Jobs.

### 4. Common Scopes and Builders

- **GlobalScope:** **use with caution.** This is a global singleton scope whose lifecycle is tied to the entire application process. Coroutines launched in `GlobalScope` can easily leak because they are not automatically cancelled when a specific UI component or business operation ends. It is mainly suitable for certain top-level long-lived background tasks, and even then it requires very careful manual management.
- **runBlocking { ... }:** starts a coroutine and **blocks the current thread** until all work inside it completes. It is mainly used to bridge blocking code with the suspending world, for example calling a `suspend` function from a `main` function or test code. **Do not use it on the Android main thread or inside another coroutine unless you clearly understand the consequences.**
- **coroutineScope { ... }**, a suspend function: creates a **structured nested scope**. It inherits the outer scope's context but has its own Job. It **suspends** the caller until all child coroutines launched inside it complete. If any child coroutine inside it fails, `coroutineScope` itself fails, rethrows the exception, and cancels the other child coroutines. It is commonly used to split one piece of work into multiple parallel subtasks and wait for all of them.
- **supervisorScope { ... }**, a suspend function: similar to `coroutineScope`, it creates a nested scope and waits for child tasks to complete. **The key difference** is that it uses a SupervisorJob. Failure of one of its direct child coroutines **does not** make `supervisorScope` fail and **does not** cancel sibling child coroutines. Exceptions must be handled by the child coroutine itself, or through `CoroutineExceptionHandler`. It is useful when child task failures should be isolated, such as several independent data-loading regions on one UI screen.

### 5. Android Jetpack Scopes

- **viewModelScope**, a ViewModel extension property: a preconfigured scope inside ViewModel whose lifecycle is bound to the ViewModel and is automatically cancelled when `onCleared()` runs. Internally it uses `SupervisorJob + Dispatchers.Main.immediate`. **It is the preferred way to launch coroutines in a ViewModel for business logic and data loading.**
- **lifecycleScope**, a LifecycleOwner extension property: a preconfigured scope inside Activity and Fragment whose lifecycle is bound to the component's Lifecycle and is automatically cancelled when the Lifecycle reaches DESTROYED. It also uses `SupervisorJob + Dispatchers.Main.immediate` internally. It provides APIs such as `launchWhenCreated`, `launchWhenStarted`, and `launchWhenResumed`, which launch coroutines in specific lifecycle states and automatically pause or cancel when the state exits.

### 6. Job() vs. SupervisorJob()

- **Job():** child task failure cancels the parent task and all sibling tasks. This is the default failure propagation behavior.
- **SupervisorJob():** child task failure does not affect the parent or sibling tasks, providing failure isolation. `viewModelScope` and `lifecycleScope` use it by default. You can also create a custom scope with `CoroutineScope(SupervisorJob() + ...)`.

(Diagram: structured concurrency - Job hierarchy and cancellation)

```plain
+---------------------------------------------+
| CoroutineScope (Parent Job)                 |
|---------------------------------------------|
|    launch { // Child Job 1                 |
|      ...                                    |
|      launch { // Grandchild Job 1.1        | --------+
|        ...                                  |         | Cancellation
|      }                                      |         | propagates down
|    } // Child Job 1 completes when 1.1 done |         V
|                                             |
|    async { // Child Job 2 (using default Job) |
|      ...                                    |
|      if (error) throw Exception() --------->|--- X (Failure)
|      ...                                    |
|    } // Failure here cancels Parent & Child 1|
|                                             |
|    launch(SupervisorJob()) { // Child Job 3 |
|      launch { // Grandchild Job 3.1        |
|        if (error) throw Exception() ------->|--- X (Failure) - Only 3.1 fails, 3 survives
|      }                                      |
|    } // Child Job 3 unaffected by 3.1 failure|
+---------------------------------------------+
   |
   | Parent Job completes only when ALL (non-failing or supervised) children complete.
   | If Parent Job is cancelled, ALL children are cancelled.
```

---

---

> In the next article, we will cover "Dispatchers: Where Coroutines Run."

**Kotlin Coroutines and Flow: Advanced Usage and Internals - Series Index**

1. Introduction: From Callback Hell to Structured Concurrency
2. **Structured Concurrency: Ending Coroutine Leaks and Chaos** (this article)
3. Dispatchers: Where Coroutines Run
4. StateFlow and SharedFlow: Hot-Flow State and Event Buses
5. Cancellation: Stopping Gracefully
