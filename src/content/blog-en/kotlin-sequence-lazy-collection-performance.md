---
title: "Kotlin Sequence vs. Iterable: Lazy Collection Performance"
lang: en
translationKey: kotlin-sequence-lazy-collection-performance
slug: kotlin-sequence-lazy-collection-performance
excerpt: "How Kotlin Sequences avoid intermediate allocations through lazy evaluation, the Iterator protocol and yield, with benchmark data and practical selection guidance."
publishDate: '2026-08-08'
tags:
- "Kotlin"
- "Sequences"
- "Performance"
seo:
  title: "Kotlin Sequence vs Iterable Lazy Performance"
  description: "A practical look at Kotlin Sequence lazy evaluation, the Iterator protocol, yield internals, benchmarks, and when to choose Sequences over Iterable."
  pageType: article
---

Last year, while optimizing an image list page, a simple chain of operations caused the frame rate to drop by 15 fps. The code was clean and the logic was fine—the problem lay in that very "cleanliness."

## A chain of operations that is easy to misuse

```kotlin
data class Image(val url: String, val size: Long, val tags: List<String>)

// 从 5000 张图片中筛选并提取标签
val filteredTags = images
    .filter { it.size > 1024 * 1024 }   // 创建中间 List（~2000 元素）
    .map { it.tags }                      // 再创建中间 List
    .flatten()                            // 再创建中间 List
    .distinct()                           // 再创建最终 List
```

This code shows no visible problem when the data volume is small. Each intermediate operation creates a new List, and all elements complete a full traversal in one operation before entering the next step. After filtering 5,000 items, about 2,000 remain; those 2,000 are stuffed completely into a new List, then map traverses them again, then flatten again. When the list scrolls, memory allocation and GC pressure spike all at once.

The chain API on Iterable uses **eager evaluation**.

## Sequence's lazy evaluation mechanism

The Kotlin standard library offers another option:

```kotlin
val filteredTags = images.asSequence()
    .filter { it.size > 1024 * 1024 }
    .map { it.tags }
    .flatten()
    .distinct()
    .toList()  // 终端操作，此时才真正执行
```

After converting to a Sequence, nothing executes until `toList()` is called. `filter`, `map`, and `flatten` only build a description of the operation chain; data flows through the whole chain one item at a time.

```
Iterable（急切求值）:
  filter [全部元素] → List1 → map [全部元素] → List2 → flatten [全部元素] → List3

Sequence（惰性求值）:
  元素1 → filter → map → flatten → 收集
  元素2 → filter → map → flatten → 收集
  ...
```

One item traverses the whole operation chain before the next item is processed. Sequence's memory overhead is O(1) rather than O(n), and intermediate results do not need to be stored in full.

But lazy evaluation is not a silver bullet. Every element in a Sequence has to go through the dispatch of the entire operation chain, so the per-element overhead is slightly higher than Iterable's batch processing. When the data is very small (for example, a few dozen items), the extra cost of creating a Sequence may be larger than the memory saved.

## The Iterator protocol: the foundation of laziness

Sequence's lazy evaluation is built on top of Kotlin's `Iterator` protocol. Every Sequence is essentially an iterator that can produce elements on demand:

```kotlin
public interface Sequence<out T> {
    public operator fun iterator(): Iterator<T>
}
```

Take `filter` as an example. It returns a new Sequence whose `iterator()` returns a wrapped iterator:

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

The `hasNext()` of the filter iterator keeps pulling elements from upstream until it finds one that satisfies the predicate or the upstream is exhausted. Laziness is not "don't compute"; it is "postpone computation until it is actually needed."

Nested iterators decouple each operation very cleanly: filter only screens, map only transforms, and they are seamlessly chained through the Iterator protocol. `distinct()` has a more complex implementation—it needs to maintain a HashSet to record elements already seen—but the core pattern is the same.

## yield and SequenceScope's coroutine-based implementation

Implementing nested Iterators manually becomes more and more cumbersome when dealing with complex logic. Kotlin provides the `sequence { }` builder, which uses `yield` inside to emit elements:

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

The block passed to `sequence { }` has the type `suspend SequenceScope<T>.() -> Unit`. SequenceScope is a restricted coroutine scope and supports only two suspending functions, `yield()` and `yieldAll()`. It uses a state machine underneath, does not go through the general coroutine dispatcher, and has no thread-switching overhead.

The execution flow of `yield()`:

1. `yield(value)` stores value in SequenceScope's next value slot
2. The coroutine suspends (saves the current state of the state machine and returns)
3. The caller obtains this value through the iterator's `next()`
4. When the caller calls `next()` again, the state machine is resumed and execution continues from the code after yield
5. When another yield is encountered, repeat step 1

This is almost the same model as Python generators, but Kotlin reuses its own coroutine infrastructure.

`yieldAll` is very common in real development:

```kotlin
fun loadImagesInBatches(urls: List<String>): Sequence<Image> = sequence {
    urls.chunked(20).forEach { batch ->
        val loaded = api.loadBatch(batch)  // 批量请求
        yieldAll(loaded)                     // 逐条产出
    }
}
```

The outer layer emits items one by one, while the inner layer requests in batches. The caller does not need to care about the batching logic and only consumes on demand.

## Real-world performance comparison and selection

I ran a simple benchmark on 5,000 Image items (filter → map → flatten → distinct chain, averaged over 100 runs on a Pixel 6):

| Approach | Average time | Peak memory allocation |
|------|---------|------------|
| Iterable chain | 4.2ms | ~380KB |
| Sequence + toList | 3.1ms | ~120KB |
| Sequence + first() | 0.2ms | ~8KB |

When the terminal operation is `toList()`, Sequence is about 26% faster than Iterable and uses 68% less memory. When only the first element is needed (`first()`), the gap widens to 20x—Sequence stops as soon as it finds the first one, while Iterable computes all of them.

This has several direct applications in Android development:

- **Data source size is unknown or very large** (database query results, reading file lines): use Sequence, because memory is controllable and it may terminate early
- **You need to traverse the result multiple times**: use Iterable. Every `toList()` on a Sequence re-executes the entire chain
- **One operation in the chain is very expensive** (such as a network request): use Sequence + `firstOrNull`, and terminate immediately after finding a result
- **Only a simple map or filter is done once**: use Iterable directly; Sequence's wrapping overhead is not worth it

One pitfall I've stepped into: `asSequence()` is not a free lunch. When the source data is itself a Collection, `asSequence()` only swaps in another iterator wrapper, so the cost is tiny. But when the data comes from a one-shot iteration source (such as a Cursor that is being closed), Sequence's replay behavior will cause the second traversal to throw an error directly.

## A selection checklist

When facing a collection operation chain, my decision order is usually:

1. Data volume < 100 and simple operations: Iterable, don't overthink it
2. Data volume unknown or > 1000: prefer Sequence
3. Only part of the result is needed (first, take, any): use Sequence
4. The chain has more than 3 steps and includes full-traversal operations such as distinct and sorted: Sequence's memory advantage is more obvious

Sequence is not a "faster" tool, but a "more restrained" tool—when you don't actually need all of the results, it doesn't compute all of them. Understanding the Iterator protocol and yield's suspension mechanism is not about hand-writing your own Sequence implementation; it is about clearly knowing, for every chained call you write, how much memory each link allocates and how many times the data is traversed.
