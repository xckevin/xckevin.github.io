---
title: 深入 Android MMKV 高性能键值存储全链路：从 mmap 内存映射到 ProtoBuf 增量更新的微信级工程实践
slug: android-mmkv-mmap-protobuf
translationKey: android-mmkv-mmap-protobuf
excerpt: 深入剖析 MMKV 如何通过 mmap 内存映射与 ProtoBuf 增量更新，解决 SharedPreferences 主线程阻塞与全量写入的 ANR 根源，并提供 SP/MMKV/DataStore 三方案选型指南。
publishDate: '2026-06-16'
tags:
- Android
- MMKV
- 性能优化
- mmap
- ProtoBuf
seo:
  title: 深入 Android MMKV 高性能键值存储全链路：从 mmap 内存映射到 ProtoBuf 增量更新的微信级工程实践
  description: 深入解析 MMKV 高性能键值存储原理，从 mmap 内存映射、ProtoBuf 增量更新到多进程安全，对比 SharedPreferences 与 DataStore 优劣，给出工程实践选型指南。
---

做客户端开发，大概率都经历过这个场景：用户反馈应用启动白屏，排查到最后发现是 `SharedPreferences` 的 `getSharedPreferences` 在主线程加载文件，把 Activity 启动卡了 2 秒。于是我把 `apply()` 全换成了 `commit()`——ANR 率不降反升。

这不是个案。SP 的设计缺陷在微信这种日均写入量巨大的应用里会被无限放大。腾讯开源的 MMKV 在微信里跑了 6 年以上，单设备日均读写超过 50 万次。

## 为什么 SharedPreferences 会卡死主线程

SP 的加载流程：`getSharedPreferences("xxx", MODE_PRIVATE)` 在构造函数里直接启动一个线程从磁盘读 XML 文件：

```java
// SharedPreferencesImpl 构造函数
private void startLoadFromDisk() {
    synchronized (mLock) {
        mLoaded = false; // 标记未加载完成
    }
    new Thread("SharedPreferencesImpl-load") {
        public void run() {
            loadFromDisk(); // 阻塞式 XML 解析
        }
    }.start();
}
```

问题在于，`getSharedPreferences` 返回的实例中，所有读操作都会检查 `mLoaded` 标记。XML 没解析完，`awaitLoadLocked()` 直接 `wait()`——连 `getString()` 这种看似无害的操作也逃不掉。

```java
private void awaitLoadLocked() {
    while (!mLoaded) {
        try {
            mLock.wait();
        } catch (InterruptedException unused) { }
    }
}
```

当 Application 初始化回调链在主线程调了大量 `getSharedPreferences`，而磁盘 IO 因为低端机 eMMC 抢占总线而延迟，后果就是主线程排队等锁，Activity 生命周期卡死。这是 SP 的 ANR 根因，不是 `commit()` 和 `apply()` 的区别能掩盖的。

写入方面，SP 的 `commit()` 同步写磁盘，本就不该在主线程调用。`apply()` 虽然是异步的，但内部往 `QueuedWork` 里丢任务，Activity 的 `onStop` 会确保它完成——Activity 切换时仍然可能触发等待。

## mmap：让文件像内存一样直接访问

MMKV 的思路很直接：既然磁盘 IO 是瓶颈，就用 mmap 把文件映射到进程地址空间，让读写变成内存操作。

mmap（Memory-Mapped File）是 Linux 内核提供的机制，在虚拟内存中建立文件与内存页的直接映射。往这块内存写数据，内核负责在合适时机把脏页刷回磁盘——对上层而言，写文件就是 `memcpy`，没有 `write()` 系统调用，没有用户态到内核态的上下文切换。

```cpp
// mmap 创建映射
m_ptr = (int8_t *) mmap(nullptr, DEFAULT_MMAP_SIZE,
    PROT_READ | PROT_WRITE, MAP_SHARED, m_fd, 0);
```

MMKV 启动时把文件 mmap 到内存，之后所有 `putInt`、`putString` 操作本质上都在往这块内存写数据。不用每次读取都定位文件偏移、发 `read` 系统调用。崩溃时，未刷盘的脏页由内核负责持久化，不会丢失已完成写入的数据——SP 做不到这一点。

mmap 有一个绕不开的坑：文件大小。内存映射要求连续的虚拟地址区域，不能像普通 IO 那样动态扩展。MMKV 的解法是预分配固定大小并用游标管理，不够了就重新 mmap 一个更大的区域。这个成本在微信的实践中可以接受，因为重新映射的触发频率远低于 IO 带来的性能损耗。

## ProtoBuf 增量更新：不写全量文件

SP 每次 `apply()` 都会把内存中的 `HashMap` 序列化成完整 XML 写回磁盘。一个 100 个 key 的 SP 文件，哪怕只改了一个 key，也要全量覆盖写入。这对微信某些配置模块（上千个 key）是灾难。

MMKV 选择了 Protocol Buffers 做序列化格式，但核心不在于序列化方案，而在于它实现了增量更新（append-only）：

```cpp
// 简化后的写入逻辑
bool MMKV::setDataForKey(MMBuffer &data, const string &key) {
    // 1. 先检查 key 是否存在
    auto itr = m_dic->find(key);
    if (itr != m_dic->end()) {
        // 2. 存在就标记旧的 slot 为无效
        itr->second->status = SlotStatus::INVALID;
    }
    // 3. 新数据追加到文件末尾
    auto sizeNeeded = pbItemSize(key, data);
    auto ptr = m_ptr + m_actualSize;
    writePBItem(ptr, key, data);
    // 4. 更新内存字典
    m_dic->emplace(key, new Slot{m_actualSize, sizeNeeded});
    m_actualSize += sizeNeeded;
}
```

每次写操作只在文件尾部追加新数据，不修改前面的内容。被更新的旧 key 在内存字典里标记为无效。

这样做有三个好处：写入量极小（只写增量，不管多少 key）；天然崩溃安全（追加写入要么成功要么没发生，不存在"覆盖一半"的中间态）；回滚简单（删除文件尾部的无效数据即可回滚到上一个有效状态）。

MMKV 会定期触发 compaction 合并有效数据、丢弃无效 slot，防止文件无限膨胀。

## 进程安全：锁的粒度与选择

多进程场景下，MMKV 用文件锁（`flock`）保护跨进程的读写操作。这和 SP 的多进程模式（`MODE_MULTI_PROCESS`）有本质区别。

SP 的 `MODE_MULTI_PROCESS` 只在 `getSharedPreferences` 时检查文件修改时间戳，发现有变就重新加载——它不做写入保护。两个进程同时改同一个 SP 文件，最后一个 `apply()` 覆盖前一个，且不会通知另一个进程数据已变。

```java
// MMKV 内部同步写操作
void MMKV::sync() {
    SCOPED_LOCK(m_lock); // 文件锁
    // mmap 是共享映射，不需要显式刷盘
    // 但需要确保元数据一致
}
```

MMKV 的锁只保护元数据和 compaction 操作。日常 `putXxx` 写入依赖 mmap 的共享映射特性——多个进程写入同一个文件的不同位置是安全的，操作系统的页缓存机制保证一致性。这种读无锁、写细粒度锁的设计，让多进程读取场景几乎没有竞争开销。

我在实际项目中踩过一个坑：Android 8.x 的某些定制 ROM 上，`flock` 行为不一致，互斥锁偶尔降级为共享锁。如果你用 MMKV 做跨进程同步，建议在千万级设备上做兼容性测试，不适合做严格时序依赖的进程通信。

## 三方案对比：什么时候该选什么

| 维度 | SharedPreferences | MMKV | DataStore |
|------|-------------------|------|-----------|
| 加载时机 | 首次访问（同步阻塞） | 初始化（异步 mmap） | 首次读取（suspend） |
| 写入方式 | 全量 XML 覆盖 | mmap + 增量追加 | 全量 Proto 覆盖 |
| 线程安全 | 不保证 | 保证 | 协程保证 |
| 进程安全 | 仅检测变更 | 文件锁 + 共享映射 | 不支持 |
| 类型安全 | 无（运行时 cast） | 无（运行时 cast） | 编译期保证 |

DataStore 基于协程 + Flow，解决了 SP 的线程安全问题，API 类型安全也更好。但内部实现仍然是读全量 + 写全量，底层写入走普通 FileOutputStream，顺序写入无法利用 mmap 的优势。

选型建议很明确：

- 简单配置、不需要多进程、已接入 Kotlin 协程的项目，用 DataStore。Flow 接口天然适配响应式配置场景，编译期类型检查能省掉运行时 `ClassCastException` 的排查时间。
- 高频写入、多进程共享、需要兼容老项目，MMKV 是唯一选择。我在性能敏感的日志模块和 ABTest 配置模块里都用 MMKV，写入耗时从 SP 的 15-30ms 降到 1ms 以内。
- 只用少量配置、永远不会多进程的轻量场景，SP 仍然够用——前提是别在 Application 初始化时同步加载大文件。

一个实际数据：某 App 的 ABTest 配置模块有 300+ 个 key，每次实验下发更新 20-30 个。用 SP 时全量写入耗时约 28ms，切到 MMKV 后降到 0.8ms 左右，内存占用基本持平。

## 容易忽略的细节

MMKV 默认文件大小是 4KB 的页对齐大小。如果你的 value 体积较大（比如存了一个 10KB 的 JSON），频繁触发扩容会抵消 mmap 的性能优势。建议对 value 做压缩，或者评估一下这些大对象是否真的适合放在 MMKV 里。

另一个点是 `MMKV.defaultMMKV()` 返回单例，内部持有全局文件锁。应用有多个进程时，建议为不同业务模块创建具名实例：

```kotlin
val configMMKV = MMKV.mmkvWithID("app_config", MMKV.MULTI_PROCESS_MODE)
val cacheMMKV = MMKV.mmkvWithID("app_cache", MMKV.MULTI_PROCESS_MODE)
```

这样能减少锁竞争，定位问题也更方便——哪个模块的 MMKV 导致卡顿，看实例名一目了然。

mmap 不是银弹。它的优势在高频小数据读写场景最明显。如果是大文件流式处理，传统的 BufferedReader 配合合理缓冲更合适。技术选型的核心不是"哪个更牛"，而是"哪个匹配你的瓶颈"。
