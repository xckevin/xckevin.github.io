---
title: "Binder IPC 机制深度解析（Beyond AIDL）（2）：深入 Binder 驱动：内核中的魔法师"
excerpt: "「Binder IPC 机制深度解析（Beyond AIDL）」系列第 2/7 篇：深入 Binder 驱动：内核中的魔法师"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Binder
  - IPC
  - AIDL
series:
  name: "Binder IPC 机制深度解析（Beyond AIDL）"
  part: 2
  total: 7
seo:
  title: "Binder IPC 机制深度解析（Beyond AIDL）（2）：深入 Binder 驱动：内核中的魔法师"
  description: "「Binder IPC 机制深度解析（Beyond AIDL）」系列第 2/7 篇：深入 Binder 驱动：内核中的魔法师"
---
# Binder IPC 机制深度解析（Beyond AIDL）（2）：深入 Binder 驱动：内核中的魔法师

> 本文是「Binder IPC 机制深度解析（Beyond AIDL）」系列的第 2 篇，共 7 篇。在上一篇中，我们探讨了「引言：Android 世界的神经网络」的相关内容。

## 二、深入 Binder 驱动：内核中的魔法师

Binder 驱动是理解 Binder 机制的核心，它实现在 `drivers/android/binder.c`（Linux Kernel 源码中）。它通过设备节点 `/dev/binder`（以及用于 HAL 和 Vendor 的 `/dev/hwbinder`、`/dev/vndbinder`）暴露接口给用户空间。

### 1. 核心 ioctl 命令

用户空间与 Binder 驱动的交互主要通过 ioctl 系统调用进行。最重要的命令是 `BINDER_WRITE_READ`，它允许在一个调用中同时写入数据（请求或回复）并读取数据（回复或新请求），这种设计减少了系统调用的开销。其他关键命令包括：

- `BINDER_SET_MAX_THREADS`：设置进程允许的最大 Binder 线程数。
- `BINDER_VERSION`：获取 Binder 驱动的版本。
- `BINDER_THREAD_EXIT`：通知驱动一个 Binder 线程即将退出。

### 2. 关键内核数据结构

Binder 驱动内部维护着复杂的数据结构来管理 IPC 状态：

- **struct binder_proc：** 代表一个使用了 Binder 的进程。它包含：
  - 一个红黑树（nodes）存储该进程拥有的所有 `binder_node`（即服务实体）。
  - 一个列表（threads）存储该进程的所有 `binder_thread`。
  - 指向通过 mmap 分配的内核虚拟地址空间的指针（buffer），用于与用户空间共享数据。
  - 待处理事务队列等。
- **struct binder_thread：** 代表进程中一个参与 Binder 通信的线程（通常是 Binder 线程池中的线程或主线程）。它包含：
  - 一个事务栈（transaction_stack），处理嵌套调用。
  - 一个等待队列（looper_private），线程在此睡眠等待新的事务。
  - 指向所属 `binder_proc` 的指针。
- **struct binder_node：** 代表一个 Binder 实体（Server 端的 BBinder 对象）。它包含：
  - 指向用户空间 BBinder 对象的指针（ptr）和 cookie（通常与 ptr 相同或相关）。
  - 一个强引用计数（internal_strong_refs）和弱引用计数（local_weak_refs）。
  - 指向所属 `binder_proc` 的指针。
  - 一个红黑树（refs）存储所有引用此 node 的 `binder_ref`。
- **struct binder_ref：** 代表一个客户端对 Binder 实体的引用（Client 端的 BpBinder 对象）。它包含：
  - 一个句柄（desc），在 Client 进程内唯一标识这个引用。
  - 指向它所引用的 `binder_node` 的指针（node）。
  - 一个强引用计数（strong）。
  - 所属 `binder_proc`（即 Client 进程）的指针。
- **struct binder_buffer：** 代表一次 Binder 事务所使用的内存缓冲区，位于驱动与用户进程共享的内存区域，包含事务数据（data）。
- **struct binder_transaction：** 代表一个正在进行的事务，连接发送方线程和目标节点/线程。

### ASCII 图示 2：Binder 驱动核心数据结构关系（简化）

```plain
+----------------+         +----------------+         +----------------+
| binder_proc A  | ------> | binder_node    | <------ | binder_ref     | ----> Owns
| (Server Proc)  | Owns    | (Service Foo)  | Refs    | (Handle 123)   |       in Proc B
|                |         | - ptr          |         | - node ptr     |
| - nodes tree   |         | - internal_refs|         | - strong count |
| - threads list |         | - refs tree ---'         +----------------+
| - buffer ptr   |         +----------------+                 ^
+----------------+                 |                          | Refs
        | Owns                     | Points to user space BBinder|
        v                          +-----------------------------+
+----------------+
| binder_thread  |
| - transaction_stack |
| - wait queue   |
+----------------+

+----------------+
| binder_proc B  |
| (Client Proc)  | ----> Owns binder_ref(s) pointing to nodes in Proc A
| ...            |
+----------------+
```

**图解：**

- `binder_proc` 代表进程，包含 `binder_thread` 列表和 `binder_node` 树。
- `binder_node` 代表服务实体，被其所属 `binder_proc` 拥有，并被其他进程中的 `binder_ref` 引用。
- `binder_ref` 代表客户端引用，属于客户端 `binder_proc`，并指向服务端的 `binder_node`。
- 引用计数（internal_strong_refs 和 strong）是管理它们生命周期的关键。

### 3. 事务处理流程（内核视角）

当 Client 通过 `ioctl(BINDER_WRITE_READ)` 发起 `BC_TRANSACTION` 命令时：

1. 驱动根据传入的 handle（Client 端的 `binder_ref->desc`）查找对应的 `binder_ref`。
2. 通过 `binder_ref` 找到目标的 `binder_node`。
3. 检查 Client 是否有权限调用目标 `binder_node`（基于 UID/PID 和可能的 SELinux 策略）。
4. 从目标进程（`binder_node->proc`）的 `binder_thread` 列表中寻找一个空闲线程：
   - 如果找到空闲线程，将其唤醒。
   - 如果没有空闲线程，但未达到最大线程数（`binder_proc->max_threads`），则指示目标进程创建新线程（通过向用户空间返回 `BR_SPAWN_LOOPER`）。
   - 如果线程池已满，将事务放入目标进程或目标节点的待处理队列（todo）。
5. 分配一个 `binder_buffer`，并将 Client 用户空间的 Parcel 数据拷贝到这个内核缓冲区。
6. 将 `binder_transaction` 结构体与目标线程关联。
7. 目标线程被唤醒后，执行 `ioctl(BINDER_WRITE_READ)`，驱动将内核缓冲区的数据（包含 `BR_TRANSACTION` 命令和 `binder_buffer`）拷贝到该线程的用户空间，并返回。
8. 目标线程处理事务，并通过 `ioctl(BINDER_WRITE_READ)` 发送 `BC_REPLY`。
9. 驱动执行类似的过程，将回复数据通过内核缓冲区传递回阻塞等待的 Client 线程。

### 4. 引用计数

Binder 的生命周期管理依赖于驱动层和用户层的协同引用计数。

- **驱动层：** `binder_node` 有 `internal_strong_refs`，`binder_ref` 有 `strong` 计数。当 Client 获取 Service 引用时，对应 `binder_ref` 创建，`strong` 为 1，目标 `binder_node` 的 `internal_strong_refs` 增加。当 Client 释放引用（进程退出或显式操作），`binder_ref` 的 `strong` 减少，降到 0 时 `binder_ref` 销毁，目标 `binder_node` 的 `internal_strong_refs` 减少。当 `binder_node` 的 `internal_strong_refs` 和 `local_weak_refs` 都为 0 时，驱动会通知 Server 进程可以销毁该 Node（通过 `BR_RELEASE` 命令）。
- **用户层（Native C++）：** 通过智能指针 `sp<IBinder>`（强引用）和 `wp<IBinder>`（弱引用）管理 BpBinder 和 BBinder 的生命周期，它们会调用 `IBinder::incStrong()` / `decStrong()` 等方法，这些方法最终会通过 IPCThreadState 与驱动交互，增减驱动层的引用计数。

这种跨层协同的引用计数确保了只有当没有任何 Client 持有强引用，并且 Server 自身也不再强持有它时，Binder 实体才会被销毁。

---

---

> 下一篇我们将探讨「内存模型与数据传输：一次拷贝的奥秘」，敬请关注本系列。

**「Binder IPC 机制深度解析（Beyond AIDL）」系列目录**

1. 引言：Android 世界的神经网络
2. **深入 Binder 驱动：内核中的魔法师**（本文）
3. 内存模型与数据传输：一次拷贝的奥秘
4. 线程模型：并发、同步与 ANR 之源
5. 基本 AIDL 实现示例
6. 死亡通知（DeathRecipient）：远端死亡的哨兵
7. 疑难问题排查：庖丁解牛 Binder
