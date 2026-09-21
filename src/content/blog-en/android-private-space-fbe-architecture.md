---
title: 'How Android Private Space Works: Multi-User Isolation and FBE Encryption'
lang: en
translationKey: android-private-space-fbe-architecture
slug: android-private-space-fbe-architecture
excerpt: Private Space is not simply hiding icons — it is a privacy container built from multi-user isolation, FBE file-level encryption, and system service coordination. This post walks through the full chain from user sandbox to key eviction.
publishDate: '2026-09-01'
tags:
- Android
- System Security
- Multi-User
- FBE Encryption
- Architecture Design
seo:
  title: How Android Private Space Uses Multi-User Isolation and FBE
  description: Private Space is not just hidden icons; it combines multi-user isolation, FBE encryption, and system services. We trace the chain from sandbox to key eviction.
  pageType: article
---

A few days ago I was doing security testing on an Android 15 device and noticed that once Private Space is locked, the apps in the process list, recent tasks, and notification shade look like they never existed. That "disappearance" is not simply hiding icons — behind it, multi-user isolation and FBE encryption work together. Let's take that chain apart.

## Multi-user isolation is the foundation

Android's multi-user model is not "multiple account login"; it is a complete sandboxing mechanism. The system assigns each user an independent UID range and data directory, so apps are naturally invisible to each other.

`UserManagerService` maintains the user list, with one integer userId per user: the primary user is 0, and Private Space is usually 10 or 11. An app's UID is computed as `userId * 100000 + appId`, so an app under user 10 runs as a UID like u10a102, which is already separated from the primary user's u0a102 at the file permission layer.

Data directories are also split per user:

```bash
/data/user/0        # 主用户
/data/user/10       # 私有空间用户
/data/user_de/10    # 设备加密存储
/data/user_ce/10    # 凭据加密存储
```

Each directory is owned by a different UID, isolated by Linux DAC permissions. This step determines that Private Space apps cannot directly read the primary user's files.

## Why Private Space is not an ordinary user

Private Space is essentially a Profile user whose User Type is `android.os.usertype.profile.PRIVATE`. It is attached under the primary user, runs at the same time as the primary user, and is constrained by the parent user's lock screen state; a secondary user is an independent entity that can be switched to on the lock screen. This is why Private Space chooses the Profile form.

I manually created a private Profile with ADB and could see the whole allocation flow:

```bash
adb shell pm create-user --profileOf 0 \
  --user-type android.os.usertype.profile.PRIVATE private_test
```

After the command runs, `UserManagerService` assigns the userId, then writes the user type, state, and restriction flags into `/data/system/users/10.xml`.

Unlike Work Profile, Private Space is managed by the user themselves, has no enterprise admin component, supports an independent lock screen credential, and supports "full hiding" — once hidden, there is no entry in Launcher or Settings.

## How FBE locks down the data

Hiding icons is only the surface; the real isolation relies on File-Based Encryption (FBE). Android's FBE splits storage into two categories: Device Encrypted (DE) and Credential Encrypted (CE).

DE storage is available at boot; CE storage is only accessible after the user unlocks. Almost all Private Space app data lives in CE directories. The core idea of locking Private Space is to evict the CE key from the kernel keyring so that even if the ciphertext is read, it cannot be decrypted.

> The command-line examples below are based on the internal interfaces of `vold` (the volume daemon) in AOSP (which can be triggered through the `vdc` debug tool), and are used to illustrate the general idea of the underlying mechanism. **These are internal implementation details, not stable, public app-development APIs. They are not guaranteed to behave identically across Android versions, and developers should not rely on them.** What Private Space exposes to the outside is the public API such as `UserManager` and `LauncherApps`. Which underlying interface is called for locking/unlocking and what the parameter format looks like are internal implementation details that may change across versions.

```bash
# 示意：锁上时驱逐 CE 密钥（具体命令/参数以 AOSP 实际版本为准）
vdc cryptfs lock_user_key 10
# 示意：解锁时用凭据重新解密 CE 密钥
vdc cryptfs unlock_user_key 10 <auth_token> <secret>
```

The CE key is derived from the user credential (PIN/pattern/password) and protected by Keystore. Once locked, there is no usable key in the kernel; even if some process remains, reading `/data/user_ce/10` returns ciphertext. This is the foundation of Private Space's "locked means secure" property.

## How the system makes apps disappear

> **Note:** The description in this section of how the various system services cooperate during the lock process is inferred from known AOSP handling patterns (such as `UserManager.isUserUnlocked()` and the existing `LauncherApps` mechanism); no complete official process documentation specific to Private Space was found. The actual implementation details (for example, which service is called back at which point in the sequence, and the specific filtering logic) are subject to the official documentation and the source code of the corresponding Android version.

Locking Private Space is not simply freezing processes. `UserController.stopUser()` inside `ActivityManagerService` kills all processes of that user, stops services, and sets the state to `RUNNING_LOCKED`.

After that, each system service clears the traces from a different entry point:

- `PackageManagerService` filters app queries by userId, so apps of a locked Profile are invisible to the primary user
- Launcher queries through `LauncherApps` and hides Private Space apps as a whole
- `NotificationManagerService` blocks notifications from the private Profile
- Recent tasks (Recents) are filtered by SystemUI, which drops tasks of that userId

Behind all of this is the same state check: each service uses `UserManager.isUserUnlocked()` to decide whether to expose data. When locked, it returns false, so upper layers naturally get nothing.

## Three things developers should note

Private Space has little impact on ordinary apps, but once an app involves multi-user or device management, there are three pitfalls to be aware of in advance.

**Unlock before connecting ADB when testing.** While Private Space is locked, `adb install --user 10` will fail because PackageManager does not allow installing apps into a locked user. The first time I hit this error, I spent a long time checking signatures and permissions, and finally found it just was not unlocked.

**Do not assume userId is fixed.** Private Space's userId is assigned dynamically and will change if it is uninstalled and recreated. Do not persist a hardcoded userId; use `UserHandle` or obtain it at runtime.

**With FBE, do not put boot-start logic in CE directories.** Components that listen for boot broadcasts and must work before CE unlock should put the relevant files in DE directories; otherwise the process cannot start in the locked state.

Private Space does not introduce any new mechanism; it reassembles three old capabilities — "multi-user + FBE + system service coordination" — into a container. Treating it as a black box and memorizing only the APIs makes it easy to forget; walking through this chain once makes it much easier to remember.
