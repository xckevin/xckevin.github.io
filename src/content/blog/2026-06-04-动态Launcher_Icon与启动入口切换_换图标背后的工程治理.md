---
title: 动态 Launcher Icon 与启动入口切换：换图标背后的工程治理
excerpt: 动态 Launcher icon 看似只调用一次 PackageManager，实际却涉及 Manifest 声明、状态机、回退策略、桌面兼容和灰度控制。本文介绍一种通用的动态启动入口切换方案，讲清楚为什么"换图标"的能力需要完整的入口状态管理设计。
publishDate: '2026-06-04'
tags:
- Android
- Launcher
- 动态图标
- PackageManager
- 工程治理
seo:
  title: 动态 Launcher Icon 与启动入口切换：换图标背后的工程治理
  description: Android 动态 Launcher Icon 的工程化设计，通过 activity-alias 管理多入口状态，配合切换状态机、健康检查、回退策略和灰度控制，让换图标的能力既灵活又可靠。
---

移动应用的桌面图标是用户进入产品的第一触点。某些业务希望在特定时间展示特殊图标，或根据地区、主题、活动状态切换启动入口。Android 提供的 `activity-alias` 能力允许一个应用声明多个 Launcher 入口，每个 alias 可以有不同 icon、label、enabled 状态，并指向同一个真实启动 Activity。运行时通过组件启停，就能控制桌面上展示哪一个入口。

但这种方案容易引发几个问题：桌面图标突然消失、启动入口重复、部分厂商桌面刷新延迟、升级后入口丢失。动态 Launcher icon 不能只作为一个简单工具函数实现，它需要完整设计。

我们项目里在 AppCommon 下有 `LauncherSwitcher`、`LauncherType`、`MyLauncherActivity`、`NewIconLauncherActivity`、`NewStyleLauncherActivity` 等入口相关类，同时各 App 壳又有自己的 launcher 资源、启动动画和主题图标。这不是单一品牌换图标，而是多品牌、多地区、多入口组件并存的入口治理问题。AppB 和 AppA 可能有不同默认图标，区域 A 和区域 B 可能有不同资源与启动动画，特殊活动可能临时切换入口。动态切换必须保证回滚、幂等、桌面缓存兼容、禁用当前组件的时机安全，以及升级后默认入口不会丢。

## 永远保留一个可用入口

动态入口切换最核心的原则是：无论远程配置错误、系统调用失败还是应用进程中断，都不能让所有 Launcher 入口同时被禁用。

切换时采用"先启用目标，再禁用旧入口"的顺序。这样即使中途失败，也更可能保留至少一个可用入口：

```kotlin
class LauncherEntrySwitcher(
    private val packageManager: PackageManager,
    private val registry: LauncherEntryRegistry,
    private val stateStore: LauncherStateStore,
    private val reporter: LauncherReporter
) {
    fun switchTo(requestedId: String) {
        val target = registry.findValid(requestedId, AppInfo.versionCode)
            ?: registry.defaultEntry()

        val previous = stateStore.currentEntryId()
            ?.let { registry.findValid(it, AppInfo.versionCode) }
            ?: registry.defaultEntry()

        val enabled = enable(target)
        if (!enabled) {
            reporter.reportSwitchFailed(target.id, "enable_failed")
            ensureDefaultEnabled()
            return
        }

        registry.allEntries().forEach { entry ->
            if (entry.id != target.id) {
                disable(entry)
            }
        }

        stateStore.saveCurrentEntryId(target.id)
        reporter.reportSwitchSuccess(previous.id, target.id)
    }
}
```

PackageManager 调用需要指定不杀进程的标记，避免切换入口时影响当前会话：

```kotlin
private fun setEnabled(component: ComponentName, enabled: Boolean): Boolean {
    val newState = if (enabled) {
        COMPONENT_ENABLED_STATE_ENABLED
    } else {
        COMPONENT_ENABLED_STATE_DISABLED
    }
    return runCatching {
        packageManager.setComponentEnabledSetting(component, newState, DONT_KILL_APP)
        true
    }.getOrDefault(false)
}
```

## Manifest 预声明与入口注册表

真实启动 Activity 不直接暴露为 Launcher，或只作为默认稳定入口之一；多个 alias 分别声明不同 icon 和 label，targetActivity 指向同一个启动 Activity。运行时只控制这些 alias 的 enabled 状态：

```xml
<activity android:name=".LauncherActivity" android:exported="true" />

<activity-alias
    android:name=".entry.DefaultEntry"
    android:enabled="true"
    android:exported="true"
    android:icon="@mipmap/icon_default"
    android:label="@string/app_name"
    android:targetActivity=".LauncherActivity">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity-alias>

<activity-alias
    android:name=".entry.CampaignEntry"
    android:enabled="false"
    android:exported="true"
    android:icon="@mipmap/icon_campaign"
    android:label="@string/app_name"
    android:targetActivity=".LauncherActivity">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity-alias>
```

客户端维护一份内置注册表，远程配置只下发稳定 id，不触碰组件名：

```kotlin
data class RemoteLauncherPolicy(
    val entryId: String,
    val activeFrom: Long,
    val activeUntil: Long,
    val minAppVersion: Int
)

fun resolveEntry(policy: RemoteLauncherPolicy?, now: Long): String {
    if (policy == null) return "default"
    if (now !in policy.activeFrom..policy.activeUntil) return "default"
    if (AppInfo.versionCode < policy.minAppVersion) return "default"
    return policy.entryId
}
```

## 启动时健康检查

应用启动时要做一次入口健康检查，修正异常状态。比如进程被杀导致多个入口同时启用，或所有入口都被禁用：

```kotlin
class LauncherEntryHealthCheck(
    private val registry: LauncherEntryRegistry,
    private val packageManager: PackageManager,
    private val reporter: LauncherReporter
) {
    fun repairIfNeeded() {
        val enabledEntries = registry.allEntries().filter { entry ->
            packageManager.isComponentEnabled(entry.componentName)
        }

        when {
            enabledEntries.isEmpty() -> {
                enable(registry.defaultEntry())
                reporter.reportRepair("no_enabled_entry")
            }
            enabledEntries.size > 1 -> {
                val preferred = choosePreferred(enabledEntries)
                registry.allEntries().forEach { entry ->
                    if (entry.id != preferred.id) disable(entry)
                }
                reporter.reportRepair("multiple_enabled_entries")
            }
        }
    }
}
```

## 落地中的关键约束

alias 不要随意删除。已经发布过的入口即使后续不用，也建议保留一段较长兼容期，并默认 disabled。直接删除旧 alias 可能影响升级用户桌面上的历史入口。

默认入口必须稳定。默认入口资源、label、目标 Activity 应尽量少变，它是所有异常恢复的落点。任何活动入口都应该能回退到默认入口。

切换频率要低。每天或每次启动都切图标会让用户困惑，也会增加桌面兼容风险。活动类图标应有明确开始和结束时间，且避免短周期反复切换。

注意桌面缓存延迟。PackageManager 调用成功不代表用户桌面立即刷新。产品和运营预期要建立在"最终一致"上，而不是把切换当作实时视觉能力。

测试矩阵要覆盖主流厂商桌面、系统版本、升级安装、覆盖安装、冷启动、进程存活切换、切换后卸载重装等场景。尤其要验证从旧版本升级到新版本时，旧入口状态是否被正确修复。

---

动态 Launcher icon 是一个看似简单、实则非常接近系统边界的能力。它的核心不在于调用一次 PackageManager，而在于保证入口状态始终可恢复、配置始终可校验、异常始终可观测。一个稳健方案通常具备这些特征：所有入口提前声明，远程只选择白名单 id；切换顺序优先保证至少一个入口可用；应用启动时执行健康检查；默认入口永远可恢复；灰度数据能区分成功、失败和修复。动态图标带来的新鲜感有价值，但不能覆盖启动稳定性。每一次切换都应该有明确理由、明确窗口和明确回退，只有这样它才会成为可靠能力，而不是一次高风险活动配置。