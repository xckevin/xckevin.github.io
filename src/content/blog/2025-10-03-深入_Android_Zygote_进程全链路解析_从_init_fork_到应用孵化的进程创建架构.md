---
title: 深入 Android Zygote 进程全链路解析：从 init fork 到应用孵化的进程创建架构
excerpt: 深入解析 Android Zygote 进程的启动链路、预加载机制与 fork 孵化原理，揭示 COW 机制如何将应用冷启动从秒级降至毫秒级。
publishDate: '2025-10-03'
tags:
- Android
- Zygote
- 性能优化
- 进程管理
- Framework
seo:
  title: 深入 Android Zygote 进程全链路解析：从 init fork 到应用孵化的进程创建架构
  description: 深入解析 Android Zygote 进程全链路：从 init fork 到应用孵化的架构设计，包括预加载机制、Socket 通信、COW 原理及实践避坑指南。
---

做 Android 性能优化时翻过 AOSP 里 Zygote 的源码，一个核心问题是：为什么冷启动一个应用要几百毫秒，而 fork 一个新进程只要几毫秒？答案藏在 Zygote 的设计里——它把"进程创建"这个重操作变成了"进程复制"。

## Zygote 是什么

Zygote 是 Android 系统启动后最早运行的守护进程之一。名字取自生物学中的"受精卵"——所有 Android 应用进程，都由它 fork 而来。

它的价值就体现在**预加载（Preload）**上：启动时把 Framework 层的大量 Java 类和 Native 库一次性加载到内存中。fork 出的子进程通过 Linux 的 **COW（Copy-on-Write）** 机制共享这些只读内存页，省去了每个应用重复加载的开销。这意味着两件事：应用启动时不用从头加载 ART 运行时环境，多个应用共享同一份 Framework 内存，整体内存占用也降下来了。

## 启动链路：init → Zygote

Zygote 由 init 进程负责拉起，定义在 init.rc 中：

```init
# system/core/rootdir/init.rc
service zygote /system/bin/app_process64 -Xzygote /system/bin --zygote --start-system-server
    class main
    priority -20
    user root
    group root readproc reserved_disk
    socket zygote stream 660 root system
```

这里有个细节：`app_process64` 不是专门的 Zygote 可执行文件——它就是 `app_process`，靠 `-Xzygote` 和 `--zygote` 参数切换行为路径。`--start-system-server` 表示 Zygote 启动后会立刻 fork 出 SystemServer 进程。

init 在拉起 Zygote 前，先创建了名为 `zygote` 的 Unix Domain Socket。后续 AMS 就通过这个 Socket 向 Zygote 发送 fork 请求。

Zygote 的入口在 `app_main.cpp` 中：

```cpp
// frameworks/base/cmds/app_process/app_main.cpp
if (zygote) {
    runtime.start("com.android.internal.os.ZygoteInit", args, zygote);
} else if (className) {
    runtime.start("com.android.internal.os.RuntimeInit", args, zygote);
}
```

`zygote` 为 true 走 ZygoteInit 路径，否则走 RuntimeInit——普通的 `app_process` 调用（比如直接执行 Java 类）走的是后者。

## 预加载机制：Zygote 到底加载了什么

进入 Java 层后，`ZygoteInit.main()` 依次执行四个关键步骤：

```java
// frameworks/base/core/java/com/android/internal/os/ZygoteInit.java
public static void main(String[] argv) {
    zygoteServer = new ZygoteServer(isPrimaryZygote);
    preload(bootTimingsTraceLog);                     // 预加载
    if (startSystemServer) {
        forkSystemServer(abiList, zygoteSocketName, zygoteServer);
    }
    zygoteServer.runSelectLoop(abiList);              // 进入等待循环
}
```

`preload()` 做了五件事，每一步都直接影响应用启动速度：

**preloadClasses()**：读取 `/system/etc/preloaded-classes` 文件，用 `Class.forName()` 逐一加载。这个文件通常包含 3000~6000 个类，基本覆盖了 Framework 里的常用类——Activity、View、Fragment 等。

**preloadResources()**：加载系统主题、颜色值、Drawable 等资源，避免每次启动重复解析。

**preloadOpenGL()**：在 Zygote 进程里初始化 EGL 上下文。fork 之后子进程可以直接复用 GPU 驱动状态，图形首帧渲染的那个初始化延迟就被省掉了。

**preloadSharedLibraries()**：加载常用 Native 共享库，包括 libandroid_runtime.so、libicu.so 等。

**preloadTextResources()**：加载国际化文本资源。

至此，Zygote 内存里已经有了完整的 ART 运行时和 Framework 环境，随时可以响应 fork 请求。

## Socket 通信与进程孵化

Zygote 用 select 多路复用监听 Socket：

```java
// frameworks/base/core/java/com/android/internal/os/ZygoteServer.java
void runSelectLoop(String abiList) {
    while (true) {
        Os.poll(pollFDs, -1);
        for (int i = pollFDs.length - 1; i >= 0; --i) {
            if (i == 0) {
                ZygoteConnection newPeer = acceptCommandPeer(abiList);
                peers.add(newPeer);
            } else {
                connection.processOneCommand(this);  // 处理 fork 请求
            }
        }
    }
}
```

AMS 决定启动 Activity、Service 或 BroadcastReceiver 时，通过 `ProcessList` 向 Zygote Socket 发送请求，参数包括进程 uid、gid、nice 名称等。

收到请求后调用 `Zygote.forkAndSpecialize()`：

```java
// frameworks/base/core/java/com/android/internal/os/Zygote.java
public static int forkAndSpecialize(int uid, int gid, int[] gids, 
        int runtimeFlags, int[][] rlimits, int mountExternal, 
        String seInfo, String niceName, ...) {
    ZygoteHooks.preFork();
    int pid = nativeForkAndSpecialize(...);
    ZygoteHooks.postForkCommon();
    return pid;
}
```

`nativeForkAndSpecialize()` 是个 JNI 调用，底层执行 `fork()` 系统调用。fork 返回后分两条路径：

- **父进程（Zygote）**：返回子进程 PID，关闭不用的 fd，继续 select 循环
- **子进程（新应用）**：返回 0，执行权限设置和 seccomp 过滤，最终调用 `RuntimeInit.applicationInit()` 启动应用的 main 线程

"Specialize" 指的就是 fork 后子进程的定制化操作——进程组设置、调度策略调整、SELinux 上下文切换。

## 为什么 fork 比创建进程快

Linux 中 `fork()` 使用 COW 语义：

- fork 时内核不复制父进程物理内存，只复制页表，所有页面标记为只读
- 父进程或子进程尝试写入某个页面时，内核才触发缺页中断，复制该页面
- 预加载的类和资源本身是只读的，子进程直接共享，零拷贝

Zygote 的本质就是把"启动 ART 虚拟机 + 加载 Framework"这个耗时操作，从**每次启动**变成**只执行一次**。实测下来，这个预加载省下的时间在 1-3 秒量级，具体取决于设备和预加载列表大小。

## 实践中的几个坑

**preloaded-classes 列表膨胀**。OEM 厂商为了缩短自家应用启动时间，会往这个文件里塞大量类。加载 10000+ 个类确实加速了特定应用，但 Zygote 自身启动变慢、内存基线也抬高了。AOSP 原生约 4000 个类，建议控制在 6000 以内。

**64 位与 32 位 Zygote 并存**。Android 5.0 后引入 Zygote64 和 Zygote32 两个进程，分别预加载对应运行环境。应用通过 `ro.zygote` 属性选择。混合架构设备上两个 Zygote 各占一份内存，低内存设备上这一点需要留意。

**Socket 队列满导致的 ANR**。Zygote 的 Socket 处理是单线程的，短时间内大量进程请求同时涌入——比如多进程架构的应用启动时同时拉起多个 Provider——请求在队列里排队，极端情况可能触发 ANR。解决思路是减少非必要进程，或者启用 USAP（Unspecialized App Process）池预 fork 进程。

**Fork 耗时 vs 应用启动耗时**。用 systrace 抓过几次启动 trace，fork 本身通常只需 5-50ms，真正耗时的是 fork 之后的 Application 初始化。优化方向应该放在 `Application.onCreate()` 和 ContentProvider 的延迟初始化上，没必要盯着 Zygote 本身。

Zygote 从 Android 1.0 延续至今，核心思路始终没变：共享内存、集中预加载。把这个机制理解透，比无脑往 preloaded-classes 里加类有用得多。
