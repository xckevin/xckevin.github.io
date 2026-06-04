---
title: "Android Large IPC: From Binder's 1 MB Limit to ASharedMemory"
lang: en
translationKey: android-large-ipc-asharedmemory
slug: android-large-ipc-asharedmemory
excerpt: "A practical guide to large cross-process data transfer on Android, comparing Binder limits, MemoryFile, ASharedMemory, Surface, and ContentProvider."
publishDate: '2026-01-09'
tags:
- "Android"
- "Binder"
- "Inter-Process Communication"
- "Zero Copy"
- "Performance"
seo:
  title: "Android Large IPC: From Binder's 1 MB Limit to ASharedMemory"
  description: "Understand Binder's 1 MB transaction limit and choose between MemoryFile, ASharedMemory, Surface, and ContentProvider for large Android IPC payloads."
  pageType: article
---

Last year, while moving Camera preview frames across processes, I hit a hard failure. A YUV frame from `CameraService` was about 8 MB, and sending it back to the app process through Binder crashed immediately. The log contained only one useful line: `!!! FAILED BINDER TRANSACTION !!!`.

Binder has a hard limit of **1 MB - 8 KB** per transaction, roughly 1016 KB. Anything larger is rejected by the driver. Many real workloads exceed that size: Camera frames, large images, audio streams, and file transfers all need another path.

## The technical root of the Binder limit

This limit exists to prevent memory fragmentation and transaction blocking. It is not a design bug.

For each transaction, the Binder driver allocates a continuous region in kernel space. The total `BINDER_VM_SIZE` is 4 MB by default, and a single transaction is capped at 1 MB. If this were unrestricted, one large transaction could exhaust the whole Binder thread pool, forcing every other process call to wait for the copy to finish.

The solution is essentially one idea: **do not move the payload through Binder driver memory; share the same physical memory between processes instead**.

## MemoryFile: Java-level shared memory

`MemoryFile` was one of the earliest shared memory APIs. It creates a shared memory region through the `ashmem` driver. Conceptually, it is a file descriptor plus `mmap`.

Sender:

```java
MemoryFile memoryFile = new MemoryFile("shared", 10 * 1024 * 1024);
memoryFile.writeBytes(data, 0, 0, data.length);
Method method = MemoryFile.class.getDeclaredMethod("getFileDescriptor");
FileDescriptor fd = (FileDescriptor) method.invoke(memoryFile);
// Pass ParcelFileDescriptor through Binder. Only the fd is sent, about 100 bytes.
```

Receiver:

```java
FileDescriptor fd = parcelFileDescriptor.getFileDescriptor();
FileInputStream fis = new FileInputStream(fd);
byte[] buffer = new byte[size];
fis.read(buffer); // Unfortunately, this becomes another Java heap copy.
```

This approach works, but it has several problems:

1. **`getFileDescriptor` is a hidden API**. It is restricted on Android 10 and later, and reflective access can be blocked at any time.
2. **Reads and writes go through the Java heap**. Data is copied from shared memory to heap memory and then copied again. This is not zero copy.
3. The API is marked `@hide`, and Google has clearly recommended moving away from it.

Before Android 8.0, this was almost the only practical option. Today I only see it when maintaining older projects.

## ASharedMemory: real zero copy through the NDK

Android 8.0 introduced the NDK API in `<android/sharedmem.h>`. It still uses the `ashmem` driver underneath, but the public API is more modern and can support true zero-copy access.

Sender in C++:

```cpp
int fd = ASharedMemory_create("camera_frame", 8 * 1024 * 1024);
uint8_t *ptr = static_cast<uint8_t *>(
    mmap(nullptr, 8 * 1024 * 1024, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));
memcpy(ptr, raw_frame, frame_size); // Write once
// Pass only fd and size through Binder
```

Receiver in C++:

```cpp
uint8_t *ptr = static_cast<uint8_t *>(
    mmap(nullptr, size, PROT_READ, MAP_SHARED, fd, 0));
// ptr points directly to the same physical memory written by the sender
process_frame(ptr, size);
```

Compared with `MemoryFile`:

| Feature | MemoryFile | ASharedMemory |
|------|-----------|---------------|
| API level | Java, hidden | Public NDK API |
| Zero copy | No, heap copy | Yes, direct mmap access |
| Process synchronization | Manual | Manual |
| NDK build | Not required | Requires CMakeLists |

`ASharedMemory` is my preferred option. Once two processes `mmap` the same physical memory, working with it feels like reading and writing the same array, without extra copy overhead. The one thing you must handle yourself is **synchronization**: how do you ensure the receiver is not reading while the sender is still writing? Use `futex` or semaphores. Android does not provide a built-in lock for this memory region.

## ParcelFileDescriptor and ContentProvider: good for file-like data

`ContentProvider.openFile()` returns a `ParcelFileDescriptor`, which is still fundamentally an fd transfer.

```kotlin
// Provider side
override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
    val file = File(cacheDir, uri.lastPathSegment!!)
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
}
```

Binder only transfers the fd descriptor. The data itself moves through a pipe or file IO. This fits **static data** such as a large image or a cache file. It is not a good fit for dynamic streams like Camera frames, because repeatedly opening and closing file descriptors is too expensive.

One easy mistake: when a `ParcelFileDescriptor` crosses processes, Binder duplicates the fd for the receiving side. Both sides manage their own lifecycle. If the sender closes too early, the receiver may end up with a dead fd.

## Surface: designed for graphics streams

For image and video frames, `Surface` plus `SurfaceTexture` is usually the best option. Its shared memory mechanism is built into the `GraphicBuffer` system, and the Android graphics stack itself runs on this model.

```kotlin
// Producer process
val surface = MediaCodec.createInputSurface()
// Pass the surface to the consumer process through Binder. The fd is transferred.
```

```kotlin
// Consumer process
val surfaceTexture = SurfaceTexture(textureId)
val surface = Surface(surfaceTexture)
surfaceTexture.setOnFrameAvailableListener {
    // A frame is ready. Render it with GL.
    surfaceTexture.updateTexImage()
}
```

`Surface` depends heavily on EGL and GLES contexts. For pure data processing, such as transferring binary configuration or audio PCM, using it is excessive.

## Engineering decision guide

After hitting these issues, I settled on a quick decision flow.

**First question: is the data streaming or static?**

- Streaming data, such as Camera frames or audio streams: ask the second question
- Static data, such as a user avatar or cache file: use `ContentProvider + ParcelFileDescriptor`

**Second question: is the data an image or video frame?**

- Yes: use `Surface`, which is naturally tied to the GPU rendering pipeline
- No: ask the third question

**Third question: can the project introduce the NDK?**

- Yes: use `ASharedMemory`, which is zero copy, public, and the best-performing option
- No: fall back to `MemoryFile`, with restricted reflection risk, or application-layer chunking

In real projects, I usually choose `ASharedMemory`, even if it means adding NDK build configuration. After mapping an 8 MB Camera frame with `mmap`, the receiver can do image preprocessing in native code, such as scaling and format conversion, without touching the Java heap. In one case, latency dropped from 30 ms to under 2 ms.

For synchronization, my usual practice is simple: use an atomic flag plus `futex` spin-waiting for small cases, and use a ring buffer for more complex streams. The producer writes one slot, the consumer reads the next slot, and read/write conflicts are naturally decoupled.

There is no silver bullet. Choose the right channel based on the data shape and the performance budget.
