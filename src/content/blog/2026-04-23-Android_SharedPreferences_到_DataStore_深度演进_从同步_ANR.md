---
title: Android SharedPreferences 到 DataStore 深度演进：从同步 ANR 风险到 Flow 驱动的协程化存储架构实践
excerpt: 深入剖析 SharedPreferences 锁机制与 ANR 根因，系统讲解 Jetpack DataStore 的设计逻辑与迁移路径，涵盖 Preferences DataStore、Proto DataStore 及协程化存储架构的工程实践。
publishDate: '2026-04-23'
tags:
- Android
- DataStore
- SharedPreferences
- 协程
- 性能优化
seo:
  title: Android SharedPreferences 到 DataStore 深度演进：从同步 ANR 风险到 Flow 驱动的协程化存储架构实践
  description: 深入剖析 SharedPreferences 锁机制与 ANR 根因，讲解 Jetpack DataStore 设计逻辑、SP 迁移路径与 Proto DataStore 实践，构建协程化存储架构。
---

---
title: Android SharedPreferences 到 DataStore 深度演进：从同步 ANR 风险到 Flow 驱动的协程化存储架构实践
excerpt: 深入剖析 SharedPreferences 的锁机制与 ANR 根因，系统讲解 Jetpack DataStore 的设计逻辑与迁移路径，涵盖 Preferences DataStore、Proto DataStore 及协程化存储架构的工程实践。
publishDate: '2026-04-21'
tags:
- Android
- DataStore
- SharedPreferences
- 协程
- 性能优化
seo:
  title: Android SharedPreferences 到 DataStore 深度演进：从同步 ANR 风险到 Flow 驱动的协程化存储架构实践
  description: 深入剖析 SharedPreferences 锁机制与 ANR 根因，讲解 Jetpack DataStore 设计逻辑、SP 迁移路径与 Proto DataStore 实践，构建协程化存储架构。
---

做性能优化时，我曾遇到一个让人抓狂的 ANR：主线程卡在 `SharedPreferences.getXxx()` 上整整 6 秒，Trace 里只有一行 `waiting to lock <...> (a java.lang.Object)`。问题根源不是读取逻辑复杂，而是另一个线程正在做 `apply()` 的磁盘写入，把整个 SP 对象锁住了。

这是 SharedPreferences（以下简称 SP）的架构缺陷，不是用法问题，是设计问题。DataStore 的出现正是为了从根本上解决这一类问题。

## SharedPreferences 的锁机制与 ANR 根因

SP 的实现在 `SharedPreferencesImpl` 里，读写操作都依赖同一把内部锁 `mLock`。理解这一点，ANR 的来龙去脉就清晰了。

```java
// SharedPreferencesImpl.java（AOSP 简化版）
public String getString(String key, String defValue) {
    synchronized (mLock) {        // 主线程持有 mLock
        awaitLoadedLocked();      // 等待磁盘加载完成
        String v = (String) mMap.get(key);
        return v != null ? v : defValue;
    }
}
```

`awaitLoadedLocked()` 内部调用 `mLock.wait()`，直到后台磁盘加载线程完成并 `notify()`。eMMC 老化、文件过大、系统 I/O 繁忙都会导致主线程在这里持续等待。

`apply()` 的问题更隐蔽。它看起来是异步的，内部却用了 `CountDownLatch`：

```java
// EditorImpl.apply()
public void apply() {
    final MemoryCommitResult mcr = commitToMemory();
    final Runnable awaitCommit = new Runnable() {
        public void run() {
            mcr.writtenToDiskLatch.await(); // 等磁盘写完
        }
    };
    // 把 awaitCommit 塞进 QueuedWork
    QueuedWork.addFinisher(awaitCommit);
    Runnable postWriteRunnable = ...; // 实际写磁盘
    QueuedWork.queue(postWriteRunnable, ...);
}
```

真正的坑是 `QueuedWork.waitToFinish()`。Activity/Service 执行 `onStop()`、`onPause()` 时，系统会调用这个方法来确保所有 `apply()` 的磁盘写入完成，而这一步在主线程执行，无法绕过。`apply()` 积压写任务多了，主线程就在 `onStop()` 里硬等，ANR 触发。

## SP 的其他架构性限制

除锁机制外，SP 在架构层面还有几个根本性短板。

**类型不安全**。SP 底层是 `Map<String, Object>` 的运行时存储，key 写错了、类型读错了，编译期完全无感知，只在运行时报错或静默返回默认值，调试成本很高。

**数据变化监听不可靠**。`registerOnSharedPreferenceChangeListener` 用 `WeakReference` 持有监听器，注册者一旦被 GC，监听自动失效。这个行为反直觉且难排查，回调在主线程执行还额外引入线程安全隐患。

**跨进程不可靠**。`MODE_MULTI_PROCESS` 在 API 23 就被标记为 deprecated，官方明确说它存在 race condition，但存量代码里还在用的项目依然不少。

## DataStore 的设计逻辑

Jetpack DataStore 分两种：`Preferences DataStore`（对标 SP，key-value）和 `Proto DataStore`（基于 Protocol Buffers，强类型）。两者核心架构一致：**所有 I/O 操作在 `Dispatchers.IO` 执行，通过 `Flow` 暴露数据流，主线程彻底隔离**。

```kotlin
// 创建 Preferences DataStore（单例，文件级别）
val Context.userPrefs by preferencesDataStore(name = "user_prefs")

// 定义 key（编译期类型安全）
val THEME_KEY = stringPreferencesKey("theme")
val FONT_SIZE_KEY = intPreferencesKey("font_size")
```

读取数据变成订阅 `Flow`：

```kotlin
val themeFlow: Flow<String> = context.userPrefs.data
    .catch { e ->
        if (e is IOException) emit(emptyPreferences()) // 处理读取异常
        else throw e
    }
    .map { prefs ->
        prefs[THEME_KEY] ?: "system"
    }
```

写入通过 `suspend` 函数完成，必须在协程上下文里调用：

```kotlin
suspend fun saveTheme(context: Context, theme: String) {
    context.userPrefs.edit { prefs ->
        prefs[THEME_KEY] = theme
    }
    // edit 是 suspend 函数，写完磁盘才返回，没有"假异步"问题
}
```

DataStore 的 `edit` 基于协程级 `Mutex` 实现悲观锁，同时只允许一个写操作进行，但不会阻塞线程——这和 SP 的 `synchronized` 有本质区别。

## 从 SP 迁移到 DataStore 的实践路径

直接替换会比较痛，尤其是项目里 `getSharedPreferences()` 到处散落的情况。我在实际迁移中用了一个过渡层模式：

```kotlin
class UserPrefsRepository(private val context: Context) {

    private val dataStore = context.userPrefs

    // 读：返回 Flow，ViewModel 层用 collectAsState 或 stateIn 消费
    val theme: Flow<String> = dataStore.data
        .map { it[THEME_KEY] ?: "system" }

    // 写：ViewModel 层在 viewModelScope 里调用
    suspend fun setTheme(theme: String) {
        dataStore.edit { it[THEME_KEY] = theme }
    }

    // 兼容层：给旧的同步调用提供一次性读取（谨慎使用）
    suspend fun getThemeOnce(): String =
        dataStore.data.first()[THEME_KEY] ?: "system"
}
```

在 ViewModel 里消费：

```kotlin
class SettingsViewModel(private val repo: UserPrefsRepository) : ViewModel() {

    val theme: StateFlow<String> = repo.theme
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), "system")

    fun onThemeChange(newTheme: String) {
        viewModelScope.launch {
            repo.setTheme(newTheme)
        }
    }
}
```

这套结构让 UI 层完全不感知存储实现，Repository 层可以随时把底层换成 Room 或其他存储，测试时也可以直接注入 fake。

**迁移中踩过的一个坑是数据迁移**。DataStore 和 SP 的文件路径不同，线上用户已有 SP 数据时直接切换会丢失配置。DataStore 提供了 `SharedPreferencesMigration` 处理这个问题：

```kotlin
val Context.userPrefs by preferencesDataStore(
    name = "user_prefs",
    produceMigrations = { context ->
        listOf(
            SharedPreferencesMigration(
                context,
                "old_user_prefs" // 旧 SP 的 name
            )
        )
    }
)
```

迁移在第一次访问 DataStore 时自动执行，完成后旧 SP 文件会被删除。有一点要注意：如果旧 SP 里有自定义对象序列化的数据（比如用 Gson 存了 JSON 字符串），需要手动实现 `DataMigration` 来处理转换逻辑，`SharedPreferencesMigration` 只能处理基本类型的直接映射。

## Proto DataStore：当 key-value 不够用时

存储的数据有结构时（比如用户配置对象），Proto DataStore 更合适。它基于 Protocol Buffers，读写强类型，schema 变更有版本管理。

定义 proto 文件：

```proto
syntax = "proto3";
option java_package = "com.example.app";
option java_multiple_files = true;

message UserSettings {
  string theme = 1;
  int32 font_size = 2;
  bool notifications_enabled = 3;
}
```

配套 Serializer：

```kotlin
object UserSettingsSerializer : Serializer<UserSettings> {
    override val defaultValue: UserSettings = UserSettings.getDefaultInstance()

    override suspend fun readFrom(input: InputStream): UserSettings =
        UserSettings.parseFrom(input)

    override suspend fun writeTo(t: UserSettings, output: OutputStream) =
        t.writeTo(output)
}
```

相比 Preferences DataStore，Proto 的优势在于：字段有默认值语义、schema 演进有规则（新增字段向后兼容）、不需要维护一堆分散的 key 常量。新项目我更倾向于直接用 Proto DataStore，Preferences DataStore 主要留给迁移场景或配置项极少的情况。

## 几条实践建议

**不要在 DataStore 里存大量或频繁变更的数据**。DataStore 每次写入都是全量序列化整个文件，频繁写入（如每秒更新位置信息）性能比 Room 差很多。这类场景直接用 Room。

**`first()` 要谨慎用**。`dataStore.data.first()` 会挂起直到拿到第一个值，看起来方便，但在冷启动路径上频繁调用会串行化多个 I/O 操作。尽量用 `Flow` 订阅模式替代一次性读取。

**单进程原则**。DataStore 文档明确说明不支持跨进程访问。跨进程场景用 ContentProvider 或 AIDL，不要尝试用多进程标志访问同一个 DataStore 文件。

SP 的问题积累已久，DataStore 的设计方向是对的：把 I/O 操作彻底下沉到 `Dispatchers.IO`，用协程和 Flow 代替回调和同步阻塞。代价是引入了协程依赖，对没有做 Coroutines 迁移的老项目有一定门槛。但从长期维护角度看，这笔账值得算。
