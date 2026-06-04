---
title: "Android Gradle Build Speed: From Configuration Cache to Replacing KAPT with KSP"
lang: en
translationKey: android-gradle-build-speed-configuration-cache-ksp
slug: android-gradle-build-speed-configuration-cache-ksp
excerpt: "A systematic Android Gradle build-speed guide covering configuration time, annotation processing, task execution, Configuration Cache, KSP migration, incremental compilation, and build governance."
publishDate: '2026-05-06'
tags:
- "Android"
- "Gradle"
- "Kotlin"
- "KSP"
- "Build Optimization"
seo:
  title: "Android Gradle Build Speed: Configuration Cache, KSP, and Task Hygiene"
  description: "Learn how to speed up Android Gradle builds with Configuration Cache, KSP migration, task input and output fixes, build cache, and parallel execution."
  pageType: article
---

A medium-sized project with 30 modules can easily take 4 minutes for a clean build and 1 minute 20 seconds for an incremental build. Numbers like these are common in teams with any real scale, but the usual response is "add more machine memory" or "upgrade Gradle and hope it gets faster."

Build time is not one single thing. It is the sum of three phases: **Configuration Phase**, **Annotation Processing**, and **Task Execution**. The bottlenecks in these phases are completely different. Optimizing them as one blob is like repairing three different failures on three different machines at the same time: it looks busy, but progress is limited.

Split the build into these three phases, locate each bottleneck, and solve them one by one.

---

## Step one: find where the time goes

Blind optimization is the most expensive kind of time waste. Gradle already provides good enough diagnostic tools, but many developers never use them.

Run a build with `--profile`, and Gradle generates an HTML report under `build/reports/profile/`. The report includes configuration-phase time and per-task execution-time distribution. For more detailed analysis, use `--scan`:

```bash
./gradlew assembleDebug --profile
./gradlew assembleDebug --scan  # Uploads to scans.gradle.com for an interactive report
```

Look for three key numbers in the report:

- **Configuration time**: if it exceeds 10 seconds, the configuration phase has a problem
- **Task `:app:kaptDebugKotlin` duration**: KAPT is often the worst offender and usually the longest single task
- **Number of parallel tasks**: if many tasks are queued serially, the dependency graph or parallel configuration has a problem

Starting changes without profile data will probably optimize something that was never the bottleneck.

---

## Configuration phase: Configuration Cache

The configuration phase is where Gradle parses all `build.gradle` files and builds the task dependency graph. **It runs on every build**, even if you changed only one line of business code.

In a project with 40 modules, configuration can easily consume 15 to 20 seconds. Configuration Cache, or CC, serializes and caches that task graph. On the next build, if `build.gradle` has not changed, Gradle can deserialize the graph and skip configuration.

Enable it like this:

```properties
# gradle.properties
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=warn  # Start with warn mode to inspect compatibility issues
```

### CC compatibility: the real work

The hard part of CC is not turning it on. It is **fixing compatibility**. Gradle requires all task inputs and outputs to be CC-safe during serialization. The following three patterns directly cause CC misses or abnormal behavior:

**Directly accessing the `project` object inside a task action:**

```kotlin
// Incorrect: project is not serializable when the task action runs
tasks.register("generateConfig") {
    doLast {
        val flavor = project.properties["flavor"]
    }
}

// Correct: capture it early as a Provider and declare it as an @Input
tasks.register("generateConfig") {
    val flavor = providers.gradleProperty("flavor")
    doLast {
        val f = flavor.orNull
    }
}
```

**Using `afterEvaluate` to modify task state:** `afterEvaluate` creates configuration-phase side effects, and its behavior is unpredictable under CC. Prefer `Provider` for lazy evaluation, or restructure task dependencies and express them through declarative APIs.

**Incompatible third-party plugins:** this is often the most painful part in real projects. AGP 8.x is fully compatible with CC, but some old code-generation plugins, such as Gradle plugins from older routing frameworks, still have not caught up. Run once in `warn` mode, find incompatible plugins from the report, and upgrade or replace them one by one.

In practice, after upgrading to AGP 8.1+ and enabling CC, a 40-module project's incremental-build configuration time dropped from 18 seconds to under 2 seconds. This is the optimization with the most direct payoff. The cost is usually one or two days of compatibility investigation.

---

## Annotation processing: replacing KAPT with KSP

KAPT, the Kotlin Annotation Processing Tool, is slow by design: compile Kotlin source into Java stubs, feed those stubs into Java APT processors, then run a full compilation again after generated code is produced. All three steps are real compilation work.

In a medium-sized project, a single module's `kaptDebugKotlin` task taking 15 to 30 seconds is normal. Across several modules, that turns into minutes of wasted time.

**KSP, Kotlin Symbol Processing**, runs directly as a Kotlin compiler plugin and processes annotations at the symbol-analysis level, completely skipping Java stub generation. Official data suggests a 2x improvement, and large-company measurements often show 2x to 4x. That number is grounded in real-world results.

### Migration steps

Using Room and Hilt as examples:

```kotlin
// Root build.gradle.kts
plugins {
    id("com.google.devtools.ksp") version "2.0.0-1.0.21" apply false
}
```

```kotlin
// Module build.gradle.kts
plugins {
    id("com.google.devtools.ksp")
}

dependencies {
    // Change kapt to ksp. Other dependencies stay the same.
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")

    ksp("com.google.dagger:hilt-compiler:2.51")
    implementation("com.google.dagger:hilt-android:2.51")
}
```

After the migration, remove `kotlin("kapt")` from all modules. Mixing KAPT and KSP for the same library makes both processor sets run, which can be slower than using KAPT alone.

### Not every library supports KSP

Glide's KSP support has long been experimental. Some routing frameworks, such as older ARouter versions, still depend on KAPT, while their KSP versions are community-maintained and need stability evaluation. Before migration, check the official documentation and confirm support. Do not just "try and see whether it builds." Differences in generated code may not fail at compile time, and runtime failures are much harder to diagnose.

---

## Task execution: incremental compilation and parallel builds

### Hidden killers of incremental compilation

Gradle incremental compilation depends on two things: task inputs and outputs being declared correctly, and UP-TO-DATE checks not being accidentally broken.

One typical trap I have hit: a custom task wrote `System.currentTimeMillis()` into a comment in its output file. The output changed every time, so the task was never UP-TO-DATE, and every downstream task depending on it was re-executed. To locate this:

```bash
./gradlew assembleDebug --info 2>&1 | grep "not up-to-date\|UP-TO-DATE"
```

Custom task inputs and outputs must be declared explicitly:

```kotlin
abstract class GenerateVersionTask : DefaultTask() {
    @get:Input
    abstract val versionCode: Property<Int>

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @TaskAction
    fun execute() {
        // Correct: output depends only on declared @Input values, with no timestamp or external randomness.
        outputFile.get().asFile.writeText("VERSION_CODE=${versionCode.get()}")
    }
}
```

### Parallel execution and JVM tuning

```properties
# gradle.properties
org.gradle.parallel=true
org.gradle.workers.max=8        # Recommended: CPU core count. IO-heavy tasks can go slightly higher.
org.gradle.caching=true         # Enables Build Cache. Independent from CC; both can be enabled.
org.gradle.jvmargs=-Xmx4g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
```

Parallel builds only help when modularization is reasonable. If all business code is piled into a single `:app` module, there is no room for parallelism. That is an architecture problem, not something configuration flags can solve.

Build Cache pays off most in CI. With the same code or when switching between branches, many tasks can be restored from cache instead of re-executed. Multi-machine CI can use a remote cache node, so one machine's build outputs can be reused directly by another.

---

## Priority and expected payoff

Based on measured results, the payoff differs significantly across these three categories:

| Optimization | Incremental-build benefit | Implementation difficulty |
|---|---|---|
| Replace KAPT with KSP | Annotation processing -50% to -70% | Low, migrate library by library |
| Configuration Cache | Configuration time -85%+ | Medium, requires compatibility fixes |
| Parallelism + incremental fixes | Task execution -20% to -40% | Low to medium |

I prefer starting with KSP migration: the risk is low, the payoff is immediate, it can be rolled out by library in batches, and rollback is easy if something fails. Changing a few dependency declarations can remove 20 to 30 seconds from build time, which is the best cost-performance ratio.

Configuration Cache payoff depends on project size. The more modules and the more complex the configuration, the more obvious the result. Small projects with fewer than 10 modules can wait. Large projects should schedule CC compatibility fixes as a separate iteration instead of mixing them into feature development. Debugging compatibility issues while also changing product code doubles the cognitive load.

Projects still on AGP 7.x should plan an AGP 8.x upgrade at the same time. Stable CC support, finer-grained `buildFeatures` control, such as disabling unused `buildConfig`, `aidl`, and `renderScript`, and R-file generation improvements all bring meaningful gains in AGP 8. The upgrade itself has migration cost, but the payoff is systemic and worth doing.

<!-- seo-internal-links -->

## Further reading

- [Back to the mobile engineering topic](/en/android-engineering/)
- [Android testing engineering practice: JUnit, integration tests, Compose semantics, and CI](/en/blog/android-testing-junit-compose/)
- [Android CI/CD practice: Jenkins, GitLab CI, build releases, and quality gates](/en/blog/jenkins-gitlab-ci-android-cicd-complete-guide/)
<!-- /seo-internal-links -->
