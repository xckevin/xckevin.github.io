---
title: "Dynamic Launcher Icons and Entry Switching: Engineering Controls Behind Icon Changes"
lang: en
translationKey: dynamic-launcher-icon-entry-switching
slug: dynamic-launcher-icon-entry-switching
excerpt: "Dynamic Launcher icons look like a single PackageManager call, but a production implementation involves manifest declarations, entry-state management, fallback behavior, launcher compatibility, and rollout controls."
publishDate: '2026-06-04'
tags:
- "Android"
- "Launcher"
- "Dynamic Icons"
- "PackageManager"
- "Engineering Governance"
seo:
  title: "Dynamic Launcher Icons and Android Entry Switching"
  description: "Implement Android dynamic Launcher icons with activity-alias entries, state management, health checks, fallback strategies, and rollout controls."
  pageType: article
---

The launcher icon of a mobile application is the user's first point of contact with the product. Some business requirements call for displaying a special icon at specific times, or switching the launch entry point based on region, theme, or campaign status. Android's `activity-alias` capability allows an application to declare multiple Launcher entries, where each alias can have a different icon, label, and enabled state, all pointing to the same underlying launch Activity. At runtime, the app controls which entry appears in the launcher by enabling or disabling components.

However, this approach can lead to several issues: the launcher icon can disappear, duplicate launch entries can appear, launcher refresh can be delayed on some OEM devices, and entries can be lost after an upgrade. Dynamic launcher icons cannot be implemented with just a simple utility function; they require a complete state-management design.

In our project, we have entry-related classes like `LauncherSwitcher`, `LauncherType`, `MyLauncherActivity`, `NewIconLauncherActivity`, and `NewStyleLauncherActivity` under `AppCommon`. Each app shell also has its own launcher resources, launch animations, and theme icons. This is not a single-brand icon swap; it is entry management across coexisting multi-brand, multi-region, and multi-entry components. AppB and AppA might have different default icons, Region A and Region B might have different resources and launch animations, and special campaigns might temporarily switch the entry point. Dynamic switching must guarantee rollback capability, idempotency, compatibility with launcher caching, safe timing for disabling components, and protection against losing the default entry after an upgrade.

## Always Keep One Usable Entry

The most critical principle for dynamic entry switching is: regardless of remote configuration errors, system call failures, or application process interruptions, all Launcher entries must never be disabled simultaneously.

The switching process must follow the order of "enable the target first, then disable the old entries." This way, even if the process fails midway, it is more likely to retain at least one usable entry:

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

`PackageManager` calls require specifying a flag that prevents process killing to avoid affecting the current session when switching entries:

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

## Manifest Pre-declaration and Entry Registry

The actual launch Activity is not directly exposed as a Launcher, or it serves only as one of the default stable entries; multiple aliases declare different icons and labels, all pointing to the same target Activity. At runtime, only the enabled state of these aliases is controlled:

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

The client maintains an internal registry, and remote configurations only push stable IDs without touching component names:

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

## Health Check at Startup

A health check for the entry point must be performed when the application starts to correct any abnormal states. For example, if the process was killed, leading to multiple entries being enabled, or if all entries are disabled:

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

## Key Constraints in Practice

Aliases should never be deleted casually. Even if an entry is no longer used, it is better to keep it for a relatively long compatibility period and leave it disabled by default. Deleting old aliases directly might affect historical launcher entries during an upgrade.

The default entry must be stable. The resources, label, and target Activity for the default entry should change as little as possible, as it is the fallback point for all exceptions. Any active entry should be able to fall back to the default entry.

Switching frequency must be low. Changing the icon every day or on every launch will confuse users and increase launcher compatibility risks. Campaign-specific icons should have clearly defined start and end times, and short-cycle, repeated switching should be avoided.

Be mindful of launcher caching delays. A successful `PackageManager` call does not guarantee an immediate launcher refresh for the user. Product and operations expectations must be built on "eventual consistency," rather than treating the switch as a real-time visual capability.

The testing matrix must cover mainstream OEM launchers, system versions, upgrade installations, clean installs, cold starts, process-alive switching, and reinstallation after switching. Pay special attention to whether old entry states are repaired correctly when upgrading from an older version.

---

Dynamic launcher icons are a feature that appears simple but is actually very close to the system boundary. Its core value lies not in making a single `PackageManager` call, but in ensuring that the entry state is always recoverable, the configuration is always verifiable, and the exceptions are always observable. A robust solution typically possesses these characteristics: all entries are declared in advance, and remote configurations only select from a whitelist of IDs; the switching order prioritizes keeping at least one entry available; a health check is executed at application startup; the default entry is always recoverable; and A/B testing data can distinguish between success, failure, and repair. The novelty brought by dynamic icons has value, but it cannot supersede launch stability. Every switch must have a clear reason, a defined window, and a clear fallback; only then will it become a reliable capability, rather than a high-risk feature configuration.
