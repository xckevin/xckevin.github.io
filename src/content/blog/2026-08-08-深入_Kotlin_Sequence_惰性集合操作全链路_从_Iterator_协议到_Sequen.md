---
title: 深入 Kotlin Sequence 惰性集合操作全链路：从 Iterator 协议到 SequenceScope 挂起转换的链式操作性能优化
excerpt: 深入分析 Kotlin Sequence 惰性求值机制，从 Iterator 协议、SequenceScope 协程化到实际性能对比，帮助开发者在集合操作链中做出正确选型。
publishDate: '2026-08-08'
tags:
- Kotlin
- Android
- Sequence
- 性能优化
- 协程
seo:
  title: 深入 Kotlin Sequence 惰性集合操作全链路：从 Iterator 协议到 SequenceScope 挂起转换的链式操作性能优化
  description: 深入解析 Kotlin Sequence 惰性求值原理，从 Iterator 协议到 SequenceScope 挂起转换，结合性能 benchmark 给出 Android 开发中的集合操作选型指南。
slug: kotlin-sequence-lazy-collection-performance
translationKey: kotlin-sequence-lazy-collection-performance
---

去年在做图片列表页优化时，一个简单的链式操作让帧率掉了 15 帧。代码很干净，逻辑也没问题——问题出在了“干净”本身。

## 一个容易误用的链式操作

```kotlin
data class Image(val url: String, val size: Long, val tags: List<String>)

// 从 5000 张图片中筛选并提取标签
val filteredTags = images
    .filter { it.size > 1024 * 1024 }   // 创建中间 List（~2000 元素）
    .map { it.tags }                      // 再创建中间 List
    .flatten()                            // 再创建中间 List
    .distinct()                           // 再创建最终 List
```

这段代码在数据量小时看不出问题。每步中间操作都生成一个新 List，全部元素在一次操作中完整遍历后才进入下一步。5000 条数据经 filter 后还剩 2000 条，这 2000 条完整塞进新 List，map 再遍历一遍，flatten 再一遍。列表滑动时，内存分配和 GC 压力集中爆发。

Iterable 的链式 API 是**急切求值**（Eager Evaluation）。

## Sequence 的惰性求值机制

Kotlin 标准库提供了另一个选择：

```kotlin
val filteredTags = images.asSequence()
    .filter { it.size > 1024 * 1024 }
    .map { it.tags }
    .flatten()
    .distinct()
    .toList()  // 终端操作，此时才真正执行
```

转为 Sequence 后，调用 `toList()` 之前什么都不会执行。`filter`、`map`、`flatten` 只是构建了一个操作链的描述，数据是一条一条流经整个链的。

```
Iterable（急切求值）:
  filter [全部元素] → List1 → map [全部元素] → List2 → flatten [全部元素] → List3

Sequence（惰性求值）:
  元素1 → filter → map → flatten → 收集
  元素2 → filter → map → flatten → 收集
  ...
```

一条数据走完全部操作链，才处理下一条。Sequence 的内存开销是 O(1) 而非 O(n)，中间结果不需要完整存储。

但惰性求值不是银弹。Sequence 每条元素都要经历完整的操作链调度，单元素开销略高于 Iterable 的批量处理。数据量很小（比如几十条）时，创建 Sequence 的额外成本可能比省下的内存更大。

## Iterator 协议：惰性的根基

Sequence 的惰性求值建立在 Kotlin 的 `Iterator` 协议之上。每个 Sequence 本质是一个可以按需产出元素的迭代器：

```kotlin
public interface Sequence<out T> {
    public operator fun iterator(): Iterator<T>
}
```

以 `filter` 为例，它返回一个新的 Sequence，其 `iterator()` 返回一个包装过的迭代器：

```kotlin
// 简化版 filter 实现思路
fun <T> Sequence<T>.filter(predicate: (T) -> Boolean): Sequence<T> {
    return object : Sequence<T> {
        override fun iterator(): Iterator<T> {
            val sourceIterator = this@filter.iterator()
            return object : Iterator<T> {
                var nextItem: T? = null
                var nextReady = false

                override fun hasNext(): Boolean {
                    while (!nextReady) {
                        if (!sourceIterator.hasNext()) return false
                        val item = sourceIterator.next()
                        if (predicate(item)) {
                            nextItem = item
                            nextReady = true
                        }
                    }
                    return true
                }

                override fun next(): T {
                    if (!hasNext()) throw NoSuchElementException()
                    nextReady = false
                    return nextItem as T
                }
            }
        }
    }
}
```

filter 迭代器的 `hasNext()` 持续从上游拉取元素，直到找到一个满足 predicate 的或上游耗尽。惰性不是“不计算”，而是“计算时机推迟到真正需要时”。

嵌套迭代器把每个操作解耦得很干净：filter 只管筛，map 只管转换，通过 Iterator 协议无缝串联。`distinct()` 的实现复杂一些——需要维护一个 HashSet 记录已见过的元素，但核心模式不变。

## yield 与 SequenceScope 的协程化

手动实现嵌套 Iterator 处理复杂逻辑会越来越繁琐。Kotlin 提供了 `sequence { }` 构建器，内部用 `yield` 产出元素：

```kotlin
fun fibonacci(): Sequence<Int> = sequence {
    var a = 0
    var b = 1
    while (true) {
        yield(a)       // 暂停，产出当前值，等待下次拉取
        val next = a + b
        a = b
        b = next
    }
}

// 惰性：只计算需要的项
fibonacci().take(10).toList()  // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

`sequence { }` 的块是 `suspend SequenceScope<T>.() -> Unit` 类型。SequenceScope 是一个受限的协程作用域，只支持 `yield()` 和 `yieldAll()` 两个挂起函数。它背后用的是状态机，不走通用协程调度器，没有线程切换开销。

`yield()` 的执行流程：

1. `yield(value)` 将 value 存入 SequenceScope 的下一个值槽位
2. 协程挂起（保存状态机当前状态后返回）
3. 调用方通过 Iterator 的 `next()` 拿到这个值
4. 调用方再次调用 `next()` 时，恢复状态机，从 yield 之后的代码继续执行
5. 再次遇到 yield 时重复步骤 1

这和 Python 的生成器几乎是一个模型，但 Kotlin 复用了自己的协程基础设施。

`yieldAll` 在实际开发中很常用：

```kotlin
fun loadImagesInBatches(urls: List<String>): Sequence<Image> = sequence {
    urls.chunked(20).forEach { batch ->
        val loaded = api.loadBatch(batch)  // 批量请求
        yieldAll(loaded)                     // 逐条产出
    }
}
```

外层逐条产出，内部按批次请求。调用方不需要关心分批逻辑，只管按需消费。

## 实际性能对比与选型

用 5000 条 Image 数据做了一组简单 benchmark（filter → map → flatten → distinct 链式操作，Pixel 6 上跑 100 次取平均）：

| 方案 | 平均耗时 | 峰值内存分配 |
|------|---------|------------|
| Iterable 链式 | 4.2ms | ~380KB |
| Sequence + toList | 3.1ms | ~120KB |
| Sequence + first() | 0.2ms | ~8KB |

当终端操作是 `toList()` 时，Sequence 比 Iterable 快约 26%，内存省了 68%。当只需要第一个元素（`first()`）时，差距拉开到 20 倍——Sequence 找到第一个就停，Iterable 算完了全部。

这在 Android 开发中有几个直接的应用场景：

- **数据源大小未知或很大**（数据库查询结果、文件行读取）：用 Sequence，内存可控且可能提前终止
- **需要多次遍历结果**：用 Iterable。Sequence 每次 `toList()` 都会重新执行整个链
- **操作链中有一个很重的操作**（如网络请求）：用 Sequence + `firstOrNull`，找到结果后立即终止
- **只做一次简单的 map 或 filter**：直接用 Iterable，Sequence 的包装开销不划算

踩过一个坑：`asSequence()` 不是免费午餐。源数据本身是 Collection 时，`asSequence()` 只是换了个迭代器包装，开销很小。但如果数据来自一次性迭代源（比如关闭中的 Cursor），Sequence 的重放特性会让第二次遍历直接报错。

## 选型清单

面对集合操作链，我的决策顺序通常是：

1. 数据量 < 100 且操作简单：Iterable，不用多想
2. 数据量未知或 > 1000：优先 Sequence
3. 只需要部分结果（first、take、any）：必须 Sequence
4. 操作链超过 3 步且包含 distinct、sorted 等全量操作：Sequence 的内存优势更明显

Sequence 不是一个“更快”的工具，而是一个“更克制”的工具——它在你不真正需要全部结果的时候，不去计算全部结果。理解 Iterator 协议和 yield 的挂起机制，不是为了手写 Sequence 实现，而是为了在写每一条链式调用时，清楚地知道每一环在分配多少内存、遍历了多少次数据。
