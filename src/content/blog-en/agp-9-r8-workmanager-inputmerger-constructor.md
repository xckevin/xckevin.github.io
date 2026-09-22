---
title: 'AGP 9 R8 Keep Rules: Fixing a WorkManager InputMerger Upload Failure'
lang: en
translationKey: agp-9-r8-workmanager-inputmerger-constructor
slug: agp-9-r8-workmanager-inputmerger-constructor
excerpt: 'An AGP 9.0.1 migration removed a constructor needed by WorkManager 2.8.1. Analytics uploads fell back to disk scanning, distorting arrival-time ordering.'
publishDate: '2026-09-22'
tags:
  - Android
  - AGP
  - R8
  - WorkManager
  - Observability
seo:
  title: 'AGP 9 R8 Keep Rules: WorkManager InputMerger Constructor Fix'
  description: 'Debug a WorkManager 2.8.1 upload failure after AGP 9.0.1: preserve the InputMerger constructor, verify minified builds, and explain arrival-time ordering.'
  pageType: article
---

While adapting Android app version 8.55.0 to a newer operating system, the project upgraded Android Gradle Plugin (AGP) from 8.6.0 to 9.0.1. An analytics anomaly followed: the collector eventually received the events, but several shared the same `crt_ms`, and sorting by that field placed the home-page event after later page events.

In this system, **`crt_ms` is the collector's receive or ingestion time**, not the time an event occurred on the client. Investigation found that the normal WorkManager upload path had failed. A fallback process scanning persisted log files eventually delivered the events, hiding the failure behind apparently complete data.

The underlying problem was in the minified artifact: R8 had removed the no-argument constructor of `OverwritingInputMerger`, breaking WorkManager's reflective instantiation. The fix explicitly preserves that constructor.

This article records the diagnosed cause and prepared fix. At the time of writing, the app fix was scheduled for release that day; post-release recovery measurements were not yet available. The regression checks below are proposed acceptance criteria.

## The affected versions and upload paths

| Component | Incident details |
| --- | --- |
| Affected app version | Android 8.55.0 |
| AGP migration | 8.6.0 → 9.0.1 |
| WorkManager | 2.8.1 |
| Affected build | Release build with R8 shrinking and obfuscation |
| Removed member | `androidx.work.OverwritingInputMerger.<init>()V` |
| Observed impact | Normal uploads failed; fallback delivery distorted ordering based on collector timestamps |

The normal pipeline persists logs before scheduling an asynchronous upload:

```text
Page event → Batch logs → Write files to disk
                                  ↓
                        Schedule WorkManager upload
                                  ↓
                        Initialize InputMerger → Upload
```

A separate fallback periodically scans persisted files and immediately attempts to upload pending logs. During this incident, the normal path stopped at InputMerger initialization, while the files remained available to that fallback. No data loss was found within the investigated logs.

That observation does not establish that delivery was healthy or that the fallback prevents every possible loss. File cleanup, corruption, or app removal can still affect pending data. What this case establishes is narrower: the observed events eventually arrived, with changed delivery timing.

## AGP 9 changed an implicit keep-rule behavior

The [AGP 9 behavior changes](https://developer.android.com/build/releases/agp-9-0-0-release-notes#behavior-changes) document a new default of `true` for `android.r8.strictFullModeForKeepRules`. A class-only rule no longer implicitly preserves its no-argument constructor:

```proguard
-keep class A
```

When that constructor is required, declare it explicitly:

```proguard
-keep class A {
    <init>();
}
```

The official defaults table compares AGP 8.13 with 9.0; this application's actual migration was 8.6.0 to 9.0.1. When investigating another project, also check for explicit property overrides.

Two distinctions matter. R8 full mode was already enabled by default in AGP 8.0; AGP 9 did not introduce that default. This incident concerns the constructor-retention behavior of keep rules. See the [AGP 8.0 release notes](https://developer.android.com/build/releases/agp-8-0-0-release-notes#default-changes).

Also, describing `-keep class A` as “keeping only the class name” is inaccurate. Plain `-keep` constrains class removal, renaming, and optimization. The missing contract is at the member level: preserving a class does not explicitly preserve every member accessed through reflection. See the [R8 keep-rule guide](https://developer.android.com/topic/performance/app-optimization/add-keep-rules).

## Why WorkManager 2.8.1 was affected

### The class survived, but its constructor did not

The published `work-runtime` 2.8.1 AAR contains this consumer rule:

```proguard
-keep class * extends androidx.work.InputMerger
```

There is no member block. The rule relied on the earlier implicit retention of a no-argument constructor. It can be checked in `proguard.txt` inside the official [WorkManager 2.8.1 AAR](https://dl.google.com/dl/android/maven2/androidx/work/work-runtime/2.8.1/work-runtime-2.8.1.aar); the current development branch is not evidence of what this older artifact shipped.

`OverwritingInputMerger` is a public Java subclass of `InputMerger` with no explicit constructor in that release. Compilation therefore provides a public no-argument constructor. In the affected app's Release artifact, subsequent R8 processing retained the class but removed `<init>()V`.

In this descriptor, `<init>` identifies an instance constructor, `()` means no parameters, and `V` is the return-type marker. Finding the class name in an artifact is insufficient: the specific member must also exist.

### Failure happened before the upload Worker started

WorkManager 2.8.1 first asks the configured `InputMergerFactory` for an instance. If it returns `null`, `createInputMergerWithDefaultFallback()` falls back to `InputMerger.fromClassName()`. This incident failed in that default reflection branch:

```java
Class<?> clazz = Class.forName(className);
return (InputMerger) clazz.getDeclaredConstructor().newInstance();
```

If the class exists but the constructor does not, constructor lookup fails. The method catches `Exception`, **records an error through `Logger`, and returns `null`**. The failure is not propagated to the business caller as an exception, but it is not completely unlogged either. The implementation is available in `InputMerger.java` and `InputMergerFactory.java` in the official [2.8.1 sources JAR](https://dl.google.com/dl/android/maven2/androidx/work/work-runtime/2.8.1/work-runtime-2.8.1-sources.jar).

In that release's `WorkerWrapper.java`, the non-periodic execution branch checks the returned merger. A `null` result causes an error log, `setFailedAndResolve()`, and an early return. The task is marked failed; along the normal execution path, business Worker creation has not yet happened.

Monitoring HTTP responses or exceptions inside `doWork()` can therefore miss this failure: the upload never reaches those points. It is also distinct from a Worker returning `Result.retry()` and entering backoff.

InputMerger combines WorkRequest input `Data`. It does not merge analytics log files or assign their `crt_ms`. Periodic work uses a different input-handling branch here in 2.8.1, so this finding should not be generalized to every WorkManager task.

## Why the logs arrived but appeared out of order

The system has two separate timelines:

| Timeline | Meaning | Suitable for reconstructing page behavior? |
| --- | --- | --- |
| Client event time | When the user action occurred | Requires clock and within-session ordering considerations |
| `crt_ms` | When the collector received or ingested the event | No; queueing, fallback delivery, and ingestion affect it |

An early home-page event can remain on disk after the normal upload fails and arrive only during a later fallback scan. Grouped delivery can also produce identical or closely clustered ingestion timestamps. Sorting by `crt_ms` then reflects collection timing, not the original page sequence.

There is an important limit to this explanation: **equal timestamps alone do not establish why the home-page event occupies a particular position.** Ties depend on secondary sort keys, read or write order, and query behavior. The evidence shows why `crt_ms` cannot reconstruct event order; explaining one record's exact position requires the relevant batch and query ordering details.

For future data design, separate these concerns:

- Capture `event_time_ms` when the event first occurs and preserve it through retries.
- Use a `session_id` and monotonically increasing `event_seq` to help reconstruct local order.
- Give each event a stable `event_id` shared by normal and fallback delivery for deduplication.
- Record collector time separately, alongside upload path, batch, and attempt information.

These are proposed improvements, not fields claimed to exist in the current system. Client clocks can drift, and sequences need defined behavior across process restarts and concurrent producers. They provide additional evidence about event semantics, not a universal order across devices.

## The fix: explicitly retain the public no-argument constructor

The prepared fix adds this rule to the application's rules file used by the Release build:

```proguard
-keep class * extends androidx.work.InputMerger {
    public <init>();
}
```

It preserves matching InputMerger subclasses and their public no-argument constructors, including the constructor required here. It does not retain every member of the entire `androidx.work` package.

A narrower alternative targets only this implementation:

```proguard
-keep class androidx.work.OverwritingInputMerger {
    public <init>();
}
```

These are scope choices; both are not needed for this issue. This case uses the first rule to cover other InputMerger subclasses with the same public no-argument construction contract. It does not preserve non-public constructors or constructors with parameters. Custom implementations need rules matching their actual creation path.

A WorkManager upgrade can be evaluated separately. Inspect the target release's published consumer rules and verify the resulting minified app; a higher dependency version alone is not proof that the reflection contract is satisfied.

## Validate the artifact and the normal upload path

A working Debug build, a successful compilation, or eventual collector receipt cannot independently prove this fix. Validation must cover both the minified artifact and the path that previously failed.

### Check the resolved dependency and merged rules

These example commands run in the Android application project. Adjust the module and variant names:

```bash
./gradlew :app:dependencyInsight \
  --dependency work-runtime \
  --configuration releaseRuntimeClasspath

./gradlew :app:assembleRelease

rg -n -A 4 'InputMerger' \
  app/build/outputs/mapping/release/configuration.txt
```

Dependency resolution confirms the version actually used. The merged `configuration.txt` establishes whether the fix reached R8. Next, inspect the final APK's DEX and confirm that `OverwritingInputMerger` contains a public `<init>()V`. For an AAB release, inspect the corresponding installable APK artifacts.

A class name in `mapping.txt`, a constructor in the original AAR, or a keep rule in a configuration file does not independently establish member retention in the final artifact.

### Exercise both delivery paths

| Regression scenario | Acceptance evidence |
| --- | --- |
| Normal upload from a minified Release build | Upload Worker starts, work succeeds, and expected events arrive |
| Isolate fallback scanning in a test environment | Normal delivery succeeds independently of fallback |
| Introduce a temporary upload failure, then recover | Persisted files are delivered without duplicate event counting |
| Generate home-page and subsequent page events | Validate event order using event semantics; inspect collector timing separately |

Observe relevant `WorkInfo` states, business Worker startup, and InputMerger instantiation errors as well as network outcomes. Normal-path success rate, fallback-delivery share, and the age of the oldest pending file can expose failures hidden by aggregate event volume.

These checks require the application project and its test environment. This article verifies the official release documentation and published WorkManager 2.8.1 sources; it does not present the proposed checks as completed production validation.

## Use AI to find candidates, then verify actual usage

After identifying this failure, an AI-assisted scan looked for similar risks and flagged a class named `InitializationProvider`. A human review confirmed that this candidate was no longer used in the application, so it was not treated as an active path requiring the same repair.

That conclusion applies only to the candidate in this project. It says nothing about identically named classes elsewhere, and does not imply that initialization providers can generally be ignored.

This kind of scan can locate intersections between reflective construction and keep rules missing required members. Human review must then check the exact class, merged manifest, dependencies and initialization entry points, final DEX, and execution evidence. Neither a search for `Class.forName` nor a manifest-only review covers every dynamic creation path.

The incident exposed two separate gaps: the build upgrade surfaced an implicit constructor dependency, while fallback delivery hid the primary-path failure in volume metrics. The keep-rule fix restores the required member. Release acceptance still needs to establish that normal uploads recover and that event time remains distinct from collector time.

## Related reading

- [Android Gradle and AGP 9 migration](/en/android-gradle-agp-9/): define the scope of build-tool migration checks.
- [Android WorkManager scheduling](/en/blog/android-workmanager-scheduling/): understand constraints, scheduling, and task chains.
- [Android CI/CD quality gates](/en/blog/android-ci-cd-quality-gates/): include Release artifacts and critical execution paths in validation.
