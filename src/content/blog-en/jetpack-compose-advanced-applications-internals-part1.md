---
title: "Jetpack Compose Advanced Applications and Internals, Part 1"
lang: en
translationKey: jetpack-compose-advanced-applications-internals-part1
slug: jetpack-compose-advanced-applications-internals-part1
excerpt: "Part 1 of Jetpack Compose Advanced Applications and Internals: the declarative UI paradigm shift."
publishDate: 2024-11-18
displayInBlog: false
tags:
  - Android
  - Jetpack Compose
  - UI
  - Declarative
series:
  name: "Jetpack Compose Advanced Applications and Internals"
  part: 1
  total: 3
seo:
  title: "Jetpack Compose Internals, Part 1: Declarative UI Core"
  description: "Learn how Jetpack Compose changes Android UI development through declarative APIs, composition, recomposition, skipping, and stability."
  pageType: article
---
> This is part 1 of the 3-part "Jetpack Compose Advanced Applications and Internals" series.

## Introduction: The Declarative UI Paradigm Shift

Jetpack Compose represents the future direction of Android UI development. It introduces a **declarative** programming paradigm that is fundamentally different from the traditional imperative View system. Developers no longer need to manually find and mutate UI widgets, such as calling `findViewById` or `textView.setText`. Instead, they write **Composable functions** that describe what the UI should look like for a given state, and the Compose framework efficiently updates the screen when that state changes.

For most developers, learning the basics of Compose, such as creating Composable functions and managing state with `remember` and `mutableStateOf`, is enough to get started. For Android specialists, that is far from sufficient. **You need a deep understanding of Compose runtime mechanisms such as Composition, Recomposition, and Skipping; its unique Snapshot state system; the correct way to handle side effects; how the declarative layout model works; and the performance optimization and testing strategies specific to Compose.** Only then can you build complex, high-performance, maintainable Compose applications and diagnose difficult problems from the bottom up.

This article goes beyond Compose basics and explores advanced usage and core internals:

- **Mindset shift:** understand the essential difference between declarative UI and imperative UI.
- **Runtime core:** analyze Composition, Recomposition, intelligent Skipping, and stability.
- **Advanced state management:** explore the Snapshot system, state holders, `derivedStateOf`, `produceState`, and more.
- **Side-effect handling:** master Effect APIs such as `LaunchedEffect`, `DisposableEffect`, and `rememberCoroutineScope`.
- **Layout model internals:** understand Measure, Placement, Modifier internals, and custom Layout.
- **Performance optimization:** find and solve Compose performance bottlenecks.
- **Testing and interoperability:** test Compose UI and integrate with the traditional View system.

---

## 1. Declarative Thinking: From "How" to "What"

The first step in understanding Compose is changing how you think about UI.

### 1. Imperative vs. declarative

- **Imperative, as in the traditional View system:** developers write code that step by step **instructs** the system how to create and mutate UI. For example: "Find the TextView with ID `my_text`, then set its text to 'Hello'." Developers must manually keep UI state and views in sync.
- **Declarative, as in Compose:** developers write code that **describes** what the UI **should be** for a given State. For example: "There should be a Text here whose `text` property equals `myState.value`." When `myState` changes, Compose computes the UI changes and efficiently updates the screen. Developers mainly focus on state management and UI description.

### 2. @Composable functions

- Kotlin functions annotated with `@Composable` are the basic building blocks of Compose UI.
- They **do not return** concrete UI objects. Instead, by calling other Composable functions or emitting low-level UI elements such as LayoutNodes, they build a tree-like UI description during **Composition**.
- Composable functions should be **idempotent**, meaning the same inputs produce consistent behavior and results, and **side-effect free**, meaning they should not mutate external state or perform work unrelated to describing UI.

### 3. Composition - building the UI tree

- The first execution of Composable functions, or the first time they enter the UI hierarchy, is called **Initial Composition**.
- The Compose Runtime executes these functions and records the generated UI nodes and their properties, forming an internal **Composition Tree**. This tree is a snapshot of the UI state at a particular moment.

### 4. Recomposition - responding to state changes

- When a State object read by a Composable function changes, the Compose Runtime **intelligently schedules** that Composable function, and possibly other functions depending on it, to execute again. This process is called **Recomposition**.
- **Goal:** compute a new UI description from the new state and update the changed parts of the Composition Tree. Compose compares the old and new Composition Tree and only updates low-level UI elements that actually changed, such as LayoutNode properties or drawing commands, to preserve efficiency.

---

## 2. Compose Runtime Core: Composition, Recomposition, and Skipping

Compose's efficiency depends heavily on its carefully designed runtime mechanisms.

### 1. Compose Compiler Plugin

- The `@Composable` annotation itself does not do much. The real work is done by the Kotlin compiler plugin.
- **Code transformation:** the plugin transforms annotated function bytecode by adding extra parameters, such as a Composer object and an integer `changed` bitmask, plus additional logic.
- **Composer:** a runtime object responsible for managing Composition, building the Slot Table, and tracking Composable calls and state reads.
- **Slot Table:** an efficient internal data structure used by Compose to store Composition Tree nodes, state information, and metadata. It supports fast updates and lookups.
- **State tracking:** compiler-injected code lets State objects notify the Composer when they are read, establishing the dependency relationship between a Composable function and the state it reads.

### 2. Recomposition Scope

- When State changes, the Compose Runtime **does not** blindly recompose every Composable that read that state. It finds the **smallest recomposable scope** that read it. Usually, each Composable function is itself a potential scope.
- This limits the impact of state changes to the smallest possible area and is a key performance optimization.

### 3. Intelligent skipping - the foundation of performance

- **Goal:** if a Composable function's input parameters have not changed since its last execution, and those parameters are all **Stable**, Compose can **skip** calling that function and reuse the previous result. This is the core mechanism for avoiding unnecessary computation and UI updates.

- **Stability:**
  - **Definition:** a type is stable when the Compose Runtime can reliably determine whether its instances changed. If two instances return `true` from `equals()`, they are considered unchanged.
  - **Common stable types:**
    - Primitive types such as Int, Float, and Boolean, plus their nullable variants.
    - String.
    - Function types, including lambdas.
    - **Immutable classes:** if all public properties of a class are `val`, and the property types are also immutable, such as primitives, String, immutable collections, or other `@Immutable` classes, the class is usually considered immutable and therefore stable.
    - Classes marked `@Stable`: developers can use the `@Stable` annotation to guarantee to the compiler that even if the class has mutable properties or cannot be inferred as immutable automatically, changes are reported to Compose through a mechanism such as SnapshotState or Flow. The `@Stable` contract is: if `equals()` returns `true`, the instance is unchanged; if any public property or behavior that may affect UI changes, Compose can be notified, usually through internal State objects.
  - **Unstable types:**
    - Classes with `var` properties and no special handling.
    - Standard mutable collection classes such as List, Map, and Set, because their `equals` behavior is not enough for Compose to reliably observe content mutations. Prefer immutable collections from `kotlinx.collections.immutable`.
    - Generics of unknown type.

- **Impact:** if **any** parameter passed to a Composable is unstable, Compose **cannot safely skip** recomposition for that Composable even if the parameter instance did not actually change. **Keeping data passed into Composables stable is therefore critical for performance.**

- **Debugging:** use Layout Inspector in Android Studio Electric Eel or newer to inspect parameter stability and recomposition skipping, or use Compose compiler reports to get stability information.

**Diagram: Recomposition Scope and Skipping**

```plain
+----------------------------+
| ParentComposable(stateA)   | Recomposes if stateA changes
|----------------------------|
|   +----------------------+ |
|   | ChildA(param1, param2) |-+ Skipped if param1 & param2 are stable & unchanged
|   +----------------------+ | |
|                            | |
|   +----------------------+ | | Recomposes if stateB changes OR Parent recomposes AND param3 is unstable/changed
|   | ChildB(param3, stateB) |-+
|   |----------------------| |
|   | +------------------+ | |
|   | | GrandChild(param4)|<-+ Skipped if ChildB skips OR param4 is stable & unchanged
|   | +------------------+ | |
|   +----------------------+ |
+----------------------------+
```

---

---

> In the next article, we will explore "Advanced State Management: Beyond remember { mutableStateOf(...) }". Stay tuned for the rest of the series.

**"Jetpack Compose Advanced Applications and Internals" series**

1. **Introduction: The Declarative UI Paradigm Shift** (this article)
2. Advanced State Management: Beyond remember { mutableStateOf(...) }
3. The Compose Layout Model: Declarative Measurement and Placement
