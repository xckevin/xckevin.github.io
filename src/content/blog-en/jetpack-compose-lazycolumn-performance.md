---
title: "Compose LazyColumn Scroll Performance: From Recomposition Tracing to Stable Frame Rates"
lang: en
translationKey: android-compose-lazycolumn-scroll-performance
slug: jetpack-compose-lazycolumn-performance
excerpt: "A practical LazyColumn performance guide covering recomposition spread, stability annotations, lambda stabilization, image loading isolation, compiler metrics, and Baseline Profiles."
publishDate: '2026-02-26'
tags:
- "Android"
- "Jetpack Compose"
- "LazyColumn"
- "Performance"
- "Recomposition"
seo:
  title: "Compose LazyColumn Scroll Performance: Recomposition, Stability, and Baseline Profiles"
  description: "Optimize LazyColumn scrolling by diagnosing recomposition spread, stabilizing models and lambdas, isolating image loading, and using Baseline Profiles."
  pageType: article
---

During a Compose migration, our team hit a typical problem: a mixed text-and-image feed dropped from 60 fps to around 35 fps while scrolling. At first we suspected the cards were too complex, but Layout Inspector told a different story: most card data had not changed, yet the cards were being recomposed repeatedly.

## How LazyColumn recomposition differs from RecyclerView

RecyclerView optimizes scrolling through ViewHolder reuse plus DiffUtil-driven updates. Views that leave the screen are recycled, and when they re-enter they are rebound with data. This model is mature, but it also means you must control update granularity in the Adapter. One careless call can refresh the whole list.

Compose takes a different path. LazyColumn does not reuse Composable instances. It uses a position-to-content mapping plus intelligent recomposition instead. When each item is called, compiler-generated recomposition markers decide whether execution can be skipped. This is a declarative improvement, but used poorly, it can be even jankier than RecyclerView.

The root cause is the difference in triggering behavior:

- RecyclerView: data changes -> `notifyItemChanged()` -> Adapter updates the matching ViewHolder
- LazyColumn: data changes -> State changes trigger recomposition -> Compose Runtime propagates recomposition through scopes -> unrelated items may be affected

When debugging, the symptom "card data did not change but the card recomposed" usually comes from this model. Recomposition spreads through the scope tree instead of targeting a single item with RecyclerView-style precision.

## Tracing and diagnosing recomposition spread

Compose 1.5+ includes Compose Compiler Metrics, which can quantify recomposition behavior. Enable it in `build.gradle`:

```kotlin
kotlinOptions {
    freeCompilerArgs += listOf(
        "-P",
        "plugin:androidx.compose.compiler.plugins.kotlin:reportsDestination=${buildDir}/compose_metrics"
    )
}
```

After compilation, it outputs three files. The key one is `<module>-composables.txt`. Each Composable function is annotated with:

- `restartable`: the function can be recomposed
- `skippable`: the function can be skipped when parameters are unchanged
- `stable`: the parameter type is inferred as stable

One trap I hit: a custom data class without `@Stable` or `@Immutable` was inferred as unstable by the compiler. As a result, every Composable that received it became `restartable` but **not `skippable`**. Any parent recomposition necessarily brought it along.

```kotlin
// The compiler treats this as unstable -> executes on every recomposition
data class FeedItem(
    val title: String,
    val avatarUrl: String,
    val tags: List<String>  // List is unstable by default
)

// After @Immutable -> recomposition can be skipped
@Immutable
data class FeedItem(
    val title: String,
    val avatarUrl: String,
    val tags: ImmutableList<String>  // Use a stable collection instead
)
```

Another convenient tool is Android Studio's Layout Inspector. Enable "Show Recomposition Counts", scroll the list, and you can see which items recompose frequently. My rule of thumb: anything above 3 times per second is worth investigating.

## Common scenarios and fixes

### Hoisted list state causing full recomposition

Place `LazyListState` in a high-level Composable and add a "back to top" button:

```kotlin
@Composable
fun FeedScreen() {
    val listState = rememberLazyListState()
    val showFab by remember {
        derivedStateOf { listState.firstVisibleItemIndex > 3 }
    }
    
    Column {
        LazyColumn(state = listState) { /* items */ }
        if (showFab) FloatingActionButton(onClick = { /* Back to top */ })
    }
}
```

`derivedStateOf` is the key. It only notifies readers when the calculated result changes. If you write `if (listState.firstVisibleItemIndex > 3)` directly, every tiny scroll offset can trigger the FAB recomposition check. The FAB itself may not redraw, but scheduling overhead still accumulates.

### Unstable lambda references

This issue is more subtle:

```kotlin
items(list, key = { it.id }) { item ->
    FeedCard(
        item = item,
        onClick = { viewModel.onItemClick(item.id) }  // New lambda on every recomposition
    )
}
```

Every outer recomposition creates a brand-new `onClick` object. Compose uses `equals` to decide whether parameters changed, and lambdas are new instances each time. Even if every other `FeedCard` parameter is unchanged, the card may still recompose.

The fix is to stabilize the lambda with `remember`, or pass the callback through state:

```kotlin
val onItemClick = remember { { id: String -> viewModel.onItemClick(id) } }
items(list, key = { it.id }) { item ->
    FeedCard(item = item, onClick = onItemClick)
}
```

### Image loading triggering unnecessary recomposition

Coil's `AsyncImagePainter` updates state when loading completes, and that update can propagate into the host Composable:

```kotlin
@Composable
fun FeedCard(item: FeedItem) {
    Column {
        AsyncImage(model = item.avatarUrl, contentDescription = null,
            modifier = Modifier.size(48.dp, 48.dp))
        Text(item.title)
    }
}
```

The better direction is to isolate image loading in its own scope so recomposition does not spread:

```kotlin
@Composable
fun FeedCard(item: FeedItem) {
    Column {
        // Image loading changes only affect this Box
        Box(modifier = Modifier.size(48.dp, 48.dp)) {
            AsyncImage(model = item.avatarUrl, contentDescription = null)
        }
        Text(item.title)
    }
}
```

When image size is fixed, combining this with `graphicsLayer` for offscreen rendering can further reduce the impact of image loading on the card's layout phase.

## Baseline Profile: smoothing the last frame-time spikes

After runtime optimizations are in place, small frame-time spikes may remain. This is where Baseline Profiles help. Their principle is to precompile key hot paths into AOT code, reducing runtime JIT CPU cost by moving compilation work from the main thread to installation time in the background.

```kotlin
// baseline-prof.txt
HSPLandroidx/compose/foundation/lazy/LazyListState$scrollToItem$1;->invoke(Lkotlin/coroutines/Continuation;)Ljava/lang/Object;
HSPLandroidx/compose/foundation/lazy/layout/LazyLayoutPrefetchState;-><init>(Lkotlin/jvm/functions/Function1;)V
```

Only collect methods that are definitely executed on the scroll path. Do not cover everything. A full profile file can slow AOT compilation and consume more storage.

We integrated Macrobenchmark into CI to run scroll frame-rate tests, collect baseline profiles, and update them automatically. After three iterations, P99 scroll frame time dropped from 18 ms to 11 ms, and visible jank mostly disappeared.

## Practical priority order

These three priorities have held up repeatedly in real projects, ordered by return on effort:

1. **Fix stability first**: `@Immutable` / `@Stable` plus stable collection types. It has the lowest cost and the most direct payoff. Use Compose Compiler Metrics to verify whether each data class is `stable`.
2. **Isolate side-effect scopes**: image loading, animations, and async state updates should have clear recomposition boundaries. Use `Modifier` or nested Composables to stop upward spread.
3. **Use Baseline Profile as a backstop**: apply it after the first two steps are solid. Returns diminish, but it is a good production tool for shaving off the last 5-8 ms.
