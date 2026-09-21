---
title: 'Deep Dive into Android JobScheduler: From Binder Scheduling in JobSchedulerService to Doze/App Standby Constrained Deferred Task Execution'
lang: en
translationKey: android-jobscheduler-doze-app-standby
slug: android-jobscheduler-doze-app-standby
excerpt: Starting from WorkManager scheduling, this traces JobSchedulerService's Binder entry, JobStore persistence, the StateController constraint chain, and the interception logic and debugging methods for Doze and App Standby.
publishDate: '2026-08-19'
tags:
- Android
- JobScheduler
- WorkManager
- Task Scheduling
seo:
  title: 'Inside Android JobScheduler: Binder Scheduling, Doze, and App Standby'
  description: 'A deep dive into Android JobScheduler: WorkManager JobInfo mapping, Binder scheduling, StateController constraints, Doze/App Standby, and dumpsys debugging.'
  pageType: article
---

While investigating an issue where a background task wasn't executing, I saw in the WorkManager logs that it ultimately called `JobScheduler.schedule()`. Continuing deeper into the system layer, I found that the segment from WorkManager to JobSchedulerService is blank in most articles: how constraints trigger, when a Job actually starts, and how Doze and App Standby intercept it can only be guessed at.

## From WorkManager to the Binder Entry

WorkManager uses `SystemJobScheduler` by default on API 23 and above. `schedule` maps a `WorkSpec` into a `JobInfo`: `Constraints.requiresCharging` corresponds to `setRequiresCharging`, network types map to `setRequiredNetworkType`, and `setExpedited` goes through JobInfo's expedited flag on Android 12+. After the mapping completes, it calls:

```java
JobScheduler scheduler = (JobScheduler)
    context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
scheduler.schedule(jobInfo);
```

`getSystemService` returns a Binder proxy; the real implementation is `JobSchedulerService` in system_server. `schedule()` crosses process boundaries into `scheduleAsPackage`, whose entry parameters carry the caller's uid and package name. From this moment the Job belongs to the system service and is decoupled from the initiating process. Even if the app process is killed afterward, the system still holds this Job.

## JobStore Persistence and the State Controller Chain

After JobSchedulerService receives the Job, it first hands it to `JobStore`. JobStore serializes the Job into XML, writes it to `/data/system/job/jobs.xml`, and restores it from the file after a restart. It also maintains a Job mapping table in memory, which the state machine uses for fast lookups.

What decides execution timing is the `StateController` chain. At system startup a batch of controllers is registered, each responsible for one category of constraints:

- `TimeController`: minimum latency, deadline, periodicity
- `ConnectivityController`: network type and network availability
- `BatteryController`: charging, low battery
- `StorageController`: insufficient storage
- `DeviceIdleJobsController`: Doze deep idle
- `AppIdleController`: App Standby app idle
- `QuotaController`: app execution quota
- `BackgroundJobsController`: background execution limits

Each controller implements `StateChangedListener`. When constraint conditions change, the corresponding system service calls back to the controller, which updates the Job's `satisfiedConstraints` bitmask and then triggers `evaluateControllerStatesLocked`. The evaluation logic treats all controllers as an "AND" relationship: as long as one constraint is unsatisfied, the Job stays in the pending queue. In actual projects, the "not executing" background tasks I encountered mostly stopped at this layer—either a constraint wasn't satisfied, or the controller didn't receive the state change callback.

## Doze and App Standby Interception Logic

DeviceIdleJobsController subscribes to DeviceIdleController state. After the device's screen turns off and it enters deep doze, the network and CPU freeze, all normal Jobs are suspended, and only the maintenance window releases a short window. There's an easy pitfall here: `setRequiresDeviceIdle(true)` requires the device to be idle to execute, while Doze postpones most Jobs—the two semantics are opposite.

AppIdleController reads the App Standby idle bucket. For apps in the rare or restricted bucket, the system defers Jobs to the maintenance window and limits execution frequency. WorkManager's expedited tasks can partially bypass App Standby, but they're constrained by QuotaController's quota and can't be abused.

Practical debugging tips: when a background task behaves abnormally, use `adb shell dumpsys jobscheduler` to see the Job's `unsatisfied constraints` and bucket, then use `adb shell cmd jobscheduler run -f <package> <jobId>` to force-trigger it—faster than adding logs.

## Execution Path: JobServiceContext to JobService Callback

After all constraints are satisfied, the Job enters the ready queue. `JobConcurrencyManager` allocates concurrency quotas by package name and uid to prevent a single app from filling up Job slots. Then JobSchedulerService uses `JobServiceContext` to request ActivityManagerService to bring up the target process and bind to the app's declared `JobService`.

```kotlin
class MyJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        // 异步任务返回 true，完成后必须 jobFinished
        doAsyncWork { jobFinished(params, false) }
        return true
    }
}
```

`onStartJob` runs on the main thread; if it times out without returning, it triggers an ANR, so time-consuming work must move to a background thread. After an asynchronous task completes, call `jobFinished(params, false)` to release the slot; otherwise the system keeps thinking the Job is running and continues occupying quota. JobServiceContext internally uses `BinderCallback` to track the app-side callback, and after the app crashes or times out, the system forcibly reclaims.

## Two Judgments and One Choice

To judge whether a task delay is caused by unsatisfied constraints or Doze interception, look at the Job's Ready state, pending flag, and unsatisfied constraints in dumpsys—more reliable than guessing.

On constraint design, I prefer to give hard constraints like network and charging to JobScheduler, and put business preconditions in app-side checks. System constraints can enter the maintenance window for unified scheduling, while app-side conditions only make the task lie in the queue. For timing tasks, prefer `setPeriodic` over `setMinimumLatency` plus infinite rescheduling: the former benefits from battery optimization windows, while the latter refreshes the Job record on every reschedule.
