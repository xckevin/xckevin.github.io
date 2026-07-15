---
title: "Kotlin Coroutine Cancellation: Cooperative Shutdown Done Safely"
lang: en
translationKey: kotlin-coroutine-cooperative-cancellation
slug: kotlin-coroutine-cooperative-cancellation
excerpt: "Understand cancellation propagation, structured concurrency, and how to use NonCancellable correctly for safe cleanup."
publishDate: '2026-07-01'
tags:
- "Kotlin"
- "Coroutines"
- "Structured Concurrency"
- "Concurrency"
seo:
  title: "Kotlin Coroutine Cooperative Cancellation"
  description: "A practical guide to CancellationException propagation and safe coroutine cleanup with NonCancellable."
  pageType: article
---

Last week, we investigated an online problem: after the user exited the page, the network request coroutine was not canceled as expected and continued to occupy the connection pool resources. The code clearly calls `job.cancel()`, but the log shows that the coroutine body is still running.

This leads to an easily misunderstood feature of coroutine design: **cancellation is cooperative, not preemptive**.

## Collaborative Cancellation Model

Threads can be violently interrupted (`Thread.stop()` has long been abandoned), but coroutines do not have this capability. The cancellation of coroutines relies on a premise: **The canceled code actively checks its own status and throws an exception**.

`job.cancel()` does two things: sets the status of the Job to Canceling, and then sends a cancellation signal to the coroutine. The signal itself does not interrupt executing code - it just sets a flag. What really stops the coroutine is the `CancellationException` thrown by the suspending function after detecting this flag during recovery.

```kotlin
// job.cancel() only signals cancellation; it does not interrupt printing 1 through 10.
runBlocking {
    val job = launch {
        for (i in 1..10) {
            println("running: $i")
            Thread.sleep(100) // No suspension point means cancellation cannot be observed.
        }
    }
    delay(200)
    job.cancel()
    println("cancel called, but coroutine still running...")
}
```

In this code, `Thread.sleep` will not respond to cancellation, and the loop will run completely. For cancellation to take effect, a suspend function needs to be introduced:
```kotlin
val job = launch {
    for (i in 1..10) {
        println("running: $i")
        delay(100) // delay checks cancellation and throws CancellationException.
    }
}
```

`delay` will call `ensureActive()` when resuming and throw `CancellationException` as soon as cancellation is detected.

## Special propagation rules for CancellationException

`CancellationException` inherits from `IllegalStateException`, but it is treated specially in the coroutine framework: it is not propagated to the parent coroutine and does not trigger the `CoroutineExceptionHandler`**.

This design is reasonable - cancellation is a normal behavior in the coroutine life cycle, not a program error. The canceled child coroutine will swallow the exception "silently" and only notify the parent coroutine to adjust its own status.

For example:

```kotlin
runBlocking {
    val handler = CoroutineExceptionHandler { _, e ->
        println("caught: $e")  // This line never executes.
    }
    val scope = CoroutineScope(handler)
    scope.launch {
        delay(100)
        throw CancellationException("manual cancel")
    }.join()
    println("continue normally") // Execution continues normally.
}
```

Replace it with a normal exception:
```kotlin
scope.launch {
    delay(100)
    throw RuntimeException("real error")
}.join()
// The handler runs and the parent coroutine is cancelled.
```

In the actual project, I stepped on a pitfall: after catching `CancellationException` in `try-catch`, it was not re-thrown, causing the coroutine to be unable to be canceled normally:
```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } catch (e: CancellationException) {
        log("cancelled, but silently swallowed") // Bug: the exception is swallowed.
    }
}
```

**Correct approach: You must `rethrow` after `catch`, unless you clearly know what you are doing. **

## Exception propagation path in the coroutine tree

After a Job is canceled, the cancellation will propagate downward to all sub-coroutines. The call chain is as follows:

1. `parentJob.cancel()` → Traverse the child Job list and call `childJob.cancel()` recursively
2. After each sub-Job receives the cancellation signal, it will throw `CancellationException` the next time it is suspended and resumed.
3. The `CancellationException` of the child Job will not be propagated back to the parent Job.
4. After all child jobs are completed, the status of the parent job changes from Canceling to Canceled.

Step 3 is key here - cancellation is one-way: the parent cancels the child, and the child does not pollute the parent.

If a child coroutine throws an exception other than `CancellationException` during the cancellation process, the situation is different - that exception will propagate upward normally, which may cause the parent coroutine to receive an unexpected error. This also explains why care should be taken in cancellation callbacks:

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        // Throwing anything other than CancellationException here also cancels the parent.
        throw RuntimeException("cleanup failed")
    }
}
```

## NonCancellable: The last line of defense for safe exit

After cancellation occurs, the resource cleanup code in the `finally` block still runs. But there is a restriction: the suspension function cannot be called in `finally` - the current coroutine has been canceled, and any suspension point will immediately throw a `CancellationException`.

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        delay(100) // Immediately throws CancellationException, interrupting cleanup.
        releaseResource()
    }
}
```

`releaseResource()` never executes. This is a breeding ground for resource leaks.

`NonCancellable` solves this problem. It is essentially a special `Job` implementation that never responds to cancellation signals. Code blocks wrapped with `withContext(NonCancellable)` can safely call any suspended function:

```kotlin
launch {
    try {
        delay(Long.MAX_VALUE)
    } finally {
        withContext(NonCancellable) {
            delay(100) // Runs despite cancellation and suspends normally.
            releaseResource() // Safely executes.
        }
    }
}
```

`withContext` switches the context of the current coroutine. The Job in it is no longer the original canceled Job, but a job that is always active. The suspend function checks the Job status in the current context, so cancellation will not be triggered.

## Cancellation strategy under structured concurrency

The tree structure of coroutines itself provides natural cancellation boundaries. A coroutine started by a UI component only needs to cancel the root job when the component is destroyed, and all subtrees are automatically cleaned up. There is no need to manually maintain the list of coroutines.

In actual projects, I prefer to use `coroutineScope` or `supervisorScope` to divide cancellation boundaries:

```kotlin
suspend fun loadPageData() = coroutineScope {
    val data = async { fetchData() }
    val config = async { fetchConfig() }
    // If either child fails, the other is cancelled automatically.
    Pair(data.await(), config.await())
}
```

If you need a subtask to fail independently without affecting others, replace it with `supervisorScope`:
```kotlin
suspend fun loadPageDataSafe() = supervisorScope {
    val data = async { fetchData() }
    val config = async { fetchConfig() }
    // A data failure does not affect config.
    Pair(data.await(), config.await())
}
```

## A few easy pitfalls

**The difference between `isActive` and `ensureActive()`. ** `isActive` is a read-only check and does not throw an exception after returning false. It is suitable for use in loop conditions. `ensureActive()` is an active check and directly throws `CancellationException` in the inactive state. Do not use `isActive` to make a judgment and then throw manually. Use `ensureActive()` directly for clearer semantics.

**`cancelAndJoin()` is not a silver bullet. ** It is equivalent to `cancel()` + `join()`, ensuring that the coroutine exits completely before continuing. But if the coroutine is stuck in a non-cancelable blocking operation (such as long IO calls, pure CPU calculations), `cancelAndJoin()` will wait forever. Cooperate with timeouts when necessary:

```kotlin
withTimeoutOrNull(3000) { job.cancelAndJoin() } ?: println("force giving up")
```

**Do not put resource cleanup in `invokeOnCompletion` to perform complex operations. ** This callback is executed on the working thread and is not suitable for calling suspending functions. Cleanup logic should be placed in the `finally` block of the coroutine body, combined with `withContext(NonCancellable)` to handle suspension requirements.

The core of cooperative cancellation is one thing: your code must give the coroutine a chance to check the cancellation status. Suspend points are natural checkpoints and purely CPU-intensive code requires manual insertion of `yield()` or `ensureActive()`. `NonCancellable` is a safe exit during the exit phase, but the premise of using it is that you know that you are bypassing the cancellation mechanism - do not perform undetermined time-consuming operations in the `NonCancellable` block, otherwise the coroutine may never exit.
