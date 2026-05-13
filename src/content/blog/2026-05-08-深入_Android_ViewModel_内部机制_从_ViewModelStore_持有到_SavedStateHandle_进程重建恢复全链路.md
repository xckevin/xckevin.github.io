---
title: 深入 Android ViewModel 内部机制：从 ViewModelStore 持有到 SavedStateHandle 进程重建恢复全链路
excerpt: 从 ViewModelStore 容器持有机制讲到 SavedStateHandle 进程重建恢复，厘清 ViewModel 在配置变更与进程死亡两种场景下的不同存活逻辑，带你理解 ViewModel 内部的双重生命周期。
publishDate: '2026-05-08'
tags:
- Android
- ViewModel
- 架构设计
- Kotlin
- Jetpack
---



做组件化改造时，我在 A 页面通过 ViewModel 缓存了一组用户数据，跳转到 B 页面操作后返回，A 页面 ViewModel 数据偶尔为 null。当时的直觉是：ViewModel 不是能扛配置变更吗，怎么数据丢了？

排查了两天才发现，这根本不是一个问题——当时系统内存低，Activity 被杀了，ViewModel 确实能扛配置变更，但没配置 SavedStateHandle 的情况下，进程死亡重建后数据就是空的。这引出了 ViewModel 的双重生命周期：**配置变更存活**与**进程死亡恢复**，两者依赖完全不同的内部机制。

## ViewModelStore：谁在持有你的 ViewModel

ViewModel 不是天生就能存活。它的存活依赖一个叫 **ViewModelStore** 的容器。每次调用 `ViewModelProvider.get()`，流程是这样的：

```kotlin
// ViewModelProvider 内部简化逻辑
fun <T : ViewModel> get(key: String, modelClass: Class<T>): T {
    var viewModel = store.get(key)  // 先从 store 取
    if (viewModel != null) return viewModel as T
    // 没有就创建新的
    viewModel = factory.create(modelClass)
    store.put(key, viewModel)
    return viewModel
}
```

ViewModelStore 本质是一个 HashMap，key 是 ViewModel 类名，value 是实例。关键问题是：**这个 store 由谁持有，它的生命周期多长？**

在 Activity 场景下，ViewModelStore 由 `ComponentActivity.getViewModelStore()` 管理：

```java
// ComponentActivity 核心逻辑（简化）
public ViewModelStore getViewModelStore() {
    if (mViewModelStore == null) {
        NonConfigurationInstances nc =
            (NonConfigurationInstances) getLastNonConfigurationInstance();
        if (nc != null) {
            mViewModelStore = nc.viewModelStore;  // 从旧实例恢复
        }
        if (mViewModelStore == null) {
            mViewModelStore = new ViewModelStore();  // 首次创建
        }
    }
    return mViewModelStore;
}
```

当配置变更发生时（比如转屏），Activity 会被销毁并重建。Android 框架会调用 `onRetainNonConfigurationInstance()`，**ComponentActivity 在这里把 ViewModelStore 塞进 NonConfigurationInstances 对象**，由系统桥接到新的 Activity 实例。新的 Activity 通过 `getLastNonConfigurationInstance()` 拿回这个 store。

整个过程 ViewModelStore 本身没有被销毁，只是换了个 Activity 来持有它。这就是配置变更存活的本质：**store 跨实例传递，而不是数据序列化**。

## ViewModel 的清理时机

Activity 正常 finish 时，`ComponentActivity` 的构造器里注册了一个 LifecycleObserver：

```kotlin
// ComponentActivity 构造器内部
lifecycle.addObserver(LifecycleEventObserver { _, event ->
    if (event == Lifecycle.Event.ON_DESTROY) {
        if (!isChangingConfigurations) {  // 关键判断
            viewModelStore.clear()
        }
    }
})
```

这就是为什么转屏时 ViewModel 不死——`isChangingConfigurations` 为 true，`clear()` 被跳过。而正常返回时这个值就是 false，store 清空，所有 ViewModel 的 `onCleared()` 被调用。

Fragment 场景类似，但 store 挂在 Fragment 的 `mViewModelStore` 字段上，通过 `FragmentManagerViewModel`（一个特殊的 ViewModel 挂在宿主 Activity 上）做中转。

## SavedStateHandle：进程死亡恢复的入口

进程被杀后，ViewModelStore 在内存里的 HashMap 荡然无存。这时靠的是 **SavedStateHandle**。

SavedStateHandle 本质是一个 **key-value 的数据容器**，内部用普通 `HashMap<String, Object>` 存储。它和 Android 原生的 `SavedStateRegistry` 深度绑定：

```kotlin
// SavedStateHandle 内部结构（简化）
class SavedStateHandle {
    private val regular = mutableMapOf<String, Any?>()
    private val savedStateProviders = mutableMapOf<String, SavedStateRegistry.SavedStateProvider>()
    private var restoredState: Bundle? = null  // 恢复时的快照
}
```

`regular` 存普通数据，`savedStateProviders` 存惰性序列化的数据（用于大数据场景），`restoredState` 是进程重启后从系统恢复的 Bundle。

整个调用链是这样的：

1. 你在 ViewModel 里通过 `savedStateHandle.set("user_id", "123")` 保存数据
2. Activity 走到 `onSaveInstanceState` 时，`SavedStateRegistry` 遍历所有注册的 provider
3. SavedStateHandle 的 `SavedStateProvider` 把 `regular` HashMap 序列化成 Bundle
4. 系统把 Bundle 写入进程外的持久化存储
5. 进程重启后，系统把 Bundle 送回给 Activity
6. `SavedStateRegistry` 把 Bundle 传回 SavedStateHandle 的 `restoredState`

```kotlin
// SavedStateHandle 数据恢复逻辑
fun <T> get(key: String): T? {
    // 优先从 restoredState 取（进程恢复的数据）
    if (restoredState?.containsKey(key) == true) {
        return restoredState?.get(key) as? T
    }
    return regular[key] as? T  // 再取运行时数据
}
```

`set()` 时数据同时写入 `regular`，`get()` 时优先读 `restoredState`。这个优先级保证了恢复数据不被运行时数据覆盖。

## ViewModel + SavedStateHandle 的构造链路

要让 ViewModel 带上 SavedStateHandle，需要用 `SavedStateViewModelFactory` 或 AndroidX 的 `viewModels()` 委托。工厂在创建 ViewModel 时的流程：

```kotlin
// SavedStateViewModelFactory.create() 简化逻辑
fun <T : ViewModel> create(modelClass: Class<T>): T {
    // 1. 先拿到 SavedStateRegistry
    val controller = SavedStateRegistryController.create(owner)
    
    // 2. 为新 ViewModel 创建专属 SavedStateHandle
    val handle = SavedStateHandle.createHandle(
        controller.getSavedStateProvider(),  // 恢复数据来源
        controller.getRestoredState()        // 已恢复的 Bundle
    )
    
    // 3. 反射调用带 SavedStateHandle 的构造器
    return modelClass.getConstructor(
        SavedStateHandle::class.java
    ).newInstance(handle)
}
```

这意味着 **SavedStateHandle 在 ViewModel 构造时就绑定好了恢复数据**。ViewModel 初始化时可以立刻从 handle 里读到进程死亡前的状态，不需要额外的恢复回调。

实际项目里我习惯直接在构造函数里消费 handle：

```kotlin
class UserViewModel(
    private val savedStateHandle: SavedStateHandle
) : ViewModel() {
    val userId: String = savedStateHandle.get<String>("user_id") ?: ""
    
    fun setUser(user: User) {
        savedStateHandle.set("user_id", user.id)
        savedStateHandle.set("user_name", user.name)
    }
}
```

不用额外写 `restoreState()` 方法，也不用担心时序——因为 handle 在构造时就已经装好恢复数据了。

## SavedStateRegistry 的跨层级协调

SavedStateHandle 能正常工作，背后是 `SavedStateRegistry` 在做协调。它不只在 Activity 层工作，在 Fragment 里也有一套。

Activity 的 `onSaveInstanceState` 触发时，流程是这样的：

1. **Activity 层**：`SavedStateRegistryController.performSave(outBundle)` 收集所有注册的 provider 数据，写入 Bundle
2. **Fragment 层**：FragmentManager 遍历所有 Fragment，让各自的 SavedStateRegistry 执行 save
3. **ViewModel 层**：每个 ViewModel 的 SavedStateHandle 作为 SavedStateRegistry 的 provider，把 `regular` HashMap 序列化写入

恢复时反过来：

1. Activity 的 `onCreate(Bundle)` 把 savedInstance Bundle 传给 SavedStateRegistry
2. Registry 把数据分发给对应的 SavedStateHandle
3. ViewModel 构造时从绑定的 SavedStateHandle 读取

一个容易踩的坑：**Fragment 里的 ViewModel 的 SavedStateHandle 数据，最终也是写到宿主 Activity 的 savedInstance Bundle 里**。所以如果 Activity 的 `onSaveInstanceState` 没被调用（比如 `finish()` 不会触发），Fragment ViewModel 的数据也不会被保存。

## 序列化与性能边界

SavedStateHandle 通过 Bundle 序列化数据，那它能存什么？不能存什么？

支持的类型：
- 基础类型：Int, Long, Float, Double, Boolean, String, CharSequence
- 数组：IntArray, LongArray, BooleanArray 等
- Parcelable 和 Serializable
- Bundle（嵌套）

不支持的类型：
- 任意 Object（建议用 Parcelable）
- Lambda 和函数类型（直接崩）
- LiveData 和 Flow（没有序列化意义）

数据大小限制和 onSaveInstanceState 一样，官方建议不超过 **500KB**。超过可能导致 TransactionTooLargeException。我踩过一个坑：把 RecyclerView 的完整数据列表存进 SavedStateHandle，结果在低端机上直接崩——应该只在 handle 里存关键标识符，完整数据从数据库或文件恢复。

```kotlin
// ✅ 正确的做法：只存关键 ID
savedStateHandle.set("current_item_id", itemId)
// 从本地缓存恢复完整数据

// ❌ 错误的做法：存整个数据对象列表
savedStateHandle.set("items", largeItemList)  // 可能超过 Bundle 限制
```

SavedStateHandle 还支持惰性序列化，通过 `setSavedStateProvider` 方法：

```kotlin
savedStateHandle.setSavedStateProvider("large_data") {
    Bundle().apply {
        // 只在真正 save 时才执行，延迟序列化
        putParcelable("data", expensiveToSerializeObject)
    }
}
```

这种方式不会把数据常驻在 `regular` HashMap 里，只在 save 时才调用 provider 生成 Bundle。适合大数据或计算成本高、访问频率低的场景。

## 两条生命线的交叉点

回过头看 ViewModel 的完整生命周期，有两条保护线：

**配置变更线**：ViewModelStore → NonConfigurationInstances → 新 Activity，纯内存传递，不序列化。这条线对 ViewModel 内部数据没要求，存什么都能活。

**进程死亡线**：SavedStateHandle → SavedStateRegistry → onSaveInstanceState Bundle → 系统持久化。这条线要求数据可序列化，有大小限制。

两条线在 ViewModel 的创建时机上交叉：新 Activity 创建时，ViewModelStore 里如果没有目标 ViewModel，才会创建新的。但如果同时有恢复的 Bundle 数据，SavedStateHandle 会在构造时先加载恢复数据，这样即使创建的是新 ViewModel 实例，也能拿到旧数据。

这个交叉点的边界情况是：**转屏时两条线都会触发**——onSaveInstanceState 会携带 SavedStateHandle 的数据，同时 ViewModelStore 也通过 NonConfigurationInstances 传递。恢复时，因为 ViewModelStore 里的 ViewModel 还在，不会创建新实例，所以 SavedStateHandle 的恢复数据其实没被使用。这些数据只在**真正进程死亡后才发挥作用**。

## 调试方法

排查 ViewModel 数据丢失问题时，有几个切入点：

**确认是配置变更还是进程死亡**。在 ViewModel 的 `onCleared()` 打日志，如果转屏时调用了它，说明 ViewModelStore 传递出了问题。如果没调用但数据丢了，问题在 SavedStateHandle 链路。

**不要杀死 Activity 后依赖 savedInstance 恢复**。测试进程死亡时，从开发者选项打开「不保留活动」，或者在 adb 里 `kill` 进程后从最近任务恢复——不要只是转屏，那个测不了进程死亡链路。

**在 ViewModel 的 init 块打日志检查 SavedStateHandle 数据**：

```kotlin
init {
    val restored = savedStateHandle.get<String>("user_id")
    Log.d("VM", "init restoredUserId=$restored")
}
```

如果日志为 null 但数据之前确实 set 过，说明 SavedStateRegistry 的 save 链路断了——检查 `onSaveInstanceState` 是否被调用，或者 Bundle 是否超限。

检查 Bundle 大小的简单方法：

```kotlin
override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    // 序列化后检查大小
    val parcel = Parcel.obtain()
    parcel.writeBundle(outState)
    Log.d("SaveState", "Bundle size: ${parcel.dataSize() / 1024}KB")
    parcel.recycle()
}