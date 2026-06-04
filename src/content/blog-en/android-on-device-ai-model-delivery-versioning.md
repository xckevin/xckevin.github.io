---
title: "Android On-device AI Model Delivery and Version Management"
lang: en
translationKey: android-on-device-ai-model-delivery-versioning
slug: android-on-device-ai-model-delivery-versioning
excerpt: "A practical model delivery architecture that decouples on-device AI models from APK releases with three-layer versioning, BSDiff incremental updates, and hot rollback."
publishDate: '2025-12-08'
tags:
- "Android"
- "On-device AI"
- "Model Management"
- "Performance Optimization"
- "Architecture"
seo:
  title: "Android On-device AI Model Delivery and Version Management"
  description: "Learn how to decouple Android on-device AI models from APK releases with version policies, BSDiff updates, rollback, and download scheduling."
  pageType: article
---

When building on-device AI, the most painful problem is often not model quality. It is that model files are easily 200MB or larger, and every iteration is tied to an app release. Change one weight parameter, and you have to ship a new APK, run a gradual rollout, wait for review, and wait for users to update. The cycle is at least a week. In fast-moving AI development, that coupling does not hold up.

Last year, we decoupled models from the APK in one project and implemented independent delivery, incremental updates, and hot rollback. This article walks through the key design decisions in that pipeline.

## App Bundle conditional delivery: moving models out of the APK

Using the App Bundle Asset Pack mechanism to separate model files from the base APK is a natural starting point.

```gradle
// build.gradle (:app)
android {
    bundle {
        language { enableSplit = true }
        density { enableSplit = true }
    }
}

// asset_pack.gradle - model Asset Pack module
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

This reduces APK size, but it does not solve the core problem: model updates are still tied to app versions. An `install-time` Asset Pack is installed with the APK. An `on-demand` pack can be downloaded when needed, but the update timing after download is still constrained by Google Play distribution. Worse, this mechanism is not available in many non-Play Store distribution channels.

The solution is to move the model lifecycle entirely to the server side.

## A three-layer design for model versioning

We built a three-layer versioning system to make the relationship between models and the app explicit.

**Layer 1: Model Line.** A model line represents one semantic model family, such as an image super-resolution model. One line can store multiple versions, but only one is active for a given online policy.

**Layer 2: Version number and compatibility range.** Each version declares the app version range it supports, through `minAppVersion` and `maxAppVersion`, as well as the required model engine version.

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

**Layer 3: Experiment group.** Model versions are bound to A/B experiments. During a gradual rollout, the new model is delivered only to specific experiment groups, keeping the blast radius under control.

With these three layers, model versions evolve independently from app versions. Users on App 2.5.0 and App 3.8.0 may run the same model version, or they may run different ones. It depends entirely on server-side policy.

## Incremental updates: BSDiff implementation details

Downloading a full 200MB model on mobile is expensive. We used BSDiff for incremental updates. The algorithm is widely documented, so here I will focus on practical details that caused real issues.

**Local delta synthesis.** The server precomputes patch files between adjacent versions. The client downloads the patch and synthesizes the new model locally.

```kotlin
class ModelUpdater(private val modelDir: File) {
    
    fun applyPatch(baseFile: File, patchFile: File, outputFile: File): Boolean {
        return try {
            BsDiffUtil.patch(
                baseFile.absolutePath,
                outputFile.absolutePath,
                patchFile.absolutePath
            )
            // Verify checksum immediately after synthesis
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

The first pitfall is **storage space**. During synthesis, the device must hold the base file, patch file, and output file at the same time. A 200MB model plus a 30MB patch actually requires around 430MB. We calculate available storage before downloading the patch. If there is not enough space, we fall back to a full download.

The second pitfall is **leftover files after synthesis failure**. BSDiff synthesis is pure CPU work, and large files can take several seconds. If the process is killed in a low-memory scenario, a half-written file remains and the next load can crash. The fix is to write to a temporary file first, then atomically rename it over the target after synthesis succeeds.

## Hot rollback: the safety fuse

This is the easiest part to overlook and also the most critical. If a model running on the device causes quality regression or crashes, you need a way to stop the bleeding immediately.

We used three rollback triggers:

1. **Server-initiated rollback**: when operations detect an issue, the server sends a rollback command; the client receives the new policy on the next heartbeat and uninstalls the current version
2. **Client-side exception self-check**: after N consecutive inference crashes, the client automatically falls back to the previous usable version
3. **Quality metric degradation**: post-processing can detect obvious bad outputs, such as an all-black image from a super-resolution model, and automatically roll back

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
        
        // Mark the current version as unusable
        prefs.edit()
            .putBoolean("model_version_blocked_$currentVersion", true)
            .apply()
        
        // Switch to the previous version
        prefs.edit()
            .putString("current_model_version", previousVersion)
            .apply()
        
        // Tell the engine to reload
        ModelLoader.reload()
    }
}
```

This mechanism saved us at least twice in production: once when a new model had precision issues on low-end devices, and once when a patch file on the CDN was accidentally overwritten and synthesis failed. In both cases, rollback was invisible to users.

## On-device download scheduling and timing

Model downloads should not compete with the user's network or battery. Our scheduling policy was intentionally conservative:

- By default, download only when **Wi-Fi + charging + screen off** are all true
- When experiment users urgently need a new model, allow a manual download with a dialog that explains mobile data usage
- Prefer incremental updates, but if the patch exceeds 50% of the base file size, use a full download because synthesis time may cost more than downloading

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

After this system shipped, model iteration changed from "release with the app, at least one week" to "change a server policy, effective within minutes." A new model can go to 1% experiment traffic first, run for a day, then roll out fully if metrics look good. If something goes wrong, rollback is always available. App releases and model iterations are fully decoupled.

Engineering on-device AI at scale comes down to two things: push the large-file problem into the distribution system, and push the stability problem into version management. The first saves bandwidth. The second keeps the product alive.
