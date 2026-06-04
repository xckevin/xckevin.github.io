---
title: "Android CI/CD Pipeline: ktlint, Detekt, Testing, and Firebase"
excerpt: "A practical Android CI/CD pipeline from ktlint and Detekt code-quality checks to Gradle Managed Devices, versioning, and Firebase App Distribution."
publishDate: '2025-06-23'
lang: en
slug: android-ci-cd-ktlint-detekt-firebase-pipeline
translationKey: android-ci-cd-ktlint-detekt-firebase-pipeline
tags:
- Android
- CI/CD
- Code Quality
- Automated Testing
- Firebase
seo:
  title: "Android CI/CD: ktlint, Detekt, Testing, Firebase Delivery"
  description: "A practical Android CI/CD flow covering ktlint and Detekt static analysis, Gradle Managed Devices, versioning, and Firebase App Distribution."
  pageType: article
---

```bash
./gradlew ktlintCheck
```

If the project has not adopted ktlint yet, the easiest way in is the ktlint-gradle plugin. Add an `.editorconfig` and you are done; there is no need to write an extra rule file.

**Detekt** handles deeper static analysis: cyclomatic complexity, null-safety risks, and naming rules. One pitfall I ran into was enabling every default Detekt rule at once. CI produced so many false positives that the team disabled the step entirely. The better approach is to start with only error-level rules, run that for a week, then tighten the configuration gradually based on the false positives you actually see.

```kotlin
// Detekt configuration: block only error-level issues in CI.
detekt {
    buildUponDefaultConfig = true
    allRules = false
    config = files("$rootDir/detekt/detekt.yml")
}
```

## Automated Testing: Emulators Are Scarce Resources

There is not much mystery around unit tests: `./gradlew test` with JUnit 5 and MockK is standard practice. The pain point is instrumentation testing.

Instrumentation tests need an emulator, and emulator startup is one of the least stable parts of CI. My solution is **Gradle Managed Devices**, letting Gradle manage the emulator lifecycle itself:

```kotlin
// app/build.gradle.kts
android {
    testOptions {
        managedDevices {
            devices {
                pixel6Api34(com.android.build.api.dsl.ManagedVirtualDevice) {
                    device = "Pixel 6"
                    apiLevel = 34
                    systemImageSource = "aosp"
                }
            }
        }
    }
}
```

The pipeline only needs one command:

```bash
./gradlew pixel6Api34DebugAndroidTest
```

This is far more stable than the old manual `adb wait-for-device` approach. Gradle automatically retries common failures such as emulator startup errors, leftover processes, and corrupted snapshots. The only real cost is downloading the system image, roughly 2 GB the first time, which becomes negligible after caching.

For test strategy, I only cover core paths: login, payment, and the most important business workflows. UI details are covered with Compose Preview screenshot tests, which are about 10 times faster than instrumentation tests and cheaper to maintain.

## Build Artifacts and Version Management

After tests pass, the pipeline moves into the build stage. Version-number strategy is an easy detail to overlook.

Using the same `versionName` for every CI build is setting yourself up for trouble. Every package in QA's hands is called `1.0.0`, so bug reports cannot tell you which build they came from. In my pipeline, I append the first seven characters of the commit hash:

```bash
VERSION_SUFFIX=$(git rev-parse --short HEAD)
./gradlew assembleDebug \
    -PversionName="1.0.0-${VERSION_SUFFIX}"
```

Gradle also generates a `build-info.json` file with the build time, branch, and commit, then uploads it together with the APK:

```json
{
  "versionName": "1.0.0-a3f2b1c",
  "buildTime": "2026-06-01T10:23:45Z",
  "branch": "feature/payment-refactor",
  "commit": "a3f2b1c9"
}
```

This file is much faster than digging through CI logs during incident analysis. You can grep the corresponding version and immediately get the full build context instead of searching through a pile of build records.

## Firebase App Distribution: Closing the Last Mile

Once the package is built, how do you get it into testers' hands? I have seen teams send APKs through WeCom, share cloud-drive links, or drop files directly into group chats. Those approaches have two fatal problems: no version tracking and no installation feedback.

Firebase App Distribution solves both. Integration is not complicated:

1. Enable App Distribution in Firebase Console
2. Upload with Firebase CLI or the Gradle plugin
3. Configure tester groups

The CI distribution step uses the Gradle plugin:

```kotlin
// Root build.gradle.kts
plugins {
    id("com.google.firebase.appdistribution") version "4.1.0"
}
```

```bash
# Upload in the pipeline and notify the tester group automatically.
./gradlew appDistributionUploadDebug \
    -PserviceCredentialsFile=$FIREBASE_CREDENTIALS \
    -PfirebaseAppDistributionArtifacts="app/build/outputs/apk/debug/app-debug.apk" \
    -PfirebaseAppDistributionGroups="qa-team"
```

One security point matters: **do not** commit the Firebase service-account JSON file to the repository. I store the base64-encoded content in GitHub Secrets, then decode it into a temporary file at pipeline runtime:

```bash
echo "$FIREBASE_SERVICE_ACCOUNT_B64" | base64 -d > /tmp/firebase-creds.json
```

Testers receive an email or notification and install directly. The Firebase dashboard shows who installed which version. After a new version is released, users on older builds receive an upgrade prompt when they open the app, which noticeably shortens the testing feedback loop.

## Practical Lessons from Engineering Delivery

After running this pipeline for half a year, a few lessons stand out:

**Parameterize environment switching**. Do not write separate workflow files for dev, staging, and production. Use `workflow_dispatch` inputs to control environment variables so one configuration covers all scenarios.

**Keep caching precise**. Overly broad Gradle caching makes the pipeline bloated. Cache `.gradle/caches` and `build-cache` separately; seven days is enough for the former, and three days is enough for the latter.

**Do not rely only on email for failure notifications**. Push CI failures to Slack or Lark with the commit link and a short failure-log summary. Discovering the failure in email the next morning means a whole day's worth of merged code may have been wasted.

For a small team, fewer than five people, first make static analysis and automated distribution solid. Instrumentation tests can cover only the core cases. Trying to roll out everything at once often gets abandoned because the maintenance cost is too high. That kind of CI zombification is worse than having no CI at all.
