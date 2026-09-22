---
title: "LazyColumn Performance: Keys, Content Types, Stability, and Measurement"
lang: en
translationKey: android-compose-lazycolumn-scroll-performance
slug: jetpack-compose-lazycolumn-performance
excerpt: "Diagnose LazyColumn jank with stable item identity, content types, carefully scoped state, and release-mode Macrobenchmark measurements."
publishDate: '2026-02-26'
updatedDate: '2026-09-22'
tags:
- Android
- Jetpack Compose
- LazyColumn
- Performance
- Recomposition
seo:
  title: "LazyColumn Performance: Keys, Content Types, and Measurement"
  description: "Improve LazyColumn behavior with stable keys, content types, accurate stability guidance, and release-mode Macrobenchmark measurement."
  pageType: article
---

**Do not tune a LazyColumn from a debug scroll impression.** First verify the release build with R8 enabled, measure a representative scroll, then fix the work shown in the trace. Lazy layouts compose and lay out visible items on demand; that helps, but it does not protect an app from unstable inputs, expensive item work, or an incorrect list structure.

The highest-value checklist is: give every stateful/reorderable item a stable unique key; supply `contentType` for genuinely different row structures; avoid doing list-wide work inside item lambdas; and measure before claiming a frame-rate result. There is no universal “60 fps fix.”

## Identity and reuse solve different problems

`key` identifies an item across inserts, deletes, moves, and restoration. It keeps remembered item state with the logical item rather than its position. When an item uses `rememberSaveable`, use a Bundle-supported stable key such as an ID, enum, or `Parcelable`.

`contentType` describes the item's *layout kind*. It lets a lazy layout reuse composition only among compatible structures. It is useful for a mixed feed, not a decoration to add to a uniform list.

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

sealed interface FeedRow { val id: Long
    data class Article(override val id: Long, val title: String) : FeedRow
    data class Ad(override val id: Long, val label: String) : FeedRow
}

@Composable
fun FeedList(rows: List<FeedRow>) {
    LazyColumn {
        items(
            items = rows,
            key = { it.id },
            contentType = { row -> when (row) {
                is FeedRow.Article -> "article"
                is FeedRow.Ad -> "ad"
            } }
        ) { row ->
            when (row) {
                is FeedRow.Article -> ArticleRow(row)
                is FeedRow.Ad -> AdRow(row)
            }
        }
    }
}

@Composable private fun ArticleRow(row: FeedRow.Article) =
    Column(Modifier.fillMaxWidth()) { Text(row.title) }
@Composable private fun AdRow(row: FeedRow.Ad) =
    Column(Modifier.fillMaxWidth()) { Text(row.label) }
```

Do not emit a whole screen's rows from one `item { ... }`: when any part becomes visible, that entire group must compose and measure together, defeating laziness. Small inseparable decoration such as a divider may remain with its row.

## Stability is a diagnosis, not an annotation ritual

Compose treats standard `List`, `Set`, and `Map` as unstable because it cannot prove immutability. `@Immutable` and `@Stable` are contracts: use them only when the type truly meets the contract and Compose is notified of every observable change. Adding an annotation to mutable data can produce stale UI.

Kotlin 2.0.20 enables Compose strong skipping by default. In that mode, restartable composables with unstable parameters can be skippable, using instance equality for unstable parameters and `equals` for stable ones; captured lambdas are also memoized by the compiler. This reduces a common lambda-allocation issue, but it does not make a new list instance, a changed item model, image decoding, or expensive work free. On older compiler setups, behavior differs—check the compiler report and the actual module configuration rather than copying a version-specific workaround.

If a trace points to repeated item composition, inspect the inputs first: are rows immutable UI models, are callbacks scoped sensibly, and is a parent rebuilding the backing list? Move sorting, filtering, and mapping to the ViewModel or cache them with correctly keyed `remember`; never mutate state that was already read during the same composition.

## Keep rapidly changing state out of the list body

For a “back to top” affordance, the UI only needs the boolean threshold, not every pixel of scroll offset. `derivedStateOf` stops notifications when the derived result remains the same.

```kotlin
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

@Composable
fun FeedWithTopButton() {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val showTopButton by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = listState) { items(100, key = { it }) { Text("Row $it") } }
        if (showTopButton) Button(onClick = { scope.launch { listState.animateScrollToItem(0) } }) { Text("Top") }
    }
}
```

Use this only when a derived value changes less often than its source. For continuous parallax or drag position, defer the state read to a lambda modifier or draw phase as explained in [Compose phases](/en/blog/jetpack-compose-phases-composition-layout-draw/).

## Measure a reproducible user journey

Use a physical or representative device, a release/profileable build with R8, a fixed data set, and the same navigation and image-cache conditions. Macrobenchmark is the official tool for an end-to-end scroll: expose the list with `Modifier.testTag`, drive it through UI Automator, record `FrameTimingMetric`, and inspect its JSON/trace output. Compare before and after the same scenario; report device, build type, iteration count, data/image conditions, and percentile or jank metric. Without those, numbers are anecdotes.

Baseline Profiles can improve startup and critical journeys, but collect them from real journeys after correcting UI work. Do not hand-author internal Compose method signatures or promise a fixed millisecond gain.

Use [Compose gestures](/en/blog/jetpack-compose-gestures/) when rows add swipe interactions, and [Compose phases](/en/blog/jetpack-compose-phases-composition-layout-draw/) to place state reads correctly. Related articles are available under [Jetpack Compose](/en/jetpack-compose/) and [Android performance](/en/android-performance/).

## Official references

- [Lazy lists and grids](https://developer.android.com/develop/ui/compose/lists)
- [Compose performance](https://developer.android.com/develop/ui/compose/performance)
- [Stability in Compose](https://developer.android.com/develop/ui/compose/performance/stability)
- [Strong skipping mode](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
- [Write a Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark)
