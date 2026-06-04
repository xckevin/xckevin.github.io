---
title: "Jetpack Compose Advanced Applications and Internals"
lang: en
translationKey: jetpack-compose-advanced-applications-internals
slug: jetpack-compose-advanced-applications-internals
excerpt: "Jetpack Compose points to the future of Android UI development with a declarative programming model that differs sharply from the traditional imperative View system."
publishDate: '2025-03-27'
tags:
- "Android"
- "Jetpack Compose"
- "UI"
- "Declarative UI"
seo:
  title: "Jetpack Compose Internals and Advanced Practices"
  description: "A practical guide to Compose state, layout, recomposition, side effects, performance tuning, testing, and View interoperability."
---
## Introduction: The declarative UI paradigm shift

Jetpack Compose points to the future of Android UI development. It introduces a **declarative** programming model that is fundamentally different from the traditional imperative View system. Developers no longer need to manually find and mutate UI controls, such as `findViewById` or `textView.setText`. Instead, they write **Composable functions** that describe what the UI should look like for a given state, and the Compose framework efficiently updates the screen when that state changes.

For most developers, learning the basics of Compose, such as creating Composable functions and managing state with `remember` and `mutableStateOf`, is enough to get started. For Android specialists, however, that is far from sufficient. **You need a deeper understanding of the runtime mechanisms behind Compose, including Composition, Recomposition, and Skipping; its unique Snapshot state system; the correct way to handle side effects; how the declarative layout model works; and the performance optimization and testing strategies specific to Compose.** Only then can you build complex, high-performance, maintainable Compose apps and debug difficult issues from the underlying mechanics.

This article goes beyond the basics and explores advanced Compose usage and core internals:

- **Mindset shift:** Understand the essential difference between declarative UI and imperative UI.
- **Runtime core:** Analyze Composition, Recomposition, smart Skipping, and stability.
- **Advanced state management:** Explore the Snapshot system, state holders, `derivedStateOf`, `produceState`, and related APIs.
- **Side effect handling:** Master Effect APIs such as `LaunchedEffect`, `DisposableEffect`, and `rememberCoroutineScope`.
- **Layout model internals:** Understand measurement, placement, Modifier internals, and custom Layout.
- **Performance optimization:** Learn key techniques for locating and fixing Compose performance bottlenecks.
- **Testing and interoperability:** Cover Compose UI testing strategies and interaction with the traditional View system.

---

## 1. Declarative thinking: From "how" to "what"

The first step in understanding Compose is changing how you think about UI.

### 1. Imperative vs. declarative

- **Imperative UI, the traditional View system:** Developers write code that tells the system step by step how to create and modify UI. For example: "Find the TextView with ID `my_text`, then set its text to 'Hello'." Developers are responsible for keeping UI state and View state synchronized.
- **Declarative UI, Compose:** Developers write code that describes what the UI should look like for a given State. For example: "There should be a Text here, and its `text` property should equal `myState.value`." When `myState` changes, the Compose framework computes the UI changes and efficiently updates the screen. Developers focus mainly on state management and UI description.

### 2. @Composable functions

- Kotlin functions annotated with `@Composable` are the basic building blocks of Compose UI.
- They **do not return** concrete UI objects. Instead, during **Composition**, they build a tree that describes the UI by calling other Composable functions or emitting lower-level UI elements such as LayoutNode.
- Composable functions should be **idempotent**, meaning the same inputs produce consistent behavior and results, and **side-effect free**, meaning they should not modify external state or perform operations unrelated to UI description.

### 3. Composition: Building the UI tree

- The process of running Composable functions for the first time, or when they first enter the UI hierarchy, is called **Initial Composition**.
- The Compose runtime executes these functions and records the generated UI nodes and their properties, forming an internal **Composition Tree**. This tree is a snapshot of UI state at a specific moment.

### 4. Recomposition: Responding to state changes

- When a State object read by a Composable function changes, the Compose runtime **intelligently schedules** that Composable function, and possibly other functions that depend on it, to run again. This process is called **Recomposition**.
- **Goal:** Compute a new UI description from the new state and update the changed portions of the Composition Tree. The Compose framework compares the old and new Composition Trees and updates only the underlying UI elements that actually changed, such as LayoutNode properties or drawing commands, to maintain efficiency.

---

## 2. The Compose runtime core: Composition, Recomposition, and Skipping

Much of Compose's efficiency comes from its carefully designed runtime.

### 1. Compose compiler plugin

- The `@Composable` annotation itself does not do much. The real work is done by the Kotlin compiler plugin.
- **Code transformation:** The plugin transforms annotated function bytecode by adding extra parameters, such as a Composer object and an integer `changed` bitmask, along with runtime logic.
- **Composer:** A runtime object responsible for managing Composition, building the Slot Table, and tracking Composable calls and state reads.
- **Slot Table:** An efficient internal data structure used by Compose to store Composition Tree nodes, state information, and metadata. It supports fast updates and lookups.
- **State tracking:** Code injected by the plugin lets State objects notify the Composer when they are read, establishing the relationship between Composable functions and the state they depend on.

### 2. Recomposition scope

- When a State changes, the Compose runtime **does not** blindly recompose every Composable that read that state. It looks for the **smallest recomposable scope** that read it. Usually, each Composable function is itself a potential scope.
- This keeps the impact of a state change as small as possible, which is central to performance optimization.

### 3. Smart skipping: The foundation of performance

- **Goal:** If a Composable function's input parameters have not changed since the previous execution, and those parameters are all **stable**, the Compose runtime can **skip** calling that function and reuse the previous result. This is the core mechanism that avoids unnecessary computation and UI updates.

- **Stability:**
  - **Definition:** A type is stable when the Compose runtime can reliably determine whether its instances changed. If two instances return `true` from `equals()`, they are treated as unchanged.
  - **Common stable types:**
    - Primitive types, such as Int, Float, and Boolean, and their nullable counterparts.
    - String.
    - Function types, or lambdas.
    - **Immutable classes:** If all public properties of a class are `val`, and those property types are also immutable, such as primitives, String, immutable collections, or other `@Immutable` classes, the class is usually considered immutable and therefore stable.
    - Classes marked with `@Stable`: Developers can use the `@Stable` annotation to promise the compiler that even if a class has mutable properties or cannot be inferred as immutable automatically, it will notify Compose about changes through a mechanism such as SnapshotState or Flow. The `@Stable` contract is: if `equals()` returns `true`, the instance has not changed; if any public property or behavior that may affect UI changes, Compose can be notified, usually through internal State objects.
  - **Unstable types:**
    - Classes with `var` properties and no special handling.
    - Standard mutable collection classes such as List, Map, and Set, because their `equals` behavior may not directly represent content changes. Prefer immutable collections from `kotlinx.collections.immutable`.
    - Generics of unknown type.

- **Impact:** If **any** parameter passed to a Composable is unstable, Compose **cannot safely skip** recomposition of that Composable even if the parameter instance did not actually change. **Ensuring that data passed into Composables is stable is therefore critical for performance.**

- **Debugging:** You can use Android Studio Electric Eel or newer Layout Inspector to view Composable parameter stability and recomposition skipping, or use Compose compiler reports to inspect stability information.

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

## 3. Advanced state management: Beyond remember { mutableStateOf(...) }

Compose provides rich and powerful state management mechanisms.

### 1. Basic state types

- **State&lt;T&gt; and MutableState&lt;T&gt;:** The basic representation of state in Compose. Reading `.value` subscribes the caller to recomposition. Writing `.value` triggers recomposition for `MutableState`.
- **remember:** Keeps state, or any computed result, across recompositions.

### 2. Snapshot System: The core of concurrent state

- **Concept:** Compose state management is built on a Snapshot system similar to software transactional memory, or STM. All **writes** to MutableState first occur inside an **isolated snapshot** on the current thread. These changes are invisible to other threads, and to other recompositions currently in progress. Only when the snapshot is **applied**, usually by the Compose framework at the end of event handling or at the start of the next frame, do the changes become globally visible and trigger corresponding recompositions.
- **Advantages:**
  - **Atomicity:** A set of state changes is applied together or not applied at all.
  - **Isolation:** Concurrent reads, such as reads during recomposition, do not observe unapplied and inconsistent intermediate state.
  - **Consistency:** UI state remains consistent.
- **Supported features:** The Snapshot system underpins advanced features such as `derivedStateOf` and multithreaded state mutation.

### 3. State hoisting

- **Pattern:** Move state up to the **lowest common ancestor** in the Composable tree that needs to access it. Child components receive **immutable** state data as parameters and pass events or mutation requests upward to the state owner through callback functions, or lambdas.
- **Advantages:**
  - **Single Source of Truth:** State is managed in one place, avoiding duplicated state and inconsistency.
  - **Reusability:** Child components do not own state, so they become more general and reusable.
  - **Testability:** Child components are easier to preview and unit test by passing fake data and empty lambdas. State management logic can also be tested independently at the hoisted location.

This is the **core pattern** for building maintainable UI in Compose.

### 4. ViewModel and state holders

- **ViewModel:** Usually acts as the owner of screen-level state and the unit that handles business logic, following Android Architecture Components guidance. State in the ViewModel, such as state exposed through StateFlow, drives the UI for the entire screen.
- **State Holder Class:** For the state and UI logic of a specific complex Composable, such as a dropdown menu or editable list item, you can create an ordinary Kotlin class as a state holder. This class owns the relevant MutableState and exposes methods for handling events. The Composable function creates and `remember`s the state holder instance, then delegates state and event handling to it. **Benefit:** The Composable itself stays simpler and focuses only on describing UI, while state logic is encapsulated for easier testing and reuse.

### 5. Derived and produced state

- **derivedStateOf { calculation }:**
  - **Use case:** Use this when a piece of UI state needs to be computed from one or more other State objects.
  - **Smart computation:** The `calculation` lambda runs again only when the value of a State read inside it **actually changes**. If a dependency triggers recomposition but its value did not change, `derivedStateOf` does not recompute.
  - **Benefit:** Avoids unnecessary and potentially expensive computation, improving performance. For example, it can compute whether a "select all" button should be enabled based on list state.

- **produceState(initialValue, key1, ...) { ... }:**
  - **Use case:** Use this when you need to convert non-Compose state, such as data from Flow, LiveData, or a suspend function, into Compose State.
  - **Mechanism:** Starts a coroutine tied to the Composition. Inside that coroutine scope, you can update State with `value = ...`. If any key parameter changes, the current coroutine is canceled and a new coroutine starts to produce state again.
  - **Benefit:** This is the standard way to bridge asynchronous data sources into the Compose state system. It automatically handles coroutine start, cancellation, and restart.

- **Flow.collectAsState() / Flow.collectAsStateWithLifecycle():**
  - **Use case:** Convert Kotlin Flow, whether a cold flow or StateFlow/SharedFlow, into Compose State.
  - `collectAsState()`: Simply collects the Flow and updates State when a new value arrives.
  - `collectAsStateWithLifecycle()` (recommended): Collects the Flow in a lifecycle-aware way, such as stopping collection in `onStop` and resuming in `onStart`, avoiding unnecessary background resource use. This requires the `androidx.lifecycle.runtime.compose` dependency.

### 6. State saving and restoration with rememberSaveable

- **Use case:** Restore UI state after an Activity or process is recreated because of a configuration change, such as screen rotation, or system reclamation.
- **Usage:** Use `rememberSaveable { mutableStateOf(...) }` instead of `remember`.
- **Requirement:** The state type must be storable in a Bundle, such as primitive types, Parcelable, Serializable, or a type with a custom Saver object.
- **Principle:** Under the hood, this uses Android's `onSaveInstanceState` / `onCreate(savedInstanceState)` mechanism.

---

## 4. Side effect handling: Interacting outside the Compose world

The core responsibility of Composable functions is to describe UI. They should be pure. Any operation that needs to interact with the outside world, such as network requests, database reads and writes, starting coroutines, or registering listeners, is a **side effect** and must be executed safely with a dedicated Effect API.

### 1. Why Effect APIs are necessary

Executing side effects directly inside a Composable function body can cause:

- **Unpredictable execution:** A Composable may execute on every recomposition, causing side effects to trigger unexpectedly many times.
- **Lifecycle problems:** A side effect may need setup when a Composable enters Composition and cleanup when it leaves, such as registering and unregistering a listener. Code written directly in the function body cannot model this lifecycle.

### 2. Key Effect APIs

- **LaunchedEffect(key1, key2, ...) { block }:**
  - **Behavior:** When `LaunchedEffect` first enters Composition, or when any key parameter changes, it starts a new coroutine to execute the suspend functions in `block`. When a key changes or the Composable leaves Composition, the previous coroutine is canceled automatically.
  - **Use:** Run **one-off** or **restartable** suspend operations tied to Compose state changes or lifecycle. Examples include fetching user data by `userId`, showing a Snackbar when `scaffoldState` changes, or triggering a one-time animation from a state change.
  - **Key point:** Key parameters decide when `block` runs again. `key1 = Unit` or `key1 = true` means "run once when entering."

- **rememberCoroutineScope(): CoroutineScope:**
  - **Behavior:** Returns a CoroutineScope tied to the lifecycle of the current Composable call site.
  - **Use:** Use this when you need to start a coroutine from a **non-Composable context**, such as a button's `onClick` lambda, while still keeping the coroutine synchronized with the UI lifecycle. The coroutine is canceled automatically when the Composable leaves Composition.
  - **Compared with LaunchedEffect:** `LaunchedEffect` starts a coroutine automatically when the Composable enters Composition or a key changes. `rememberCoroutineScope` gives you a scope so you can manually `launch` a coroutine when needed, such as from an event callback.

- **DisposableEffect(key1, key2, ...) { onDispose { cleanup } }:**
  - **Behavior:** When `DisposableEffect` enters Composition or a key changes, it executes its main block, usually for setup. It **must** return an `onDispose` lambda. When the Composable leaves Composition, or a key change causes the Effect to restart, the `onDispose` lambda runs.
  - **Use:** Manage resources or callbacks that require **cleanup**. Examples include registering and unregistering a BroadcastReceiver, adding and removing a LifecycleObserver, or subscribing and unsubscribing from an external data source.
  - **Key point:** `onDispose` is the core of this API and performs the paired cleanup operation.

- **SideEffect { block }:**
  - **Behavior:** The code inside `block` is called **after every successful** recomposition.
  - **Use:** Synchronize Compose state to an external object that is not managed by Compose, effectively "publishing" state. For example, update an analytics or logging library with the current Compose state value. **This has a very limited set of use cases and should be used carefully.**

- **produceState, also an Effect:** As described earlier, this converts asynchronous sources into State and is essentially a managed coroutine.

- **rememberUpdatedState(value): State&lt;T&gt;:**
  - **Use case:** In a potentially long-running Effect, such as a `LaunchedEffect` or `DisposableEffect` `onDispose`, you may need access to the latest value passed into a Composable rather than the old value captured when the Effect started.
  - **Usage:** `val latestOnValueChange by rememberUpdatedState(onValueChange)`. Always use `latestOnValueChange` inside the Effect lambda.
  - **Benefit:** Avoids capturing stale lambdas or state values inside an Effect when the key has not changed.

---

## 5. The Compose layout model: Declarative measurement and placement

Compose uses an independent declarative layout system built around Modifier and Layout Composables.

### 1. Core idea

The parent layout passes Constraints downward. Each child determines its Size based on those constraints and its own content. The parent then places each child at the appropriate position based on the child's measured size.

### 2. Layout phase

The layout phase occurs after Composition and contains two main steps:

- **Measure:**
  - Usually completed in a **single pass**, unlike the View system, which may require multiple passes.
  - The parent LayoutNode passes Constraints downward, including minimum and maximum width and height.
  - A child LayoutNode decides its own size based on the received Constraints and its measurement logic, which may be fixed or content-based, then passes the size result upward.

- **Placement:**
  - After measurement, the parent LayoutNode uses each child's measured size and its own layout logic, such as Column's vertical arrangement or Row's horizontal arrangement, to decide each child node's `(x, y)` coordinate.
  - The parent calls the child node's `placeAt(x, y)` method to complete placement.

### 3. Modifier: Chained UI decoration and behavior

- **Role:** Modifier is the primary way in Compose to change a Composable's appearance, such as size, padding, background, or border; add behavior, such as click, scroll, or drag; change layout behavior, such as weight or alignment; or add semantic information.
- **Chaining:** `Modifier.padding(16.dp).background(Color.Blue).clickable { }`. Order is very important. Each later Modifier acts on the result processed by the previous Modifier.
- **Internal mechanism:** Each Modifier wraps the element after it, which may be another Modifier or the final LayoutNode, and may affect measurement, layout, drawing, input handling, or other phases.

### 4. Intrinsic measurements

- **Use case:** Some layouts, such as Row and Column, need to know a child's "intrinsic" minimum or maximum size under given constraints before determining their own size, especially for `wrap_content`, or before sizing children. For example, a Row may need to know the tallest height among all children to determine its own height.
- **Mechanism:** A parent layout can query a child's intrinsic size before the main measurement pass, using `minIntrinsicWidth`, `maxIntrinsicWidth`, `minIntrinsicHeight`, and `maxIntrinsicHeight`. The child layout must be able to return these intrinsic sizes based on the passed height constraint when width is queried, or width constraint when height is queried.

### 5. Custom layouts

- **Layout(...) Composable:**
  - The **most common** way to create a custom layout.
  - Provides a `content: @Composable () -> Unit` lambda to define child elements.
  - Provides a `measurePolicy: MeasurePolicy` lambda to implement measurement and layout logic.
  - The MeasurePolicy lambda receives `measurables`, the list of child elements that can be measured with `measurable.measure(constraints)`, and `constraints`, the constraints from the parent layout.
  - After measuring all children and obtaining a list of Placeable objects, you calculate the layout's own size and place every child inside the `layout(width, height) { ... }` scope by calling `placeable.placeAt(x, y)`.

- **SubcomposeLayout(...):**
  - **Use case:** Use this when you need to **dynamically decide** which child elements to compose and measure during the **layout phase** based on available space or other conditions. `BoxWithConstraints` is implemented on top of this pattern and decides what constraints to pass to its `content` lambda based on its own constraints.
  - **Mechanism:** Allows `subcompose` to be called inside the measure lambda so part of the child content can be composed and measured.
  - **Cost:** More expensive than `Layout`, because it can involve multiple composition and measurement passes. Use it only when necessary.

### 6. LayoutNode Tree

- An internal tree maintained by the Compose runtime that represents the final layout result of the UI.
- Each node, or LayoutNode, contains measurement results, placement position, drawing information, which may point to a RenderNode, and associated Modifiers.
- The Compose framework traverses the LayoutNode tree to perform drawing.

---

## 6. Compose performance optimization: Keeping UI smooth

Although Compose is designed to improve developer productivity, performance still requires attention to avoid jank.

### 1. Core goals

- **Reduce unnecessary Recomposition:** This is the most important optimization target. Use the Skipping mechanism well.
- **Lower the cost of Composition, Layout, and Draw:** Make each execution as fast as possible.

### 2. Key optimization techniques

- **Ensure Stability:**
  - **Prefer immutable data:** For data passed into Composables, prefer `val`, primitive types, String, and collections from `kotlinx.collections.immutable`.
  - **Wrap unstable types:** If you must use mutable classes, wrap them in a state holder annotated with `@Stable` or `@Immutable`, and expose only the necessary data through State.
  - **Annotate explicitly:** Add `@Stable` or `@Immutable` to custom classes that truly satisfy the stability or immutability contract.
  - **Check lambda stability:** Lambdas passed into Composables are implicitly stable. However, if a lambda captures unstable variables, it may still cause problems.

- **Minimize the scope of state reads:**
  - **Read only what is needed:** Do not read fine-grained state that only lower-level Composables need in a high-level Composable. Instead, pass already-processed data downward as parameters.
  - **Hoist state with restraint:** State hoisting is a good pattern, but excessive hoisting, such as moving all state to the top level, can cause many unrelated Composables to become invalidated when top-level state changes, even if some of them may be skipped.

- **Defer state reads:**
  - **Use function references or lambdas:** For event callbacks, passing a function reference such as `::doSomething`, or a simple lambda such as `{ doSomething(id) }`, is usually better than passing a complex lambda created inside a Composable scope that captures current state. The latter may block Skipping by capturing unstable state or creating a new instance on every recomposition.

- **Use derivedStateOf:** Optimize complex calculations based on multiple states.

- **Optimize lists, such as LazyColumn and LazyRow:**
  - **Provide keys:** Give `items` a stable, unique key, such as `key = { item.id }`. This helps Compose identify list item moves, insertions, and deletions, and reuse Composable instances, greatly improving performance when a list changes.
  - **Set contentType:** Provide a `contentType` for different item types, such as `contentType = { item.type }`. This lets Compose reuse underlying resources such as LayoutNode across items of the same type, similar to RecyclerView's ViewHolder reuse.
  - **Keep item Composables simple:** Do not perform expensive operations inside the `itemContent` lambda. State management inside each item should also be efficient.

- **Use Baseline Profiles:**
  - **Role:** Baseline Profiles precompile Compose code ahead of time for critical user journeys, such as startup and list scrolling. This reduces runtime interpretation and JIT compilation overhead, significantly improving first-run performance and smoothness.
  - **Generation and application:** Use the `androidx.benchmark:benchmark-macro-junit4` library to record and generate Profile files, then include them in the app release package.

- **Analyze recomposition:**
  - **Layout Inspector, Android Studio Electric Eel or newer:** Shows each Composable's recomposition count and skip count, and highlights areas currently recomposing. This is a valuable tool for locating unnecessary recomposition.
  - **Compose Compiler Metrics:** The compiler can output reports that include each Composable's stability information and whether it is skippable.
  - **Manual wrapping:** Wrap a suspected problematic Composable in a simple wrapper Composable and observe the wrapper's recomposition behavior, then narrow the scope step by step.

- **Optimize custom layouts:** Make sure measure and place logic is efficient and avoids redundant computation.

- **Optimize Modifier chains:** Some Modifier combinations may be more efficient than others. Usually the impact is small, but in extreme cases it is worth analyzing.

---

## 7. Testing Compose UI

Compose provides a dedicated testing framework.

### 1. Core dependency

`androidx.compose.ui:ui-test-junit4`.

### 2. ComposeTestRule

The test entry point, used to host Compose UI in a test environment:

- `createComposeRule()`: For pure Compose UI tests that do not depend on an Activity.
- `createAndroidComposeRule<MyActivity>()`: For testing Compose UI integrated with an Activity.

### 3. Finding nodes

Using **Semantics** to locate Composables is a **best practice**, because it decouples tests from specific implementation details such as hierarchy structure or Text content:

- `onNodeWithText("...")`, `onNodeWithContentDescription("...")`, `onNodeWithTag("myTag")`, using `Modifier.testTag("myTag")`.
- You can also search by hierarchy, such as `onRoot()`, `onChildren()`, and `onParent()`, but this is not recommended.

### 4. Performing actions

Simulate user interactions:

- `performClick()`, `performScrollTo()`, `performTextInput("...")`, `performGesture { ... }` for complex gestures.

### 5. Assertions

Verify UI state:

- `assertIsDisplayed()`, `assertIsEnabled()`, `assertTextEquals("...")`, `assertContentDescriptionEquals("...")`, `assertExists()`, and `assertDoesNotExist()`.

### 6. Test isolation

Use `composeTestRule.setContent { MyComposable(...) }` to directly set the Composable under test, passing Mock or Fake data and callbacks. This enables isolated tests for an individual Composable or screen.

### 7. Synchronization

The Compose test framework automatically waits for the UI to become idle, meaning there are no pending layout, draw, or animation operations, before executing actions and assertions. This simplifies test authoring.

---

## 8. Interoperability: Compose and the View system together

Introducing Compose into an existing project, or using legacy View components inside Compose, is common.

### 1. Using Compose inside View

- **ComposeView:** An Android View that can be used in XML layouts or created in code. Call its `setContent { @Composable ... }` method to embed Compose UI.
- **Use case:** Gradually introduce Compose-built screens or screen sections into existing Activities and Fragments.

### 2. Using View inside Compose

- **AndroidView(factory = { context -> MyCustomView(context) }, update = { view -> view.setData(myState) }):** A Composable function that embeds a traditional Android View into the Compose UI hierarchy.
  - `factory`: Creates the View instance and is called only once.
  - `update`: Runs after `factory` and during later recompositions when dependent state changes, updating View properties from Compose state.
- **Use case:** Reuse existing complex custom Views or use Views that do not yet have Compose equivalents, such as WebView or MapView.

### 3. Theme and style interoperability

- **Accompanist libraries:** Libraries such as `accompanist-themeadapter-material` and `accompanist-themeadapter-appcompat` help share colors, typography, and other style attributes between Compose and XML-based Material/AppCompat themes, creating a consistent visual experience.

### 4. Notes

- **Performance:** There can be some overhead at the boundary between Compose and View. Minimize the number of boundaries where possible.
- **Context and lifecycle:** Pay attention to Context passing and component lifecycle management.
- **Focus and input:** Focus management and input event propagation across the boundary may require additional handling.
- **Use:** This is mainly for **progressive migration** or **reusing existing components**. Prefer pure Compose for new UI.

---

## 9. Conclusion: Embrace declarative UI, master the craft

Jetpack Compose is not only a paradigm shift in Android UI development. It is also a well-designed, powerful modern toolkit. Through declarative APIs, deep Kotlin integration, and strong runtime optimization, it aims to improve both developer productivity and UI performance.

However, to truly take advantage of Compose, you cannot stop at the surface. You need to deeply understand its **runtime core**, including Composition, Recomposition, Stability, and Skipping; its **state management philosophy**, including the Snapshot system, state hoisting, and derived state; its **safe side effect mechanisms**; its **declarative layout model**; and its **unique performance optimization points**.

Although Compose is designed to simplify UI development, a deep understanding of its internals and strict adherence to best practices remain essential when building complex, high-performance apps. Mastering the advanced applications and internals of Compose means being able to confidently build the next generation of Android interfaces, solve performance bottlenecks efficiently, and help a team adopt the future of declarative UI development.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping recomposition](/en/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose Modifier internals: Chained nodes, layout, drawing, and event handling](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/en/blog/jetpack-compose-gestures/)
- [Jetpack Compose animation: AnimationSpec, spring models, and Transition](/en/blog/jetpack-compose-animation/)
<!-- /seo-internal-links -->
