---
title: "Android Health Connect: FHIR Data Modeling, Permissions, and Sync"
lang: en
translationKey: android-health-connect-fhir
slug: android-health-connect-fhir
excerpt: "A deep dive into Android Health Connect, covering its FHIR-style data model, fine-grained permissions, changes-token incremental sync, and local-first aggregation architecture."
publishDate: '2025-07-31'
tags:
- "Android"
- "Health Connect"
- "Health Data"
- "FHIR"
- "On-device Architecture"
seo:
  title: "Android Health Connect: FHIR Data, Permissions, and Sync"
  description: "Explore Android Health Connect from its FHIR-style record model and granular permissions to changes-token sync and practical integration trade-offs."
  pageType: article
---

While building a health app, I once hit a frustrating issue: step counts recorded in Samsung Health appeared 30% lower when read inside our own app. After digging in, we found that both apps maintained their own sensor sampling and step-counting logic, and their algorithms simply did not agree. This was not a bug in one app. It was a symptom of the long-standing fragmentation in Android health data.

Health Connect is Google's system-level health data platform built into Android 14. Its goal is to solve that fragmentation. It acts as an on-device data aggregation layer: apps read and write health data through a unified API, and users manage all permissions from one system panel. The idea is similar to iOS HealthKit, but the implementation has several Android-specific design choices.

## FHIR data model: more than key-value storage

Health Connect's data model follows the ideas of **FHIR (Fast Healthcare Interoperability Resources)**, the healthcare data exchange standard defined by HL7. Google adapted and trimmed the model for mobile devices while keeping the core modeling approach.

The central abstraction is **Record**. All health data types inherit from the `Record` base class. Health Connect currently supports more than 50 record types, grouped roughly by use case:

- **Vitals**: `HeartRateRecord`, `BloodPressureRecord`, `BodyTemperatureRecord`
- **Activity data**: `StepsRecord`, `DistanceRecord`, `CaloriesBurnedRecord`
- **Sleep**: `SleepSessionRecord`, including sleep stages such as deep sleep, light sleep, and REM
- **Nutrition**: `NutritionRecord`, covering macro- and micronutrients
- **Reproductive health**: `MenstruationPeriodRecord`, `OvulationTestRecord`

Every Record carries three key fields: start and end time, source package name, and metadata. You can trace exactly which app wrote a step record and which time window it belongs to. When data does not line up, that traceability directly determines how quickly you can debug the issue.

The aggregation layer also does one important thing for you: **automatic aggregation**. For steps, for example, you do not need to store hourly totals and then compute daily totals yourself. Health Connect maintains hourly and daily aggregation views as data is written. When reading, `aggregateGroupByPeriod` can return daily totals directly, avoiding custom SQL for time-window aggregation.

```kotlin
// Read daily step counts for the last 7 days
val response = healthConnectClient.aggregateGroupByPeriod(
    AggregateGroupByPeriodRequest(
        metrics = setOf(StepsRecord.COUNT_TOTAL),
        timeRangeFilter = TimeRangeFilter.between(
            startTime, endTime
        ),
        timeRangeSlicer = Period.DAY
    )
)
response.forEach { result ->
    val steps = result.result[StepsRecord.COUNT_TOTAL] ?: 0L
    val date = result.startTime // Midnight for that day
}
```

Aggregation is calculated in UTC. If your users are spread across time zones, the UI needs to apply the proper offset. Otherwise, steps taken at 1 a.m. may appear under the previous day, and users will report that the numbers are wrong.

## Permission control: from broad access to fine-grained scope

The traditional Android permission model is broad: once location permission is granted, an app can read location whenever allowed by the platform rules. Health Connect does not use that model. It defines its own **per-data-type, read/write-separated** permission system across three dimensions.

**Dimension 1: data type.** Each Record type is its own permission unit. To read steps, an app declares `androidx.health.permission.Steps.READ`. To write heart rate, it declares `androidx.health.permission.HeartRate.WRITE`. There is no fallback permission that means "read all health data."

**Dimension 2: read/write separation.** Read and write are separate permissions for the same data type. This is not overengineering. A sleep-tracking app may only need to write sleep data and should not need access to a user's activity records. With separation, users can control each app's data access precisely.

**Dimension 3: foreground/background access.** Reading health data in the background requires the separate `READ_HEALTH_DATA_IN_BACKGROUND` permission. A subtle trap: foreground and background access appear as two toggles in the same permission panel, so the user experience has no second jump, but the permission logic is completely independent. If you forget to request background access separately, reads will silently fail after the app moves to the background, which is painful to debug.

The declaration style also differs from traditional `AndroidManifest` permissions:

```xml
<!-- AndroidManifest.xml -->
<activity>
    <intent-filter>
        <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE"/>
    </intent-filter>
</activity>
```

On the first permission request, the system opens the Health Connect permission panel. This is system UI, so apps cannot customize its styling. That keeps permission management consistent across apps. In real testing, panel launch speed depends heavily on device performance. It opens almost instantly on a Pixel 6, but some mid-range devices can show a white screen for 1-2 seconds. Add a short transition before requesting permissions so the experience does not feel broken.

## Cross-app sync: the changes-token design

When multiple apps read and write at the same time, the hardest problem is **data consistency**. If one fitness app writes 5,000 steps and another updates the same time range to 4,800 steps, how does your app know that the data changed?

Health Connect solves incremental sync with a **Changes Token** mechanism.

The core flow is simple:

```text
App A writes data -> Health Connect creates a change record -> Global changes token is updated
App B requests changes with its previous token -> Health Connect returns delta data plus a new token
```

At the code level:

```kotlin
// Initial full sync plus token acquisition
val response = healthConnectClient.getChanges(
    ChangesRequest(changesToken = null) // null means full sync
)
val token = response.changesToken // Persist locally

// Later incremental sync
val deltaResponse = healthConnectClient.getChanges(
    ChangesRequest(changesToken = token)
)
deltaResponse.changes.forEach { change ->
    when (change) {
        is Change.Upsert -> processNewRecord(change.record)
        is Change.Deletion -> removeRecord(change.recordId)
    }
}
// Save the new token
saveToken(deltaResponse.changesToken)
```

There are several implementation details worth watching.

**Write deduplication strategy.** Each Health Connect Record type has a corresponding **idempotency key**. Steps are deduplicated by `(startTime, endTime)`, while heart rate is deduplicated by `(time, type)`. Repeated writes from the same app with the same key overwrite instead of append. Across apps, records are kept separately because the source package name differs.

**Sync timing does not depend on FCM.** HealthKit on iOS can use background delivery to trigger sync, but Health Connect chose a **purely local polling** model. Google's rationale is privacy first: less cloud involvement means a smaller data exposure surface. In production, use `WorkManager` for periodic pulls and keep the interval at 15 minutes or longer to avoid excessive wakeups and battery drain.

**Deletion is not immediate disappearance.** After `deleteRecords` is called, other apps receive a `Change.Deletion` record through `getChanges`; the data does not simply vanish from their perspective. This gives every app a window to handle deletion events, but it also means you need a local list of deleted records to filter historical data.

## Local aggregation architecture trade-offs

Health Connect stores all data locally using a Room database plus encrypted filesystem storage. Aggregation and change tracking happen entirely on the device, with no server involved. This local-first architecture has several direct consequences.

**Storage overhead is manageable.** With 30 consecutive days of steps, heart rate, and sleep data, including one heart-rate sample per minute, the Health Connect database is roughly 15 MB. On Android 14, Health Connect runs as a system service and is not constrained by your app's storage quota, so space is usually not a major concern.

**Backup does not include health data itself.** Health Connect uses the Android system backup channel, but **only metadata and permission configuration are backed up**, not the health records. Apps must provide their own export path for user health data. This design trades off privacy and user experience, but there is still no good cross-app export standard. Exporting to Google Fit is possible; exporting elsewhere is much more awkward.

**Cross-device sync depends on a Google account.** Under the same account, health data can migrate automatically when users switch phones. This is a Google Play Services capability and is effectively unavailable in markets where Play Services is not present. If you target those markets, you need to build your own sync system.

## Practical integration notes

After integrating Health Connect end to end, a few lessons had a real impact on development efficiency.

**Check availability before initialization.** Health Connect is a system service on Android 14, but on Android 9-13 it exists as a standalone app that users install from the Play Store. `HealthConnectClient.isAvailable()` is more reliable than hard-coding OS version checks.

**Aggregation queries have performance traps.** `aggregateGroupByPeriod` can become problematic across multi-month ranges. For 90 days of second-level heart-rate data, the query can take more than 2 seconds. A better approach is to use the `Changes` mechanism for a local cache and run aggregation only on incremental data.

**Data types evolve by version.** Health Connect data types change over time through new fields and deprecated fields. When handling Records, use null-safe checks and do not assume that a field is always present. One real pitfall: older versions of `HeartRateRecord` did not have `heartRateVariability`, and code that skipped null checks crashed with an NPE.

**Handle revoked permissions.** Users can revoke any data-type permission from system settings at any time, and the app receives no callback. The only reliable approach is to handle the result of every read and write. If a `SecurityException` is returned, guide the user to grant access again. The experience is not ideal, but there is no better option for now.

Health Connect is not perfect. The local-first architecture still leaves gaps around cross-device sync, and some ecosystems require additional adaptation. But its FHIR-style data model and fine-grained permission system establish a solid baseline for Android health data. If your app needs to read or write health data, integrating now is likely cheaper than waiting and migrating later.
