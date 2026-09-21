---
title: "深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析（1）：Lifecycle 感知的三层协作"
excerpt: "「深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析」系列第 1/2 篇：Lifecycle 感知的三层协作"
publishDate: 2026-07-06
displayInBlog: false
series:
  name: "深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析"
  part: 1
  total: 2
seo:
  title: "深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析（1）：Lifecycle 感知的三层协作"
  description: "「深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析」系列第 1/2 篇：Lifecycle 感知的三层协作"
---


> 本文是「深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析」系列的第 1 篇，共 2 篇。

去年接手一个电商项目的维护工作，QA 提了个让人摸不着头脑的 bug：从商品详情页返回列表页后，列表自动刷新并跳到了顶部。排查下来发现，列表页通过 LiveData 观察了一个全局 Repository 里的数据，每次 Fragment 从回退栈恢复，LiveData 都重新把上次的数据推给观察者。

这就是数据倒灌（Data Backflow）——LiveData 社区里最常见的抱怨，但根因比表面上"粘性事件"四个字复杂得多。

## Lifecycle 感知的三层协作

LiveData 的生命周期感知依赖三个组件协作：`observe` 做绑定入口、`LifecycleBoundObserver` 充当状态监听器、`activeStateChanged` 触发分发。

调用 `observe(lifecycleOwner, observer)` 时，LiveData 内部会创建包装类：

```kotlin
// LiveData.java core logic (simplified)
public void observe(@NonNull LifecycleOwner owner, @NonNull Observer<? super T> observer) {
    LifecycleBoundObserver wrapper = new LifecycleBoundObserver(owner, observer);
    ObserverWrapper existing = mObservers.putIfAbsent(observer, wrapper);
    if (existing != null && !existing.isAttachedTo(owner)) {
        throw new IllegalArgumentException("Cannot add the same observer...");
    }
    owner.getLifecycle().addObserver(wrapper);
}
```

每个 `LifecycleOwner` 只能绑定一个同类型观察者。`LifecycleBoundObserver` 继承了 `ObserverWrapper` 同时实现了 `LifecycleEventObserver`，后者让它能感知 Lifecycle 状态变迁：

```kotlin
class LifecycleBoundObserver extends ObserverWrapper implements LifecycleEventObserver {
    @Override
    public void onStateChanged(@NonNull LifecycleOwner source, @NonNull Lifecycle.Event event) {
        Lifecycle.State currentState = mOwner.getLifecycle().getCurrentState();
        if (currentState == DESTROYED) {
            removeObserver(mObserver); // auto cleanup
            return;
        }
        activeStateChanged(shouldBeActive());
    }
}
```

`shouldBeActive()` 的判断条件很简单：**Lifecycle 高于或等于 STARTED 就是 active**。一旦进入 DESTROYED，观察者自动解绑——LiveData 防内存泄漏的底线。

## activeStateChanged 是如何把旧数据推出去的

`ObserverWrapper.activeStateChanged` 是真正的分发点：

```kotlin
void activeStateChanged(boolean newActive) {
    if (newActive == mActive) return;
    mActive = newActive;
    if (mActive) {
        dispatchingValue(this); // 立即向该观察者分发当前值
    }
}
```

从 inactive 回到 active 时，LiveData 无条件调用 `dispatchingValue(this)`，传入刚变活跃的那个观察者。`dispatchingValue` 检查版本号后执行 `observer.onChanged(mData)`——`mData` 是 LiveData 内部持有的最新值，无论它是一秒前还是三小时前设置的。

**粘性事件的源头就在这里：只要观察者从 inactive 回到 active，LiveData 默认认为你需要最新的数据。**

屏幕旋转重建时这很合理，但 Fragment 返回栈恢复时，那个"最新数据"可能已经在之前消费过了，再推一次就是灾难。

## 数据倒灌的三层根因

### 1. 粘性设计本身

LiveData 的设计定位是"可观察的数据持有者"，不是"事件总线"。它始终持有当前值，新订阅者立即收到这个值。横竖屏旋转场景下，这种设计避免了重新加载数据的开销。但同一个观察者反复因 Lifecycle 切换而重新订阅时，设计初衷就成了 bug 来源。

### 2. ViewModel 和 Repository 放大了问题范围

ViewModel 的生命周期跨越 Fragment 的销毁重建，Repository 的生命周期往往覆盖整个进程。LiveData 放在这两层里，数据的存活时间远超 UI 层。我在那个电商项目里看到的正是这种情况：

```kotlin
object UserRepository {
    private val _user = MutableLiveData<User>()
    val user: LiveData<User> = _user

    fun login(name: String) {
        _user.value = User(name) // 这个值永远存在
    }
}
```

一旦设置，任何后续订阅 `user` 的观察者都会收到这条数据——无论 UI 当时需不需要。

### 3. 版本号只防重复，不防倒灌

`setValue` 的源码揭示了 LiveData 对"消费"的认知局限：

```kotlin
@MainThread
protected void setValue(T value) {
    mVersion++;              // 只有版本号递增
    mData = value;
    dispatchingValue(null);  // 分发给所有活跃观察者
}
```

`mVersion` 和每个 `ObserverWrapper` 的 `mLastVersion` 做对比，防止同一观察者在同一个 active 周期内收到重复的版本数据。但它解决不了"新观察者不该收到历史值"的问题——LiveData 里没有"消费后销毁"的概念，`mData` 永远存在。

## 三种补丁方案与它们的代价

### SingleLiveEvent：够用但有短板

Google 官方 Samples 提供的 `SingleLiveEvent`，核心用 `AtomicBoolean` 控制事件投放：

```kotlin
class SingleLiveEvent<T> : MutableLiveData<T>() {
    private val mPending = AtomicBoolean(false)

    override fun observe(owner: LifecycleOwner, observer: Observer<in T>) {
        super.observe(owner) { t ->
            if (mPending.compareAndSet(true, false)) {
                observer.onChanged(t)
            }
        }
    }

    override fun setValue(value: T) {
        mPending.set(true)
        super.setValue(value)
    }
}
```

`compareAndSet` 只会成功一次——如果有两个观察者同时监听同一个 `SingleLiveEvent`，只有一个能收到事件。

### Event Wrapper：把消费权交给 View 层

把事件包进可消费的容器，View 层显式调用 `getContentIfNotHandled()`：

```kotlin
class Event<out T>(private val content: T) {
    private var hasBeenHandled = false

    fun getContentIfNotHandled(): T? {
        return if (hasBeenHandled) null
        else { hasBeenHandled = true; content }
    }

    fun peekContent(): T = content
}
```

解决了多观察者问题，但每次都要在 View 侧调用包装方法，团队里总有人忘记。

### 手动跳过首次值：简单粗暴但埋雷

```kotlin
var isFirstObserve = true
viewModel.data.observe(viewLifecycleOwner) {
    if (isFirstObserve) {
        isFirstObserve = false
        return@observe
    }
    // handler
}
```

能救命。但如果页面确实需要首次加载的数据，这个标志位和初始化逻辑纠缠在一起，很快变脏。

---

> 下一篇我们将探讨「StateFlow 的范式转换：数据不因观察者到来而改变」，敬请关注本系列。

**「深入 Android LiveData 全链路：从 Lifecycle 感知机制到数据倒灌陷阱与 Flow 迁移策略的源码级解析」系列目录**

1. **Lifecycle 感知的三层协作**（本文）
2. StateFlow 的范式转换：数据不因观察者到来而改变
