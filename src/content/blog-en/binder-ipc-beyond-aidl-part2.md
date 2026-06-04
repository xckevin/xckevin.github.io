---
title: "Binder IPC Deep Dive (Beyond AIDL) (2): Inside the Binder Driver"
lang: en
translationKey: binder-ipc-beyond-aidl-part2
slug: binder-ipc-beyond-aidl-part2
excerpt: "Part 2 of the Binder IPC deep dive series, covering Binder driver ioctls, kernel data structures, transaction flow, and reference counting."
publishDate: '2024-04-21'
displayInBlog: false
tags:
- "Android"
- "Binder"
- "IPC"
- "AIDL"
series:
  name: "Binder IPC Deep Dive (Beyond AIDL)"
  part: 2
  total: 7
seo:
  title: "Android Binder Driver Internals: ioctl, Transactions, and Refs"
  description: "Explore Binder driver internals, including BINDER_WRITE_READ, binder_proc, binder_node, binder_ref, kernel transactions, and reference counts."
  pageType: article
---
> This is part 2 of 7 in the "Binder IPC Deep Dive (Beyond AIDL)" series. The previous article covered "Introduction: Android's Neural Network."

## 2. Inside the Binder Driver: The Kernel-Space Operator

The Binder driver is the core of the Binder mechanism. It is implemented in `drivers/android/binder.c` in the Linux kernel source tree. It exposes its user-space interface through the `/dev/binder` device node, along with `/dev/hwbinder` for HAL and `/dev/vndbinder` for vendor-side communication.

### 1. Core ioctl Commands

User space interacts with the Binder driver mainly through the ioctl system call. The most important command is `BINDER_WRITE_READ`, which allows a process to write data, such as a request or reply, and read data, such as a reply or a new request, in a single call. This design reduces system-call overhead. Other important commands include:

- `BINDER_SET_MAX_THREADS`: sets the maximum number of Binder threads a process may use.
- `BINDER_VERSION`: gets the Binder driver version.
- `BINDER_THREAD_EXIT`: tells the driver that a Binder thread is about to exit.

### 2. Key Kernel Data Structures

The Binder driver maintains a set of sophisticated data structures to track IPC state:

- **struct binder_proc:** represents a process that uses Binder. It contains:
  - A red-black tree, `nodes`, storing all `binder_node` objects owned by the process, meaning its service entities.
  - A list, `threads`, storing all `binder_thread` objects in the process.
  - A pointer, `buffer`, to kernel virtual address space allocated through mmap and shared with user space.
  - Queues for pending transactions.
- **struct binder_thread:** represents a thread in the process that participates in Binder communication, usually a Binder thread-pool thread or the main thread. It contains:
  - A transaction stack, `transaction_stack`, for nested calls.
  - A wait queue, `looper_private`, where the thread sleeps while waiting for new transactions.
  - A pointer to its owning `binder_proc`.
- **struct binder_node:** represents a Binder entity, the BBinder object on the Server side. It contains:
  - A pointer, `ptr`, to the user-space BBinder object, and a cookie, usually the same as or related to `ptr`.
  - A strong reference count, `internal_strong_refs`, and a weak reference count, `local_weak_refs`.
  - A pointer to its owning `binder_proc`.
  - A red-black tree, `refs`, containing all `binder_ref` objects that reference this node.
- **struct binder_ref:** represents a client reference to a Binder entity, the BpBinder object on the Client side. It contains:
  - A handle, `desc`, that uniquely identifies this reference inside the Client process.
  - A pointer, `node`, to the `binder_node` it references.
  - A strong reference count, `strong`.
  - A pointer to the owning `binder_proc`, meaning the Client process.
- **struct binder_buffer:** represents the memory buffer used by one Binder transaction. It lives in the memory region shared between the driver and the user process and contains transaction data, `data`.
- **struct binder_transaction:** represents an in-flight transaction and connects the sending thread with the target node or target thread.

### ASCII Diagram 2: Core Binder Driver Data Structures, Simplified

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

**Diagram notes:**

- `binder_proc` represents a process and contains the `binder_thread` list and `binder_node` tree.
- `binder_node` represents a service entity. It is owned by its `binder_proc` and referenced by `binder_ref` objects in other processes.
- `binder_ref` represents a client-side reference. It belongs to the client `binder_proc` and points to the server-side `binder_node`.
- Reference counts, such as `internal_strong_refs` and `strong`, are central to lifecycle management.

### 3. Transaction Flow from the Kernel's Perspective

When the Client initiates a `BC_TRANSACTION` command through `ioctl(BINDER_WRITE_READ)`:

1. The driver looks up the corresponding `binder_ref` from the incoming handle, the Client-side `binder_ref->desc`.
2. It follows the `binder_ref` to find the target `binder_node`.
3. It checks whether the Client has permission to call the target `binder_node`, based on UID/PID and possible SELinux policy.
4. It looks for an idle thread in the target process's `binder_thread` list, where the target process is `binder_node->proc`:
   - If an idle thread exists, the driver wakes it.
   - If no idle thread exists but the maximum thread count, `binder_proc->max_threads`, has not been reached, the driver tells the target process to create a new thread by returning `BR_SPAWN_LOOPER` to user space.
   - If the thread pool is full, the transaction is placed into the target process or target node's pending queue, `todo`.
5. The driver allocates a `binder_buffer` and copies the Client's user-space Parcel data into that kernel buffer.
6. The `binder_transaction` structure is associated with the target thread.
7. After the target thread wakes and calls `ioctl(BINDER_WRITE_READ)`, the driver copies the kernel-buffer data, including the `BR_TRANSACTION` command and `binder_buffer`, into that thread's user space and returns.
8. The target thread handles the transaction and sends `BC_REPLY` through `ioctl(BINDER_WRITE_READ)`.
9. The driver performs a similar process to deliver the reply data through a kernel buffer back to the blocked Client thread.

### 4. Reference Counting

Binder lifecycle management relies on coordinated reference counting across the driver layer and user layer.

- **Driver layer:** `binder_node` has `internal_strong_refs`, and `binder_ref` has a `strong` count. When the Client obtains a Service reference, the corresponding `binder_ref` is created with `strong` set to 1, and the target `binder_node`'s `internal_strong_refs` increases. When the Client releases the reference, either because the process exits or through explicit operations, the `binder_ref`'s `strong` count decreases. When it reaches 0, the `binder_ref` is destroyed and the target `binder_node`'s `internal_strong_refs` decreases. When both `internal_strong_refs` and `local_weak_refs` on the `binder_node` reach 0, the driver notifies the Server process that the node can be destroyed through the `BR_RELEASE` command.
- **User layer, Native C++:** smart pointers `sp<IBinder>` for strong references and `wp<IBinder>` for weak references manage the lifetime of BpBinder and BBinder. They call methods such as `IBinder::incStrong()` and `decStrong()`, which eventually interact with the driver through IPCThreadState to increase or decrease driver-level reference counts.

This cross-layer reference-counting scheme ensures that a Binder entity is destroyed only when no Client holds a strong reference and the Server itself no longer strongly owns it.

---

---

> The next article will cover "Memory Model and Data Transfer: The Mystery of One Copy."

**"Binder IPC Deep Dive (Beyond AIDL)" Series**

1. Introduction: Android's Neural Network
2. **Inside the Binder Driver: The Kernel-Space Operator** (this article)
3. Memory Model and Data Transfer: The Mystery of One Copy
4. Thread Model: Concurrency, Synchronization, and the Source of ANR
5. Basic AIDL Implementation Example
6. Death Notifications, or DeathRecipient: The Sentinel for Remote Death
7. Troubleshooting Binder with Surgical Precision
