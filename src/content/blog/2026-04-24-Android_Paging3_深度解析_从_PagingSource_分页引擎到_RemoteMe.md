---
title: Android Paging3 深度解析：PagingSource、RemoteMediator 与响应式分页架构
excerpt: 深入拆解 Paging3 的三层架构——Pager、PagingSource、RemoteMediator，厘清各层职责边界，剖析与 Room、RecyclerView、协程调度器的耦合原理及实践中的高频坑点。
publishDate: '2026-04-24'
tags:
- Android
- Paging3
- Kotlin
- 架构设计
- 性能优化
seo:
  title: Android Paging3 深度解析：PagingSource、RemoteMediator 与响应式分页架构
  description: 深入解析 Paging3 三层架构：PagingSource 分页引擎、Pager 数据流组装、RemoteMediator 网络与数据库协调，涵盖 cachedIn 缓存、线程模型与实战踩坑。
---

在做一个信息流功能时，我发现 Paging3 和 Paging2 的接入体感差异极大——不只是 API 风格变了，整个数据流向的设计逻辑都换了。Paging2 的 DataSource + PagedList 是命令式的，你得手动管理加载状态；Paging3 把分页抽象成一条 `Flow<PagingData<T>>`，加载逻辑、缓存策略、UI 状态全部内聚在这条数据流里。

这篇文章不介绍 Paging3 的基础用法，而是拆解它的三层架构——`Pager`、`PagingSource`、`RemoteMediator`——搞清楚各自的职责边界，以及与协程调度器、Room、RecyclerView 的耦合原理。

## PagingSource：分页引擎的核心契约

`PagingSource<Key, Value>` 只需要实现两个方法：`load()` 和 `getRefreshKey()`。理解它的行为，要从 `LoadParams` 和 `LoadResult` 的类型层级入手。

`LoadParams` 有三个子类：`Refresh`、`Append`、`Prepend`，分别对应刷新、向后加载、向前加载三种触发场景。Paging3 内部根据当前的 `PagingState` 决定发起哪种请求，开发者只需在 `load()` 里按 params 类型分支处理：

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
        // 从当前锚点位置反推 key，用于配置变更后的恢复
        return state.anchorPosition?.let { anchor ->
            state.closestPageToPosition(anchor)?.prevKey?.plus(1)
                ?: state.closestPageToPosition(anchor)?.nextKey?.minus(1)
        }
    }
}
```

`getRefreshKey()` 容易被忽视，但它决定了配置变更（比如旋转屏幕）后，列表能否从用户当前浏览位置恢复，而不是强制回到第一页。`anchorPosition` 是 `PagingState` 记录的用户当前可见位置，`closestPageToPosition` 找到离它最近的已加载页，从该页的边界 key 推算出刷新起点。返回 `null` 时 Paging3 默认从头加载，用户滚到中间位置后旋转屏幕会直接跳回顶部——这个体验问题很难通过 bug report 复现，往往被漏掉。

## Pager 与 Flow\<PagingData\>：数据流的组装

`Pager` 的职责是把 `PagingSource` 的分页逻辑封装成一条冷流，连接数据源与下游消费者。

```kotlin
val pager = Pager(
    config = PagingConfig(
        pageSize = 20,
        prefetchDistance = 5,      // 距底部 5 条时预加载
        enablePlaceholders = false
    ),
    pagingSourceFactory = { ArticlePagingSource(api) }
)

// ViewModel 中
val articles: Flow<PagingData<Article>> = pager.flow
    .map { pagingData -> pagingData.map { it.toUiModel() } }
    .cachedIn(viewModelScope)  // 跨订阅缓存，防止重复加载
```

`cachedIn(viewModelScope)` 是这里最容易踩坑的地方。`Flow<PagingData>` 本身是冷流，每次在 UI 层 `collect` 都会触发一次新的 `PagingSource` 实例创建，等同于重新加载第一页。`cachedIn` 把这条流转换成共享流，将 `PagingData` 缓存在指定的 `CoroutineScope` 生命周期内，配置变更时 UI 重新订阅拿到的是已有数据而非重新发起网络请求。

还有一个顺序问题：**`cachedIn` 必须是最后一个操作符**。在 `cachedIn` 之后接 `map` 不会让缓存失效（数据不会重新加载），但每次 `collect` 都会重新执行后续的 `map` 逻辑，产生非预期的副作用。正确顺序是 `flow → map → cachedIn`。

`PagingConfig` 里的 `prefetchDistance` 默认等于 `pageSize`。在实际项目中我倾向于设为 `pageSize` 的 1/4——弱网环境下过早触发预加载会让多个请求同时挂起，并没有改善体验，反而增加了服务端压力。

## RecyclerView 接入：PagingDataAdapter 的差异更新机制

`PagingDataAdapter` 内部使用 `AsyncPagingDataDiffer` 驱动差异更新（Diff Update）。它在后台线程（`Dispatchers.Default`）计算 diff，然后在主线程 dispatch 更新。

```kotlin
class ArticleAdapter : PagingDataAdapter<Article, ArticleViewHolder>(DIFF_CALLBACK) {

    companion object {
        val DIFF_CALLBACK = object : DiffUtil.ItemCallback<Article>() {
            override fun areItemsTheSame(old: Article, new: Article) = old.id == new.id
            override fun areContentsTheSame(old: Article, new: Article) = old == new
        }
    }

    override fun onBindViewHolder(holder: ArticleViewHolder, position: Int) {
        val item = getItem(position) // enablePlaceholders=true 时可能为 null
        item?.let { holder.bind(it) }
    }
}
```

`submitData()` 是挂起函数，它会等待前一次 diff 计算完成后才接受新的 `PagingData`。Paging2 里最常见的 `IndexOutOfBoundsException` 崩溃——来自并发更新期间 RecyclerView 的 item count 不一致——在 Paging3 里通过这个串行化机制彻底消除了。

加载状态通过 `loadStateFlow` 暴露，分 `refresh`、`append`、`prepend` 三个维度：

```kotlin
lifecycleScope.launch {
    adapter.loadStateFlow.collect { loadStates ->
        swipeRefresh.isRefreshing = loadStates.refresh is LoadState.Loading
        if (loadStates.refresh is LoadState.Error) {
            showError((loadStates.refresh as LoadState.Error).error)
        }
        // append 错误时显示底部重试 Footer
        footerAdapter.loadState = loadStates.append
    }
}
```

`adapter.retry()` 可以重新触发上次失败的请求，不需要重置整个分页流。弱网场景下这是高频操作，务必给用户暴露重试入口。

## RemoteMediator：网络与数据库的协调者

纯网络分页（只用 `PagingSource`）在离线或弱网场景下体验差。`RemoteMediator` 的设计目的是：**让数据库作为单一数据源（Single Source of Truth），网络只负责填充数据库**。

工作流程：UI 消费 Room 数据库的 `PagingSource`，当数据库数据不足（列表接近末尾）时，Paging3 自动调用 `RemoteMediator.load()` 向网络发起请求，写入数据库，Room 的响应式查询随即驱动 UI 更新——整条链路不需要手动 notify。

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
            // 大多数信息流不支持向上翻页，直接终止
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

这里有几个细节需要说清楚。

**事务原子性**：`db.withTransaction {}` 保证清空旧数据和写入新数据是原子操作，避免用户在刷新瞬间看到空列表的闪烁。这个问题在首次打开 + 网络较慢时尤其明显，不加事务会偶现白屏。

**页码存储方案**：用独立的 `RemoteKey` 表存储页码，而不是放在内存里。进程被杀后重启仍能从正确位置继续加载，`REFRESH` 时重置，`APPEND` 时读取并递增。内存方案看起来简单，但在后台进程被回收的场景下会悄悄丢失翻页状态。

**`initialize()` 控制首次加载策略**：`RemoteMediator` 还有一个可以 override 的 `initialize()` 方法，返回 `LAUNCH_INITIAL_REFRESH` 会在首次订阅时强制刷新数据库，返回 `SKIP_INITIAL_REFRESH` 则直接使用数据库已有数据。有离线缓存需求的场景，启动时返回 `SKIP_INITIAL_REFRESH` 可以让用户在无网络时也能立即看到上次的数据。

组装时把 `RemoteMediator` 和基于 Room 的 `PagingSource` 一起传给 `Pager`：

```kotlin
val pager = Pager(
    config = PagingConfig(pageSize = 20),
    remoteMediator = ArticleRemoteMediator(api, db),
    pagingSourceFactory = { db.articleDao().pagingSource() }
)
```

Room 的 `@Query` 返回 `PagingSource<Int, Article>` 时，每次数据库写入都会自动触发 `PagingSource` 的 `invalidate()`，进而让 Paging3 重新收集数据。整个响应式驱动的根基就在这里。

## 调度器耦合与线程模型

Paging3 内部的线程调度是分层的：`Pager` 用 `Dispatchers.Default` 处理分页状态机逻辑，`PagingSource.load()` 由 Paging3 内部的 fetcher 协程调用（默认运行在 `Dispatchers.IO`），`AsyncPagingDataDiffer` 的 diff 计算同样在 `Dispatchers.Default`，最终 dispatch 到主线程更新 UI。

踩过的一个坑：在 `PagingSource.load()` 里直接做了 JSON 反序列化后的复杂数据映射，没有切换调度器，导致主线程偶发卡帧。`load()` 是挂起函数，如果内部有 CPU 密集型计算却没有显式指定调度器，就会占用当前协程的线程资源。正确做法是在 ViewModel 的 `Flow.map` 里处理映射，或者在 `load()` 内部显式切换：

```kotlin
// ViewModel 中，map 操作在 viewModelScope 的调度器上执行
val articles = pager.flow
    .map { pagingData ->
        pagingData.map { withContext(Dispatchers.Default) { it.toHeavyUiModel() } }
    }
    .cachedIn(viewModelScope)
```

`RemoteMediator.load()` 里的网络请求（Retrofit 默认 `Dispatchers.IO`）和 Room 挂起查询各自在自己的调度器运行，不需要额外处理。

## 几点实践建议

**`PagingSource` 只做数据获取，不做业务映射。** 它的实例会因 `invalidate()` 频繁重建，重计算逻辑放在这里会产生不必要的开销。数据到 UI 模型的转换放在 ViewModel 的 `Flow.map` 里。

**三维加载状态要完整处理。** `refresh`、`append`、`prepend` 各自独立，`append` 的 `Error` 状态尤其容易被漏掉——用户会以为列表到头了，实际上是请求失败。`ConcatAdapter` + 专门的 `LoadStateAdapter` 是目前最干净的实现方式。

**测试 `PagingSource` 用 `TestPager`。** Paging3 提供了 `TestPager` 测试工具，可以不依赖完整的 `Pager` 和 `Flow` 对 `load()` 逻辑做单元测试，覆盖首页加载、翻页、错误重试三个核心路径。
