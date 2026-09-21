---
title: 'Inside Android SQLite: Connection Pool Reuse, WAL Logging, and Transaction Isolation'
lang: en
translationKey: android-sqlite-connection-pool-wal-transactions
slug: android-sqlite-connection-pool-wal-transactions
excerpt: A "database is locked" investigation leads into connection pool reuse, WAL logging, and transaction isolation internals, with a practical checklist for concurrent read/write scenarios.
publishDate: '2026-08-13'
tags:
- Android
- SQLite
- Kotlin
- Performance Optimization
- Concurrency
seo:
  title: 'Android SQLite Internals: Connection Pool, WAL, and Transactions'
  description: 'Android SQLite storage internals: connection pool reuse, WAL logging, and transaction isolation, with an optimization guide for write concurrency.'
  pageType: article
---

I once debugged a multi-threaded write crash where the logs repeatedly showed `android.database.sqlite.SQLiteDatabaseLockedException: database is locked (code 5)`. My first instinct was to look for a busy timeout setting in Android's public API—only to discover, after digging around, that **`SQLiteDatabase` has no `setBusyTimeout()` method**. This is a common misconception (most likely carried over from the native SQLite C API's `sqlite3_busy_timeout()` or bindings in other languages). On Android, lock-wait timeout handling lives inside `SQLiteConnection`/`SQLiteConnectionPool`, and ordinary developers don't get a direct entry point into that layer. They can only mitigate the problem indirectly by adjusting connection pool behavior, transaction modes, WAL, and so on. Following the call stack further down, the root cause wasn't the timeout setting at all—it was the combination of three things: connection pool reuse, WAL configuration, and Android's transaction defaults.

## Connection Pool Reuse: getWritableDatabase Does Not Mean Opening a File

Many engineers assume that every call to `SQLiteOpenHelper.getWritableDatabase()` opens the database file again. In reality, `SQLiteDatabase` maintains a connection pool (`SQLiteConnectionPool`) internally, backed by a number of `SQLiteConnection` instances. The file is only actually opened when the pool has no available connection; finished connections are returned to the pool for reuse, not destroyed.

The pool has a primary connection, which write transactions must occupy; read operations can use non-primary connections. The reuse benefit comes from here, and so does the blocking scenario:

```kotlin
// 线程 A：拿到游标后慢处理，游标不关就占着一个连接
val cursor = db.query("message", null, null, null, null, null, null)

// 线程 B：开写事务，必须等主连接空闲
db.beginTransaction()
```

If thread A doesn't `close()` the cursor for a long time, thread B gets stuck at `beginTransaction()`. When the two threads end up waiting on each other, the symptom is an ANR rather than an exception. I've stepped into this pitfall myself: when a cursor leak overlaps with concurrent write transactions, the stack trace shows no lock information at all, and you can only locate the problem by dumping connection state.

## WAL: The Watershed for Concurrent Reads and Writes

In rollback journal mode, reads must acquire a SHARED lock and writes must acquire an EXCLUSIVE lock, making reads and writes mutually exclusive. During bulk writes, all reads are blocked, and no matter how large you tune the cache, throughput won't improve.

WAL (Write-Ahead Logging) changes the write path: writes are appended to a separate `-wal` file while the main database file stays unchanged, so readers continue reading the old snapshot. Readers don't block writers, and writers don't block readers, but write-vs-write is still serialized—SQLite always has a single writer.

How to enable it:

```kotlin
// 原生 SQLiteOpenHelper 需要显式打开
helper.setWriteAheadLoggingEnabled(true)

// Room 在常规设备上 AUTOMATIC 会自动落到 WAL
Room.databaseBuilder(context, AppDb::class.java, "app.db")
    .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
    .build()
```

WAL comes with two files: `-shm` is the shared-memory index, which records the WAL page index and read/write locks; `-wal` is the write log itself. Once writes accumulate past a threshold, a checkpoint merges the WAL pages back into the main database, with a default `wal_autocheckpoint=1000` pages. When checkpoints can't keep up, the `-wal` file keeps growing, which slows down cold-start open times.

My experience: if reads dominate writes, just enable WAL; for pure bulk-import scenarios, you can temporarily switch back to TRUNCATE, since checkpoint contention actually hurts in those cases.

## Transaction Isolation: Android Hides a Default

SQLite has three transaction types: DEFERRED, IMMEDIATE, and EXCLUSIVE, differing in when they acquire locks. DEFERRED takes no lock at BEGIN; it acquires SHARED on the first read and upgrades when writing. If the first operation is a write, it directly attempts RESERVED and throws SQLITE_BUSY on conflict. IMMEDIATE acquires the RESERVED lock at BEGIN, grabbing the write slot up front. EXCLUSIVE goes fully exclusive.

The real trap is Android's wrapper: `beginTransaction()` executes `BEGIN EXCLUSIVE` by default.

```java
// SQLiteConnection.java（AOSP 简化）
if (exclusive) {
    execute("BEGIN EXCLUSIVE;", null, false);
} else {
    execute("BEGIN IMMEDIATE;", null, false);
}
```

In rollback journal mode, this default makes a write transaction block all reads from other connections from the very start. To allow concurrent reads, use `beginTransactionNonExclusive()`, which issues `BEGIN IMMEDIATE`; combined with WAL, this is how you fully capture the read/write concurrency benefit:

```kotlin
db.beginTransactionNonExclusive()
try {
    db.execSQL("INSERT INTO message(body) VALUES(?)", arrayOf("hello"))
    db.setTransactionSuccessful()
} finally {
    db.endTransaction()
}
```

`setBusyTimeout()` does not exist in Android's public API, and treating it as "the solution" is itself the misconception. The real fix is to shorten lock-holding time, choose the right transaction mode, enable WAL, and at the application layer add retry/fallback logic for `SQLiteDatabaseLockedException` as a safety net.

## From SQL to Disk Pages: The Native Storage Pipeline

Inside SQLite, a SQL statement roughly follows this path:

1. The tokenizer and parser compile the SQL into VDBE bytecode.
2. The VDBE virtual machine executes the bytecode, reading and writing through B-tree cursors.
3. The B-tree organizes data by pages; each table and index corresponds to a b-tree, and large fields are written to overflow pages.
4. The Pager manages the page cache, loading pages on demand, and dirty pages are committed with transactions.
5. The VFS abstracts the file system, hiding platform differences.

Once you understand this pipeline, tuning has clear leverage points: `page_size` determines the page size, defaulting to 4096; `cache_size` determines the page cache's memory footprint; `mmap_size` maps the file to reduce `read` syscalls. These PRAGMAs are not "bigger is better"—an oversized page cache on low-memory devices makes the process more likely to be reclaimed by the LMK.

Back to that initial code 5: the final fix was to enable WAL, switch write transactions to non-exclusive, close cursors immediately after reading, and add a write-retry layer at the application level (catch `SQLiteDatabaseLockedException`, then retry a few times with delays, in place of the non-existent busy timeout setting). With these three changes plus retry as a backstop, multi-threaded stress testing no longer reproduced the issue.

One caveat: these changes significantly reduce the probability of lock conflicts, but they are not a guarantee that "nothing will ever go wrong." Under heavy concurrent writes, multiple processes accessing the same database file, or unusually slow disk I/O, `SQLITE_BUSY` can still be triggered, so the application layer still needs reasonable retry/fallback logic.

The practical checklist:

- For concurrent reads and writes, prefer WAL first, then pair it with non-exclusive write transactions.
- Keep the scope of cursors and transactions as small as possible, and release them as soon as you're done.
- Add application-level retry as a fallback for `SQLiteDatabaseLockedException`—don't fantasize that a non-existent busy timeout API can fully solve the problem.
