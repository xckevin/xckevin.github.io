---
title: Jetpack Compose Snapshot 状态系统深度解析：从 MutableState 到 Recomposition 触发的响应式运行时原理
excerpt: 深入剖析 Compose Snapshot 系统的 MVCC 设计本质，揭示从 MutableState 写入、Snapshot apply 到 RecomposeScope 失效的完整重组触发链路，并讲解 derivedStateOf、MutationPolicy 等机制的实际应用与常见陷阱。
publishDate: '2026-04-17'
tags:
- Android
- Jetpack Compose
- 性能优化
- 响应式编程
- Kotlin
seo:
  title: Jetpack Compose Snapshot 状态系统深度解析：从 MutableState 到 Recomposition 触发的响应式运行时原理
  description: 深入解析 Compose Snapshot 的 MVCC 设计，涵盖 MutableState 读写原理、RecomposeScope 订阅机制、derivedStateOf 优化逻辑与多线程 MutationPolicy 冲突处理，帮你彻底搞清 Recomposition 触发根源。
---

Strong Skipping Mode 在 Compose 1.7 正式落地之后，我发现团队里很多人对它的理解停留在"跳过不必要的重组"这一层，却说不清楚为什么之前会触发不必要的重组。根源在 Snapshot 系统本身——一个被大多数人忽略的响应式运行时。

## Snapshot 不是响应式框架，是 MVCC

很多人把 `mutableStateOf` 理解成"一个可观察的变量"，这个理解没错，但太浅了。Compose 的状态系统本质上是一套**多版本并发控制（MVCC, Multi-Version Concurrency Control）**机制，和数据库的 MVCC 共享同一种设计哲学。

每个 `MutableState<T>` 背后是一个 `SnapshotMutableStateImpl`，它不直接持有 `T`，而是持有一条 `StateRecord` 链表。每次写入都会在链表头部插入一条新记录，旧记录不会立刻被删除。

```kotlin
// androidx.compose.runtime.snapshots.SnapshotMutableStateImpl (简化)
internal class SnapshotMutableStateImpl<T>(
    value: T,
    override val policy: SnapshotMutationPolicy<T>
) : StateObject {
    // 不是直接存 T，而是存 StateRecord 链表头
    override var firstStateRecord: StateRecord = StateStateRecord(value)
    
    private inner class StateStateRecord(val value: T) : StateRecord() {
        override fun assign(value: StateRecord) { /* ... */ }
        override fun create(): StateRecord = StateStateRecord(this.value)
    }
}
```

读取时，运行时遍历链表，找到当前 Snapshot 版本下"对我可见"的最新记录。写入时，先检查当前线程是否处于可写 Snapshot 中，再把新值包成 `StateRecord` 插到链表头。

这意味着：**两个协程可以同时修改同一个 State，互不可见，直到各自的 Snapshot 被 apply**。Compose 靠这个机制实现了线程安全的状态隔离，无需任何显式锁。

## GlobalSnapshot 与 apply 观察者

系统中存在一个全局快照（GlobalSnapshot），所有 Composable 函数内对 `state.value` 的读取，都注册在当前活跃 Snapshot 的 `readObserver` 里。这是 Recomposition 感知变化的入口。

触发重组的完整链路：

**写入 → apply → 通知观察者 → 调度 Recomposition**

```kotlin
// Snapshot.apply() 之后会触发全局通知
Snapshot.registerApplyObserver { changedSet, snapshot ->
    // changedSet: 本次 apply 中被修改的 StateObject 集合
    // 这里会找出哪些 RecomposeScope 订阅了这些对象
    invalidateAffectedScopes(changedSet)
}
```

`Recomposer` 启动时调用 `Snapshot.registerApplyObserver`，把自己挂上去。每次有 Snapshot 被 apply，观察者收到一个 `Set<Any>`，里面是所有被修改的 `StateObject`。`Recomposer` 遍历这个集合，找到订阅了这些对象的 `RecomposeScope`，标记为 dirty，安排下一帧重组。

在 UI 线程上，每次写入 `state.value = newValue` 并不会立刻 apply——Compose 框架在每帧开始时显式调用 `Snapshot.sendApplyNotifications()`，把这帧内所有写操作打包通知出去。这就是为什么同一帧内连续写多个 State，只会触发一次重组。

## RecomposeScope 的订阅与失效

`RecomposeScope` 是 Compose 编译器生成的最小重组单元，对应一个"可重启的 lambda"。每次 Composable 执行时，运行时把当前 `RecomposeScope` 设为活跃，执行函数体。函数体内所有对 `state.value` 的读取，都通过 `readObserver` 把 State 和当前 Scope 绑定。

```kotlin
// 伪代码展示订阅关系的建立
val currentScope = currentRecomposeScope // 由运行时隐式设置

// state.value 的 getter 内部
override var value: T
    get() {
        // 读取时，把当前 scope 记录为订阅者
        Snapshot.current.recordRead(this)
        return readable.value
    }
```

`recordRead` 把 (StateObject → Set\<RecomposeScope\>) 的映射存到当前 Snapshot 的读集合里。apply 触发时，这个映射就是查找受影响 Scope 的索引。

一个常见误解：**订阅关系在每次重组后会重建**。上一次重组读了哪些 State，下一次重组开始前会先清空，重组完成后重新记录。如果某次重组因为 `if` 分支没有读取某个 State，它就不再订阅这个 State，后续写入不会触发它。

踩过的一个坑：在 `LaunchedEffect` 里读取 State，实际上在独立协程里执行，运行在不同于 Composition 的 Snapshot 上下文中，读取不会被 Composition 的 `readObserver` 捕获。想让 `LaunchedEffect` 响应某个 State 变化，必须把它加进 `key` 列表，或者用 `snapshotFlow { state.value }` 显式建立订阅。

## 派生状态与 derivedStateOf 的优化逻辑

`derivedStateOf` 创建的是 `DerivedSnapshotState`，它本身也是 `StateObject`，但有两层订阅：

1. 内部订阅：订阅自己依赖的 State（计算 lambda 中读取的所有 State）
2. 外部订阅：Composable 订阅这个 derived state 的结果值

```kotlin
val filtered by remember {
    derivedStateOf { items.filter { it.isActive } } // items 是 SnapshotStateList
}
```

`items` 变化时，`derivedStateOf` 内部重新计算 lambda，再用 `MutationPolicy`（默认结构相等）比较新旧值。**只有计算结果真正变化，才会通知外层 Composable 重组。** 这让高频变化的 State（比如滚动偏移）不会无脑触发下游重组。

Strong Skipping Mode 解决的是另一个问题——参数相等时跳过重组——作用层不同，两者不是替代关系。

## apply 冲突与 MutationPolicy

多线程场景下，两个 Snapshot 同时修改同一个 State，apply 时产生冲突。Compose 的解决机制是 `SnapshotMutationPolicy`：

```kotlin
// 三种内置 policy
structuralEqualityPolicy()   // equals() 相等则视为无冲突
referentialEqualityPolicy()  // === 相等则视为无冲突，默认用于 remember
neverEqualPolicy()           // 永远视为有变化，每次赋值都触发重组
```

冲突发生时，Snapshot 系统调用 `policy.merge(previous, current, applied)` 尝试合并。`merge` 返回 `null` 则 apply 失败，调用方需要重试。配合 `ViewModel` + `StateFlow` 使用时基本遇不到这个问题，但如果在后台线程直接写 Compose State，就得注意这块。

我的倾向是把可变状态集中在 ViewModel 的 `StateFlow` 里，Compose 层只用 `collectAsStateWithLifecycle()` 消费，完全绕开多线程写入的问题。Compose State 的直写应当只发生在主线程。

## 实践建议

**用 `snapshotFlow` 桥接 Snapshot 和协程世界。** 需要在协程里响应 State 变化时，`snapshotFlow { state.value }` 会在每次值变化时 emit，且正确处理 Snapshot 语义，比在 `LaunchedEffect` 里轮询要干净得多。

```kotlin
LaunchedEffect(Unit) {
    snapshotFlow { scrollState.value }
        .distinctUntilChanged()
        .collect { offset -> /* 响应滚动 */ }
}
```

**定位 Recomposition 过度触发时，先查读取路径，不要只看写入方。** Layout Inspector 的 Recomposition 计数只告诉你"谁在重组"，不告诉你"谁触发了它"。在 `readObserver` 上打断点，或者临时用 `neverEqualPolicy()` 替换某个 State 的 policy 来验证假设，比盲目加 `key` 有效得多。

**`remember` 的计算 lambda 不在 Snapshot 读取上下文中。** `remember { expensiveCalculation() }` 里的 `expensiveCalculation` 如果读取了 State，这个读取**不会**建立订阅关系，不会触发重组。`remember` 的结果只跟 `key` 相关。这是"State 变了但 UI 没更新"的一个高频陷阱。

搞清楚 `readObserver` 在哪里建立、`apply` 在什么时候触发，很多"为什么这里要用 `derivedStateOf`"的问题就自然有了答案。Snapshot 系统把并发安全、细粒度订阅和惰性求值整合进同一套模型，理解它的边界比死记 API 用法要值钱得多。
