---
slug: android-selinux-sepolicy-neverallow
translationKey: android-selinux-sepolicy-neverallow
title: 深入 Android SELinux 安全机制全链路：从 sepolicy 编译到 neverallow 审计的系统级访问控制架构
excerpt: 从一条 avc 拒绝日志切入，系统梳理 Android SELinux 的 sepolicy 编译链路、域转换、contexts 映射与 neverallow 审计，并给出 native 服务排障与落地建议。
publishDate: '2026-08-18'
tags:
- Android
- SELinux
- sepolicy
- 安全机制
- 系统架构
seo:
  title: 深入 Android SELinux 安全机制全链路：从 sepolicy 编译到 neverallow 审计的系统级访问控制架构
  description: 深入 Android SELinux 全链路：从 sepolicy 编译、域转换与 contexts 映射，到 neverallow 编译期审计，再到 avc 拒绝日志的排障方法与实践建议。
---

适配新平台时，我给系统加了一个 native 服务，进程刚拉起来就挂。logcat 里只有一行：

```text
avc: denied { read } for name="vendor_config.json"
scontext=u:r:my_service:s0
tcontext=u:object_r:vendor_configs_file:s0
tclass=file permissive=0
```

这条 avc 日志是 SELinux 的访问拒绝记录，也是 Android 系统级访问控制里最常见的排障入口。要解决它，得把 sepolicy 编译链路、域转换和 neverallow 审计串起来看。

## SELinux 在 Android 里管什么

Android 的权限模型分两层：自主访问控制（DAC）和强制访问控制（MAC）。DAC 是传统 Unix 权限，进程以 UID 为单位读写文件，权限由文件属主决定。MAC 由 SELinux 提供，系统策略统一约束规则，进程即使拿到 root，也突破不了策略允许的范围。

Android 4.3 引入 SELinux，5.0 起全面开启 enforcing。系统给每个进程、文件、property、binder service 都打上安全上下文（Security Context），格式统一为 `user:role:type:level`，其中 type 是访问控制的核心。

一个上下文对应关系：

```text
u:r:system_server:s0          # system_server 进程域
u:object_r:system_file:s0      # /system 下文件的类型
u:object_r:vendor_file:s0      # /vendor 下文件的类型
```

SELinux 策略不直接写「谁允许读什么」，而是写「哪个 domain 对哪个 type 的哪些 class 拥有哪些权限」。system_server 是 domain，system_file 是 type，class 是 file，权限是 read。

## sepolicy 编译链路

Android 的策略源码位于 `system/sepolicy`，平台和厂商可以各自扩展。一份 `.te` 文件长这样：

```te
type my_service, domain;
type my_service_exec, exec_type, file_type, vendor_file_type;

init_daemon_domain(my_service)

allow my_service vendor_configs_file:file { read getattr open };
```

`.te` 文件不能直接上机，要经过宏展开、CIL 生成、编译成二进制 policy，再打包进分区。编译入口是 `system/sepolicy/Android.bp`，关键产物是 `sepolicy` 和 `vendor_sepolicy.cil`。

编译流程大致是：

```text
.te 源文件
  → m4 宏展开
  → 生成 CIL（Common Intermediate Language）
  → secilc 编译成二进制 policy
  → 打包进 system/vendor 分区
```

### 为什么中间有 CIL

Android 8.0 引入 Treble 后，system 和 vendor 策略需要独立编译、运行时合并。平台先发布自己的 `plat_sepolicy.cil`，厂商策略以 `vendor_sepolicy.cil` 形式叠加，避免两边互相改源码。版本兼容规则 compat 也在这层处理。

编译时还有一个容易踩的点：宏不是简单文本替换。`init_daemon_domain(my_service)` 会展开成域转换规则、exec 访问、tmpfs 目录创建等一整组 allow 规则。自己用裸 `allow` 拼，很容易漏掉 `open`、`getattr`、`map` 这类基础权限。

## 域转换与访问规则

init 拉起 my_service 时，光有 allow 还不够，需要域转换（Domain Transition）。转换要满足四个条件：init 对 my_service_exec 有 execute 权限、my_service 对 exec 文件有 entrypoint 权限、策略声明了 type_transition、init 对 my_service 进程类型有 transition 权限。

`init_daemon_domain` 宏把这几件事一起做了。展开后核心规则等价于：

```te
allow init my_service_exec:file { execute getattr open map read };
allow my_service my_service_exec:file entrypoint;
allow init my_service:process transition;
type_transition init my_service_exec:process my_service;
```

type_transition 只是声明「允许转换」，真正的 allow 规则才是授权。很多新人在这里误解：写了 type_transition 不代表进程会自动切 domain，还必须配 allow。

### 三类 contexts 映射

除了文件，Android 里常见的访问对象还有 property、binder service 和目录。分别由 `property_contexts`、`service_contexts`、`file_contexts` 建立「对象名到 type」的映射。规则写错往往不是 allow 的问题，而是 contexts 没标对。

一个 vendor 服务注册 binder 的完整片段：

```te
type my_service, domain;
type my_service_exec, exec_type, file_type, vendor_file_type;

init_daemon_domain(my_service)
binder_use(my_service)
add_service(my_service, my_service)
```

`binder_use` 宏授予 `/dev/binder` 的访问权限，`add_service` 把服务名写进 service_contexts 并允许注册。我更倾向于直接复用宏，不手写 binder 的 allow 规则，class 集合多，手写容易漏。

## neverallow：编译期的安全红线

neverallow 是 SELinux 策略里的反向断言：声明「任何情况下不允许某 domain 访问某 type」。它不产生运行时规则，只在编译期校验。

Android 平台策略里有一组红线，比如：

```te
neverallow { domain -su } { file_type -system_file -vendor_file }:file write;
```

这条规则禁止除 su 外的所有 domain 写除 system_file、vendor_file 外的文件类型。你要开放某个文件访问，必须让目标文件属于白名单类型，否则编译直接报错。

我踩过的坑：给 vendor 进程开放 `system_data_file` 的读权限，编译报 neverallow violated。当时的思路是「改 allow 就行」，结果平台红线根本不允许。正确做法是让 system 侧提供 binder 接口，或者把数据放到双方约定的类型下。

编译报错长这样：

```text
libsepol.report_failure: neverallow on line XXX violated by allow my_service system_data_file:file { read }
```

遇到这种错误，别急着找 sepolicy-ignore 忽略。Android 12 之后很多 neverallow 是从安全漏洞模型里抽象出来的，忽略等于把 CVE 风险引回自己项目。

## 排障链路与落地建议

回到开头那条日志。排障顺序我一般固定成四步：

1. 确认 enforcing 状态：`getenforce`。permissive 只用来定位问题，不能作为最终方案
2. 抓完整 avc 日志：`adb logcat -b all | grep avc` 或 `dmesg | grep avc`
3. 判断是规则缺失还是 contexts 标错
4. 用 `audit2allow` 生成候选规则，人工判断后写入 `.te`

audit2allow 的用法：

```bash
adb shell dmesg | grep avc | audit2allow -p out/target/product/xxx/sepolicy
```

它输出的是 allow 建议，不是最终答案。机器只会把「被拒绝的权限」转成 allow，分不清你该开放 file 还是改用 binder。真实项目里我遇到过 audit2allow 建议开放 `:file write`，但业务上只需要读一个配置，开放写权限属于过度授权。

更可靠的做法是看 avc 里的 `scontext` 和 `tcontext`，问自己两个问题：源 domain 是否合理？目标 type 是否标错？很多时候该改的是 file_contexts，而不是给 domain 加 allow。

给 Android 加 native 服务或 daemon 时，我现在的固定流程：

- 先定义 type 和 domain，复用 `init_daemon_domain`、`binder_use` 等宏，不裸写 allow
- 把文件、property、binder 的 contexts 一次配齐，避免「跑起来再补规则」的循环
- 编译期认真看 neverallow 报错，把平台红线当作安全边界而不是障碍

SELinux 策略写起来繁琐，但它把「谁能碰什么」从代码里抽出来，变成可编译、可审计、可版本化的声明。理解这条链路后，avc 日志不再是一堆晦涩字符串，而是系统在明确告诉你边界在哪里。
