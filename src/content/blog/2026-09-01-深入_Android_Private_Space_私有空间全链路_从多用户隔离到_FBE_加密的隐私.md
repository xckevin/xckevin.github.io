---
slug: android-private-space-fbe-architecture
translationKey: android-private-space-fbe-architecture
title: 深入 Android Private Space 私有空间全链路：从多用户隔离到 FBE 加密的隐私容器架构
excerpt: 私有空间并非简单的图标隐藏，而是由多用户隔离、FBE 文件级加密与系统服务协同构成的隐私容器。文章拆解了从用户沙箱到密钥驱逐的完整链路。
publishDate: '2026-09-01'
tags:
- Android
- 系统安全
- 多用户
- FBE加密
- 架构设计
seo:
  title: 深入 Android Private Space 私有空间全链路：从多用户隔离到 FBE 加密的隐私容器架构
  description: 拆解 Android 私有空间的安全实现：多用户 UID 隔离、FBE 凭据加密的密钥驱逐，以及系统服务如何让锁定应用彻底隐藏。
---

前几天给一台 Android 15 设备做安全测试，发现私有空间（Private Space）锁上之后，进程列表、最近任务、通知栏里的那些应用像从未存在过。这个「消失」不是隐藏图标那么简单，背后是多用户隔离和 FBE 加密一起生效。这条链路拆开看。

## 多用户隔离是地基

Android 的多用户（Multi-User）模型不是「多账号登录」，而是一套完整的沙箱机制。系统给每个用户分配独立的 UID 区间和数据目录，应用之间天然不可见。

`UserManagerService` 维护用户列表，每个用户一个整数 userId：主用户是 0，私有空间通常是 10 或 11。应用 UID 按 `userId * 100000 + appId` 计算，所以用户 10 下的应用跑在 u10a102 这类 UID，和主用户的 u0a102 在文件权限层就已经隔开。

数据目录同样按用户切分：

```bash
/data/user/0        # 主用户
/data/user/10       # 私有空间用户
/data/user_de/10    # 设备加密存储
/data/user_ce/10    # 凭据加密存储
```

每个目录的 owner 是不同 UID，靠 Linux DAC 权限隔离。这一步决定了私有空间的应用无法直接读主用户的文件。

## 私有空间凭什么不是普通用户

私有空间本质是一个用户类型（User Type）为 `android.os.usertype.profile.PRIVATE` 的 Profile 用户。它挂在主用户下面，和主用户同时运行，受父用户锁屏状态约束；二级用户则是独立个体，可以在锁屏界面切换。这就是私有空间选 Profile 形态的原因。

我用 ADB 手动建过一个私有 Profile，能看到完整的分配流程：

```bash
adb shell pm create-user --profileOf 0 \
  --user-type android.os.usertype.profile.PRIVATE private_test
```

命令执行后，`UserManagerService` 分配 userId，再把用户类型、状态、限制标志写进 `/data/system/users/10.xml`。

和工作资料（Work Profile）不同，私有空间由用户自己管理，没有企业管理员组件，支持独立锁屏凭据，也支持「完全隐藏」——隐藏后 Launcher 和设置里都找不到入口。

## FBE 如何锁住数据

图标隐藏只是表象，真正的隔离靠文件级加密（File-Based Encryption，FBE）。Android 的 FBE 把存储分成两类：设备加密（Device Encrypted，DE）和凭据加密（Credential Encrypted，CE）。

DE 存储开机即可用，CE 存储要用户解锁后才能访问。私有空间的应用数据几乎都落在 CE 目录。锁私有空间的核心思路，是把 CE 密钥从内核 keyring 里驱逐，让密文即便被读到也无法解密。

> 以下命令行示例基于 AOSP 中 `vold`（volume daemon）的内部接口（可通过 `vdc` 调试工具触发），用于说明底层机制的大致思路。**这些是系统内部实现细节，不是稳定、公开的应用开发 API，不保证在不同 Android 版本中行为一致，开发者不应依赖它们。** Private Space 对外暴露的是 `UserManager`、`LauncherApps` 等公开 API，锁定/解锁具体调用哪个底层接口、参数格式如何，属于系统内部实现，可能随版本变化。

```bash
# 示意：锁上时驱逐 CE 密钥（具体命令/参数以 AOSP 实际版本为准）
vdc cryptfs lock_user_key 10
# 示意：解锁时用凭据重新解密 CE 密钥
vdc cryptfs unlock_user_key 10 <auth_token> <secret>
```

CE 密钥由用户凭据（PIN/图案/密码）派生，由 Keystore 保护。锁上之后内核里没有可用密钥，即便有进程残留，读 `/data/user_ce/10` 拿到的也是密文。这是私有空间「锁住即安全」的根基。

## 系统如何让应用消失

> **说明：**本节关于锁定流程中各系统服务如何协作的描述，基于 AOSP 已知的处理模式（如 `UserManager.isUserUnlocked()`、`LauncherApps` 的现有机制）推断而成，未找到针对 Private Space 的完整官方流程文档。实际实现细节（例如哪个服务在哪个时序回调、具体过滤逻辑）以官方文档和对应 Android 版本的源码为准。

锁私有空间不是简单冻结进程。`ActivityManagerService` 里的 `UserController.stopUser()` 会杀掉该用户所有进程、停掉服务，并把状态置为 `RUNNING_LOCKED`。

之后各系统服务从不同入口把痕迹清掉：

- `PackageManagerService` 查询应用时按 userId 过滤，锁定 Profile 的应用对主用户不可见
- Launcher 走 `LauncherApps` 查询，把私有空间应用整体隐藏
- `NotificationManagerService` 拦掉私有 Profile 的通知
- 最近任务（Recents）由 SystemUI 过滤掉该 userId 的任务

背后是同一个状态判断：各服务通过 `UserManager.isUserUnlocked()` 决定要不要暴露数据。锁定时返回 false，上层自然拿不到任何内容。

## 开发者的三个注意点

私有空间对普通应用影响不大，但应用一旦涉及多用户或设备管理，有三个坑得提前知道。

**测试要先解锁再连 ADB**。私有空间锁定时，`adb install --user 10` 会失败，因为 PackageManager 不允许往锁定用户装应用。我第一次遇到这个报错时，查了半天签名和权限，最后发现只是没解锁。

**别假设 userId 固定**。私有空间的 userId 是动态分配的，卸载重建会变。持久化数据不要存死 userId，用 `UserHandle` 或运行时获取。

**FBE 下别把开机自启逻辑写进 CE 目录**。监听开机广播、且 CE 解锁前就要工作的组件，相关文件得放 DE 目录，否则锁状态下进程起不来。

私有空间没有引入新机制，就是把「多用户 + FBE + 系统服务协同」三个老能力重新拼成一个容器。把它当黑盒只记 API 很容易忘，顺着这条链路看一遍反而记得牢。
