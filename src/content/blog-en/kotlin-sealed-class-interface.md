---
title: "Kotlin Sealed Classes and Interfaces: Type-Safe UI State"
lang: en
translationKey: kotlin-sealed-class-interface
slug: kotlin-sealed-class-interface
excerpt: "A practical guide to Kotlin sealed classes and sealed interfaces, from exhaustive when checks to type-safe Compose UI state, MVI reducers, Flow results, and Navigation routes."
publishDate: '2026-01-21'
tags:
- "Kotlin"
- "Jetpack Compose"
- "Android"
- "Architecture"
- "Type Safety"
seo:
  title: "Kotlin Sealed Classes and Interfaces for Type-Safe UI State"
  description: "Learn how Kotlin sealed classes and interfaces enable exhaustive checks, safer Compose MVI state, Flow results, and typed Navigation routes."
  pageType: article
---

Last year I inherited a Compose project where one screen used six Boolean fields to control loading, empty data, error, success, refreshing, and network failure states. A single UI needed more than a dozen `when` branches, and missing one state combination often produced a blank screen. I spent an afternoon collapsing those Booleans into a `sealed interface`, and the bug count for that area dropped by roughly 40%.

This was not an advanced trick. It was just using Kotlin sealed types where compile-time exhaustiveness actually matters.

## The Core Value of Sealed Classes: Giving Enum-Like Cases Real Types

The main limitation of `enum class` is that every constant has the same shape. Each case cannot naturally carry a different data structure. Take a network result:

```kotlin
// ❌ enum cannot model this because every state carries different data.
enum class Result { Success, Error, Loading }
// Success needs data: T, Error needs error: Throwable, and enum cannot express that cleanly.
```

A `sealed class` restricts its direct subclasses, so the compiler can know whether a `when` expression covers every case. Each subclass is also its own type and can define its own properties.

```kotlin
sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(val code: Int, val message: String) : ApiResult<Nothing>()
    data object Loading : ApiResult<Nothing>()
}
```

Break it down:

- `out T` makes `Success(data)` covariant, while `Error` and `Loading` can use `Nothing` when they do not need `T`.
- Each subclass carries full context. `Error` owns its `code` and `message`, so callers do not need a separate parsing path.
- Kotlin 1.9+ recommends `data object` for singleton subclasses because it gives friendlier `toString()` output than a plain `object`.

Once the compiler knows every subclass of `ApiResult`, it can check `when` exhaustiveness at compile time:

```kotlin
fun <T> handleResult(result: ApiResult<T>): String = when (result) {
    is ApiResult.Success -> "Data: ${result.data}"
    is ApiResult.Error   -> "Error[${result.code}]: ${result.message}"
    is ApiResult.Loading -> "Loading..."
}
// Miss any branch → compilation fails, and the IDE highlights it immediately.
```

An enum is a set of values. A sealed class is a restricted type hierarchy. That is the fundamental difference.

## Sealed Interfaces: Splitting a Hierarchy Across Files

Direct subclasses of a `sealed class` must live in the same package and module, and historically the same file was the common pattern. Once a state hierarchy grows, for example when `Loading` splits into initial loading and refreshing, the file can quickly balloon to several hundred lines.

Kotlin 1.5 introduced `sealed interface`, which makes large hierarchies easier to split. Implementations can be distributed across files in the same package and module.

```kotlin
// file: UiState.kt
sealed interface ListUiState {
    data object Initial : ListUiState
    data object Loading : ListUiState

    // Nested sealed interfaces are allowed.
    sealed interface HasData : ListUiState {
        val items: List<String>
    }
}

// file: ContentState.kt  <- can be split into a separate file
data class ContentLoaded(override val items: List<String>) : ListUiState.HasData
data class Refreshing(override val items: List<String>) : ListUiState.HasData

// file: ErrorState.kt
data class LoadFailed(val reason: String) : ListUiState
```

The rule of thumb I use in real projects is simple:

| Scenario | Choice |
|------|------|
| Five or fewer states, unlikely to expand | `sealed class` |
| States will keep growing and need separate files | `sealed interface` |
| You need nested sub-hierarchies | `sealed interface` |

For exhaustive `when` checks, both behave the same. The compiler model is equivalent.

## Practice 1: Flow + Sealed Result to Remove Callback Spaghetti

A single network request with `try-catch` is manageable. Once you add parallel request merging, retries, and local-cache fallback, the traditional version quickly turns into this:

```kotlin
fun fetchWithCache() {
    viewModelScope.launch {
        try {
            val cached = cache.get()
            if (cached != null) emitUi(cached)
            val remote = api.fetch()
            cache.save(remote)
            emitUi(remote)
        } catch (e: Exception) {
            if (cached != null) emitUi(cached)  // Fallback
            else emitError(e)
        }
    }
}
```

Three paths are intertwined, and debugging depends on logs. A sealed class can describe the result of each step explicitly:

```kotlin
sealed class FetchStep {
    data class CacheHit(val data: List<Item>) : FetchStep()
    data object CacheMiss : FetchStep()
    data class RemoteSuccess(val data: List<Item>) : FetchStep()
    data class RemoteFailed(val error: Throwable) : FetchStep()
}
```

The Flow pipeline becomes linear:

```kotlin
fun fetchFlow(): Flow<FetchStep> = flow {
    val cached = cache.get()
    if (cached != null) emit(FetchStep.CacheHit(cached))
    else emit(FetchStep.CacheMiss)

    try {
        val remote = api.fetch()
        cache.save(remote)
        emit(FetchStep.RemoteSuccess(remote))
    } catch (e: Exception) {
        emit(FetchStep.RemoteFailed(e))
    }
}
```

The ViewModel reduces state by exhaustively handling each step:

```kotlin
fun observeFetch() {
    fetchFlow().collect { step ->
        _uiState.value = when (step) {
            is FetchStep.CacheHit      -> UiState.Content(step.data, fromCache = true)
            is FetchStep.CacheMiss     -> UiState.Loading
            is FetchStep.RemoteSuccess -> UiState.Content(step.data, fromCache = false)
            is FetchStep.RemoteFailed  -> if (currentState is UiState.Content)
                UiState.Content(currentState.data, fromCache = true)
            else UiState.Error(step.error.toUserMessage())
        }
    }
}
```

When `RemoteFailed` falls back, it needs the current `Content` state. With sealed types, a direct `is` check gives you the data. You do not need a separate `lastSuccessData` variable, which is exactly the kind of intermediate state that often gets out of sync.

## Practice 2: Type-Safe Navigation Routes

Compose Navigation parameters are often built with string concatenation:

```kotlin
navController.navigate("detail/${id}?source=${source}")
```

Route definitions and parameter names end up scattered across the codebase. During refactors, one missed string does not fail compilation. Define the route table as a sealed class instead:

```kotlin
sealed interface AppRoute {
    @Serializable data object Home : AppRoute
    @Serializable data class Detail(val id: String, val source: String = "list") : AppRoute
    @Serializable data class Profile(val userId: Long) : AppRoute
}

// Navigation call
navController.navigate(AppRoute.Detail(id = "123"))
```

With the type-safe APIs in Navigation 2.8+:

```kotlin
NavHost(navController, startDestination = AppRoute.Home) {
    composable<AppRoute.Home> { HomeScreen() }
    composable<AppRoute.Detail> { backStackEntry ->
        val route: AppRoute.Detail = backStackEntry.toRoute()
        DetailScreen(route.id, route.source)
    }
    composable<AppRoute.Profile> { backStackEntry ->
        val route: AppRoute.Profile = backStackEntry.toRoute()
        ProfileScreen(route.userId)
    }
}
```

If you add a route but forget the matching `composable` inside `NavHost`, the app will still crash at runtime. That is still better than a silent "parameter not found" bug. A compile-time lint check would be the stronger version of this pattern, and it is worth building separately in larger codebases.

## Practice 3: A Type-Safe State Machine for MVI

In MVI, UI state is often assembled from a `data class` full of nullable fields:

```kotlin
// ❌ You only know at runtime which fields are valid.
data class MviUiState(
    val items: List<Item> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val isRefreshing: Boolean = false,
)
```

The problem is that when `items` has data, `isLoading` should be false. When `error` is non-null, `items` should usually be ignored. Those constraints are enforced only by human discipline, so they eventually break.

A sealed interface locks the valid combinations into the type system:

```kotlin
sealed interface MviUiState {
    data object Initial : MviUiState
    data object Loading : MviUiState
    data class Content(
        val items: List<Item>,
        val isRefreshing: Boolean = false,
    ) : MviUiState
    data class Error(
        val message: String,
        val canRetry: Boolean = true,
    ) : MviUiState
}
```

Compose consumes the state exhaustively:

```kotlin
@Composable
fun ListScreen(state: MviUiState) {
    when (state) {
        is MviUiState.Initial  -> EmptyPrompt(onClick = { vm.load() })
        is MviUiState.Loading  -> ShimmerList()
        is MviUiState.Content  -> LazyColumn {
            items(state.items) { ItemCard(it) }
            if (state.isRefreshing) item { RefreshIndicator() }
        }
        is MviUiState.Error    -> ErrorBanner(state.message, state.canRetry) { vm.retry() }
    }
}
```

A `when` branch cannot accidentally receive a state that is both loading and carrying an error. The type system removes those illegal combinations for you.

Take the same idea further and model user interaction as intents:

```kotlin
sealed interface ListIntent {
    data object LoadInitial : ListIntent
    data object Refresh : ListIntent
    data class Delete(val id: String) : ListIntent
    data object Retry : ListIntent
}
fun reduce(state: MviUiState, intent: ListIntent): MviUiState = when (intent) {
    is ListIntent.LoadInitial -> MviUiState.Loading
    is ListIntent.Refresh    -> (state as? MviUiState.Content)?.copy(isRefreshing = true) ?: state
    is ListIntent.Delete     -> if (state is MviUiState.Content)
        MviUiState.Content(state.items.filterNot { it.id == intent.id })
    else state
    is ListIntent.Retry      -> MviUiState.Loading
}
```

Every transition is deterministic. Unit tests do not need to mock a pile of Booleans:

```kotlin
@Test
fun `delete item from content removes it`() {
    val state = MviUiState.Content(listOf(Item("1"), Item("2")))
    val next = reduce(state, ListIntent.Delete("1"))
    assertEquals(1, (next as MviUiState.Content).items.size)
}
```

## Pitfalls and Tradeoffs

**Pitfall 1: Do not hide sealed coverage behind `else`**

Many people write this for convenience:

```kotlin
when (state) {
    is UiState.Loading -> showLoading()
    else -> showContent(state)  // ❌ New states compile, then fall into else at runtime.
}
```

Once you add `else`, the compiler stops enforcing exhaustiveness. When a new subclass is added, the IDE will not guide you to the missing branch. In production, that usually means a bug. A team lint rule should forbid `else` in `when` expressions over sealed types.

**Pitfall 2: sealed does not mean immutable**

`sealed class` does not force its subclasses to be `data class` instances. If you use ordinary classes, internal `var` fields can still be mutated unexpectedly. Prefer `data class` and `data object` for subclasses unless you have a specific reason not to.

**Pitfall 3: Serialization compatibility**

With `kotlinx.serialization`, put `@Serializable` on both the sealed type and each subclass. The default JSON shape includes a `type` discriminator to identify the subclass. If your backend infers the subtype from regular fields instead, you may need a custom `JsonContentPolymorphicSerializer`.

**Tradeoff: Should every state become sealed?**

If a screen only has loading and content, a Boolean can be enough. Sealed types start paying for themselves when the state count reaches four or more. Do not introduce them just to use the pattern.

I prefer state hierarchies that mirror the full lifecycle of the business flow: Initial → Loading → first data or empty data → later refresh or retryable error. At that granularity, a sealed interface is almost always more controllable than scattered Booleans.
