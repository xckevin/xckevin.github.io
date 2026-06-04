---
title: "Android init and the Boot Process: From BootLoader to Home Screen"
lang: en
translationKey: android-init-boot-process
slug: android-init-boot-process
excerpt: "A deep dive into Android init, from BootLoader to Home Screen, covering init.rc parsing, property triggers, system_server startup, and boot optimization."
publishDate: '2026-03-24'
tags:
- "Android"
- "init"
- "Boot Process"
- "Performance"
- "Source Code"
seo:
  title: "Android init and Boot Process: BootLoader, init.rc, system_server, Launcher"
  description: "Trace Android startup from BootLoader to init.rc, property triggers, system_server, Launcher, and practical boot optimization pitfalls."
  pageType: article
---

## A boot-time investigation that raised a bigger question

During Android system boot optimization, a teammate asked a useful question: from pressing the power button to showing Launcher, after the kernel finishes and before Zygote appears, what is the system actually doing? Most online articles start from Zygote fork and barely mention init.

That leaves out the most important user-space process. init is PID 1, the ancestor of every user-space process. If it dies, the system goes straight to kernel panic. This article starts from init.rc parsing and service orchestration, then connects the full path from BootLoader to Home Screen.

## BootLoader to kernel: the first three seconds

BootLoader has a narrow job: initialize DRAM, load the kernel image, pass kernel command-line arguments, and jump to the kernel entry point.

```c
// kernel/init/main.c - the final step of kernel startup
if (!try_to_run_init_process("/system/bin/init"))
    return 0;
```

After kernel initialization finishes, the kernel tries to execute `/system/bin/init` as PID 1. If that path is wrong, the system panics. On A/B partition devices, the system first loads the ramdisk from the boot partition. That ramdisk contains a minimal init and first-stage init.rc. The system partition is not mounted yet, so everything must be handled from the ramdisk.

## The three phases of init

init has three core jobs: mount file systems, parse init.rc, and start services according to dependencies.

### first_stage_init: running from ramdisk

In this phase, init reads init.rc directly from the ramdisk. The key operations look like this:

```bash
# Most file systems are still tmpfs at this point
mount("tmpfs", "/dev", "tmpfs", MS_NOSUID, "mode=0755")
mount("proc", "/proc", "proc", 0, NULL)
mount("sysfs", "/sys", "sysfs", 0, NULL)
```

First-stage SELinux initialization also happens here. init calls `selinux_initialize` to load `/vendor/etc/selinux/plat_sepolicy.cil`. After Android 8.0, Google moved policy files from binary format to CIL. The reason is that CIL parsing is faster. Compiled policy generation during boot would introduce unacceptable startup latency, so CIL is placed directly into images and parsed once at boot.

The final step of `first_stage_init` is `switch_root`, which moves to the system partition and executes `/system/bin/init` for the second stage.

### Second stage: mount partitions and start ueventd

After entering the main flow:

1. Load the device tree and fstab, then mount partitions such as vendor, product, and odm
2. Create key device nodes under `/dev`
3. Start ueventd to handle kernel uevents

ueventd is Android's device-node manager. When it receives a kernel uevent, it creates the corresponding `/dev/` node and sets permissions. Rules are defined in `/ueventd.rc`:

```text
/dev/binder               0666   root       root
/dev/hwbinder             0666   root       root
/dev/vndbinder            0666   root       root
```

If the binder node is not created, servicemanager cannot start. This dependency chain may not be explicitly declared in init.rc, but Binder communication depends on `/dev/binder`, and servicemanager is the registration entry point for every Binder service.

## init.rc syntax and parsing logic

Android init language defines five kinds of statements: **Action, Command, Service, Option, and Import**.

```text
# Action: execute a set of commands when the trigger fires
on early-init
    start ueventd

on init
    symlink /dev/block/platform/soc /dev/block/bootdevice
    write /proc/sys/kernel/randomize_va_space 2

# Service: define a daemon process
service servicemanager /system/bin/servicemanager
    class core
    user system
    group system readproc
    critical
```

`class core` tells init that this service belongs to the core class. `class_start core` starts all services in that class. `critical` means that if the service exits, the system must reboot. If servicemanager dies, all Binder communication breaks, so the system cannot keep running normally.

init's parser works in **two passes**. The first pass parses all files, including imported child files, and builds Service and Action lists. The second pass triggers Actions in boot-stage order, such as early-init, init, and late-init, then executes the matching Commands.

### Service startup mode

The most common mode is **simple**: fork a child process and execute it without blocking init.

```text
service zygote /system/bin/app_process64 -Xzygote /system/bin \
    --zygote --start-system-server
    class main
    socket zygote stream 660 root system
    onrestart restart audioserver
    onrestart restart cameraserver
    onrestart restart media
```

`onrestart` maintains **soft dependencies** between services. When Zygote restarts, audio, camera, media, and other Binder-dependent services should restart as well. This dependency is manually written into configuration files. init does not infer it automatically. Miss one line, and that service may continue running after a Zygote crash with a broken Binder reference.

## Property system and trigger chain

Property Service is the only communication channel between init and other processes. `on property:key=value` is the most common Action trigger:

```text
on property:sys.boot_completed=1
    bootchart stop
    exec -- /system/bin/bootstat -r boot_complete
```

The property-change-to-Action chain is **single-threaded and serial**. I once hit a bug where an Action triggered by `sys.boot_completed=1` synchronously read a config file from an ext4 partition. That blocked the property service thread for three seconds and delayed later Service startup. The fix was to move config reading into a background Service and keep the Action lightweight.

## system_server and Launcher startup

After init runs `class_start main`, Zygote starts and forks `system_server`. The core startup order inside `system_server` is:

- **ActivityManagerService (AMS)**: manages Activity lifecycle
- **PackageManagerService (PMS)**: scans installed apps
- **WindowManagerService (WMS)**: manages windows and input

PMS must finish first because AMS needs package data before it can launch Launcher. After AMS completes `systemReady()`, it sets `sys.boot_completed=1` and calls `startHomeOnAllDisplays()` to start the default Launcher. Only then does the user see the home screen.

## Two details that are easy to miss

**Service startup timeout.** init has a default five-second timeout for each Service. If the service does not become running before the timeout, init kills and restarts it. Some HAL services initialize slowly. Without an explicit timeout, they can repeatedly crash and restart:

```text
service vendor.camera-provider-2-4 /vendor/bin/hw/android.hardware.camera.provider@2.4-service
    class hal
    timeout_period 30
```

**The blocking behavior of `exec_start`.** `exec_start` synchronously waits for the program to finish. I have seen device init.rc files use `exec_start` during `on boot` to run a shell script that writes register values. That blocked the entire boot stage. A `service + oneshot` asynchronous path is the correct fix.

## Practical boot-optimization advice

When I optimize boot time, I split the path this way:

1. **BootLoader to kernel**: lock CPU frequency and remove unnecessary peripheral initialization
2. **kernel to init**: use `dmesg` to inspect driver load time during kernel initialization
3. **init phase**: defer noncritical blocking work and Services until after `sys.boot_completed=1`
4. **Zygote to Home**: trim the preloaded class list and enable parallel dexopt

The first tools I reach for are bootstat and Perfetto. `bootstat -p` directly prints per-stage timing distribution, making bottlenecks easy to spot. Perfetto traces for the init process show exact timestamps for property changes and Service startup.

When modifying init.rc, first run `adb shell dmesg | grep init` on an AVD and check for service crash-and-restart logs. That is much faster than repeatedly flashing a physical device. Most init.rc dependencies are implicit. Before changing anything, map which services depend on Binder and which require mounted file systems. The config files will not spell that out for you.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [What Is Android Binder? A practical guide to the Binder IPC model](/en/blog/android-binder/)
- [Android cold start: Zygote, ActivityThread, and Systrace diagnosis](/en/blog/android-cold-start-zygote-systrace/)
- [Getting started with Android Perfetto: capture traces, read tracks, and diagnose performance](/en/blog/android-perfetto/)
<!-- /seo-internal-links -->
