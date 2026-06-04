---
title: "Android SharedPreferences to DataStore Deep Dive: From ANR Risk to Flow-Based Coroutine Storage"
lang: en
translationKey: android-sharedpreferences-datastore-deep-dive
slug: android-sharedpreferences-datastore-deep-dive
excerpt: "A deep look at SharedPreferences locking and ANR root causes, Jetpack DataStore's design, migration paths, Preferences DataStore, Proto DataStore, and coroutine-based storage architecture."
publishDate: '2026-04-23'
tags:
- "Android"
- "DataStore"
- "SharedPreferences"
- "Coroutines"
- "Performance"
seo:
  title: "SharedPreferences to DataStore: Android Storage Deep Dive"
  description: "Analyze SharedPreferences locking and ANR causes, then learn Jetpack DataStore design, migration from SP, Proto DataStore, and coroutine storage practices."
  pageType: article
---

While working on performance optimization, I once ran into a maddening ANR: the main thread was stuck in `SharedPreferences.getXxx()` for a full 6 seconds, and the trace showed only one line: `waiting to lock <...> (a java.lang.Object)`. The root cause was not complicated read logic. Another thread was doing a disk write from `apply()`, which locked the entire SharedPreferences object.

This is an architectural flaw in SharedPreferences, or SP for short. It is not a usage problem. It is a design problem. DataStore was introduced precisely to solve this class of issue at the root.

## SharedPreferences locking and the root cause of ANRs

SP is implemented in `SharedPreferencesImpl`. Both reads and writes depend on the same internal lock, `mLock`. Once you understand that, the ANR chain becomes clear.

```java
// SharedPreferencesImpl.java, simplified from AOSP
public String getString(String key, String defValue) {
    synchronized (mLock) {        // Main thread holds mLock
        awaitLoadedLocked();      // Waits for disk loading to finish
        String v = (String) mMap.get(key);
        return v != null ? v : defValue;
    }
}
```

`awaitLoadedLocked()` internally calls `mLock.wait()` until the background disk-loading thread finishes and calls `notify()`. Aging eMMC storage, oversized files, and busy system I/O can all leave the main thread waiting here for a long time.

The problem with `apply()` is more subtle. It looks asynchronous, but internally it uses a `CountDownLatch`:

```java
// EditorImpl.apply()
public void apply() {
    final MemoryCommitResult mcr = commitToMemory();
    final Runnable awaitCommit = new Runnable() {
        public void run() {
            mcr.writtenToDiskLatch.await(); // Waits for disk write
        }
    };
    // Adds awaitCommit to QueuedWork
    QueuedWork.addFinisher(awaitCommit);
    Runnable postWriteRunnable = ...; // Actual disk write
    QueuedWork.queue(postWriteRunnable, ...);
}
```

The real trap is `QueuedWork.waitToFinish()`. When an Activity or Service runs `onStop()` or `onPause()`, the system calls this method to make sure all disk writes from `apply()` have completed. That wait happens on the main thread and cannot be bypassed. Once `apply()` write tasks pile up, the main thread is forced to wait inside `onStop()`, and an ANR can be triggered.

## Other architectural limits of SP

Beyond the locking model, SP has several fundamental architectural weaknesses.

**It is not type-safe.** Under the hood, SP stores data in a runtime `Map<String, Object>`. If a key is misspelled or a value is read as the wrong type, the compiler cannot help. You either get a runtime error or silently receive the default value, which makes debugging expensive.

**Change listeners are unreliable.** `registerOnSharedPreferenceChangeListener` holds listeners through `WeakReference`. Once the registered listener is garbage-collected, the listener silently stops working. That behavior is counterintuitive and hard to diagnose. The callback also runs on the main thread, which introduces additional thread-safety risks.

**Cross-process behavior is unreliable.** `MODE_MULTI_PROCESS` was deprecated in API 23, and the official documentation explicitly notes its race conditions. Even so, plenty of legacy projects still use it.

## DataStore's design logic

Jetpack DataStore has two variants: `Preferences DataStore`, which matches SP's key-value use case, and `Proto DataStore`, which is based on Protocol Buffers and provides strong typing. Their core architecture is the same: **all I/O runs on `Dispatchers.IO`, data is exposed through `Flow`, and the main thread is fully isolated from disk access**.

```kotlin
// Create a Preferences DataStore, singleton at the file level
val Context.userPrefs by preferencesDataStore(name = "user_prefs")

// Define keys with compile-time type safety
val THEME_KEY = stringPreferencesKey("theme")
val FONT_SIZE_KEY = intPreferencesKey("font_size")
```

Reads become subscriptions to a `Flow`:

```kotlin
val themeFlow: Flow<String> = context.userPrefs.data
    .catch { e ->
        if (e is IOException) emit(emptyPreferences()) // Handle read failures
        else throw e
    }
    .map { prefs ->
        prefs[THEME_KEY] ?: "system"
    }
```

Writes are completed through a `suspend` function and must be called from a coroutine context:

```kotlin
suspend fun saveTheme(context: Context, theme: String) {
    context.userPrefs.edit { prefs ->
        prefs[THEME_KEY] = theme
    }
    // edit is a suspend function. It returns after disk write finishes,
    // so there is no "fake async" behavior.
}
```

DataStore's `edit` uses a coroutine-level `Mutex` to implement pessimistic locking. Only one write can run at a time, but it does not block a thread. That is fundamentally different from SP's `synchronized` locking.

## A practical path from SP to DataStore

A direct replacement is painful, especially when `getSharedPreferences()` calls are scattered throughout a project. In real migrations, I use a transitional repository layer:

```kotlin
class UserPrefsRepository(private val context: Context) {

    private val dataStore = context.userPrefs

    // Read: return Flow, consumed by collectAsState or stateIn in the ViewModel layer
    val theme: Flow<String> = dataStore.data
        .map { it[THEME_KEY] ?: "system" }

    // Write: called from viewModelScope in the ViewModel layer
    suspend fun setTheme(theme: String) {
        dataStore.edit { it[THEME_KEY] = theme }
    }

    // Compatibility layer: one-shot read for old synchronous call sites. Use carefully.
    suspend fun getThemeOnce(): String =
        dataStore.data.first()[THEME_KEY] ?: "system"
}
```

Consume it in the ViewModel:

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

This structure keeps the UI layer unaware of the storage implementation. The repository can later swap the underlying storage to Room or another mechanism, and tests can inject a fake directly.

**One migration trap is existing data.** DataStore and SP use different file paths. If online users already have SP data, switching directly will lose their configuration. DataStore provides `SharedPreferencesMigration` for this:

```kotlin
val Context.userPrefs by preferencesDataStore(
    name = "user_prefs",
    produceMigrations = { context ->
        listOf(
            SharedPreferencesMigration(
                context,
                "old_user_prefs" // Old SP name
            )
        )
    }
)
```

Migration runs automatically the first time DataStore is accessed. After it finishes, the old SP file is deleted. One detail matters: if the old SP contains custom serialized objects, such as JSON strings written with Gson, you need to implement `DataMigration` manually to handle the conversion. `SharedPreferencesMigration` only supports direct mapping of primitive types.

## Proto DataStore: when key-value is not enough

When the stored data has structure, such as a user settings object, Proto DataStore is a better fit. It is based on Protocol Buffers, provides strongly typed reads and writes, and gives schema changes versioned rules.

Define the proto file:

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

Add the matching serializer:

```kotlin
object UserSettingsSerializer : Serializer<UserSettings> {
    override val defaultValue: UserSettings = UserSettings.getDefaultInstance()

    override suspend fun readFrom(input: InputStream): UserSettings =
        UserSettings.parseFrom(input)

    override suspend fun writeTo(t: UserSettings, output: OutputStream) =
        t.writeTo(output)
}
```

Compared with Preferences DataStore, Proto's advantages are default-value semantics, schema evolution rules such as backward-compatible field additions, and no need to maintain scattered key constants. For new projects, I prefer starting directly with Proto DataStore. Preferences DataStore is mainly useful for migration scenarios or for very small sets of configuration items.

## Practical recommendations

**Do not store large or frequently changing data in DataStore.** Every DataStore write serializes the entire file. For frequent writes, such as location updates every second, its performance is much worse than Room. Use Room directly for those cases.

**Use `first()` carefully.** `dataStore.data.first()` suspends until the first value is available. It looks convenient, but frequent use on the cold-start path serializes multiple I/O operations. Prefer the `Flow` subscription model over one-shot reads whenever possible.

**Keep to a single process.** The DataStore documentation explicitly says it does not support cross-process access. For cross-process scenarios, use ContentProvider or AIDL. Do not try to access the same DataStore file through multiprocess flags.

SP's problems have been accumulating for a long time, and DataStore's direction is the right one: push I/O entirely down to `Dispatchers.IO`, and replace callbacks and synchronous blocking with coroutines and Flow. The cost is an added coroutine dependency, which creates some migration friction for old projects that have not adopted Coroutines. But from a long-term maintenance perspective, the tradeoff is worth making.
