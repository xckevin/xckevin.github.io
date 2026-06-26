---
title: 深入 Android SystemProperties 属性系统全链路：从 init 进程属性服务到跨进程通知的系统级配置架构
excerpt: 深入剖析 Android 系统属性机制，从物理存储、init 属性服务、共享内存零拷贝读取、到 SELinux 权限卡控与跨进程通知，完整串起 SystemProperties 的全链路实现原理。
publishDate: '2026-06-18'
tags:
- Android
- SystemProperties
- 性能优化
- 底层原理
- 架构设计
seo:
  title: 深入 Android SystemProperties 属性系统全链路：从 init 进程属性服务到跨进程通知的系统级配置架构
  description: 一文讲透 Android SystemProperties 全链路：属性文件物理存储、init 进程属性服务、共享内存零拷贝读取、SELinux 精准卡控，以及跨进程通知机制，附带实战排查思路。
---

做 Android 系统开发的人几乎每天都会跟 `adb shell getprop` 打交道，但 `SystemProperties.get("ro.build.version.sdk")` 为什么能在任意进程里调用、属性到底存在哪里、跨进程同步怎么实现、SELinux 在哪一层卡控——这些问题的答案，不翻源码很难串起来。

我在排查一个系统属性设不进去的 Bug 时，把整条链路走了一遍，发现它比想象中精巧得多。

## 属性文件的物理存储

Android 系统属性不是数据库，而是普通文本文件，分布在各个分区：

```
/system/build.prop          # 系统核心属性，ro. 前缀为主
/vendor/build.prop          # 硬件相关属性
/product/build.prop         # 产品定制属性
/system/etc/prop.default    # 默认属性（Android 10+）
```

文件格式极简，就是 `key=value` 的纯文本，一行一条：

```
ro.build.version.sdk=34
ro.product.brand=google
persist.sys.timezone=Asia/Shanghai
```

启动时，init 进程按顺序读取这些文件，后加载的覆盖先加载的同名属性。但 `ro.` 前缀例外——它在 init 的属性服务里被硬编码为只读，一旦设置就不可更改，这个约束不是文件系统权限决定的，所以即使后加载的文件里有同名 `ro.` 属性，也会被静默忽略。

`persist.*` 前缀的属性会持久化到 `/data/property/` 目录下，每个属性一个文件，文件名就是属性名。重启后 init 重新加载，保证配置不丢失。如果在 `/data/property/` 下看到一堆以属性名命名的文件，不用奇怪，这是正常行为。

## init 进程的属性服务

属性系统的核心是一个跑在 init 进程里的属性服务（Property Service），监听一个 Unix Domain Socket：

```c
// system/core/init/property_service.cpp
static constexpr const char kPropertyServiceSocket[] = "/dev/socket/property_service";
```

启动流程在 init 的 `main()` 中：

```c
// start_property_service() 内部逻辑
void start_property_service() {
    // 1. 创建共享内存区域
    property_area = __system_property_area_init();
    
    // 2. 加载所有属性文件
    load_properties_from_file("/system/etc/prop.default", nullptr);
    load_properties_from_file("/system/build.prop", nullptr);
    load_properties_from_file("/vendor/build.prop", nullptr);
    // ...
    
    // 3. 监听 socket，接收来自其他进程的 set 请求
    listen(kPropertyServiceSocket, 8);
}
```

任何进程想设置系统属性，都要通过这个 socket 向 init 发请求。只有 init 进程有写入权限，其他进程只能读。这种单点写入、多点读取的架构，让属性系统天然避免了并发写入的竞争问题。

## 共享内存：跨进程读取的零拷贝机制

如果每次 `getprop` 都要走 socket 问 init，开销太大。Android 的解法是共享内存。

init 进程在启动属性服务时，通过 `__system_property_area_init()` 创建一块共享内存，映射到自己的地址空间。其他进程通过 `__system_property_area__` 函数映射同一块物理内存，内核保证所有进程看到同一份数据。

共享内存的结构体简化后大致是：

```c
struct prop_area {
    unsigned volatile count;     // 当前属性数量
    unsigned volatile serial;    // 魔法值，用于检测布局变化
    prop_info info[0];           // 变长数组，每个元素是一个属性
};

struct prop_info {
    unsigned serial;             // 属性被修改的次数
    char name[PROP_NAME_MAX];    // 属性名
    char value[PROP_VALUE_MAX];  // 属性值
};
```

读属性时，libc 提供 `__system_property_find()` 直接遍历这块共享内存，不需要任何 IPC 调用。`adb shell getprop` 和 `SystemProperties.get()` 最终都走到同一个函数：

```c
const prop_info* __system_property_find(const char* name) {
    // 直接遍历 prop_area 中的 info 数组
    // 无锁读取，利用 serial 字段做乐观锁检测
    for (unsigned i = 0; i < area->count; i++) {
        if (!strcmp(area->info[i].name, name)) {
            return &area->info[i];
        }
    }
    return nullptr;
}
```

写入路径则完全不同：调用方进程通过 socket 发送 `PROP_MSG_SETPROP` 消息给 init，init 校验后写入共享内存，然后更新 `serial` 字段。其他进程下次读取时通过 `serial` 变化感知到数据更新。

## SELinux 的精准卡控

属性不是谁都能设的。Android 用 SELinux 对属性操作做细粒度控制，核心文件是 `property_contexts`：

```
# system/sepolicy/private/property_contexts
ro.build.version.sdk      u:object_r:build_prop:s0
persist.sys.timezone       u:object_r:timezone_prop:s0
ctl.start                  u:object_r:ctl_start_prop:s0
```

每个属性被映射到一个 SELinux 安全上下文。当进程尝试设置属性时，init 会检查该进程的 SELinux domain 是否有对应 `property_contexts` 的 `set` 权限：

```c
// system/core/init/property_service.cpp
static bool check_mac_perms(const std::string& name, 
                            char* source_ctx) {
    // 调用 selinux_check_access() 查询 AVC (Access Vector Cache)
    bool has_access = (selinux_check_access(
        source_ctx,         // 请求进程的上下文
        property_context,   // 属性对应的上下文
        "property_service", 
        "set",              // 操作类型
        nullptr) == 0);
    return has_access;
}
```

不匹配的直接拒绝，内核日志里会留下 `avc: denied` 记录。我踩过一个坑：自己写的 native 服务想设 `persist.vendor.xxx` 属性，一直失败，查了半天发现是 `property_contexts` 里没声明这个属性的 context，而 fallback 规则默认禁止了非 system 进程的 `set` 操作。

**注意**：`ro.` 前缀的属性在 SELinux 检查之前就已经被 init 拒绝——即使你有 SELinux 权限也改不了，这是两道独立的防线。

## 跨进程通知机制

属性改了之后，依赖方怎么知道？init 进程在写入属性后，会向所有注册了监听的进程发送 `PROP_MSG_CHANGED` 消息。

Java 层的监听入口是 `SystemProperties.addChangeCallback()`，底层通过 `PropertyChangeListener` 注册到 native 层。native 层启动一个监听线程，阻塞在 socket 上等待 init 推送变更通知。

这套通知机制有两个细节：

1. **通知是批量的**。短时间内多次修改同一属性，init 可能合并为一次通知，避免频繁唤醒监听进程。
2. **通知不携带新值**。收到 `PROP_MSG_CHANGED` 后，进程需要自己通过共享内存读取最新值。这样做有两个好处：通知消息体不会因为属性值过大而膨胀；即使你在处理通知时属性又被其他进程改了，读到的也一定是最新值。

## 实践建议

梳理完整条链路后，有几个点值得在日常开发中留意：

**不要滥用 `SystemProperties.set()`**。每次 set 都是一次 IPC 调用，经过 SELinux 校验、socket 传输、init 写入共享内存、序列号更新、通知广播，链路不短。高频读写场景用内存缓存，只在关键时机同步。

**`persist.*` 属性谨慎使用**。每次修改都会触发 `/data/property/` 下的文件写入，频繁修改会带来磁盘 I/O 开销。如果只是运行时状态，用普通属性加开机重启即可。

**排查属性问题时，三件套走一遍**：`getprop | grep xxx` 看当前值、`dmesg | grep avc` 看 SELinux 拦截、`ls -la /data/property/` 看持久化文件。绝大多数问题在这三步里就能定位。
