---
title: 深入 Android Google Play In-App Update 全链路：从 Play Core 内部分发机制到即时/灵活更新模式的工程实践
excerpt: 详解 Android In-App Update 从 Play Core IPC 请求链路、Immediate/Flexible 策略选型到 App Bundle 差分机制的全链路实现，结合工程实践将更新完成率从 30% 提升至 70% 以上。
publishDate: '2026-06-01'
tags:
- Android
- Google Play
- Play Core
- 应用内更新
- 工程实践
seo:
  title: 深入 Android Google Play In-App Update 全链路：从 Play Core 内部分发机制到即时/灵活更新模式的工程实践
  description: 深入解析 Android In-App Update 全链路实现，涵盖 Play Core 请求机制、Immediate 与 Flexible 模式选型策略、App Bundle 版本差分优化及工程化落地实践。
---

去年我在一个海外项目中接手了应用内更新（In-App Update）模块，线上数据显示只有 30% 的用户在收到更新提示后完成了升级。翻看代码后发现，团队只是在 Activity 里调了 `startUpdateFlowForResult`，没有处理任何边界情况——网络中断怎么办、用户拒绝后何时再次提示、灵活更新下载到一半 App 被杀掉怎么恢复。

说白了，In-App Update 不是调一个 API 就能搞定的。它涉及 Play Core 库的内部请求链路、Google Play 服务端的版本差分策略，以及客户端对两种更新模式的工程化封装。

## Play Core 的请求链路：调用 `startUpdateFlowForResult` 之后发生了什么

先看一段最基础的调用代码：

```kotlin
val appUpdateManager = AppUpdateManagerFactory.create(context)
val appUpdateInfoTask = appUpdateManager.appUpdateInfo

appUpdateInfoTask.addOnSuccessListener { info ->
    if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
        && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
    ) {
        appUpdateManager.startUpdateFlowForResult(
            info,
            AppUpdateType.IMMEDIATE,
            this,
            REQUEST_CODE_UPDATE
        )
    }
}
```

代码上只是拿到了一个 `AppUpdateInfo` 对象，然后启动了更新流程。但背后 Play Core 做了三件事：

1. **校验 Play 商店版本**：通过 `PlayCoreVersion` 检查设备上的 Play 商店是否支持 In-App Update API（最低要求 4.0+）。不满足时，`appUpdateInfo` 的 `isUpdateTypeAllowed` 直接返回 false，不抛异常。
2. **发起 IPC 请求**：Play Core 通过 AIDL 与 Play 商店进程通信，请求检查当前应用是否有可用更新。这一步是异步的——你调了 `addOnSuccessListener`，回调可能在几百毫秒甚至几秒后才返回。
3. **返回更新元数据**：`AppUpdateInfo` 里携带的不只是"有没有更新"，还包括 `availableVersionCode`、`updateAvailability`、`updatePriority` 等字段。其中 `updatePriority` 决定了 Play 商店是强行弹出更新页（Immediate 模式）还是静默下载（Flexible 模式）。

踩过一个坑：在国内厂商 ROM 上（比如某些 MIUI 版本），即使装了 Play 商店，Play Core 的 IPC 调用也可能失败，表现为 `appUpdateInfoTask` 永远不回调。处理方式是加一个 5 秒超时，超时后降级为引导用户去 Play 商店手动更新。

## 优先级策略：Immediate 和 Flexible 到底怎么选

Google 文档上的描述很简洁：Immediate 是阻塞式全屏更新页，适用于关键更新；Flexible 是后台下载，下载完成后弹窗提示重启。

实际选型时，我按 **更新类型** 来划分：

| 更新类型 | 推荐策略 | 典型场景 |
|---------|---------|---------|
| 强制升级（breaking API 变更） | Immediate + 不可取消 | 服务端接口废弃、数据结构不兼容 |
| 重要更新（严重 bug 修复） | Immediate + 可推迟一次 | 崩溃率超过阈值、安全问题 |
| 功能更新 | Flexible | 常规功能迭代 |
| 内容/资源更新 | Flexible + 静默 | 素材包、离线数据 |

`updatePriority` 的值范围是 0~5，由 Play Console 上的发布配置决定，客户端只能读取它做分支判断：

```kotlin
when {
    info.updatePriority() >= 4 && info.isUpdateTypeAllowed(IMMEDIATE) -> {
        // 强制立即更新，不给用户关闭选项
        appUpdateManager.startUpdateFlowForResult(info, IMMEDIATE, this, RC)
    }
    info.updatePriority() in 2..3 -> {
        // 灵活更新，后台静默下载
        appUpdateManager.startUpdateFlowForResult(info, FLEXIBLE, this, RC)
    }
    info.updatePriority() < 2 -> {
        // 低优先级，3 天后再次提示
        scheduleReminder(3.days)
    }
}
```

Flexible 模式的下载进度监听必须注册 `InstallStateUpdatedListener`，而且 Activity 重建后监听器会丢失。我的做法是在 `Application` 层持有一个单例 Listener，绕过生命周期限制。

## App Bundle 版本差分：为什么灵活更新有时比完整包还大

In-App Update 底层复用的是 Play 商店的补丁安装机制。上传 APK 时，Play 服务端使用 `bsdiff` 算法生成差异包——两版本之间代码变化越小，增量包越小。

换成 App Bundle（AAB），情况就复杂了。AAB 在服务端被动态拆分为多个 split APK（base + config splits），更新时按设备特征重新组装。这里有两个关键影响：

1. **增量补丁是针对 split 级别计算的**，不是对整个 APK。如果你的 base split 依赖了某个 native 库，而这个库在版本间发生了 ABI 变化，即使业务代码没改，增量包也可能很大。
2. **Play Asset Delivery（PAD）的资源更新不走差分**。安装包里有 `install-time` 资源包的话，每次更新都会完整重新下载这些资源，哪怕只改了一个像素。

我在一次包体优化中发现，项目使用 App Bundle + PAD，灵活更新的下载量竟然达到完整包体积的 85%。排查后发现，`install-time` 资源包里模型文件的文件名带了版本号（`model_v3.tflite` → `model_v4.tflite`），导致 `bsdiff` 完全失效。

解决办法：PAD 的资源包尽量用 `fast-follow` 或 `on-demand` 模式分发，`install-time` 只放核心的 base 逻辑。这样灵活更新时只下载 base split 的增量，数据包在 App 启动后再按需拉取。

## 测试验证：模拟真实场景比读文档有效

Play Console 提供了内部测试轨道（Internal Test Track），可以用来验证 In-App Update 的真实流程。有几个点文档说得不够清楚：

**Internal Test Track 的延迟**：上传新版本后，In-App Update 的可用性不是立即生效，通常需要 15~30 分钟。Google Play 的 CDN 分发存在缓存窗口，急着测试的话会看到 `UPDATE_NOT_AVAILABLE`。

**版本号必须递增**：Play 商店端判断更新的唯一依据是 `versionCode`（而不是 `versionName`）。`versionCode` 不递增，即使 `versionName` 变化了，`updateAvailability` 也会返回 `UPDATE_NOT_AVAILABLE`。

**Immediate 模式无法在模拟器测试**：Immediate 依赖 Play 商店的 Activity 覆盖，模拟器上的 Play 商店版本不支持这个特性。模拟器只能测 Flexible 模式的基本流程。

我在 CI 里加了一套验证脚本：每次向 Internal Test Track 发布新版本后，等 20 分钟，拉取 `appUpdateInfo` 检查 `updateAvailability` 是否为 `UPDATE_AVAILABLE`，并且 `allowedUpdateTypes` 包含预期的更新模式。不用每次手动点来点去。

```bash
# 在 CI 中用 ADB 触发验证的简化版
adb shell am broadcast \
  -a com.example.CHECK_UPDATE \
  --ei expected_version_code 42 \
  --ei expected_update_type 1
```

## 工程落地的三个关键决策

In-App Update 的 API 看着简单，工程化之后真正花时间的地方不在调用，而在边界处理。

**1. 连接 Play Core 和业务的生命周期。** Flexible 模式的状态监听器会跨 Activity 生命周期存活，用 `ProcessLifecycleOwner` 监听前后台切换，App 回到前台时立即检查 `installStatus`，如果是 `DOWNLOADED` 就直接触发安装。

**2. 给用户设置"下次再说"的上限。** 不要每次都弹更新提示——记录用户拒绝次数，超过 3 次后拉长提示间隔到 7 天，超过 5 次后只在 App 冷启动时静默检查 Flexible 更新。

**3. Immediate 模式加降级出口。** Play 服务异常导致 Immediate 更新页弹不出时，30 秒无响应后自动降级为跳转 Play 商店详情页，避免用户卡死在更新流程里。这比直接抛异常让用户不知所措要好得多。

三个点做扎实，线上更新完成率从 30% 提到 70% 以上不算难。
