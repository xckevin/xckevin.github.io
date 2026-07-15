---
title: "Isolated-Process Inference for Android On-Device AI"
lang: en
translationKey: android-on-device-ai-isolated-process-aidl
slug: android-on-device-ai-isolated-process-aidl
excerpt: "Use a separate Android process and AIDL to isolate model memory and native crashes while preserving reliable inference lifecycle management."
publishDate: '2026-07-14'
tags:
- "Android"
- "On-device Inference"
- "AIDL"
- "Process Isolation"
seo:
  title: "Android Isolated-Process AI Inference with AIDL"
  description: "Isolate Android on-device AI memory and crashes with a dedicated process and AIDL."
  pageType: article
---

At the end of last year, I connected the end-side LLM in the project. As soon as the 4GB quantitative model was loaded, the main process native heap soared to 3.8GB. Coupled with UI overhead, the OOM killer on low-end machines will kill within 30 seconds. What's even more annoying is that the GPU delegate occasionally crashes natively on certain models, and the main process crashes along with it - the online crash rate is directly increased by 3 percentage points.

Moving the reasoning to a separate process is the only solution. This article records the architectural decisions and pitfalls during the implementation process.

## Three levels of benefits for independent processes

Android's `android:process` attribute allows Service to run in an independent virtual machine instance, with complete memory isolation between processes. For on-device inference, the benefits are not just “more secure” but three specific issues:

**Memory Isolation**: The native memory occupied by model weights does not occupy the main process heap. The main process GC is not affected by inference, and the memory allocation of the UI thread will not trigger Stop-The-World frequently due to heap tightness. According to online measurements, the GC pause time of the main process dropped from 120ms to 8ms.

**Crash Isolation**: The native crash of the GPU delegate only kills the inference process. I mark the crashes of the inference process separately for statistics, and the stability curve of the main process is not disturbed at all.

**Automatic recycling of resources**: After the inference process is killed, the system reclaims all memory - Java heap, native heap, GPU memory references, and there is no need to manually manage the release order of `AHardwareBuffer`. This is much more reliable than relying on coroutine release within the process.

The price is cross-process communication overhead. The measured Binder call delay is within 200μs, which is completely acceptable compared to the 200ms level inference delay.

## AIDL interface design

Reasoning serviceAfter , the main process calls the inference process through AIDL. The interface design follows one principle: **reduce the number of cross-process calls** and complete a complete reasoning in one call.

```java
// IInferenceService.aidl
interface IInferenceService {
    int loadModel(String modelPath, int delegateType);
    float[] infer(int sessionId, in ParcelFileDescriptor inputFd, int inputSize);
    void unloadModel(int sessionId);
}
```

The timing of transferring data into `ParcelFileDescriptor` is critical. Binder's single transfer limit is 1MB, and a 512×512 RGB image is 786KB, which can easily exceed the output limit. Use `ashmem` shared memory to transfer Tensor, Binder only transfers fd descriptor, the data itself does not go through Binder driver, zero copy.

The reason why the output is `float[]` return value instead of shared memory is because the inference output is usually very small - the classification results are dozens of floats, and the first token of the generative model is only a few hundred. It is more than enough for Binder to transfer this data, and there is no need to increase the complexity of shared memory management.

## Implementation of reasoning process

The inference process is hosted by `Service`:

```xml
<service
    android:name=".inference.InferenceService"
    android:process=":inference"
    android:exported="false" />
```

The `:` prefix indicates a private process, and the process name is `package name:inference`, which is clearly identifiable in `adb shell ps` and is convenient for monitoring.

The service uses `ConcurrentHashMap` internally to manage multiple model sessions:

```kotlin
class InferenceService : Service() {
    private val sessions = ConcurrentHashMap<Int, InferenceSession>()

    override fun onBind(intent: Intent): IBinder = binder

    private val binder = object : IInferenceService.Stub() {
        override fun loadModel(modelPath: String, delegateType: Int): Int {
            val id = sessionIdCounter.incrementAndGet()
            sessions[id] = InferenceSession(modelPath, delegateType)
            return id
        }

        override fun infer(sessionId: Int, inputFd: ParcelFileDescriptor?, size: Int): FloatArray {
            val session = sessions[sessionId] ?: throw RemoteException("Session not found")
            return session.run(inputFd, size)
        }

        override fun unloadModel(sessionId: Int) {
            sessions.remove(sessionId)?.close()
        }
    }
}
```

The `Stub` generated by AIDL implements `IBinder`, and all remote calls are executed in the Binder thread pool. When `infer()` runs GPU inference internally, the Binder thread is blocked and other calls are queued. For operations such as inference that occupy exclusive computing resources, this plays a natural serialization role.

## Cross-process life cycle binding

The life cycle of the inference process cannot be independent of the main process - after the main process exits, the inference process must be destroyed accordingly. The way to do this is to use `bindService` instead of `startService`:

```kotlin
class InferenceClient(context: Context) {
    private var service: IInferenceService? = null
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = IInferenceService.Stub.asInterface(binder)
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    init {
        context.bindService(
            Intent(context, InferenceService::class.java),
            connection, Context.BIND_AUTO_CREATE
        )
    }
}
```

`BIND_AUTO_CREATE` ensures that the Service is automatically created with the binding. When the main process is destroyed, all `ServiceConnection` are automatically unbound. After inferring that the process has no other binders, the system recycles the process. No need to manually `stopService`.

`onServiceDisconnected` is triggered when the Binder is disconnected, usually after the inference process crashes. This callback should reset the `service` reference and notify the upper layer. In the actual project, I use `Flow` here to issue state changes, allowing the ViewModel layer to sense the inference process state and perform UI degradation.

## A Binder calling pit

This synchronous call to `infer()` works fine when the inference process is alive, but the Binder driver will throw `DeadObjectException` during a process crash. If the main process is not protected, this exception will be propagated all the way to the UI layer.

```kotlin
suspend fun infer(sessionId: Int, inputFd: ParcelFileDescriptor?, size: Int): FloatArray {
    return withContext(Dispatchers.IO) {
        try {
            service?.infer(sessionId, inputFd, size) ?: throw IllegalStateException("Service disconnected")
        } catch (e: DeadObjectException) {
            service = null
            // bindService reconnects after a disconnection, but the current session is lost.
            throw InferenceException("Inference process died", e)
        }
    }
}
```

After `DeadObjectException`, the `service` reference is no longer valid and must be set to null. An `IllegalStateException` will be triggered the next time it is called, and the upper layer can display the "Inference Service Unavailable" prompt accordingly.

Another point that is easily overlooked: Is `infer()` a oneway or a synchronous call? AIDL is synchronous by default, and the caller thread blocks waiting for the result. If inference takes 2 seconds, the main thread call will be severely stuck or even trigger an ANR. So `infer()` must be placed on a background thread - use `withContext(Dispatchers.IO)` to switch to the IO thread pool to avoid blocking the caller thread.

## Three decisions in practice

**Model preloading timing**: Do not load the model immediately when the inference process starts. `bindService` is asynchronous, and the `onServiceConnected` callback may be delayed by tens of milliseconds. Loading the model is done when `loadModel()` is called, ensuring that the caller knows that the connection is ready. If the app requires inference capabilities when it is started, you can bind it in advance in `Application.onCreate()`, and the model is loaded in parallel with the UI initialization.

**Multi-model management**: One inference process can host multiple model sessions, distinguished by `sessionId`. Each session is loaded and released independently without interfering with each other. However, the GPU delegate may compete for video memory in multi-model scenarios - the GPU memory of low-end machines is usually only 512MB, and loading two models at the same time may cause OOM. The solution is to use the LRU unloading strategy: before loading a new model, if there is insufficient video memory, unload the least recently used session first.

**Binder thread pool size**: AIDL default thread pool 16 threads may not be enough in high concurrency scenarios. However, inference is an operation of exclusive resources, and it is useless no matter how large the thread pool is - the GPU can only run one kernel at a time. In the actual configuration, I kept the default value and relied on `infer()`'s synchronous blocking to achieve natural queuing.

If your on-device AI project still runs inference in the main process, migrating the model to a separate process is one of the optimizations with the highest investment-output ratio. Memory isolation and crash isolation not only improve stability, but also make the iteration and testing of the inference module completely independent of the main project - if the inference process crashes, the online monitoring of the main process will not even be aware of it.
