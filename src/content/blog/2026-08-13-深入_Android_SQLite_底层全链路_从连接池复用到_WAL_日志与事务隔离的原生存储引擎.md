---
title: 深入 Android SQLite 底层全链路：从连接池复用到 WAL 日志与事务隔离的原生存储引擎解析
excerpt: 从一次 SQLite database is locked 排查入手，剖析连接池复用、WAL 日志与事务隔离的底层机制，并给出读写并发场景下的落地优化清单。
publishDate: '2026-08-13'
tags:
- Android
- SQLite
- Kotlin
- 性能优化
- 并发
seo:
  title: 深入 Android SQLite 底层全链路：从连接池复用到 WAL 日志与事务隔离的原生存储引擎解析
  description: 深入分析 Android SQLite 底层存储全链路，涵盖连接池复用、WAL 日志与事务隔离机制，并给出多线程写入崩溃的排查与优化方案。
---

排查过一次多线程写入崩溃：日志反复出现 `android.database.sqlite.SQLiteDatabaseLockedException: database is locked (code 5)`。第一反应是找 Android 公开 API 里的 busy timeout 设置方法——翻了一圈才发现**`SQLiteDatabase` 并没有 `setBusyTimeout()` 这个方法**，这是一个常见的认知误区（很可能是从原生 SQLite C API 的 `sqlite3_busy_timeout()` 或其他语言绑定联想过来的）。Android 层面处理锁等待超时的机制在 `SQLiteConnection`/`SQLiteConnectionPool` 内部，普通开发者拿不到这层直接调用的入口，只能通过调整连接池行为、事务模式、WAL 等方式间接缓解。顺着调用栈往下挖，根因不在超时设置，而在连接池复用、WAL 配置、Android 事务默认值三件事叠加。

## 连接池复用：getWritableDatabase 不等于打开文件

不少工程师以为每次调用 `SQLiteOpenHelper.getWritableDatabase()` 都会打开一次数据库文件。实际上 `SQLiteDatabase` 内部维护了一个连接池（`SQLiteConnectionPool`），底层是若干 `SQLiteConnection`。只有池里没有可用连接时才真正打开文件，用完的连接回池复用，不会销毁。

池里有一个主连接（primary connection），写事务必须占用它；读操作可以走非主连接（non-primary connection）。复用收益来自这里，阻塞场景也埋在这里：

```kotlin
// 线程 A：拿到游标后慢处理，游标不关就占着一个连接
val cursor = db.query("message", null, null, null, null, null, null)

// 线程 B：开写事务，必须等主连接空闲
db.beginTransaction()
```

线程 A 长时间不 `close()` 游标，线程 B 就卡在 `beginTransaction()`。两个线程再互相等待，表现是 ANR 而不是异常。我踩过这个坑：游标泄漏叠加并发写事务时，堆栈里看不到任何锁信息，只能靠 dump 连接状态定位。

## WAL：读写并发的分水岭

回滚日志（rollback journal）模式下，读要拿 SHARED 锁，写要拿 EXCLUSIVE 锁，读写互斥。批量写入期间，所有读都被挡在外面，缓存调得再大也救不了吞吐。

WAL（Write-Ahead Logging）改了写入路径：写操作追加到独立的 `-wal` 文件，主库文件保持不变，读者继续读旧快照。读者不阻塞写者，写者也不阻塞读者，但写写仍然串行，SQLite 始终是单写者。

开启方式：

```kotlin
// 原生 SQLiteOpenHelper 需要显式打开
helper.setWriteAheadLoggingEnabled(true)

// Room 在常规设备上 AUTOMATIC 会自动落到 WAL
Room.databaseBuilder(context, AppDb::class.java, "app.db")
    .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
    .build()
```

WAL 附带两个文件：`-shm` 是共享内存索引，记录 WAL 页索引和读写锁；`-wal` 是写日志本体。写入积累到阈值后，checkpoint 把 WAL 页合并回主库，默认 `wal_autocheckpoint=1000` 页。checkpoint 没跟上时 `-wal` 会持续变大，拖慢冷启动打开速度。

我的经验：读多写少直接上 WAL；纯批量导入场景可以临时切回 TRUNCATE，checkpoint 竞争在这类场景下反而拖后腿。

## 事务隔离：Android 藏了一个默认值

SQLite 事务分三种：DEFERRED、IMMEDIATE、EXCLUSIVE，区别在拿锁时机。DEFERRED 在 BEGIN 时不取锁，首次读才拿 SHARED，写入时再升级；首次操作就是写则直接尝试 RESERVED，冲突抛 SQLITE_BUSY。IMMEDIATE 在 BEGIN 时就拿 RESERVED 锁，先占住写位置。EXCLUSIVE 直接排他。

真正容易踩的是 Android 封装：`beginTransaction()` 默认执行 `BEGIN EXCLUSIVE`。

```java
// SQLiteConnection.java（AOSP 简化）
if (exclusive) {
    execute("BEGIN EXCLUSIVE;", null, false);
} else {
    execute("BEGIN IMMEDIATE;", null, false);
}
```

回滚日志模式下，这个默认值让写事务从一开始就阻塞其他连接的所有读。要允许并发读，用 `beginTransactionNonExclusive()`，它走 `BEGIN IMMEDIATE`，再配合 WAL 才能吃满读写并发红利：

```kotlin
db.beginTransactionNonExclusive()
try {
    db.execSQL("INSERT INTO message(body) VALUES(?)", arrayOf("hello"))
    db.setTransactionSuccessful()
} finally {
    db.endTransaction()
}
```

`setBusyTimeout()` 不存在于 Android 公开 API，把它当成“解决方案”本身就是个误区。真正的解法是缩短持锁时间、选对事务模式、开 WAL，应用层再搭配针对 `SQLiteDatabaseLockedException` 的重试/降级逻辑作为兼底。

## 从 SQL 到磁盘页：原生存储全链路

一条 SQL 在 SQLite 内部大致走这条路径：

1. 分词器与解析器把 SQL 编译成 VDBE 字节码
2. VDBE 虚拟机执行字节码，通过 B-tree 游标读写
3. B-tree 按页组织数据，表和索引各对应一棵 b-tree，大字段写入溢出页
4. Pager 管理页缓存，按需装载页，脏页随事务提交
5. VFS 抽象文件系统，屏蔽平台差异

理解这条链路后，调优就有抓手：`page_size` 决定页大小，默认 4096；`cache_size` 决定页缓存内存占用；`mmap_size` 映射文件后减少 read 系统调用。这些 PRAGMA 不是越大越好，页缓存过大在低内存设备上会让进程更容易被 LMK 回收。

回到开头的 code 5：最终处理是开 WAL、写事务改成 non-exclusive、游标读完立即 close，另外在应用层加了一层写重试逻辑（捕获 `SQLiteDatabaseLockedException` 后延时重试几次，代替不存在的 busy timeout 设置）。三个改动叠加重试兵底，多线程压测没再复现。

需要提醒的是，这些改动能显著降低锁冲突概率，但不是“绝对不会出问题”的保证。高并发写入、多进程访问同一数据库文件、或磁盘 IO 异常慢时，仍然可能触发 `SQLITE_BUSY`，应用层仍需保留合理的重试/降级逻辑。

落地清单：

- 读写并发优先用 WAL，再配合 non-exclusive 写事务
- 游标和事务的作用域尽量小，用完立即释放
- 针对 `SQLiteDatabaseLockedException` 在应用层做重试兜底，不要幻想一个不存在的 busy timeout API 能彻底解决问题
