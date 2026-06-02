---
title: 深入 Kotlin Sealed Class/Interface 密封类层次：从编译期穷举检查到 Compose UI 状态建模的类型安全实践
excerpt: 本文深入探讨 Kotlin 密封类与密封接口的设计理念，从编译期穷举检查机制出发，结合 Compose UI 状态建模、MVI 架构、Flow 异步处理和 Navigation 路由等实战场景，展示如何用类型系统消除非法状态组合，提升代码健壮性。
publishDate: '2026-01-21'
tags:
- Kotlin
- Jetpack Compose
- Android
- 架构设计
- 类型安全
seo:
  title: 深入 Kotlin Sealed Class/Interface 密封类层次：从编译期穷举检查到 Compose UI 状态建模的类型安全实践
  description: 从 Boolean 散装状态到 sealed interface 类型安全建模，本文详解 Kotlin 密封类的编译期穷举机制及其在 Compose MVI、Flow 异步、Navigation 路由中的实战应用，附踩坑经验与取舍建议。
---

去年接手一个 Compose 项目，打开代码发现 UI 状态用了 6 个 Boolean 变量控制加载、空数据、错误、成功、刷新中、网络异常。一个界面要维护十几行 when 分支，还经常漏掉某个组合状态导致白屏。花了一个下午把所有 Boolean 收拢成 sealed interface，切换完 bug 数量直接降了 40%。

这不是什么高级技巧，只是把 Kotlin 密封类的编译期穷举能力用对了地方。

## Sealed Class 的核心价值：把枚举的"灵魄"注入类继承

`enum class` 的痛点是每个常量只能是同一个类型，不能携带不同结构的数据。以网络请求结果为例：

```kotlin
// ❌ enum 做不到——每个状态携带的数据不同
enum class Result { Success, Error, Loading }
// Success 要带 data: T，Error 要带 error: Throwable，enum 没法搞
```

`sealed class` 限制子类在同一文件内定义，编译器因此能在 `when` 表达式中判断分支是否穷举完毕。每个子类是独立类型，可以定义各自的属性。

```kotlin
sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(val code: Int, val message: String) : ApiResult<Nothing>()
    data object Loading : ApiResult<Nothing>()
}
```

拆解一下：

- `out T` 让 `Success(data)` 可以协变，`Error` 和 `Loading` 不需要 T 时用 `Nothing` 占位。
- 子类封装完整上下文——`Error` 自带 code 和 message，调用方不需要额外解析。
- Kotlin 1.9+ 推荐用 `data object` 替代 `object` 声明单例子类，`toString()` 更友好。

编译器感知到 `ApiResult` 的所有子类后，`when` 就能在编译期校验穷举：

```kotlin
fun <T> handleResult(result: ApiResult<T>): String = when (result) {
    is ApiResult.Success -> "数据: ${result.data}"
    is ApiResult.Error   -> "错误[${result.code}]: ${result.message}"
    is ApiResult.Loading -> "加载中..."
}
// 漏掉任一分支 → 编译不过，IDE 直接标红
```

enum 是值的集合，sealed class 是类型的受限层次——这是两者最根本的区别。

## Sealed Interface：打破单文件限制的层次分离

`sealed class` 的子类必须写在同一个文件里。当状态层次变复杂——比如 Loading 又要细分「首次加载」和「刷新中」——文件迅速膨胀到五六百行。

Kotlin 1.5 引入的 `sealed interface` 放宽了这个限制：子类可以分散在同一 package 的不同文件中。

```kotlin
// file: UiState.kt
sealed interface ListUiState {
    data object Initial : ListUiState
    data object Loading : ListUiState

    // 允许子 sealed interface 嵌套
    sealed interface HasData : ListUiState {
        val items: List<String>
    }
}

// file: ContentState.kt  ← 可以拆分到单独文件
data class ContentLoaded(override val items: List<String>) : ListUiState.HasData
data class Refreshing(override val items: List<String>) : ListUiState.HasData

// file: ErrorState.kt
data class LoadFailed(val reason: String) : ListUiState
```

实际项目中选择标准很简单：

| 场景 | 选择 |
|------|------|
| 状态 ≤ 5 种，不太会扩展 | `sealed class` |
| 状态会持续增加，需要拆文件 | `sealed interface` |
| 需要子状态的子继承（嵌套层次） | `sealed interface` |

两者在 `when` 穷举检查上完全等价——编译器行为一致。

## 实战一：Flow + Sealed Result 消灭回调地狱

单个网络请求用 `try-catch` 勉强能接受，但涉及到并行请求合并、重试逻辑、本地缓存降级时，传统写法会变成这样：

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
            if (cached != null) emitUi(cached)  // 降级
            else emitError(e)
        }
    }
}
```

三个路径交叉，调试全靠 log。用 sealed class 封装每一步的结果：

```kotlin
sealed class FetchStep {
    data class CacheHit(val data: List<Item>) : FetchStep()
    data object CacheMiss : FetchStep()
    data class RemoteSuccess(val data: List<Item>) : FetchStep()
    data class RemoteFailed(val error: Throwable) : FetchStep()
}
```

Flow 链路变得线性：

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

ViewModel 端的状态归并按步骤穷举：

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

`RemoteFailed` 降级时需要访问当前的 Content 状态。sealed class 模式下直接 `is` 判断拿到 data，不需要额外维护 `lastSuccessData` 变量——省掉一个容易忘更新的中间态。

## 实战二：Navigation 路由的类型安全

Compose Navigation 传参基本靠字符串拼接：

```kotlin
navController.navigate("detail/${id}?source=${source}")
```

路由定义和参数名散落在各处，重构时漏改一个字符串编译找不到。用 sealed class 定义路由表：

```kotlin
sealed interface AppRoute {
    @Serializable data object Home : AppRoute
    @Serializable data class Detail(val id: String, val source: String = "list") : AppRoute
    @Serializable data class Profile(val userId: Long) : AppRoute
}

// 导航调用
navController.navigate(AppRoute.Detail(id = "123"))
```

配合 Navigation 2.8+ 的类型安全 API：

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

路由变更时，如果在 `NavHost` 里漏加 `composable`，运行时会直接 crash——但总比「找不到参数」的静默 bug 强。更理想的做法是写个编译期 lint 检查，这个后续可以单独展开。

## 实战三：MVI 模式的类型安全状态机

MVI 架构下，UI 状态往往用 `data class` 加一堆可空字段拼凑：

```kotlin
// ❌ 运行时才知道哪些字段有效
data class MviUiState(
    val items: List<Item> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val isRefreshing: Boolean = false,
)
```

问题在于：`items` 有数据时 `isLoading` 应该为 false，`error` 非 null 时 `items` 应忽略——这些约束全靠人工逻辑保证，迟早崩。

sealed interface 直接把合法状态组合锁死：

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

Compose 端消费时穷举所有状态：

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

`when` 中不可能出现「既是 Loading 又有 error」的状态——类型系统替你屏蔽了这些非法组合。

再进一步，把用户交互抽象成 Intent：

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

每条状态转换都是确定的，写单元测试时不需要 mock 一堆 Boolean：

```kotlin
@Test
fun `delete item from content removes it`() {
    val state = MviUiState.Content(listOf(Item("1"), Item("2")))
    val next = reduce(state, ListIntent.Delete("1"))
    assertEquals(1, (next as MviUiState.Content).items.size)
}
```

## 踩过的坑和取舍

**坑一：`when` 覆盖别用 `else`**

很多人图省事写：

```kotlin
when (state) {
    is UiState.Loading -> showLoading()
    else -> showContent(state)  // ❌ 新增状态编译通过，运行时走 else
}
```

只要加了 `else`，编译器就放弃穷举检查。新增子类时 IDE 不会提示，线上出问题才后知后觉。项目中应该用 lint 规则禁止 sealed class 的 `when` 使用 `else`。

**坑二：sealed 不等于不可变**

`sealed class` 不强制 `data class` 子类。如果用了普通 class，小心内部的 `var` 字段被意外修改。子类统一用 `data class` 或 `data object`，省心。

**坑三：序列化兼容性**

用 `kotlinx.serialization` 序列化 sealed class 时，`@Serializable` 要加在 sealed class 本身和每个子类上。JSON 默认会多一个 `type` 字段区分子类。如果后端直接在字段层级判断，需要自定义 `JsonContentPolymorphicSerializer`。

**取舍：要不要所有状态都上 sealed？**

如果一个页面只有「加载中」和「有数据」两种状态，用个 `Boolean` 完全够。sealed class 的投入产出比在状态 ≥ 4 种时才开始显现。不要为了用而用。

我倾向于让状态层次反映业务流程的完整生命周期——Initial → Loading → 首次数据 / 空数据 → 后续刷新 / 错误重试。这个粒度下 sealed interface 几乎总是比散装 Boolean 可控。
