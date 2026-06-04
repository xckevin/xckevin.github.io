---
title: "Android User Data Backup and Restore: Auto Backup, Key/Value Backup, and DataStore"
lang: en
translationKey: android-user-data-backup-restore
slug: android-user-data-backup-restore
excerpt: "A deep dive into Android Auto Backup and Key/Value Backup, with practical DataStore migration lessons, backup scheduling, transport encryption, restore pitfalls, and adb debugging commands."
publishDate: '2026-04-03'
tags:
- "Android"
- "Data Backup"
- "DataStore"
- "Auto Backup"
- "Architecture"
seo:
  title: "Android User Data Backup and Restore with Auto Backup and DataStore"
  description: "A practical guide to Android Auto Backup, Key/Value Backup, DataStore migration, encryption, restore timing, and adb-based backup debugging."
  pageType: article
---

Last year I took over an overseas social app where users reported losing login state after switching phones. The token had not expired; the entire SharedPreferences file had failed to restore. After investigation, I found that Auto Backup on Android 12 silently skipped a data file larger than 25 MB, with no callback notification. That pushed me to reexamine the full Android backup and restore pipeline.

## Auto Backup: "automatic" is less automatic than it sounds

Auto Backup, introduced in Android 6.0, is enabled by default for apps with `targetSdkVersion >= 23`. Its mechanism is blunt: package the app's private data directory and upload it to Google Drive, with a 25 MB limit. If the data exceeds the limit, it is skipped directly. No notification, no obvious logs. It took me three days to identify that as the root cause.

The core configuration lives in the Manifest:

```xml
<application
    android:allowBackup="true"
    android:fullBackupContent="@xml/backup_rules">
</application>
```

`backup_rules.xml` controls which files participate in backup:

```xml
<full-backup-content>
    <include domain="sharedpref" path="user_prefs.xml" />
    <include domain="database" path="app.db" />
    <exclude domain="file" path="cache/" />
    <exclude domain="external" />
</full-backup-content>
```

`<include>` creates allowlist behavior. Once any include rule is defined, all files not explicitly listed are excluded. Many developers add an include rule and forget that the previous default full-backup behavior has changed, so files disappear silently.

## BackupManagerService scheduling strategy

Auto Backup does not run immediately when the app calls `backup()`. BackupManagerService, or BMS, schedules work centrally in the SystemServer process, and its policy is conservative:

- **Minimum interval of 24 hours**: at least one day must pass between two full backups. Calling `dataChanged()` frequently does not speed this up.
- **Idle execution**: it relies on `JobScheduler` with `setRequiresDeviceIdle(true)`, so it usually runs when the device is charging and the screen is off.
- **30-minute timeout**: one backup session can run for at most half an hour. After that, the transport process is killed.

In a test environment, waiting a day to validate backup is painful. The practical debugging trick is to force the flow with `adb shell bmgr`:

```bash
# Enable backup
adb shell bmgr enable true
# Force backup now and skip interval limits
adb shell bmgr backupnow <package>
# Check current transport status
adb shell bmgr status
```

`backupnow` is a lifesaver during debugging. But it still goes through the full transport chain: data is serialized, routed through BMS to the Google Play services transport component, and finally written to Google Drive. If any link fails, the whole backup fails without detailed error information.

## Key/Value Backup: precise but tedious

The alternative to Auto Backup is Key/Value Backup, based on `BackupAgent`. It fits scenarios with small amounts of data and a need for fine-grained control. It splits app data into independent key-value pairs and transfers only changed parts each time.

```kotlin
class MyBackupAgent : BackupAgentHelper() {
    override fun onCreate() {
        // Back up SharedPreferences
        addHelper("prefs", SharedPreferencesBackupHelper(this, "user_prefs"))
        // Back up a custom file
        addHelper("db", FileBackupHelper(this, "../databases/app.db"))
    }
}
```

The key differences from Auto Backup:

| Feature | Auto Backup | Key/Value Backup |
|------|------------|-----------------|
| Backup granularity | Whole file | Single key |
| Incremental transfer | Not supported | Supported, changed keys only |
| 25 MB limit | Hard limit | No global limit, but single key <= 5 KB |
| Restore control | None | `onRestore()` can intercept |

KV Backup has clear limits: a single key's value cannot exceed 5 KB, and it is suitable only for SharedPreferences and a small number of files. After 2018, Google stopped adding major new features to it and shifted focus fully to Auto Backup.

## Transport encryption: how safe is the data path?

Backup data is protected across the path from device to Google Drive with three layers:

1. **TLS transport encryption**: BMS to Google Play services uses local IPC, while Google Play services to Google Drive uses HTTPS.
2. **Device-side encryption**: before backup data is written to Drive, it is encrypted with a key derived from the device PIN or password. Google cannot decrypt the backup.
3. **End-to-end encryption, or E2EE**: Android 9+ introduced end-to-end encryption based on the lock-screen credential. The cloud stores an encrypted blob, and restore is possible only after the user enters the correct lock-screen password.

One pitfall I hit: an app that enabled `android:fullBackupContent` but did not set `android:backupInForeground` could have backup transport interrupted by background limits on Android 12+. Add this line:

```xml
<application
    android:backupInForeground="true"
    ...>
```

During backup, it shows a non-cancelable notification in exchange for foreground process priority, significantly reducing the chance of being killed.

## Backup strategy after migrating to DataStore

After the team migrated from SharedPreferences to DataStore, the backup strategy also had to change. DataStore's `.preferences_pb` files are included in Auto Backup by default, but there are two problems:

1. **Larger file size**: DataStore uses Protobuf. For the same data volume, it is about 30%-50% larger than XML SharedPreferences. If your old SP file was already 20 MB, the migrated DataStore file may approach the 25 MB limit.
2. **Cross-process writes**: DataStore's atomic writes rely on `File.fsync()` plus temporary-file rename. If a write happens while Auto Backup is reading the file, the backup may capture an incomplete file.

The fix is to exclude `.preferences_pb` and use a custom `BackupAgent` to export DataStore into a temporary file before backup:

```kotlin
override fun onFullBackup(data: FullBackupDataOutput) {
    // 1. Serialize DataStore into temporary JSON
    val tempFile = File(context.cacheDir, "backup_snapshot.json")
    tempFile.writeText(serializeDataStore())

    // 2. Back up the temporary file
    fullBackupFile(tempFile, data)

    // 3. Clean up
    tempFile.delete()
}
```

This makes you, not the filesystem timing, responsible for deciding when the backup snapshot is taken.

## State synchronization pitfalls during restore

The more hidden backup problem is restore timing: Auto Backup restore happens after the app is installed for the first time but before `Application.onCreate()` runs. That means when initialization code starts, SharedPreferences or DataStore may already contain restored data, but your code may not be prepared for it.

One real incident: in `Application.onCreate()`, we ran a migration from old SP to DataStore. The migration logic checked whether old keys existed in SP, then overwrote DataStore. After a device replacement restore, SP existed on the new device but DataStore was empty. The migration used the old SP to overwrite data that should have been restored into DataStore.

The fix was to run migration only after restore completed:

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Delay migration until after the first Activity starts.
        // By then Auto Backup restore has completed in practice.
        registerActivityLifecycleCallbacks(...)
    }
}
```

There is no official API that tells you exactly when restore has completed, but in testing, `onActivityCreated` inside `registerActivityLifecycleCallbacks` runs after restore.

## A few practices that save time

Run `adb shell dumpsys backup` before changing code. This command prints the current backup queue, last backup time, and transport component version. Most "backup did not work" issues can be diagnosed there.

25 MB is a transport limit, not a storage limit. If your app data directory is 30 MB, do not try to compress it to 24 MB as a long-term strategy. Auto Backup's 25 MB limit applies to each transport session, not to cloud storage. Split it into two `<include>` domains of 15 MB each and it still transfers 30 MB in one session.

Clearing app data is not enough when testing restore. `adb shell pm clear` does not trigger restore because BMS still considers the app "in use." The correct path is to fully uninstall and reinstall the app, or run `adb shell bmgr restore <token> <package>` with a specific restore token.

DataStore provides better type safety and async reads and writes, but it also changes backup strategy from "copy files" to "export data." That cost is worth calculating before migration. If disaster recovery is the core requirement rather than performance, SharedPreferences plus KV Backup may actually be more stable.
