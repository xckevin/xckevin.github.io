---
title: "Android Navigation3 Architecture: Putting the Back Stack Back in Developers' Hands"
lang: en
translationKey: android-navigation3-scene-composable
slug: android-navigation3-scene-composable
excerpt: "A close look at Navigation3's core design: turning the back stack from a NavController black box into developer-owned Compose state, with Scene strategies for multi-pane layouts."
publishDate: 2026-04-14
tags:
- "Android"
- "Jetpack Compose"
- "Navigation3"
- "Architecture"
seo:
  title: "Android Navigation3 Architecture: Back Stack, Scene, and Compose"
  description: "A practical explanation of Navigation3, covering SnapshotStateList back stacks, type-safe routes, NavEntry features, Scene strategies, and migration tradeoffs."
  pageType: article
---

Navigation3 released 1.1.0 stable in April 2026. It is not an incremental upgrade to the old Navigation component. It is a navigation library designed from scratch by Google for Compose. The core difference can be summarized in one sentence: **the old library manages the back stack for you; Navigation3 lets you manage it yourself**.

After migrating to Navigation3, my strongest impression was that navigation logic could finally be debugged like ordinary Compose state. The back stack is just a `List`; set a breakpoint and you can see the current navigation state directly, without digging through NavController internals.

## The fundamental problem with old Navigation

The old Navigation component, `navigation-compose`, provides a Compose DSL, but underneath it still depends on the Fragment lifecycle model. NavController maintains a stack of `NavBackStackEntry` objects internally, and state saving, restoration, and transition animation are all coupled together.

The pain points in real projects are concrete.

**NavController is a black box.** Add, remove, and update operations on the back stack all happen through imperative APIs such as `navigate()` and `popBackStack()`. You cannot directly observe or manipulate the stack state. If you want to skip intermediate screens and return directly to Home, you have to combine `popUpTo` and `inclusive` parameters. It is awkward to write and harder to read.

**Routes lack type safety.** A route is essentially string concatenation. A pattern such as `"detail/{id}"` cannot validate parameter type or count at compile time. A common production crash is route argument parsing failure. Pass one parameter too few, or pass the wrong type, and the compiler will not warn you.

**Multi-pane adaptation is difficult.** On large-screen devices, a List-Detail two-pane layout requires hand-written logic around the navigation layer. The old library itself does not understand the idea of showing multiple destinations at the same time.

Navigation3 has a clear goal: return the back stack to developers, and let the navigation library render UI according to stack state.

## BackStack as State

Navigation3's most important design decision is this: **the back stack is an ordinary Compose state list**.

```kotlin
// Define type-safe routes
@Serializable data object HomeRoute
@Serializable data class DetailRoute(val id: String)

@Composable
fun App() {
    // Back stack = a mutableStateList that you fully own
    val backStack = rememberMutableStateList<Any>(HomeRoute)

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryProvider = entryProvider { route ->
            when (route) {
                is HomeRoute -> NavEntry(route) {
                    HomeScreen(onItemClick = { id ->
                        backStack.add(DetailRoute(id)) // navigation = append to the list
                    })
                }
                is DetailRoute -> NavEntry(route) {
                    DetailScreen(route.id)
                }
            }
        }
    )
}
```

This snippet is a complete Navigation3 setup. Several details are worth unpacking.

Routes are Kotlin data classes marked with `@Serializable`, so the compiler checks parameter types directly. `DetailRoute(id = "123")` replaces string concatenation such as `"detail/123"`, making type safety a compile-time property.

`backStack` is a `SnapshotStateList`. Navigation operations are list operations: `add()` moves forward, `removeLast()` goes back, and `clear()` followed by `add()` resets the stack. There is no need for specialized APIs such as `navigate()`, `popUpTo`, or `launchSingleTop`, because list operations already cover the navigation scenarios.

`NavDisplay` has a narrow job: observe changes in `backStack`, use `entryProvider` to obtain the matching `NavEntry` for the route at the top of the stack, and render it. **It is a stateless renderer.** All navigation state remains in your hands.

## NavEntry and Scene strategies

`NavEntry` is the basic rendering unit in Navigation3. It binds a route key to Composable content. The more interesting part is the **Scene strategy**, or `SceneStrategy`, which decides how multiple NavEntry instances are displayed at the same time.

```kotlin
NavDisplay(
    backStack = backStack,
    onBack = { backStack.removeLastOrNull() },
    entryProvider = entryProvider { ... },
    // Scene strategy chain: try each strategy in order
    sceneStrategy = DialogSceneStrategy()
        then TwoPaneSceneStrategy(isDetailVisible = backStack.size > 1)
        then SinglePaneSceneStrategy() // fallback
)
```

A Scene strategy is effectively a chain of responsibility. After `NavDisplay` obtains the current back stack, it asks each strategy in order, "Can you handle this set of entries?" `DialogSceneStrategy` recognizes entries marked as dialogs and renders them as overlays. `TwoPaneSceneStrategy` shows the top two entries side by side on large screens. `SinglePaneSceneStrategy` is the fallback and shows only the top entry.

This is a cleaner model than the old library. Large-screen support in the old library usually required hand-written conditional logic outside navigation, or nested NavHost instances, scattering logic across the app. Navigation3 abstracts "how to display entries" into pluggable strategies. The application layer only composes the strategy chain and does not need to know the rendering internals.

In projects, I usually organize it like this: phones use only `SinglePaneSceneStrategy`; tablets add a `TwoPaneSceneStrategy`; foldables switch dynamically based on hinge state. Strategy selection itself is driven by Compose state. When the window size changes, recomposition handles it without manual configuration-change plumbing.

## State saving and lifecycle

One advantage of the old library is its deep integration with `SavedStateHandle`. `NavBackStackEntry` comes with its own ViewModel scope. Navigation3 takes a different path.

Each `NavEntry` can declare the lifecycle resources it needs:

```kotlin
NavEntry(
    route = DetailRoute(id),
    featureMap = mapOf(
        SavedStateFeature to SavedStateSpec(),
        ViewModelStoreFeature to ViewModelStoreSpec()
    )
) {
    DetailScreen(route.id)
}
```

`featureMap` is an extensible capability declaration mechanism. `SavedStateFeature` lets an entry restore state after process recreation, and `ViewModelStoreFeature` gives the entry its own ViewModelStore. These capabilities are **declared on demand**. If a screen does not need a ViewModel, do not attach that feature, and you avoid unnecessary overhead.

There is one easy pitfall: if you forget to declare `ViewModelStoreFeature`, calling `viewModel()` inside the entry's Composable returns the outer ViewModel scope, usually the Activity scope, instead of an entry-level scope. This is easy to miss because it does not crash; data just appears to leak between screens.

## Practical migration advice

When migrating from old Navigation to Navigation3, my advice is not to do it all at once. Replace it module by module.

**Migrate route definitions first.** Convert string routes into data classes. This can already be done on the old library because Navigation 2.8+ supports type-safe routes. When you move to Navigation3, the route layer can be reused directly.

**Centralize navigation logic in a StateHolder.** Do not let every Screen mutate `backStack` directly. Expose semantic methods through a centralized `NavigationStateHolder`:

```kotlin
class AppNavigationState(private val backStack: SnapshotStateList<Any>) {
    fun goToDetail(id: String) = backStack.add(DetailRoute(id))
    fun goBack() = backStack.removeLastOrNull()
    fun resetToHome() {
        backStack.clear()
        backStack.add(HomeRoute)
    }
}
```

This preserves the observability of "back stack as state" while preventing navigation logic from spreading across Screens.

**Avoid depending on deep nesting for now.** Navigation3's current support for nested NavDisplay is still relatively basic, and deeply nested state saving may have edge cases. If the old app used nested NavHost heavily, first flatten it into a single NavDisplay combined with Scene strategies.

One final personal take: Navigation3's API is already stable enough for new projects. For existing projects with simple navigation, the main benefits are type safety and debuggability. Those improvements are real, but whether they justify a large refactor depends on whether your project is actually blocked by the navigation layer. Do not migrate just to use something new.
