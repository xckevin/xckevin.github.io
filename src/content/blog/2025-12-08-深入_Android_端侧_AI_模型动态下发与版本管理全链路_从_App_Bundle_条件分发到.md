---
title: 深入 Android 端侧 AI 模型动态下发与版本管理全链路
excerpt: 从 APK 解耦模型，通过三层版本体系、BSDiff 增量更新和热回滚机制，实现端侧 AI 模型独立下发、分钟级迭代与稳定保障。
publishDate: '2025-12-08'
tags:
- Android
- 端侧AI
- 模型管理
- 性能优化
- 架构设计
seo:
  title: 深入 Android 端侧 AI 模型动态下发与版本管理全链路
  description: 详解 Android 端侧 AI 模型从 APK 解耦的工程实践，涵盖三层版本体系、BSDiff 增量更新、热回滚与下载调度，实现模型独立下发与分钟级迭代。
---

做端侧 AI，最头疼的不是模型效果不行，而是模型文件动辄 200MB+，每次迭代都绑着 App 版本走。改个权重参数就得发新 APK，灰度、审核、等用户更新，周期至少一周。在快速迭代的 AI 场景里，这种耦合完全扛不住。

去年我们在项目里把模型从 APK 解耦，做到了独立下发、增量更新和热回滚。这篇文章把这条链路的关键设计理一遍。

## App Bundle 条件分发：把模型拆出 APK

用 App Bundle 的 Asset Pack 机制把模型从 base APK 剥离，是很自然的起步。

```gradle
// build.gradle (:app)
android {
    bundle {
        language { enableSplit = true }
        density { enableSplit = true }
    }
}

// asset_pack.gradle — 模型 Asset Pack 模块
plugins {
    id 'com.android.asset-pack'
}

assetPack {
    packName = "model_pack"
    dynamicDelivery {
        deliveryType = "install-time"
    }
}
```

这套方案能缩不少 APK 体积，但有个绕不开的问题：模型更新还是跟着 App 版本走。`install-time` 的 Asset Pack 随 APK 安装，`on-demand` 虽说能按需下载，但下载之后的更新时机依然受制于 Google Play 的分发节奏。更麻烦的是，国内渠道根本没有 Play Store，这套机制等于没法用。

解法是把模型的生命周期完全交到服务端手里。

## 模型版本管理的三层设计

我们搞了一套三层版本体系，管清楚模型和 App 的关系：

**第一层：模型线（Model Line）**。同一个模型语义上归一条线，比如「图像超分模型」。一条线可以同时存多个版本，但在线服务的只有一个。

**第二层：版本号与兼容区间**。每个版本声明自己兼容的 App 版本范围（minAppVersion / maxAppVersion），以及依赖的模型引擎版本。

```json
{
  "model_line": "image_super_resolution",
  "model_version": "3.2.1",
  "min_app_version": "2.5.0",
  "max_app_version": "4.0.0",
  "engine_version": "1.3.0",
  "file_size": 234567890,
  "checksum": "sha256:abc123...",
  "base_version": "3.1.0",
  "diff_url": "https://cdn.example.com/models/sr_3.1.0_to_3.2.1.patch"
}
```

**第三层：实验分组**。模型版本跟 AB 实验绑定，灰度时只对特定实验组用户下发新版本，出问题的影响面可控。

三层下来，模型版本彻底独立于 App 版本演进。App 2.5.0 的用户和 App 3.8.0 的用户可能跑同一个模型版本，也可能跑不同版本——全看服务端策略怎么配。

## 增量更新：BSDiff 落地细节

全量下载 200MB+ 的模型文件，移动端吃不消。增量更新我们用了 BSDiff，原理网上很多文章讲过，这里说几个真正踩过坑的落地细节。

**本地差量合成**：服务端提前算好每个相邻版本之间的 patch 文件，客户端下载 patch 后在本地合成。

```kotlin
class ModelUpdater(private val modelDir: File) {
    
    fun applyPatch(baseFile: File, patchFile: File, outputFile: File): Boolean {
        return try {
            BsDiffUtil.patch(
                baseFile.absolutePath,
                outputFile.absolutePath,
                patchFile.absolutePath
            )
            // 合成后立即校验 checksum
            val actualChecksum = computeSha256(outputFile)
            actualChecksum == expectedChecksum
        } catch (e: Exception) {
            outputFile.delete()
            false
        }
    }
    
    private fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
```

第一个坑：**存储空间**。合成时要同时持有 base 文件、patch 文件和输出文件。一个 200MB 模型 + 30MB patch，实际需要约 430MB。我们在下载 patch 前先算可用空间，不够就降级走全量。

第二个坑：**合成失败后的残留**。BSDiff 合成是纯 CPU 操作，大文件要跑好几秒。低内存场景下进程被 kill，剩半个文件在那儿，下次加载就崩。处理方式是先写临时文件，合成成功后再原子 rename 覆盖目标。

## 热回滚：出问题的保险丝

整个方案里最容易忽视、也最关键的环节。模型在端上跑，效果退化或者崩了，得能立刻止血。

回滚触发我们设了三层：

1. **服务端主动回滚**：运维发现问题后直接下发回滚指令，客户端下次心跳拿到新策略，卸载当前版本
2. **客户端异常自检**：连续 N 次推理崩溃，自动降到上一个可用版本
3. **效果指标劣化**：模型输出通过后处理能检出明显异常（比如超分模型输出全黑图），自动回退

```kotlin
class ModelRollbackManager(
    private val prefs: SharedPreferences,
    private val modelDir: File
) {
    private val crashCounter = AtomicInteger(0)
    private val maxConsecutiveCrashes = 3
    
    fun recordInferenceCrash() {
        val count = crashCounter.incrementAndGet()
        if (count >= maxConsecutiveCrashes) {
            rollbackToPreviousVersion()
        }
    }
    
    fun recordInferenceSuccess() {
        crashCounter.set(0)
    }
    
    private fun rollbackToPreviousVersion() {
        val previousVersion = prefs.getString("prev_model_version", null) ?: return
        val currentVersion = prefs.getString("current_model_version", null)
        
        // 标记当前版本为不可用
        prefs.edit()
            .putBoolean("model_version_blocked_$currentVersion", true)
            .apply()
        
        // 切换到上一个版本
        prefs.edit()
            .putString("current_model_version", previousVersion)
            .apply()
        
        // 通知引擎重新加载
        ModelLoader.reload()
    }
}
```

这个机制在线上救过我们至少两次：一次是新模型在低端机上有精度问题，一次是 CDN 上某个 patch 文件被意外覆盖导致合成失败。两次回滚用户完全无感。

## 端上的下载调度与时机选择

模型下载不能抢用户的网络和电量，调度规则定的比较保守：

- 默认只在 **WiFi + 充电 + 息屏** 三个条件同时满足时才下载
- 实验组用户急需新模型时，可以手动触发下载，弹窗告知流量消耗
- 增量更新优先，但如果 patch 超过 base 文件的 50%，直接走全量——合成耗时可能比下载还长，不划算

```kotlin
class ModelDownloadScheduler(context: Context) {
    
    fun shouldDownloadNow(modelVersion: ModelVersion): DownloadDecision {
        if (!isWifiConnected()) return DownloadDecision.Defer("no_wifi")
        if (!isCharging()) return DownloadDecision.Defer("not_charging")
        if (isScreenOn()) return DownloadDecision.Defer("screen_on")
        
        val localVersion = getLocalVersion(modelVersion.modelLine)
        if (localVersion != null && modelVersion.hasDiffFrom(localVersion)) {
            val diffSize = modelVersion.diffSize
            val fullSize = modelVersion.fileSize
            return if (diffSize < fullSize * 0.5) {
                DownloadDecision.Diff(modelVersion.diffUrl, modelVersion.checksum)
            } else {
                DownloadDecision.Full(modelVersion.fullUrl, modelVersion.checksum)
            }
        }
        
        return DownloadDecision.Full(modelVersion.fullUrl, modelVersion.checksum)
    }
}
```

整套方案上线后，模型迭代从「跟 App 发版，至少一周」变成「服务端配一下，分钟级生效」。新模型先推 1% 实验流量，跑一天没问题再全量，出状况随时回滚。App 发版和模型迭代彻底解耦。

做端侧 AI 工程化，核心就两件事：把大文件的问题丢给分发系统，把稳定性的问题交给版本管理。前者省流量，后者保命。
