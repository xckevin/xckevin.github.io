---
title: "Android Process Survival and Resource Scheduling: OOM Adj to LMK"
lang: en
translationKey: android-process-oom-adj-lmk
slug: android-process-oom-adj-lmk
excerpt: "A system-level look at Android OOM Adj scoring, LMK and lmkd evolution, cgroup memory isolation, foreground services, expedited WorkManager jobs, and memory self-monitoring."
publishDate: '2026-05-09'
tags:
- "Android"
- "Process Survival"
- "Memory Management"
- "LMK"
- "Performance"
seo:
  title: "Android OOM Adj and LMK: Process Survival, lmkd, Cgroups, and Scheduling"
  description: "Understand Android OOM Adj, LMK and lmkd evolution, cgroup memory limits, foreground services, WorkManager expedited jobs, and memory self-monitoring."
  pageType: article
---

Two years ago, during ROM adaptation work, QA reported a strange issue: our input method process was killed three seconds after moving to the background on Huawei devices, while a competing app survived for 10 minutes. The root cause was not our business code. It was **OOM Adj, or Out-Of-Memory Adjustment**, a value calculated by AMS and enforced by LMK that decides when your process gets killed.

## OOM Adj: a process's kill priority

Android assigns every process an OOM Adj value from `-1000` to `1001`. The larger the value, the more likely the process is to be reclaimed under memory pressure.

```text
FOREGROUND_APP_ADJ        = 0    // Foreground app
VISIBLE_APP_ADJ           = 100  // Visible but not foreground
PERCEPTIBLE_APP_ADJ       = 200  // Perceptible, such as background music playback
PREVIOUS_APP_ADJ          = 700  // Previous foreground app
HOME_APP_ADJ              = 600  // Launcher
SERVICE_ADJ               = 500  // Active Service
CACHED_APP_MIN_ADJ        = 900  // Invisible cached process
CACHED_APP_MAX_ADJ        = 906  // Cached-process ceiling
```

These values are calculated dynamically in AMS through `updateOomAdjLocked()`. Every process state change triggers reevaluation. Inputs include component state, foreground interaction, service binding relationships, and many other factors.

The key rule is this: a process's OOM Adj is the **minimum value** computed from all components inside that process. If your process contains one foreground service, the whole process is treated with foreground priority.

## The three-stage evolution of LMK

Early Android versions used the kernel LMK, or Low Memory Killer, driver directly. It read memory thresholds from `/sys/module/lowmemorykiller/parameters/minfree` and killed processes from higher Adj to lower Adj. This was a polling-style passive eviction mechanism: once memory dropped below a threshold, it scanned the process list, calculated `oom_score`, and killed the process with the highest score.

```bash
# View kernel LMK threshold configuration, in pages
cat /sys/module/lowmemorykiller/parameters/minfree
# 18432,23040,27648,32256,55296,80640
```

I once hit a painful issue while customizing a system image: the CACHED_APP threshold mapped to the third value was tuned too aggressively, so apps were killed immediately after users switched away from them. The experience was terrible. LMK parameters should not be guessed. They need staged tuning based on the actual memory distribution.

### First shift: from kernel LMK to userspace lmkd

Starting with Android 10, LMK logic moved from the kernel into the userspace `lmkd` daemon.

Kernel LMK used hard-coded linear mappings of `oom_score_adj` and had no real awareness of Android framework process-state semantics. Userspace lmkd can receive OOM Adj information from AMS directly, which enables smarter decisions: prioritize large-memory victims, use weighted scoring, and trigger kills at different pressure levels.

The more useful improvement is **PSI, or Pressure Stall Information**, monitoring. lmkd reads `/proc/pressure/memory` to observe memory pressure in real time instead of relying only on static watermarks. The kernel tracks "the percentage of tasks blocked because of insufficient memory over a recent time window."

```bash
cat /proc/pressure/memory
# some avg10=5.23 avg60=2.17 avg300=0.85 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

The `some` line means at least some tasks were waiting on memory. The `full` line means all tasks were waiting. lmkd uses values like `avg10` to choose the trigger level: light pressure reclaims cached processes with Adj >= 900 first, medium pressure can go down to the Service layer, and heavy pressure is when foreground work may be touched.

### Second shift: cgroup memory isolation

Android 12 introduced the cgroup v2 memory controller. Processes are no longer treated only as individual lives with individual scores. They are placed into hierarchical groups, and each group can have independent `memory.max` and `memory.high` limits.

```text
/system/
  └─ uid_1000/
       ├─ foreground/    <- Foreground process group with looser memory limits
       └─ background/    <- Background process group with stricter limits
```

This means that even if your process has OOM Adj 0, the cgroup OOM killer can still act if the background cgroup as a whole exceeds its limit. **OOM Adj is no longer the only judge.**

## The survival game: escalation on both sides

Early Android process-keepalive techniques were everywhere: dual-process watchdogs, one-pixel activities, transparent foreground overlays, JNI port occupation, and more. In essence, they all tried to **trick AMS's OOM Adj calculation** into assigning a lower score.

After Android 8.0, Google kept tightening the rules: background `startService()` restrictions, mandatory notifications for foreground services, and limits on background activity launches. By Android 14, starting a foreground service from the background requires specific permissions in many cases.

ByteDance once shared an approach on InfoQ: stop trying to hard-keep processes alive and move toward "elastic degradation." If the process is reclaimed, WorkManager restarts the smallest necessary task in an appropriate execution window. The thinking changes from "do not kill me" to "if I am killed, I can recover."

I agree with that direction. Hard keepalive strategies fight the system's memory scheduling policy. They may "win" in the short term, but both iOS and Android are moving toward tighter platform control. Improving cold-start speed and state restoration is a better investment than chasing undocumented tricks.

## Three strategies that actually work

**Use foreground services in a compliant way.** If the app really needs to keep running in the background, such as navigation or workout tracking, declare a specific `foregroundServiceType`:

```xml
<service
    android:foregroundServiceType="location|health"
    android:name=".TrackService" />
```

After Android 14, the system checks whether the declared type matches actual behavior. A foreground service pretending to be one thing while doing another can be killed directly.

**Use WorkManager Expedited Work.** For background tasks that must finish within about 10 minutes, expedited work requests temporarily raise process priority:

```kotlin
val request = OneTimeWorkRequestBuilder<SyncWorker>()
    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    .build()
WorkManager.getInstance(context).enqueue(request)
```

Expedited work is still throttled under battery optimization. `OutOfQuotaPolicy` controls what happens after the app exceeds its quota.

**Build memory self-awareness.** Instead of only studying how not to be killed, study your own memory footprint. `ActivityManager.getProcessMemoryInfo()` gives you PSS data, and `Debug.getNativeHeapAllocatedSize()` helps monitor native leaks. I once diagnosed a native leak whose root cause was unrecycled Bitmap memory before Android 8.0. Bitmap memory now lives differently, but native library leaks are still a major reason processes get killed.

When memory crosses a threshold, degrade proactively: clear Glide caches, release noncritical Views, or notify the user. Before LMK cuts you at Adj 900, you have already reduced your own footprint.

---

OOM Adj and LMK are Android's resource-allocation mechanism for finite physical memory and effectively unlimited app demand. Understanding them is not about fighting the system. It is about cooperating with it: degrade when you should, and restart cleanly when your process is reclaimed.
