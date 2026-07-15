---
title: 深入 Android 端侧 AI 的独立进程推理架构：从进程隔离到 AIDL 通信的稳定性保障
slug: android-on-device-ai-isolated-process-aidl
translationKey: android-on-device-ai-isolated-process-aidl
excerpt: 将端侧 LLM 推理迁移到独立进程，通过内存隔离解决 OOM 问题，通过崩溃隔离保护主进程稳定性。本文详细记录了 AIDL 接口设计、跨进程生命周期绑定、Binder 通信陷阱及多模型管理等实战经验。
publishDate: '2026-07-14'
tags:
- Android
- 端侧AI
- 进程隔离
- AIDL
- 性能优化
seo:
  title: 深入 Android 端侧 AI 的独立进程推理架构：从进程隔离到 AIDL 通信的稳定性保障
  description: 将端侧 LLM 推理迁移到独立进程，通过内存隔离与崩溃隔离保障主进程稳定性，涵盖 AIDL 接口设计、跨进程生命周期绑定及 Binder 通信实战经验。
---

去年底在项目里接入端侧 LLM，4GB 量化模型一加载，主进程 native heap 飙到 3.8GB。加上 UI 开销，低端机上 OOM killer 30 秒内必杀。更烦的是，GPU delegate 在个别机型偶发 native crash，主进程跟着一起崩——线上 crash 率直接被拉高 3 个百分点。

把推理挪到独立进程是唯一解。这篇文章记录落地过程中的架构决策和踩坑。

## 独立进程的三层收益

Android 的 `android:process` 属性让 Service 运行在独立虚拟机实例中，进程间内存完全隔离。对端侧推理来说，收益不是"更安全"这种虚话，是三个具体问题：

**内存隔离**：模型权重占用的 native 内存不挤占主进程 heap。主进程 GC 不受推理影响，UI 线程的内存分配不会因为堆紧张而频繁触发 Stop-The-World。线上测得主进程 GC 暂停时间从 120ms 降到 8ms。

**崩溃隔离**：GPU delegate 的 native crash 只 kill 推理进程。我把推理进程的崩溃单独打标统计，主进程稳定性曲线完全不受干扰。

**资源自动回收**：推理进程被杀后，系统回收全部内存——Java heap、native heap、GPU 显存引用，不需要手动管理 `AHardwareBuffer` 的释放顺序。这比进程内靠协程编排释放可靠得多。

代价是跨进程通信开销。实测 Binder 调用延迟在 200μs 以内，相比 200ms 级别的推理时延，完全可以接受。

## AIDL 接口设计

推理服务化后，主进程通过 AIDL 调用推理进程。接口设计遵循一个原则：**减少跨进程调用次数**，一次调用完成一次完整推理。

```java
// IInferenceService.aidl
interface IInferenceService {
    int loadModel(String modelPath, int delegateType);
    float[] infer(int sessionId, in ParcelFileDescriptor inputFd, int inputSize);
    void unloadModel(int sessionId);
}
```

`ParcelFileDescriptor` 传输入数据的时机很关键。Binder 单次传输上限 1MB，512×512 的 RGB 图就 786KB，加上输出容易超。用 `ashmem` 共享内存传 Tensor，Binder 只传 fd 描述符，数据本身不经过 Binder 驱动，零拷贝。

输出走 `float[]` 返回值而非共享内存，是因为推理输出通常很小——分类结果几十个 float，生成式模型的首 token 也就几百个。Binder 传这点数据绰绰有余，没必要增加共享内存的管理复杂度。

## 推理进程的实现

推理进程用 `Service` 承载：

```xml
<service
    android:name=".inference.InferenceService"
    android:process=":inference"
    android:exported="false" />
```

`:` 前缀表示私有进程，进程名是 `包名:inference`，`adb shell ps` 里清晰可辨，方便监控。

服务内部用 `ConcurrentHashMap` 管理多个模型 session：

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

AIDL 生成的 `Stub` 实现了 `IBinder`，所有远程调用在 Binder 线程池中执行。`infer()` 内部跑 GPU 推理时，Binder 线程被阻塞，其他调用排队等待。对于推理这种独占计算资源的操作，这反而起到了天然串行化的作用。

## 跨进程生命周期绑定

推理进程的生命周期不能独立于主进程——主进程退出后，推理进程必须跟着销毁。做法是用 `bindService` 而非 `startService`：

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

`BIND_AUTO_CREATE` 确保 Service 随绑定自动创建。当主进程销毁时，所有 `ServiceConnection` 自动解绑，推理进程没有其他绑定者后，系统回收该进程。不需要手动 `stopService`。

`onServiceDisconnected` 在 Binder 断开时触发，通常是推理进程 crash 后。这个回调里应该重置 `service` 引用并通知上层。实际项目中我在这里用 `Flow` 发出状态变化，让 ViewModel 层感知推理进程状态并做 UI 降级。

## 一个 Binder 调用的坑

`infer()` 这种同步调用在推理进程存活时工作正常，但进程 crash 期间 Binder 驱动会抛出 `DeadObjectException`。如果主进程不加保护，这个异常会一路传到 UI 层。

```kotlin
suspend fun infer(sessionId: Int, inputFd: ParcelFileDescriptor?, size: Int): FloatArray {
    return withContext(Dispatchers.IO) {
        try {
            service?.infer(sessionId, inputFd, size) ?: throw IllegalStateException("Service disconnected")
        } catch (e: DeadObjectException) {
            service = null
            // 绑定断开后 bindService 会触发重连，但当前 session 已丢失
            throw InferenceException("Inference process died", e)
        }
    }
}
```

`DeadObjectException` 之后，`service` 引用已经无效，必须置 null。下次调用时会触发 `IllegalStateException`，上层可以据此展示"推理服务不可用"的提示。

另一个容易忽略的点：`infer()` 是 oneway 还是同步调用？AIDL 默认是同步的，调用方线程阻塞等待结果。如果推理耗时 2 秒，主线程调用会严重卡顿甚至触发 ANR。所以 `infer()` 必须放在后台线程——用 `withContext(Dispatchers.IO)` 切到 IO 线程池，避免阻塞调用方线程。

## 实践中的三个决策

**模型预加载时机**：推理进程启动时不要立即加载模型。`bindService` 是异步的，`onServiceConnected` 回调可能延迟几十毫秒。加载模型放在 `loadModel()` 调用时做，确保调用方知道连接已就绪。如果 App 启动就需要推理能力，可以在 `Application.onCreate()` 中提前 bind，模型加载与 UI 初始化并行。

**多模型管理**：一个推理进程可以承载多个模型 session，用 `sessionId` 区分。每个 session 独立加载和释放，互不干扰。但 GPU delegate 在多模型场景下可能争抢显存——低端机的 GPU 显存通常只有 512MB，两个模型同时加载可能 OOM。解决方案是用 LRU 卸载策略：加载新模型前，如果显存不足，先卸载最近最少使用的 session。

**Binder 线程池大小**：AIDL 默认线程池 16 个线程，高并发场景下可能不够。但推理是独占资源的操作，线程池再大也没用——GPU 一次只能跑一个 kernel。实际配置中我保持默认值，靠 `infer()` 的同步阻塞实现天然排队。

如果你的端侧 AI 项目还在主进程里跑推理，把模型迁移到独立进程是投入产出比最高的优化之一。内存隔离和崩溃隔离不光提升稳定性，还让推理模块的迭代和测试完全独立于主工程——推理进程 crash 了，主进程的线上监控甚至感知不到。
