---
title: "Android Paging 3 Deep Dive: PagingSource, RemoteMediator, and Reactive Pagination"
lang: en
translationKey: android-paging3-pagingsource-remotemediator
slug: android-paging3-pagingsource-remotemediator
excerpt: "A deep breakdown of Paging 3's three-layer architecture: Pager, PagingSource, and RemoteMediator, including Room, RecyclerView, coroutine dispatchers, caching, and common pitfalls."
publishDate: '2026-04-24'
tags:
- "Android"
- "Paging 3"
- "Kotlin"
- "Architecture"
- "Performance"
seo:
  title: "Android Paging 3: PagingSource and RemoteMediator Deep Dive"
  description: "Explore Paging 3 architecture across PagingSource, Pager, RemoteMediator, Room, cachedIn, threading, RecyclerView updates, and practical pitfalls."
  pageType: article
---

While building a feed feature, I found that Paging 3 feels very different from Paging 2 to integrate. It is not just an API style change. The whole data-flow model changed. Paging 2's `DataSource` plus `PagedList` model is imperative, and you have to manage loading state manually. Paging 3 turns pagination into a `Flow<PagingData<T>>`, with loading logic, cache strategy, and UI state all enclosed in that data stream.

This article does not cover the basic usage of Paging 3. Instead, it breaks down the three-layer architecture - `Pager`, `PagingSource`, and `RemoteMediator` - so their responsibility boundaries are clear, along with how they couple to coroutine dispatchers, Room, and RecyclerView.

## PagingSource: the core contract of the paging engine

`PagingSource<Key, Value>` only requires two methods: `load()` and `getRefreshKey()`. To understand its behavior, start with the type hierarchy of `LoadParams` and `LoadResult`.

`LoadParams` has three subclasses: `Refresh`, `Append`, and `Prepend`, corresponding to refresh, loading after the current data, and loading before the current data. Paging 3 internally decides which request to issue based on the current `PagingState`. The developer only needs to branch on the params type inside `load()`:

```kotlin
class ArticlePagingSource(
    private val api: ArticleApi
) : PagingSource<Int, Article>() {

    override suspend fun load(params: LoadParams<Int>): LoadResult<Int, Article> {
        val page = params.key ?: 1
        return try {
            val response = api.getArticles(page, params.loadSize)
            LoadResult.Page(
                data = response.items,
                prevKey = if (page == 1) null else page - 1,
                nextKey = if (response.hasMore) page + 1 else null
            )
        } catch (e: Exception) {
            LoadResult.Error(e)
        }
    }

    override fun getRefreshKey(state: PagingState<Int, Article>): Int? {
        // Derive the key from the current anchor position for restoration after config changes.
        return state.anchorPosition?.let { anchor ->
            state.closestPageToPosition(anchor)?.prevKey?.plus(1)
                ?: state.closestPageToPosition(anchor)?.nextKey?.minus(1)
        }
    }
}
```

`getRefreshKey()` is easy to overlook, but it determines whether the list can recover from the user's current browsing position after a configuration change, such as a screen rotation, instead of forcing the list back to the first page. `anchorPosition` is the user's current visible position recorded in `PagingState`. `closestPageToPosition` finds the loaded page closest to that position, and the refresh starting point is inferred from that page's boundary key. If it returns `null`, Paging 3 loads from the beginning by default. A user who rotates the screen after scrolling to the middle will jump straight back to the top. This experience issue is hard to reproduce from a bug report and is often missed.

## Pager and `Flow<PagingData>`: assembling the data stream

`Pager` wraps `PagingSource` pagination logic into a cold stream, connecting the data source with downstream consumers.

```kotlin
val pager = Pager(
    config = PagingConfig(
        pageSize = 20,
        prefetchDistance = 5,      // Preload when 5 items away from the bottom
        enablePlaceholders = false
    ),
    pagingSourceFactory = { ArticlePagingSource(api) }
)

// In the ViewModel
val articles: Flow<PagingData<Article>> = pager.flow
    .map { pagingData -> pagingData.map { it.toUiModel() } }
    .cachedIn(viewModelScope)  // Cache across subscriptions to avoid duplicate loads
```

`cachedIn(viewModelScope)` is the easiest part to get wrong here. `Flow<PagingData>` is a cold stream. Every `collect` in the UI layer creates a new `PagingSource` instance, which is equivalent to loading the first page again. `cachedIn` converts the stream into a shared stream and caches `PagingData` for the lifetime of the specified `CoroutineScope`. After a configuration change, the UI resubscribes and receives existing data instead of triggering another network request.

There is also an ordering issue: **`cachedIn` must be the last operator**. Placing `map` after `cachedIn` does not invalidate the cache and does not reload data, but every `collect` reruns the downstream `map` logic, which can create unexpected side effects. The correct order is `flow -> map -> cachedIn`.

In `PagingConfig`, `prefetchDistance` defaults to `pageSize`. In real projects, I usually set it to one quarter of `pageSize`. On weak networks, triggering preloads too early can leave multiple requests suspended at the same time. That does not improve the experience and increases server pressure.

## RecyclerView integration: PagingDataAdapter's diff update mechanism

`PagingDataAdapter` internally uses `AsyncPagingDataDiffer` to drive diff updates. It calculates the diff on a background thread, `Dispatchers.Default`, and then dispatches updates to the main thread.

```kotlin
class ArticleAdapter : PagingDataAdapter<Article, ArticleViewHolder>(DIFF_CALLBACK) {

    companion object {
        val DIFF_CALLBACK = object : DiffUtil.ItemCallback<Article>() {
            override fun areItemsTheSame(old: Article, new: Article) = old.id == new.id
            override fun areContentsTheSame(old: Article, new: Article) = old == new
        }
    }

    override fun onBindViewHolder(holder: ArticleViewHolder, position: Int) {
        val item = getItem(position) // May be null when enablePlaceholders = true
        item?.let { holder.bind(it) }
    }
}
```

`submitData()` is a suspending function. It waits for the previous diff calculation to finish before accepting a new `PagingData`. The common Paging 2 `IndexOutOfBoundsException` crash - caused by RecyclerView item-count mismatch during concurrent updates - is eliminated in Paging 3 through this serialization mechanism.

Loading state is exposed through `loadStateFlow` across three dimensions: `refresh`, `append`, and `prepend`.

```kotlin
lifecycleScope.launch {
    adapter.loadStateFlow.collect { loadStates ->
        swipeRefresh.isRefreshing = loadStates.refresh is LoadState.Loading
        if (loadStates.refresh is LoadState.Error) {
            showError((loadStates.refresh as LoadState.Error).error)
        }
        // Show a retry footer when append fails
        footerAdapter.loadState = loadStates.append
    }
}
```

`adapter.retry()` can retry the last failed request without resetting the entire paging stream. This is a frequent operation on weak networks, so the UI must expose a retry entry point.

## RemoteMediator: coordinating network and database

Pure network pagination, using only `PagingSource`, performs poorly in offline or weak-network scenarios. `RemoteMediator` is designed to **make the database the single source of truth, while the network only fills the database**.

The workflow is: the UI consumes a Room database `PagingSource`; when the database does not have enough data and the list approaches the end, Paging 3 automatically calls `RemoteMediator.load()` to request the network; the result is written into the database; Room's reactive query then drives the UI update. The whole chain does not require manual `notify` calls.

```kotlin
@OptIn(ExperimentalPagingApi::class)
class ArticleRemoteMediator(
    private val api: ArticleApi,
    private val db: AppDatabase
) : RemoteMediator<Int, Article>() {

    override suspend fun load(
        loadType: LoadType,
        state: PagingState<Int, Article>
    ): MediatorResult {
        val page = when (loadType) {
            LoadType.REFRESH -> 1
            // Most feeds do not support upward pagination, so stop immediately.
            LoadType.PREPEND -> return MediatorResult.Success(endOfPaginationReached = true)
            LoadType.APPEND -> {
                db.remoteKeyDao().getNextPage()
                    ?: return MediatorResult.Success(endOfPaginationReached = true)
            }
        }

        return try {
            val response = api.getArticles(page, state.config.pageSize)
            db.withTransaction {
                if (loadType == LoadType.REFRESH) db.articleDao().clearAll()
                db.remoteKeyDao().saveNextPage(page + 1)
                db.articleDao().insertAll(response.items)
            }
            MediatorResult.Success(endOfPaginationReached = !response.hasMore)
        } catch (e: IOException) {
            MediatorResult.Error(e)
        }
    }
}
```

Several details matter here.

**Transaction atomicity:** `db.withTransaction {}` guarantees that clearing old data and writing new data happen atomically, avoiding a visible empty-list flicker during refresh. This is especially obvious during first open on a slow network. Without the transaction, occasional blank screens appear.

**Page-number storage:** Store page numbers in a dedicated `RemoteKey` table instead of memory. If the process is killed and restarted, loading can still continue from the correct position. Reset on `REFRESH`, read and increment on `APPEND`. An in-memory solution looks simple, but it silently loses pagination state after background process death.

**`initialize()` controls the first-load strategy:** `RemoteMediator` also has an overridable `initialize()` method. Returning `LAUNCH_INITIAL_REFRESH` forces a database refresh on the first subscription. Returning `SKIP_INITIAL_REFRESH` uses existing database data directly. For scenarios that need offline cache, returning `SKIP_INITIAL_REFRESH` at startup lets users immediately see the last data even without a network connection.

When assembling the pipeline, pass both `RemoteMediator` and the Room-based `PagingSource` to `Pager`:

```kotlin
val pager = Pager(
    config = PagingConfig(pageSize = 20),
    remoteMediator = ArticleRemoteMediator(api, db),
    pagingSourceFactory = { db.articleDao().pagingSource() }
)
```

When a Room `@Query` returns `PagingSource<Int, Article>`, every database write automatically triggers `PagingSource.invalidate()`, which causes Paging 3 to collect data again. This is the foundation of the whole reactive chain.

## Dispatcher coupling and threading model

Paging 3's internal threading is layered. `Pager` uses `Dispatchers.Default` for paging state-machine logic. `PagingSource.load()` is called by Paging 3's internal fetcher coroutine, which runs on `Dispatchers.IO` by default. `AsyncPagingDataDiffer` also calculates diffs on `Dispatchers.Default`, then dispatches UI updates to the main thread.

One trap I have hit: doing complex data mapping after JSON deserialization directly inside `PagingSource.load()` without switching dispatchers, causing occasional dropped frames on the main thread. `load()` is a suspending function. If it contains CPU-heavy work without an explicit dispatcher, it consumes the current coroutine's thread resources. The right approach is to handle mapping in the ViewModel's `Flow.map`, or explicitly switch inside `load()`:

```kotlin
// In the ViewModel, map runs on the dispatcher of viewModelScope.
val articles = pager.flow
    .map { pagingData ->
        pagingData.map { withContext(Dispatchers.Default) { it.toHeavyUiModel() } }
    }
    .cachedIn(viewModelScope)
```

Network requests in `RemoteMediator.load()`, such as Retrofit calls, normally run on `Dispatchers.IO`, and Room suspending queries run on their own dispatchers. No extra handling is usually needed.

## Practical recommendations

**Let `PagingSource` fetch data, not perform business mapping.** Its instances are frequently rebuilt because of `invalidate()`, so putting recomputation there creates unnecessary overhead. Convert data to UI models in the ViewModel's `Flow.map`.

**Handle all three loading-state dimensions.** `refresh`, `append`, and `prepend` are independent. `append` errors are especially easy to miss. Users may think they reached the end of the list when the request actually failed. `ConcatAdapter` plus a dedicated `LoadStateAdapter` is currently the cleanest implementation.

**Use `TestPager` to test `PagingSource`.** Paging 3 provides the `TestPager` test utility, which lets you unit-test `load()` without a full `Pager` and `Flow`. Cover the three core paths: first-page load, next-page load, and error retry.
