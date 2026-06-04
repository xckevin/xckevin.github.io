---
title: "Jetpack Compose Advanced Applications and Internals, Part 3"
lang: en
translationKey: jetpack-compose-advanced-applications-internals-part3
slug: jetpack-compose-advanced-applications-internals-part3
excerpt: "Part 3 of Jetpack Compose Advanced Applications and Internals: the Compose layout model, performance, testing, and View interoperability."
publishDate: 2025-01-27
displayInBlog: false
tags:
  - Android
  - Jetpack Compose
  - UI
  - Declarative
series:
  name: "Jetpack Compose Advanced Applications and Internals"
  part: 3
  total: 3
seo:
  title: "Jetpack Compose Internals, Part 3: Layout and Performance"
  description: "Understand Compose layout measurement and placement, Modifier behavior, custom layouts, performance tuning, UI testing, and View interoperability."
  pageType: article
---
> This is part 3 of the 3-part "Jetpack Compose Advanced Applications and Internals" series. In the previous article, we discussed "Advanced State Management: Beyond remember { mutableStateOf(...) }".

## 5. The Compose Layout Model: Declarative Measurement and Placement

Compose uses an independent declarative layout system based on Modifier and Layout Composables.

### 1. Core idea

The parent layout passes constraints downward. The child layout determines its size from those constraints and its own content. The parent then places the child at the appropriate position based on the child's size.

### 2. Layout Phase

This phase happens after Composition and contains two main steps:

- **Measure:**
  - Usually completed in a **single pass**, unlike the View system, which may use multiple passes.
  - The parent LayoutNode passes Constraints downward, including minimum and maximum width and height.
  - The child LayoutNode decides its own size based on the received Constraints and its measurement logic, which may be fixed or content-based, then passes the size result upward.

- **Placement:**
  - After measurement completes, the parent LayoutNode determines each child's `(x, y)` coordinates based on child measurement results and its own layout logic, such as vertical arrangement in Column or horizontal arrangement in Row.
  - The parent calls the child's `placeAt(x, y)` method to complete placement.

### 3. Modifier - chained UI decoration and behavior

- **Role:** Modifier is the main way in Compose to change a Composable's appearance, such as size, padding, background, or border; add behavior, such as click, scroll, or drag; change layout behavior, such as weight or alignment; or add semantic information.
- **Chaining:** `Modifier.padding(16.dp).background(Color.Blue).clickable { }`. Order matters. Each later Modifier operates on the result processed by the previous Modifier.
- **Internal mechanism:** each Modifier wraps the element after it, which may be another Modifier or the final LayoutNode, and may affect phases such as measurement, layout, drawing, or input handling.

### 4. Intrinsic Measurements

- **Scenario:** some layouts, such as Row and Column, need to know the intrinsic minimum or maximum size of their children under given constraints before deciding their own size, especially for `wrap_content`, or before deciding child sizes. For example, Row may need to know the tallest child height to determine its own height.
- **Mechanism:** a parent layout can query a child layout's intrinsic dimensions before the main measurement pass, such as `minIntrinsicWidth`, `maxIntrinsicWidth`, `minIntrinsicHeight`, and `maxIntrinsicHeight`. The child layout must be able to provide those intrinsic sizes from the incoming height constraint when querying width, or the incoming width constraint when querying height.

### 5. Custom layouts

- **Layout(...) Composable:**
  - The **most common** custom layout approach.
  - Provides a `content: @Composable () -> Unit` lambda to define child elements.
  - Provides a `measurePolicy: MeasurePolicy` lambda to implement measurement and layout logic.
  - The MeasurePolicy lambda receives `measurables`, the list of child elements that can be measured with `measurable.measure(constraints)`, and `constraints`, the constraints from the parent layout.
  - After measuring all children and obtaining a list of Placeable objects, it calculates its own size and places all children inside a `layout(width, height) { ... }` scope by calling `placeable.placeAt(x, y)`.

- **SubcomposeLayout(...):**
  - **Scenario:** use it when the layout phase needs to **dynamically decide** which children to measure based on available space or other conditions. `BoxWithConstraints` is implemented on top of this idea: it decides which constraints to pass to the `content` lambda based on its own constraints.
  - **Mechanism:** allows calling `subcompose` inside the measure lambda to compose and measure part of the child content.
  - **Cost:** more expensive than Layout because it may involve multiple composition and measurement passes. Use it only when necessary.

### 6. LayoutNode Tree

- A tree structure maintained internally by the Compose Runtime that represents the final layout result of the UI.
- Each node, or LayoutNode, contains measurement results, placement position, drawing information, possibly pointing to a RenderNode, and associated Modifiers.
- The Compose framework traverses the LayoutNode tree to execute drawing operations.

---

## 6. Compose Performance Optimization: Keeping UI Smooth

Although Compose is designed to improve development efficiency, performance still matters if you want to avoid jank.

### 1. Core goals

- **Reduce unnecessary Recomposition:** this is the most important optimization point. Make effective use of Skipping.
- **Lower the cost of Composition, Layout, and Draw:** keep each phase as fast as possible.

### 2. Key optimization techniques

- **Ensure stability:**
  - **Prefer immutable data:** for data passed into Composables, use `val`, primitives, String, and `kotlinx.collections.immutable` collections whenever possible.
  - **Encapsulate unstable types:** if mutable classes are required, wrap them in state holders annotated with `@Stable` or `@Immutable`, and expose only the necessary data through State.
  - **Add explicit annotations:** annotate custom classes that truly satisfy the stable or immutable contract with `@Stable` or `@Immutable`.
  - **Check lambda stability:** lambdas passed to Composables are implicitly stable. However, if a lambda captures unstable variables, it may still cause problems.

- **Minimize the scope of state reads:**
  - **Read only the data needed:** do not read fine-grained state in a high-level Composable if it is only needed by a lower-level Composable. Pass processed data down as parameters.
  - **Hoist state in moderation:** state hoisting is a good pattern, but excessive hoisting, such as moving all state to the top level, can cause many unrelated Composables to be invalidated when top-level state changes, even if some of them may be skipped.

- **Defer state reads:**
  - **Use function references or lambdas:** for event callbacks, passing a function reference such as `::doSomething` or a simple lambda such as `{ doSomething(id) }` is usually better than passing a complex lambda created inside a Composable scope that captures current state. The latter may prevent Skipping because it captures unstable state or creates a new instance on every recomposition.

- **Use derivedStateOf:** optimize complex calculations based on multiple state values.

- **Optimize lists, such as LazyColumn and LazyRow:**
  - **Provide keys:** give items stable, unique keys, such as `key = { item.id }`. This helps Compose recognize item moves, additions, and deletions, and reuse Composable instances, which greatly improves list update performance.
  - **Set contentType:** provide different `contentType` values for different item types, such as `contentType = { item.type }`. This lets Compose reuse low-level resources such as LayoutNodes across items of the same type, similar to RecyclerView ViewHolder reuse.
  - **Keep item Composables simple:** do not perform expensive work inside the `itemContent` lambda. State management inside each item should also be efficient.

- **Use Baseline Profiles:**
  - **Role:** precompile Compose code ahead of time, or AOT, for key user journeys such as app startup or list scrolling. This reduces runtime interpretation and JIT compilation overhead, significantly improving first-run performance and smoothness.
  - **Generation and application:** use the `androidx.benchmark:benchmark-macro-junit4` library to record and generate Profile files, then include them in the application release package.

- **Analyze recomposition:**
  - **Layout Inspector in Android Studio Electric Eel or newer:** shows each Composable's recomposition count and skip count, and highlights the parts currently recomposing. It is a powerful tool for finding unnecessary recomposition.
  - **Compose Compiler Metrics:** compiler reports can include stability information for each Composable and whether it is skippable.
  - **Manual wrapping:** wrap a suspicious Composable in a simple wrapper Composable and observe the wrapper's recomposition behavior, then narrow the range step by step.

- **Optimize custom layouts:** keep measure and place logic efficient and avoid redundant computation.

- **Optimize Modifier chains:** some Modifier combinations may be more efficient than others. The difference is usually small, but in extreme cases it is worth analyzing.

---

## 7. Testing Compose UI

Compose provides a dedicated testing framework.

### 1. Core dependency

`androidx.compose.ui:ui-test-junit4`.

### 2. ComposeTestRule

The test entry point, used to host Compose UI in a test environment:

- `createComposeRule()`: for pure Compose UI tests that do not depend on an Activity.
- `createAndroidComposeRule<MyActivity>()`: for testing Compose UI integrated with an Activity.

### 3. Finders

Using **Semantics** to locate Composables is the **best practice**, because it decouples tests from implementation details such as hierarchy structure and Text content:

- `onNodeWithText("...")`, `onNodeWithContentDescription("...")`, `onNodeWithTag("myTag")` through `Modifier.testTag("myTag")`.
- You can also search by hierarchy, such as `onRoot()`, `onChildren()`, and `onParent()`, but this is not recommended.

### 4. Actions

Simulate user interactions:

- `performClick()`, `performScrollTo()`, `performTextInput("...")`, and `performGesture { ... }` for complex gestures.

### 5. Assertions

Verify UI state:

- `assertIsDisplayed()`, `assertIsEnabled()`, `assertTextEquals("...")`, `assertContentDescriptionEquals("...")`, `assertExists()`, and `assertDoesNotExist()`.

### 6. Test isolation

Use `composeTestRule.setContent { MyComposable(...) }` to set the Composable under test directly, passing Mock or Fake data and callbacks. This enables isolated testing for a single Composable or screen.

### 7. Synchronization

The Compose test framework automatically waits until the UI is idle, meaning no pending layout, drawing, or animation work, before executing actions and assertions. This simplifies test writing.

---

## 8. Interoperability: Compose and the View System Together

Introducing Compose into an existing project, or using legacy View components inside Compose, is a common requirement.

### 1. Using Compose inside View

- **ComposeView:** an Android View that can be used in XML layouts or created in code. Call its `setContent { @Composable ... }` method to embed Compose UI.
- **Scenario:** gradually introduce Compose-based parts of the UI into an existing Activity or Fragment.

### 2. Using View inside Compose

- **AndroidView(factory = { context -> MyCustomView(context) }, update = { view -> view.setData(myState) }):** a Composable function that embeds a traditional Android View into the Compose UI hierarchy.
  - `factory`: creates the View instance and is called only once.
  - `update`: runs after `factory` and on later recompositions when dependent state changes, updating View properties from Compose state.
- **Scenario:** reuse existing complex custom Views or use Views that do not yet have Compose equivalents, such as WebView or MapView.

### 3. Theme and style interoperability

- **Accompanist libraries:** libraries such as `accompanist-themeadapter-material` and `accompanist-themeadapter-appcompat` help share colors, typography, and other style attributes between Compose and XML-based Material/AppCompat themes, creating a consistent visual appearance.

### 4. Notes

- **Performance:** crossing the Compose/View boundary can have some performance cost. Keep boundary count as low as practical.
- **Context and lifecycle:** pay attention to Context passing and component lifecycle management.
- **Focus and input:** focus management and input event propagation across the boundary may require extra handling.
- **Purpose:** this is mainly for **incremental migration** or **reusing existing components**. New screens should generally prefer pure Compose implementations.

---

## 9. Conclusion: Embrace Declarative UI and Master Its Mechanics

Jetpack Compose is not only a paradigm shift for Android UI development. It is also a carefully designed, powerful modern toolkit. Through declarative APIs, deep Kotlin integration, and strong runtime optimization, it aims to improve both development efficiency and UI performance.

However, to truly unlock Compose, you cannot stop at the surface. You need a deep understanding of its **runtime core**, including Composition, Recomposition, Stability, and Skipping; its **state management philosophy**, including the Snapshot system, state hoisting, and derived state; its **safe side-effect mechanisms**; its **declarative layout model**; and its **unique performance optimization points**.

Although Compose tries to simplify UI development, building complex and high-performance applications still requires a deep understanding of its internals and disciplined use of best practices. Mastering advanced Compose applications and internals means you can confidently build next-generation Android interfaces, solve performance bottlenecks efficiently, and help your team move toward the future of declarative UI development.

---

**"Jetpack Compose Advanced Applications and Internals" series**

1. Introduction: The Declarative UI Paradigm Shift
2. Advanced State Management: Beyond remember { mutableStateOf(...) }
3. **The Compose Layout Model: Declarative Measurement and Placement** (this article)
