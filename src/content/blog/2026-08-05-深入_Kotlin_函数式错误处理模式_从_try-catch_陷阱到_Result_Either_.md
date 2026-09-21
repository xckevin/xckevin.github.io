---
title: 深入 Kotlin 函数式错误处理模式
excerpt: 从线上崩溃案例切入，剖析 try-catch 在工程化项目中的结构性缺陷，深入对比 Kotlin Result 与 Arrow Either 两种函数式错误处理方案的设计理念、适用场景与工程取舍。
publishDate: '2026-08-05'
tags:
- Kotlin
- 函数式编程
- 错误处理
- Arrow
- 架构设计
seo:
  title: 深入 Kotlin 函数式错误处理模式
  description: 从 try-catch 的结构性缺陷出发，详解 Kotlin Result 与 Arrow Either 的函数式错误处理方案，结合 Railway Oriented Programming 给出实战场景选型指南。
---

## 一个线上崩溃引起的反思

去年排查过一个奇怪的线上 crash：订单提交接口返回了 200，但解析 body 时抛了 JsonSyntaxException。堆栈追踪显示异常在 ViewModel 层被 `catch(e: Exception)` 兜底捕获，弹了一个通用 Toast。用户看到"操作失败"后连点了三次提交，后台生成了三笔重复订单。

问题出在哪？catch 块吃掉了异常的语义。`catch(e: Exception)` 把所有错误扁平化成一句话，业务层根本不知道发生了什么——是网络断了、是参数错了、还是服务端格式变了？

try-catch 在工程化项目中有三个结构性缺陷。

**异常不可见。** 调用方无法从函数签名判断会不会抛异常。`fun fetchOrder(id: String): Order` 看起来人畜无害，内部却可能抛出 NetworkException、AuthException、ParseException。这些信息全在文档里——而文档大概率没人维护。编译器既不提示也不检查。

**无法组合。** 串行三步操作：拉取用户信息 → 校验权限 → 创建订单，每一步都可能失败。用 try-catch 嵌套要么层层包裹形成地狱缩进，要么一个大 catch 吃掉所有差异。

```kotlin
fun processOrder(): Order? {
    return try {
        val user = fetchUser()
        if (!checkPermission(user)) return null
        createOrder(user)
    } catch (e: Exception) {
        log("操作失败: ${e.message}")
        null  // 三种不同的业务状态被统一成了 null
    }
}
```

**恢复困难。** catch 块里通常三种选择——抛新异常（污染调用链）、返回 null（丢失上下文）、返回默认值（掩盖 bug）。调用方永远拿不到错误细节。

## Kotlin Result：把错误变成返回值

`Result<T>` 的核心思路：让错误成为返回值的一部分，而不是控制流的副作用。它把操作结果封装成 Success 或 Failure，编译器会强制调用方处理两种状态。

```kotlin
suspend fun fetchOrder(id: String): Result<Order> = runCatching {
    val response = api.getOrder(id)
    if (!response.isSuccessful) {
        throw HttpException(response)
    }
    response.body()!!
}

val result = fetchOrder("12345")
result
    .onSuccess { order -> showOrder(order) }
    .onFailure { e -> handleError(e) }
```

`runCatching` 是进入 Result 世界的主要入口，自动捕获 Throwable 并包装成 Result 失败分支。需要注意的是，`Result<T>` 是一个 inline class，并没有对外暴露 `Result.Success`/`Result.Failure` 这样可直接做子型匹配的公开子类，内部只是用一个 `value` 字段区分成功/失败。正确的用法是通过 `isSuccess`/`isFailure`/`getOrNull()`/`exceptionOrNull()`/`onSuccess`/`onFailure` 这些方法来判断和取值，而不是用 `when (result) { is Result.Success -> ... }` 这种 `when` 语句。

还有一个容易忽略的陷阱：`runCatching` 会捕获**所有** `Throwable`，包括协程的 `CancellationException`。在协程上下文中，`CancellationException` 是协程取消机制的信号，一旦被 `runCatching` 吸掉就会阻断协程取消的传播，导致已取消的任务仍在后台执行，或者结构化并发（structured concurrency）的取消传播链断裂。安全的做法是在 catch 位置显式重新抛出 `CancellationException`：

```kotlin
suspend fun fetchOrder(id: String): Result<Order> = try {
    Result.success(api.getOrder(id).also {
        if (!it.isSuccessful) throw HttpException(it)
    }.body()!!)
} catch (e: CancellationException) {
    throw e  // 协程取消信号必须重新抛出，不能包进 Result
} catch (e: Exception) {
    Result.failure(e)
}
```

如果确实想继续用 `runCatching` 的简洁写法，可以包一层辅助函数，在内部检测到 `CancellationException` 时重新抛出。

Result 提供了一套转换算子，支持链式组合：

```kotlin
val finalResult = runCatching { fetchRawData() }
    .mapCatching { raw -> parseToModel(raw) }   // 转换成功值，捕获异常
    .recoverCatching { e -> loadFromCache() }    // 失败时降级到缓存
    .map { model -> enrichWithMetadata(model) }  // 不再可能失败的操作
```

`mapCatching` 和 `recoverCatching` 保持 Result 包装状态，普通的 `map` 只在 Success 上执行。这套 API 可以在不写 try-catch 的前提下组合多个可能失败的操作，每个环节的错误都被精确记录。

但 Result 有一个关键限制：Failure 分支只承载 Throwable，丢失了错误类型的精度。如果你需要区分"网络不可达"和"参数校验失败"，只能靠 `when (e is XxxException)` 做类型判断——本质上又回到了 try-catch。

另一个工程上的尴尬：Kotlin 1.9 之前禁止 suspend 函数以 `Result<T>` 作为返回类型，1.9 放开了限制但 IDE 仍会警告。官方倾向于把 Result 定位为模块内部的中间类型，不建议让它穿越模块边界。

## Arrow Either 与 Railway Oriented Programming

Railway Oriented Programming（铁路导向编程）把函数比作铁轨切换器：正常路径是主干道，错误路径是岔路。成功时数据沿主干道流动，一旦出错就切换到侧线，后续操作全部跳过直到终点处理。

Arrow 库的 `Either<L, R>` 是这个模型在 Kotlin 中的落地：`Left<L>` 承载错误，`Right<R>` 承载成功值。和 Result 的区别在于 L 可以是任意类型：

```kotlin
sealed class OrderError {
    data class Network(val cause: Throwable) : OrderError()
    data class Auth(val reason: String) : OrderError()
    data class Validation(val field: String, val msg: String) : OrderError()
}

fun fetchOrder(id: String): Either<OrderError, Order> = either {
    val response = api.getOrder(id).bind()
    ensure(response.isSuccessful) { OrderError.Network(HttpException(...)) }
    response.body()!!
}
```

`either { }` 构建块配合 `bind()` 是实现 Railway 的核心。bind() 在 Right 上解包继续执行，在 Left 上短路整个 either 块。多个操作串联后，代码读起来像同步流程，但隐含完整的错误传播语义：

```kotlin
fun createOrderWorkflow(id: String): Either<OrderError, OrderConfirmation> = either {
    val rawOrder = fetchOrder(id).bind()           // 网络失败 → 短路
    val validated = validate(rawOrder).bind()      // 校验失败 → 短路
    val enriched = applyPromotions(validated).bind() // 规则冲突 → 短路
    submitToBackend(enriched).bind()               // 提交失败 → 短路
}
```

任何一个环节返回 Left，后续 bind 全部跳过，错误原封不动传到调用方。调用方用 fold 做统一收口：

```kotlin
when (val result = createOrderWorkflow("12345")) {
    is Either.Left -> handleOrderError(result.value)
    is Either.Right -> showConfirmation(result.value)
}
```

这种写法的工程价值在于编译器会帮你穷举所有错误分支。当你给 `OrderError` 增加一个新的子类时，所有 when 处理都会报编译警告——运行时永远做不到这种保障。

## 实战中的取舍

我在三个项目的网络层分别用过 try-catch、Result、Either，体感如下。

直接用 try-catch 仍然是上手最快的方式。团队对函数式范式接受度不高时，强行引入 Either 反而增加认知负担。小程序或工具脚本，Result 足够。

Result 适合模块内部使用。比如 Repository 层内部用 runCatching 组合网络和缓存逻辑，在边界转成 sealed class 暴露给上层。不要让 Result 穿越模块边界——Kotlin 的设计倾向不鼓励这样做，跨模块后错误类型信息已经丢失了。

Either 适合强类型错误场景。多角色权限系统、支付流程、表单校验链——当错误分支有明确业务含义且需要精细化处理时，Either 的类型精度是 try-catch 无法提供的。代价是团队需要理解 `either { }`、`bind()`、`traverse` 这些概念。

关于依赖：Kotlin 标准库自带 Result，零额外成本。Arrow 的 `arrow-core` 约 500KB，对 APK 体积影响可忽略，但学习曲线不低。如果只想要 Either 类型不想引入 Arrow，可以手写一个极简版：

```kotlin
sealed class Either<out L, out R> {
    data class Left<L>(val value: L) : Either<L, Nothing>()
    data class Right<R>(val value: R) : Either<Nothing, R>()
}
```

缺少 bind() 会让链式调用退化成嵌套 flatMap，但仍然能获得 Left/Right 的编译期错误提示——这是 try-catch 永远给不了的保障。

try-catch、Result、Either 不是递进关系，它们解决不同规模的问题。更务实的判断标准是：如果你的 catch 块里开始写 `if (e is A) ... else if (e is B)` 了，就是时候升级了。不要因为函数式编程"看起来高级"就引入 Either，也不要因为 try-catch"太基础"就不屑于用它——工具的选择取决于你面临的约束，而不是工具的知名度。
