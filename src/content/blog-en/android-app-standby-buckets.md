---
title: "Android App Standby Buckets: Background Resource Limits Explained"
lang: en
translationKey: android-app-standby-buckets
slug: android-app-standby-buckets
excerpt: "How Android classifies app activity, applies background execution limits, and how to design work that remains reliable under standby restrictions."
publishDate: '2026-06-26'
tags:
- "Android"
- "Power Management"
- "Background Execution"
- "JobScheduler"
seo:
  title: "Android App Standby Buckets and Background Limits"
  description: "Understand Android App Standby Buckets, resource restrictions, and resilient background-work strategies."
  pageType: article
---

## A "ghostly" background task delay

When troubleshooting an online problem last year, a user's JobService was delayed for 6 hours in execution. The same code runs normally on another device and there are no errors in the logs. After following for three days, I finally located the cause - on that device, the system put the application into the "Rare" standby bucket, and the minimum delay of the JobScheduler was forcibly extended to 24 hours.

The root of the problem is not in the code, but in the App Standby Buckets mechanism introduced in Android 9. It's not an edge optimization strategy - starting with Android 11, it's a constraint layer that all background task scheduling cannot bypass.

## Bucketing model: five levels of resource quotas

Android dynamically allocates each application to a standby bucket based on how frequently the user uses the application. The level of the bucket directly determines how many background resources the application can obtain:

```text
Active              → In foreground use; almost unrestricted
Working Set         → Used often; lightly restricted
Frequent            → Used periodically; moderately restricted
Rare                → Seldom used; strongly restricted
Restricted          → Never used or manually restricted; background work is nearly frozen
```

The fewer applications a user has open, the smaller the background quota given by the system. This is a key change in the power saving strategy from coarse-grained one-size-fits-all to fine-grained scheduling based on usage behavior. The definition of each bucket is already detailed in the official documents and will not be repeated here. Focus on two things: **how the system determines which bucket your application falls into**, and **the specific restrictions on each bucket**.

## Bucketing algorithm: How the system determines the "heat" of an application

### Signal collection and timestamp

The system makes decisions based on the timestamps of the following interaction events, and the data is recorded in the `UsageStatsManager` data set:

- The application is launched (Launcher click, Intent evoked)
- The user interacts with the foreground Activity
- The user clicked on a notification from the app
- The app appears and is viewed in the Recent Tasks view

These events are aggregated by application and entered into a **weighted time decay model** for scoring.

### The core logic of the attenuation model

The system does not simply count "how many times it has been opened in the last N days". Each interaction event is weighted by exponential decay according to the time of occurrence - yesterday's launch weight is much higher than a week ago, and events older than about 45 days contribute almost no effective weight.

The decay function is not disclosed in the document, but it can be inferred from the implementation of the `AppIdleHistory` class in AOSP: the system maintains an event count matrix based on time buckets, and the more recent time buckets have greater weight.

Use `UsageStatsManager.queryEvents()` to do an approximate calculation locally:

```kotlin
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
val endTime = System.currentTimeMillis()
val beginTime = endTime - 45 * 24 * 60 * 60 * 1000L

val events = usm.queryEvents(beginTime, endTime)
val appEvents = events.filter { it.packageName == packageName }
// Apply time-decay weighting locally to estimate the system's likely bucket.
```

The system gets more complete data than you do - it will also fine-tune the bucketing results based on factors such as device charging status and Doze mode active cycle.

### Adaptive Bucket: ML-assisted prediction

Android 11 introduces “Adaptive Bucket”. The device runs a lightweight prediction model, infers which applications the user is likely to open next based on historical usage patterns, and promotes them to a higher bucket in advance.

This explains a situation that developers often encounter: an application has not been used for several weeks, but its job is still running very fast - it may have been pulled up in advance by the prediction model. The model logic runs in closed source at the system service layer, and developers cannot intervene, but at least it shows that bucketing is not purely mechanical time statistics.

## Limit gradient: resource suppression in three dimensions

Bucketing results are directly mapped to restrictions on the three major resource dimensions.

### JobScheduler delay forced extension

This is the most widely affected restriction. The system imposes a minimum delay on the execution window of the underlying tasks of `JobScheduler` and `WorkManager`:

| Bucket | Minimum delay (approximately) | Longest execution of a single Job |
|---|---|---|
| Active | Unlimited | Unlimited |
| Working Set | ~2 minutes | ~10 minutes |
| Frequent | ~8 minutes | ~10 minutes |
| Rare | ~24 hours | ~10 minutes |
| Restricted | Almost never executed | Almost never executed |

These values are affected by Doze mode stacking, with the final delay being the stricter of the two. The 24-hour minimum delay of the Rare bucket means that the 15-minute periodic Job you set is completely invalid in that bucket.

### AlarmManager hard current limit

Starting from Android 12, `setExact()` and `setWindow()` are forced to add a minimum trigger interval in the low bucket position:

- Frequent: at least 15 minutes between alarms
- Rare: at least 1 hour apart
- Restricted: completely blocks non-exempt alarms

`setExactAndAllowWhileIdle()` cannot circumvent this limitation. If your application relies on accurate alarm clocks for data synchronization, this solution is basically useless in the Rare and Restricted buckets.

### Chain attack between network and FCM

Restricted buckets experience additional suppression at the network level in Android 11+:

-Background network access is completely cut off, the behavior is equivalent to turning on power saving mode
- FCM high-priority messages are forcibly downgraded, and delivery delays increase from seconds to minutes or even hours.
- Some systems have limited access to ContentProvider

## Query and debugging: know which bucket you are in

### Query the current bucket position during runtime

```kotlin
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
when (usm.appStandbyBucket) {
    UsageStatsManager.STANDBY_BUCKET_ACTIVE -> { /* Run at full speed. */ }
    UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> { /* Reduce frequency moderately. */ }
    UsageStatsManager.STANDBY_BUCKET_FREQUENT -> { /* Batch work. */ }
    UsageStatsManager.STANDBY_BUCKET_RARE -> { /* Do only essential work. */ }
    UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> { /* Forego background work. */ }
}
```

### adb manual intervention

```bash
# Show the current bucket.
adb shell am get-standby-bucket com.example.app

# Force a bucket (10=Active, 20=Working Set, 30=Frequent, 40=Rare, 45=Restricted)
adb shell am set-standby-bucket com.example.app rare

# Restore automatic bucketing.
adb shell am set-standby-bucket com.example.app reset
```

`set-standby-bucket` is usually disabled on user version devices and needs to be enabled in the developer options. A more practical debugging method is `adb shell dumpsys usagestats` - it outputs the complete bucket allocation history and event log, and the amount of information is much larger than `am get-standby-bucket`.

### An easily overlooked behavioral characteristic

The system will send an ACTION_STANDBY_BUCKET_CHANGED broadcast when the bucket level changes, but the broadcast of the bucket level falling will not wake up your process. You can only check the current state while the application is running to determine the execution strategy of the current task - you cannot "reactively react" to degradation in the broadcast receiver.

## Adaptation idea: Design to degrade execution rather than refuse execution

When the team was doing power-saving adaptation, they encountered a pitfall: if they judged that the bucket position was too low, they would just return and do nothing. This is bad from a product perspective - users occasionally open your app and find that the data is all old.

A more reasonable strategy is to perform gradient downgrade by bucket position:

```kotlin
fun scheduleSync(bucket: Int) {
    when (bucket) {
        STANDBY_BUCKET_ACTIVE ->
            WorkManager.enqueuePeriodicSync(minutes = 15)
        STANDBY_BUCKET_WORKING_SET ->
            WorkManager.enqueuePeriodicSync(minutes = 120)
        STANDBY_BUCKET_FREQUENT ->
            WorkManager.enqueueDailySync()
        STANDBY_BUCKET_RARE ->
            WorkManager.enqueueOnChargeOrAppOpen()
        else -> { /* Restricted: wait for the user to open the app. */ }
    }
}
```

WorkManager has made some internal adaptations to bucketing, but don't rely entirely on its default behavior - explicit judgment combined with its own business logic is more controllable than black-box trust.

For applications that rely heavily on push, FCM high-priority messages (`priority=high`) will temporarily promote the application to the Active bucket when sending, but Android 12+ limits the frequency to about 20 times per day. After the limit is exceeded, the message is degraded and the delay is uncontrollable. If your business really needs real-time access, the safest way is to guide users to set your app to "No Optimization" in the "Battery Optimization" settings.

**Exemption scenarios that are not restricted by standby bucketing**: The application is running in the foreground, holding foreground services, the device is charging (some restrictions are relaxed), and the user is whitelisted in battery optimization. However, starting from Android 14, the foreground service requires the notification bar to be visible and cannot be used as a means to keep the background alive.

## Evolution trajectory and design mentality

Looking back from Android 6’s Doze mode, the evolution of power saving strategies is a clear tightening line:

- **Doze (Android 6)**: Freeze the background roughly, regardless of application
- **Standby Buckets (Android 9)**: Introducing the concept of bucketing and differentiation restrictions
- **Restricted Bucket (Android 11)**: Add a fifth level to suppress "zombie applications" to the maximum extent
- **Android 12+**: Continue to tighten time limits and network policies for low buckets

The effect of this mechanism is visible in actual measurements - Google's internal data shows that standby power consumption is reduced by 15% to 25%. The cost is passed on to the developer: you can't assume that background tasks will always run on time.

At the beginning of the design, it is assumed that your application is running in a Rare bucket, and then "functional enhancement" is made for higher-level buckets instead of "functional reduction" for lower-level buckets. This kind of reverse design can avoid the embarrassment of discovering that large areas of background logic have silently failed after going online. Make good use of `dumpsys usagestats` when debugging, it exposes much richer internal system state than API queries.
