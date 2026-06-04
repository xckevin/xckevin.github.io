---
title: "Binder IPC Deep Dive (Beyond AIDL) (3): Memory and Data Transfer"
lang: en
translationKey: binder-ipc-beyond-aidl-part3
slug: binder-ipc-beyond-aidl-part3
excerpt: "Part 3 of the Binder IPC deep dive series, explaining mmap, Binder's one-copy data path, Parcel, Parcelable, and large-transaction handling."
publishDate: '2024-04-21'
displayInBlog: false
tags:
- "Android"
- "Binder"
- "IPC"
- "AIDL"
series:
  name: "Binder IPC Deep Dive (Beyond AIDL)"
  part: 3
  total: 7
seo:
  title: "Android Binder Memory Model: mmap, Parcel, and One Copy"
  description: "Understand Binder's mmap-based one-copy memory model, Parcel and Parcelable mechanics, and practical fixes for TransactionTooLargeException."
  pageType: article
---
> This is part 3 of 7 in the "Binder IPC Deep Dive (Beyond AIDL)" series. The previous article covered "Inside the Binder Driver: The Kernel-Space Operator."

## 3. Memory Model and Data Transfer: The Mystery of One Copy

Binder is often described as a "zero-copy" mechanism, but that is not completely accurate. Compared with traditional IPC mechanisms such as pipes or sockets, which require two data copies, user space to kernel space and kernel space to user space, Binder uses mmap to implement **one copy**.

### 1. mmap Memory Mapping

- When a process first opens `/dev/binder` and initializes Binder, usually through the ProcessState singleton, it calls `mmap()` to map a region of physical memory into both its own virtual address space and the kernel's virtual address space.
- This shared memory is managed by the Binder driver and stores `binder_buffer` objects, meaning Parcel data in transit.
- When the Client sends data, the driver copies the Client's user-space Parcel data into the `binder_buffer` inside the kernel-mapped region with `copy_from_user`.
- Because the Server process has already mapped the same physical memory into its own virtual address space through `mmap()` during initialization, the Server can **directly access** the data in `binder_buffer` without another `copy_to_user`.

Across the whole process, data is copied only once, from Client user space into the kernel-mapped region through `copy_from_user`. The receiver reads the shared memory region through its mmap mapping, avoiding the second copy from a kernel buffer into the receiver's user buffer. That is the core of Binder's "one-copy" design.

### ASCII Diagram 3: Binder "One-Copy" Memory Mapping

```plain
+-----------------------------------+      +---------------------------------+
| Client Process Virtual Address Spc|      | Server Process Virtual Address Spc|
|                                   |      |                                 |
|   +-------------+                 |      |                 +-------------+   |
|   | Parcel Data |                 |      |                 | Parcel Data |   |
|   +-------------+                 |      |                 +-------------+   |
|         |                         |      |                         ^         |
|         | 1. copy_from_user       |      |      3. copy_to_user    |         |
|         V                         |      | (or direct access)      |         |
|   +-------------------------+     |      |     +-------------------------+   |
|   | Kernel Mapped Region    | <---mmap------> | Kernel Mapped Region    |   |
|   | (Binder Buffer Space)   |     |      |     | (Binder Buffer Space)   |   |
|   +-------------------------+     |      |     +-------------------------+   |
|                                   |      |                                 |
+-----------------------------------+      +---------------------------------+
                ^                                     ^
                | mmap                                | mmap
                |                                     |
+---------------V-------------------------------------V----------------------+
|                         Kernel Virtual Address Space                        |
|                                                                            |
|                      +-------------------------+                           |
|                      | Kernel Mapped Region    |                           |
|                      | (Binder Buffer Space)   |                           |
|                      +-----------^-------------+                           |
|                                  |                                         |
|                                  | Maps to                                 |
|                                  V                                         |
|                      +-------------------------+                           |
|                      |   Physical Memory       |                           |
|                      +-------------------------+                           |
|                                                                            |
+----------------------------------------------------------------------------+

Data Flow: Client Private -> Kernel Mapped (1 Copy) -> Server Mapped -> Server Private
```

**Diagram notes:**

1. Data is copied from Client private memory into the kernel-mapped shared memory region, the first copy.
2. Through the mapping, the Server can directly access that shared memory, or copy its contents into its own private memory if it needs to deserialize into objects.
3. The key point is that Binder avoids the second copy from Kernel Buffer to Server Private Buffer.

### 2. Parcel Objects and a Parcelable Example

Parcel is the carrier for data transfer. Custom objects need to implement the Parcelable interface.

```java
// MyData.java - a simple parcelable object
import android.os.Parcel;
import android.os.Parcelable;

public class MyData implements Parcelable {
    private int intValue;
    private String stringValue;

    public MyData(int intValue, String stringValue) {
        this.intValue = intValue;
        this.stringValue = stringValue;
    }

    // Getters...
    public int getIntValue() { return intValue; }
    public String getStringValue() { return stringValue; }

    // --- Parcelable Implementation ---

    protected MyData(Parcel in) {
        intValue = in.readInt();
        stringValue = in.readString();
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
        dest.writeInt(intValue);
        dest.writeString(stringValue);
    }

    @Override
    public int describeContents() {
        return 0; // Usually 0 is enough
    }

    public static final Creator<MyData> CREATOR = new Creator<MyData>() {
        @Override
        public MyData createFromParcel(Parcel in) {
            return new MyData(in);
        }

        @Override
        public MyData[] newArray(int size) {
            return new MyData[size];
        }
    };
}
```

### 3. Handling TransactionTooLargeException, Conceptually

The concrete strategies vary, but the basic idea is to avoid sending a large payload in one transaction.

```java
// Client Side (Conceptual)
import android.os.RemoteException;
import android.util.Log;
import java.util.List;
// Assuming LargeObject is your large data class and IMyAidlInterface has:
// oneway void sendDataChunk(in List<LargeObject> chunk, boolean isFirst, boolean isLast);

IMyAidlInterface myService;
List<LargeObject> dataToSend = ...; // Assume this is a very large list

final int CHUNK_SIZE = 100; // Define the chunk size
int offset = 0;
try {
    boolean isFirst = true;
    while (offset < dataToSend.size()) {
        int end = Math.min(offset + CHUNK_SIZE, dataToSend.size());
        List<LargeObject> chunk = dataToSend.subList(offset, end);
        boolean isLast = (end == dataToSend.size());
        // Assume there is an AIDL method that supports chunked transfer
        myService.sendDataChunk(chunk, isFirst, isLast);
        offset = end;
        isFirst = false; // Subsequent chunks are not the first
    }
} catch (RemoteException e) {
    // Handle exceptions, especially TransactionTooLargeException, even though chunking makes it less likely
    Log.e("BinderClient", "Failed to send data chunks", e);
    // You may need retry or rollback logic
    if (e instanceof android.os.TransactionTooLargeException) {
        Log.e("BinderClient", "TransactionTooLargeException even with chunking! Chunk size might still be too big or overhead is large.");
    }
}
```

**Note:** the service side needs to implement `sendDataChunk` accordingly so it can receive and assemble chunks. Shared memory is usually a better approach.

### 4. TransactionTooLargeException

The shared memory size for a Binder transaction is limited, usually around 1 MB minus overhead. If the data being transferred, meaning the serialized Parcel size, exceeds that limit, Android throws `TransactionTooLargeException`. This is an important design constraint of Binder.

**Mitigation strategies:**

- **Chunking:** split large data into smaller chunks and transfer them through multiple Binder calls. The protocol layer must define how chunks are assembled.
- **Shared memory, such as SharedMemory, MemoryFile, or ashmem:** create an anonymous shared-memory region, write the large data into it, then pass the shared-memory file descriptor, or FD, through Binder. The receiver maps the shared memory through the FD and reads the data. This is the recommended approach for large files.
- **FileDescriptor:** pass an FD that points directly to a file and let the receiver read it.
- **Optimize the data structure:** avoid transmitting unnecessary data and use a more compact serialization format.
- **Redesign the interface:** reconsider whether that much data really needs to be transferred in one call.

Android specialists need to weigh these strategies for each scenario, considering implementation complexity, performance overhead, and ease of use.

---

---

> The next article will cover "Thread Model: Concurrency, Synchronization, and the Source of ANR."

**"Binder IPC Deep Dive (Beyond AIDL)" Series**

1. Introduction: Android's Neural Network
2. Inside the Binder Driver: The Kernel-Space Operator
3. **Memory Model and Data Transfer: The Mystery of One Copy** (this article)
4. Thread Model: Concurrency, Synchronization, and the Source of ANR
5. Basic AIDL Implementation Example
6. Death Notifications, or DeathRecipient: The Sentinel for Remote Death
7. Troubleshooting Binder with Surgical Precision
