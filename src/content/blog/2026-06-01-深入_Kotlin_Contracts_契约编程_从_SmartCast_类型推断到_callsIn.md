---
title: 深入 Kotlin Contracts 契约编程：从 SmartCast 失效到 callsInPlace 的编译器协作机制
excerpt: 深入解析 Kotlin Contracts 契约编程机制，涵盖 returns() implies 与 callsInPlace 两种核心契约如何帮助编译器实现 SmartCast 和变量初始化推断，并探讨实际使用场景与限制。
publishDate: '2026-06-01'
tags:
- Kotlin
- Contracts
- SmartCast
- 编译器
- 类型推断
seo:
  title: 深入 Kotlin Contracts 契约编程：从 SmartCast 失效到 callsInPlace 的编译器协作机制
  description: Kotlin Contracts 契约编程深度解析：了解 returns() implies 和 callsInPlace 如何让编译器理解函数调用效应，解决 SmartCast 失效问题，实现更精确的类型推断。
---

有一次在 Code Review 时看到一段代码，reviewer 问："这里为什么用 `!!`？用 `?.let` 不是更安全吗？" 我回他：前面已经调过 `requireNotNull` 了，但编译器不认。他愣了一下，然后我俩同时沉默了。

这大概是每个 Kotlin 开发者都撞过的墙：**你的逻辑是对的，但编译器不知道。**

```kotlin
fun validate(input: String?) {
    checkNotNull(input)  // 如果为 null 就抛异常，后续必然非 null
    println(input.length) // ❌ 编译器仍然认为 input 是 String?
}
```

`checkNotNull` 明明保证了后面不会为 null，SmartCast 为什么不生效？答案在 Kotlin 编译器的一个设计选择：**函数边界是类型推断的墙**——编译器不分析函数内部干了什么，只相信函数签名。`checkNotNull` 的签名是 `fun checkNotNull(value: Any?): Any`，在编译器眼里它只是一个普通函数调用，调用之后世界照旧。

要打破这堵墙，函数得向编译器"坦白"自己的行为。这便是 Kotlin Contracts（契约）要做的事。

## Contracts 是什么

Contracts 是一套 DSL，让函数向编译器声明自己的**调用效应**（Call Effect）。编译器根据这些声明在**调用处**做更精确的类型推断，而不是靠分析函数体。

它最早在 Kotlin 1.3 作为 Experimental API 引入，1.4 稳定。标准库里的 `checkNotNull`、`require`、`isNullOrBlank`、`apply`、`run` 等等都依赖它。

```kotlin
@kotlin.internal.InlineOnly
public inline fun checkNotNull(value: Any?): Any {
    contract {
        returns() implies (value != null)  // 向编译器声明：正常返回时，value 必不为 null
    }
    return if (value == null) throw IllegalStateException("...") else value
}
```

`contract` 块里的声明是**编译时元信息**，不产生任何运行时代码。编译器在遇到 `checkNotNull(input)` 后，根据契约更新 `input` 的类型信息，后续的 SmartCast 就生效了。

Contracts 的核心逻辑很直接：**函数作者声明效应 → 编译器在调用处应用效应 → 调用方获得更好的类型推断。**

## 三种核心契约

Contracts 提供的声明能力集中在三类：

### returns() implies —— 正常返回条件

最常见的模式。`returns()` 表示"函数正常返回时"，`implies` 后面跟一个布尔条件。

```kotlin
inline fun require(condition: Boolean) {
    contract {
        returns() implies condition  // 正常返回 → condition 为 true
    }
    if (!condition) throw IllegalArgumentException("...")
}

fun doSomething(value: String?) {
    require(value is String)  // 编译器知道后续 value 是 String
    println(value.length)     // ✅ SmartCast 生效
}
```

条件可以是 null 检查、类型判断、布尔表达式等。`returns(null)` 则声明"返回 null 时"的条件，用于 `isNullOrBlank` 这类函数。

### callsInPlace —— 函数调用次数保证

这个名字直译是"就地调用"，核心语义是声明**传入的 lambda 会在函数体内被调用多少次**。有四种枚举值：

| 枚举值 | 含义 |
|---|---|
| `AT_MOST_ONCE` | lambda 最多被调用 1 次，配合变量初始化推断 |
| `EXACTLY_ONCE` | lambda 恰好被调用 1 次，最强保证 |
| `AT_LEAST_ONCE` | lambda 至少被调用 1 次 |
| `UNKNOWN` | 调用次数未知，无类型优化 |

`run`、`let`、`apply` 等作用域函数的核心就依赖 `callsInPlace`：

```kotlin
@kotlin.internal.InlineOnly
public inline fun <T, R> T.run(block: T.() -> R): R {
    contract {
        callsInPlace(block, InvocationKind.EXACTLY_ONCE)
    }
    return this.block()
}
```

为什么需要它？看个例子：

```kotlin
fun example() {
    val x: Int
    run {
        x = 42  // ✅ 编译器允许，因为 run 的契约声明 block 恰好调用 1 次
    }
    println(x) // ✅ x 一定已被初始化
}
```

没有 `callsInPlace` 时，编译器会把 `run` 的 lambda 当作可能不被调用的代码块，拒绝在 lambda 内初始化 `val`。有了 `EXACTLY_ONCE` 声明，编译器就知道 `x = 42` 一定会执行。

### returns() 与 callsInPlace 组合

一个函数可以同时声明多个契约。`buildString` 就是典型：

```kotlin
@kotlin.internal.InlineOnly
public inline fun buildString(
    builderAction: StringBuilder.() -> Unit
): String {
    contract { callsInPlace(builderAction, InvocationKind.EXACTLY_ONCE) }
    return StringBuilder().apply(builderAction).toString()
}
```

这里只需要 `callsInPlace`——它关心的是"builderAction 一定被调用 1 次"，不需要返回条件。

## 自己写 Contract

自定义函数也能加契约。一个真实场景：封装重试逻辑。

```kotlin
@OptIn(ExperimentalContracts::class)
inline fun <T> retryDefault(block: () -> T): T {
    contract {
        callsInPlace(block, InvocationKind.AT_LEAST_ONCE)
    }
    return try {
        block()
    } catch (e: Exception) {
        block()
    }
}

fun demo() {
    val result: Int
    retryDefault {
        result = 42  // ✅ AT_LEAST_ONCE 保证 result 至少被赋值一次
    }
    println(result)
}
```

写 contract 时有三条硬约束。

`contract` 块必须放在函数体最开头——写在其他位置编译器直接报错，这是语法层面的限制。

只对 `inline` 函数生效。Contracts 的设计依赖编译时元信息，不涉及任何运行时机制。非 inline 函数写 contract 不会报错，但没有实际效果——调用处是普通方法调用，编译器无法将契约信息跨界传播。

`implies` 的条件只能是函数参数（或 `this`），不能引用外部变量。这是刻意保持的局部性，避免效应传播失控。

## 实战中的一个限制场景

写过一个 DSL 构建器，想用 contract 声明某个 lambda 内的 receiver 类型收窄：

```kotlin
inline fun <T> Context.ifApiLevel(min: Int, block: Context.(Int) -> T): T? {
    contract {
        returns() implies (this@ifApiLevel is Activity)  // ❌ 不生效
    }
    if (Build.VERSION.SDK_INT >= min) return block(min)
    return null
}
```

`this@ifApiLevel` 是 receiver 参数，理论上可以声明契约，但 `is Activity` 这种类型检查不在 contract 的支持范围内——`implies` 只认三种条件：`!= null`、`is` 类型判断、以及这些条件的布尔组合。对 receiver 的类型收窄效果不稳定，还取决于编译器版本。

在这个方向上折腾一圈后，我的结论是：不如直接拆分函数或在调用处做类型检查。Contracts 的边界比看起来窄，它不是银弹。

## 什么时候该用，什么时候不该用

**该用的场景：**

- 封装了 `check/require/assert` 类逻辑的工具函数，天然适合 `returns() implies`
- 自定义作用域函数或 DSL lambda，需要编译器确认变量初始化，用 `callsInPlace`
- 包装类构造函数，用 `returns() implies (value != null)` 让 null 检查穿透

**不该用或不需要的场景：**

- 普通业务逻辑函数——contract 的设计目标就是库作者，应用层代码用 `!!` 或 `?.let` 足够
- 想让编译器"理解"复杂业务逻辑——contract 不是图灵完备的定理证明器，表达能力刻意受限
- 非 inline 函数——没有实际效果，写了白写

一个实用判断标准：**如果你的函数使用者会发现"明明检查过了，编译器怎么还报错"，就值得加 contract。** 否则保持简洁。

## 编译器的内部协作机制

Contracts 不改变 Kotlin 的类型系统本身，它作用在编译器的**控制流分析**（Control Flow Analysis）和**类型推断流水线**上。

Kotlin 编译器的类型推断分两个阶段：先基于签名做局部推断（不跨函数），再做跨函数的数据流分析。Contract 的信息注入发生在第二阶段的前置步骤——编译器解析调用处时，先检查被调函数是否有 contract 声明，有的话就把声明的效应融合进当前作用域的类型约束。整个过程完全在编译期完成，JVM 字节码里找不到任何 contract 痕迹。

这也解释了 contract 为什么必须配合 inline：inline 函数在编译时会被展开到调用处，contract 的效应自然作用在展开后的代码上。非 inline 函数的调用只是一条 `invokevirtual` 指令，编译器的数据流分析穿不透这道墙。

## 取舍

Kotlin Contracts 的本质是**用极低的学习成本，换取编译器对函数效应的精确理解**。它的表达能力收敛在 null 检查和调用次数这两件事上，但也正因为收敛，用起来没有心智负担。

如果你的标准库函数的 null 检查后面总跟一个冗余的 `?.let`，花五分钟给函数加个 contract 值得。但如果想用它做更复杂的类型收窄——收手吧，那不是它设计的目的。
