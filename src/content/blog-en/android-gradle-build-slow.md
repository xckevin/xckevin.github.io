---
title: "How to Analyze a Slow Android Gradle Build"
lang: en
translationKey: android-gradle-build-slow
slug: android-gradle-build-slow
excerpt: "A practical path for analyzing slow Android Gradle builds, including Build Scan, Configuration Cache, KSP, task dependencies, and cache hits."
publishDate: '2026-06-01'
tags:
- "Android"
- "Gradle"
- "Mobile Engineering"
seo:
  title: "How to Analyze Slow Android Gradle Builds: Configuration Cache and Task Hygiene"
  description: "Learn how to diagnose slow Android Gradle builds across Build Scan, Configuration Cache, KSP, task dependencies, cache hits, and CI optimization."
---

When an Android build feels slow, do not start by swapping plugins or buying bigger machines. Build time is the combined result of configuration, task execution, compilers, cache hits, and the CI environment. If you do not separate those layers, your optimization work will probably land in the wrong place.

This article is not a full build-speed playbook. It focuses on the analysis path: how to figure out where the build is slow, which numbers are worth looking at, and where to dig next once you find a problem.

## Step one: capture a comparable baseline

Build performance work falls apart quickly when it is based on feel. Start by fixing a command, for example:

```bash
./gradlew :app:assembleDebug --profile
./gradlew :app:assembleDebug --scan
```

Then run it at least three times: first as a cold build, second as a repeated build with no code changes, and third after changing one line of application code. Those three runs reveal different problems. A cold build shows full cost, a repeated build shows cache behavior, and an incremental build reflects the day-to-day developer experience.

When you record the results, do not write down only total duration. At minimum, break out:

- Configuration time
- Task execution time
- Number of executed tasks and up-to-date tasks
- KAPT/KSP/Kotlin compile time
- Dex, R8, and resource-processing time
- Differences between local and CI builds

Without that table, every later optimization discussion turns into "I think."

## Slow configuration phase: check Configuration Cache

If Build Scan shows high configuration time, Gradle is spending a lot of time parsing scripts, creating tasks, and configuring plugins. In large multi-module projects, this phase can easily exceed 10 seconds, even when you changed only one line of business code.

First, check whether Configuration Cache is enabled:

```properties
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=warn
```

If it is enabled but not being reused, do not stop at the last line of console output. Build Scan lists the specific incompatibilities: a plugin accessing `Project`, a task action reading the Gradle model, or unsafe use of `afterEvaluate`. These issues have to be fixed one by one. They usually cannot be solved by flipping one more property.

The success criterion for configuration optimization is simple: on the second identical build, configuration time should drop significantly. If it does not, do not jump to KSP, R8, or Dex yet. The bottleneck is still in the configuration layer.

## Slow execution phase: find the top tasks first

When task execution is slow, sort tasks by duration instead of guessing from `build.gradle`. Common heavy hitters include:

- `kaptDebugKotlin`: KAPT stub generation and annotation processing.
- `compileDebugKotlin`: Kotlin compilation, affected by module boundaries and ABI changes.
- `mergeDebugResources` / `processDebugResources`: resource volume, AAPT2, and duplicate resources.
- `dexBuilderDebug` / `mergeDexDebug`: method count, dependency size, and incremental hits.
- `minifyReleaseWithR8`: release build shrinking and optimization.

If KAPT is near the top, first evaluate whether dependencies such as Room, Hilt, or Moshi can move to KSP. If resource processing is slow, inspect resource count, variant count, and whether full processing is being triggered every time. If Kotlin compilation is slow, focus on module boundaries, public API churn, and oversized foundation modules.

## Cache misses are more dangerous than slow tasks

Many slow builds are not slow because a task is inherently expensive. They are slow because that task reruns every time. To debug this, ask Gradle why a task is not up to date:

```bash
./gradlew :app:assembleDebug --info
```

Common causes include custom tasks that do not declare inputs and outputs, outputs that embed timestamps, environment variables read without being declared as inputs, unstable generated-file paths, remote resources, and random logic in build scripts.

Custom tasks are a frequent source of damage. A code-generation task that is always out of date can force downstream Kotlin compilation, resource processing, and even Dex work to rerun. Fixing that kind of issue often pays off faster than upgrading hardware.

## Treat CI as a separate problem

A fast local build does not guarantee a fast CI build. Common CI problems include missing persistent Gradle caches, downloading dependencies on every run, unfixed JDK/NDK/AGP versions, parallel jobs fighting for CPU, and emulator tests interfering with build tasks.

At minimum, CI should cache three things: the Gradle wrapper, the Gradle dependency cache, and the Build Cache. When configured carefully, a remote Build Cache lets different branches and machines reuse intermediate outputs. But remote caching also needs admission rules, so unreliable tasks do not poison the cache.

## A practical debugging order

I usually debug slow Android Gradle builds in this order:

1. Establish a baseline with `--scan` and `--profile`.
2. Check whether configuration time is too high, then address Configuration Cache first.
3. Inspect top tasks and separate KAPT, Kotlin, resources, Dex, and R8.
4. Check up-to-date status and Build Cache hit rates.
5. Compare local and CI separately, then fix caches and pin the environment.
6. Only then consider module restructuring, dependency cleanup, and AGP upgrades.

The benefit of this order is that each step has a data loop. Build optimization is not guesswork. The report usually already tells you where the time went.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Mobile Engineering](/en/android-engineering/)
- [Android Gradle build acceleration: Configuration Cache, KSP, and task governance](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android CI/CD quality gates: build, test, lint, performance, and release checks](/en/blog/android-ci-cd-quality-gates/)
<!-- /seo-internal-links -->
