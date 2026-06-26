---
title: "Inside MMKV: How mmap and Append-Only Protobuf Beat SharedPreferences"
lang: en
translationKey: android-mmkv-mmap-protobuf
slug: android-mmkv-mmap-protobuf
excerpt: "A practical walkthrough of MMKV's mmap memory mapping and append-only Protobuf writes, why SharedPreferences blocks the main thread, and how to choose between SP, MMKV, and DataStore."
publishDate: '2026-06-16'
tags:
- "Android"
- "MMKV"
- "Performance"
- "mmap"
- "Protobuf"
seo:
  title: "Inside MMKV: mmap and Append-Only Protobuf vs SharedPreferences"
  description: "How MMKV uses mmap and Protobuf append-only writes to replace SharedPreferences, with a SP/MMKV/DataStore selection guide."
  pageType: article
---

If you do client development, you have probably lived through this scenario: a user reports a white screen on launch, you dig in, and discover `SharedPreferences` is loading a file on the main thread inside `getSharedPreferences`, stalling Activity startup for two seconds. So you swap every `apply()` for `commit()` — and the ANR rate goes up, not down.

That is not an isolated case. SP's design flaws are amplified inside an app like WeChat, which writes an enormous volume daily. Tencent open-sourced MMKV, which has run inside WeChat for over six years and handles more than 500,000 reads and writes per device per day.

## Why SharedPreferences Blocks the Main Thread

SP's loading flow: `getSharedPreferences("xxx", MODE_PRIVATE)` starts a thread from the constructor to read the XML file from disk:

```java
// SharedPreferencesImpl constructor
private void startLoadFromDisk() {
    synchronized (mLock) {
        mLoaded = false;
    }
    new Thread("SharedPreferencesImpl-load") {
        public void run() {
            loadFromDisk(); // blocking XML parse
        }
    }.start();
}
```

The problem is that every read on the returned instance checks the `mLoaded` flag. If XML parsing is not finished, `awaitLoadLocked()` calls `wait()` directly — even a seemingly harmless `getString()` cannot escape it.

```java
private void awaitLoadLocked() {
    while (!mLoaded) {
        try {
            mLock.wait();
        } catch (InterruptedException unused) { }
    }
}
```

When Application init fires a chain of `getSharedPreferences` calls on the main thread and disk I/O is slow because a low-end device's eMMC is fighting for bus time, the result is the main thread queuing on a lock and Activity lifecycle stuck. That is the root cause of SP ANRs — the `commit()` vs `apply()` distinction does not fix it.

On the write side, SP's `commit()` writes synchronously and should never be called on the main thread. `apply()` is asynchronous, but it enqueues work onto `QueuedWork`, and Activity's `onStop` waits for that queue to drain — so Activity transitions can still stall.

## mmap: Treat the File Like Memory

MMKV's approach is direct: if disk I/O is the bottleneck, map the file into the process address space with mmap and turn reads and writes into memory operations.

mmap (Memory-Mapped File) is a Linux kernel mechanism that establishes a direct mapping between a file and pages in virtual memory. Writes to that memory are flushed back to disk by the kernel at the right time. From the upper layer's perspective, writing the file is a `memcpy` — no `write()` syscall, no user-to-kernel context switch.

```cpp
// mmap mapping creation
m_ptr = (int8_t *) mmap(nullptr, DEFAULT_MMAP_SIZE,
    PROT_READ | PROT_WRITE, MAP_SHARED, m_fd, 0);
```

At startup MMKV mmaps the file. After that, every `putInt` and `putString` is essentially a write to that memory. No file-offset lookup, no `read` syscall per access. On crash, unwritten dirty pages are persisted by the kernel — completed writes are not lost. SP cannot guarantee this.

mmap has one unavoidable constraint: file size. Memory mapping requires a contiguous virtual address region and cannot grow dynamically like ordinary I/O. MMKV's solution is to preallocate a fixed size and manage it with a cursor; when it runs out, it re-mmaps a larger region. In WeChat's experience this cost is acceptable because remapping is far less frequent than the overhead I/O would have imposed.

## Append-Only Protobuf: Stop Rewriting the Whole File

Every SP `apply()` serializes the in-memory `HashMap` to a complete XML document and writes it back. A 100-key SP file that changed a single key still writes the entire file. For modules with thousands of keys, this is disastrous.

MMKV chose Protocol Buffers as its serialization format, but the real win is not the format — it is the append-only (incremental) update strategy:

```cpp
// Simplified write logic
bool MMKV::setDataForKey(MMBuffer &data, const string &key) {
    auto itr = m_dic->find(key);
    if (itr != m_dic->end()) {
        itr->second->status = SlotStatus::INVALID;
    }
    auto sizeNeeded = pbItemSize(key, data);
    auto ptr = m_ptr + m_actualSize;
    writePBItem(ptr, key, data);
    m_dic->emplace(key, new Slot{m_actualSize, sizeNeeded});
    m_actualSize += sizeNeeded;
}
```

Each write only appends new data at the file's tail; existing content is untouched. The old slot for an updated key is marked invalid in the in-memory dictionary.

Three benefits follow. Write volume is minimal — only the delta, regardless of key count. Crash safety is natural — an append either completed or never happened, with no "half-overwritten" middle state. Rollback is simple — truncate the invalid tail to restore the last valid state.

MMKV periodically triggers compaction to merge valid data and discard invalid slots, preventing unbounded file growth.

## Process Safety: Lock Granularity

In multi-process scenarios, MMKV uses file locks (`flock`) to protect cross-process reads and writes. This is fundamentally different from SP's multi-process mode (`MODE_MULTI_PROCESS`).

SP's `MODE_MULTI_PROCESS` only checks the file's modification timestamp when `getSharedPreferences` is called and reloads if it changed — it provides no write protection. Two processes editing the same SP file will overwrite each other, with no notification to the other process.

```java
// MMKV internal sync
void MMKV::sync() {
    SCOPED_LOCK(m_lock); // file lock
    // mmap is a shared mapping; no explicit flush needed
    // but metadata consistency must be ensured
}
```

MMKV's lock only protects metadata and compaction. Day-to-day `putXxx` writes rely on mmap's shared mapping — multiple processes writing different offsets of the same file is safe, and the OS page cache guarantees coherence. This lock-free-read, fine-grained-write design means multi-process read scenarios have almost no contention overhead.

One pitfall I hit in production: on some Android 8.x custom ROMs, `flock` behavior is inconsistent — exclusive locks occasionally degrade to shared locks. If you use MMKV for cross-process synchronization, run compatibility tests across tens of millions of devices, and do not rely on it for strict ordering guarantees between processes.

## Three-Way Comparison: When to Pick What

| Dimension | SharedPreferences | MMKV | DataStore |
|-----------|-------------------|------|-----------|
| Load timing | First access (sync block) | Init (async mmap) | First read (suspend) |
| Write strategy | Full XML overwrite | mmap + append | Full Proto overwrite |
| Thread safety | Not guaranteed | Guaranteed | Coroutine-guaranteed |
| Process safety | Change detection only | File lock + shared map | Unsupported |
| Type safety | None (runtime cast) | None (runtime cast) | Compile-time |

DataStore is built on coroutines and Flow, which fixes SP's thread-safety issues, and its typed API is better. But its implementation is still read-all + write-all, and writes go through an ordinary FileOutputStream — sequential writes that cannot exploit mmap.

The selection guidance is clear:

- Simple config, single-process, already using Kotlin coroutines: DataStore. Its Flow interface fits reactive config scenarios, and compile-time type checking saves you from runtime `ClassCastException` debugging.
- High-frequency writes, multi-process sharing, or legacy compatibility: MMKV is the only choice. In performance-sensitive logging and A/B-test config modules I cut write latency from SP's 15–30ms to under 1ms.
- A few keys, never multi-process, lightweight: SP still works — as long as you do not synchronously load a large file during Application init.

One real data point: an A/B-test config module with 300+ keys, where each experiment update changes 20–30. With SP, a full write cost about 28ms. After switching to MMKV it dropped to roughly 0.8ms, with memory footprint essentially unchanged.

## Easily Overlooked Details

MMKV's default file size is a 4KB page-aligned region. If your values are large (say a 10KB JSON), frequent expansion will erode mmap's advantage. Compress large values, or evaluate whether they really belong in MMKV at all.

The other detail: `MMKV.defaultMMKV()` returns a singleton holding a global file lock. When your app has multiple processes, prefer named instances per business module:

```kotlin
val configMMKV = MMKV.mmkvWithID("app_config", MMKV.MULTI_PROCESS_MODE)
val cacheMMKV = MMKV.mmkvWithID("app_cache", MMKV.MULTI_PROCESS_MODE)
```

This reduces lock contention and makes debugging easier — which module's MMKV is causing stalls is obvious from the instance name.

mmap is not a silver bullet. Its advantage is most pronounced for high-frequency small-data reads and writes. For streaming large files, a traditional BufferedReader with a sensible buffer is the better fit. The core of technology selection is not "which is more powerful" — it is "which matches your bottleneck."
