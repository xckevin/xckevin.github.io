---
title: 深入 Android init 进程与系统启动全链路：从 BootLoader 到 Home Screen 的启动流程架构解析
excerpt: 深度解析 Android init 进程从 BootLoader 到 Home Screen 的完整启动链路，涵盖 init.rc 解析逻辑、属性系统触发链、system_server 启动顺序，以及启动优化实战经验与踩坑记录。
publishDate: '2026-06-02'
tags:
- Android
- init进程
- 系统启动
- 性能优化
- 源码分析
seo:
  title: 深入 Android init 进程与系统启动全链路：从 BootLoader 到 Home Screen 的启动流程架构解析
  description: 深度解析 Android init 进程启动全链路：从 BootLoader 到内核、init.rc 语法与属性系统、system_server 及 Launcher 启动，附带启动优化实战经验与常见踩坑记录。
---

## 一次启动耗时排查引出的问题

做 Android 系统启动优化时，团队有个同事问了一个问题：从按下电源键到 Launcher 显示，内核启动完了之后、Zygote 出现之前，系统到底在干什么？翻了翻网上的资料，大部分文章从 Zygote fork 开始讲，init 阶段几乎被一笔带过。

这就离谱了。init 是 PID 1，是所有用户态进程的祖先，它挂了系统直接 kernel panic。这篇文章从 init.rc 的解析和服务编排切入，把 BootLoader 到 Home Screen 的完整链路串起来。

## BootLoader 到内核：前 3 秒

BootLoader 的活很单一：初始化 DRAM、加载内核镜像、传内核命令行参数，然后跳转到内核入口。

```c
// kernel/init/main.c — 内核启动的最后一步
if (!try_to_run_init_process("/system/bin/init"))
    return 0;
```

内核初始化完成后尝试执行 `/system/bin/init` 作为 PID 1。路径不对就走 panic。A/B 分区设备会先从 boot 分区加载 ramdisk，里面放着精简版 init 和第一阶段 init.rc——system 分区还没挂载，一切都得自力更生。

## init 进程的三个阶段

init 的核心任务只有三个：挂载文件系统、解析 init.rc、按依赖编排服务启动。

### first_stage_init：跑在 ramdisk 上

这一阶段 init 直接读取 ramdisk 里的 init.rc，关键动作如下：

```bash
# 大部分文件系统还是 tmpfs
mount("tmpfs", "/dev", "tmpfs", MS_NOSUID, "mode=0755")
mount("proc", "/proc", "proc", 0, NULL)
mount("sysfs", "/sys", "sysfs", 0, NULL)
```

第一阶段的 SELinux 初始化也在这一步完成——调用 `selinux_initialize` 加载 `/vendor/etc/selinux/plat_sepolicy.cil`。Google 在 Android 8.0 之后把策略文件从二进制换成了 CIL 格式，原因是 CIL 解析更快。编译型策略文件（sepolicy 二进制）在构建时引入的时延对系统启动来说是不能接受的，CIL 直接打在镜像里，启动时一次性解析完事。

first_stage_init 的最后一步是 `switch_root` 切到 system 分区，执行 `/system/bin/init` 进入第二阶段。

### 第二阶段：挂载分区、启动 ueventd

进入 main 流程后：

1. 加载设备树和 fstab，挂载 vendor、product、odm 等分区
2. 创建 /dev 下关键设备节点
3. 启动 ueventd 处理内核 uevent

ueventd 是 Android 的 device node 管理器，收到内核 uevent 时创建对应的 `/dev/` 节点并设权限。`/ueventd.rc` 里定义了规则：

```
/dev/binder               0666   root       root
/dev/hwbinder             0666   root       root
/dev/vndbinder            0666   root       root
```

binder 节点不创建，servicemanager 起不来——这条依赖链在 init.rc 里未必显式声明，但 Binder 通信离不开 `/dev/binder`，servicemanager 又是所有 Binder 服务注册的入口。

## init.rc 语法与解析逻辑

Android init 语言定义了 5 种语句：**Action、Command、Service、Option、Import**。

```init
# Action：在 trigger 触发时执行一组命令
on early-init
    start ueventd

on init
    symlink /dev/block/platform/soc /dev/block/bootdevice
    write /proc/sys/kernel/randomize_va_space 2

# Service：定义一个守护进程
service servicemanager /system/bin/servicemanager
    class core
    user system
    group system readproc
    critical
```

`class core` 告诉 init 这个服务属于 core 类别，`class_start core` 会批量启动同类服务。`critical` 标记的含义是：服务退出后系统必须重启——servicemanager 挂了，Binder 通信全断，不重启也没法用了。

init 的解析器走**两遍处理**：第一遍解析所有文件（包括 import 的子文件），建立 Service 和 Action 列表；第二遍按 boot 阶段（early-init → init → late-init）依次触发 Action，执行对应 Commands。

### Service 的启动模式

四种模式里最常用的是 **simple**——fork 子进程执行，不阻塞 init：

```init
service zygote /system/bin/app_process64 -Xzygote /system/bin \
    --zygote --start-system-server
    class main
    socket zygote stream 660 root system
    onrestart restart audioserver
    onrestart restart cameraserver
    onrestart restart media
```

`onrestart` 维护的是服务间的**软依赖**：Zygote 重启时，audio、camera、media 这些依赖 Binder 的服务也得跟着重启。这种依赖关系是人工写在配置文件里的，init 不做自动推导——漏写一条，那个服务就会在 Zygote crash 后带着坏的 Binder 引用继续跑。

## 属性系统与触发链

属性服务（Property Service）是 init 与其他进程通信的唯一管道。`on property:key=value` 是 Action 最常用的触发条件：

```init
on property:sys.boot_completed=1
    bootchart stop
    exec -- /system/bin/bootstat -r boot_complete
```

属性变化 → 触发 Action 这条链路是**单线程串行**的。我踩过一个坑：在 `sys.boot_completed=1` 的 Action 里同步读 ext4 分区的配置文件，属性服务线程阻塞了 3 秒，连锁推迟了后面 Service 的启动。修复方案是把读配置放到后台 Service 里异步执行，Action 里只做轻量操作。

## system_server 与 Launcher 启动

init 执行 `class_start main` 后，Zygote 启动，fork 出 system_server。system_server 的核心启动顺序：

- **ActivityManagerService（AMS）** → 管理 Activity 生命周期
- **PackageManagerService（PMS）** → 扫描已安装应用
- **WindowManagerService（WMS）** → 管理窗口和输入

PMS 必须先完成，因为 AMS 需要查询已安装应用才能启动 Launcher。AMS 的 `systemReady()` 调用完成后设置属性 `sys.boot_completed=1`，然后执行 `startHomeOnAllDisplays()` 拉起默认 Launcher——这时用户才看到桌面。

## 两个容易遗漏的细节

**服务启动超时。** init 对每个 Service 有默认 5 秒超时，超时未变为 running 状态就会被 kill 并重启。某些 HAL 服务初始化慢，不显式设置超时就会出现反复崩溃重启的情况：

```init
service vendor.camera-provider-2-4 /vendor/bin/hw/android.hardware.camera.provider@2.4-service
    class hal
    timeout_period 30
```

**exec_start 的阻塞特性。** `exec_start` 会同步等待程序执行结束。我见过某些设备的 init.rc 在 `on boot` 阶段用 exec_start 跑 shell 脚本去写寄存器值，这个操作直接卡住了整个 boot 阶段。换成 `service + oneshot` 异步执行才是正解。

## 启动优化实战建议

我做启动优化时的拆段思路：

1. **BootLoader 到 kernel**：锁 CPU 频率、砍掉多余外设初始化
2. **kernel 到 init**：用 `dmesg` 看内核初始化阶段的驱动加载耗时
3. **init 阶段**：把非关键的阻塞操作和 Service 推迟到 `sys.boot_completed=1` 之后
4. **Zygote 到 Home**：裁剪预加载类清单、开启并行 dexopt

分析工具首选 bootstat 和 Perfetto。`bootstat -p` 直接输出各阶段耗时分布，一眼定位瓶颈。Perfetto 抓 init 进程的 trace 能看到属性设置和 Service 启动的精确时间戳。

改 init.rc 配置时建议先在 AVD 上跑 `adb shell dmesg | grep init`，检查有没有 service 崩溃重启日志，比在真机上反复刷机高效得多。init.rc 的依赖关系大多是隐式的，改之前务必理清楚哪些服务依赖 binder、哪些服务要求文件系统已挂载——这些都不会写在配置文件里。
