---
title: Kotlin and Coroutines
lang: en
translationKey: kotlin-coroutines
seo:
  title: Kotlin Coroutines and Flow
  description: Kotlin notes covering coroutines, Flow, StateFlow, SharedFlow, structured concurrency, testing, compiler behavior, and Android engineering practices.
---

This topic focuses on Kotlin and coroutine-based Android engineering.

For Android teams, Kotlin is not just syntax. Coroutines, Flow, compiler behavior, type-system choices, and multiplatform constraints all shape app architecture. This page collects notes that connect Kotlin language features with production Android debugging and maintainable code design.

## Learning Path

1. Understand what the compiler generates for `suspend` functions. Coroutines are not threads; they are a runtime and state-machine model.
2. Learn structured concurrency through cancellation, exception propagation, scope ownership, and lifecycle boundaries.
3. Use Flow, StateFlow, and SharedFlow as reactive streams with explicit backpressure and collection semantics.
4. Track Kotlin K2, KSP, contracts, value classes, and DSL design as engineering tools rather than isolated language features.

## Core Articles

- [Kotlin `suspend` internals: from CPS transformation to continuation state-machine bytecode](/blog/kotlin-suspend-state-machine/)
- [Kotlin Flow engineering: cold streams, StateFlow, and SharedFlow](/blog/kotlin-flow-stateflow-sharedflow/)
- [Advanced Kotlin Coroutines and Flow usage](/blog/kotlin-coroutines-flow-advanced-applications-internals/)
- [Kotlin K2 compiler: unified frontend, type inference, and Android build impact](/blog/kotlin-k2-compiler-android/)

## Type System, Testing, and Code Generation

- [Testing Kotlin coroutines: from `TestDispatcher` to virtual-time control](/blog/kotlin-coroutines-testing/)
- [Kotlin context receivers: expressing implicit dependencies safely](/blog/kotlin-context-receivers/)
- [Kotlin contracts: SmartCast, `callsInPlace`, and compiler cooperation](/blog/kotlin-contracts-smartcast/)
- [Kotlin sealed classes and interfaces: exhaustive state modeling for Compose UI](/blog/kotlin-sealed-class-interface/)
- [Kotlin Symbol Processing: from annotation scanning to generated code](/blog/kotlin-symbol-processing-ksp/)
- [Kotlin inline class and value class: zero-cost type-safe abstractions](/blog/kotlin-value-class-inline-class/)
- [Kotlin inline functions: bytecode inlining, reified generics, and compiler optimization](/blog/kotlin-inline-functions-reified/)
- [Type-safe Kotlin builders and DSL design](/blog/kotlin-type-safe-builders-dsl/)

## Engineering Judgment

- Keep coroutine scope ownership explicit. Ambiguous scope ownership is usually where leaks and lost cancellation start.
- Treat Flow collection as a lifecycle decision, not just a syntax choice.
- Prefer type-safe state models for UI state, network state, and domain events.
- Evaluate language features by whether they reduce production ambiguity, not by whether they look elegant in isolation.

## Next Step

For build speed, CI, and large-project Kotlin governance, continue with [Mobile Engineering](/en/android-engineering/). For UI state and side effects, continue with [Jetpack Compose](/en/jetpack-compose/).
