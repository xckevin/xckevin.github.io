---
title: Android Gradle and AGP
lang: en
translationKey: android-gradle-agp-9
seo:
  title: Android Gradle and AGP Engineering Notes
  description: Android Gradle and AGP notes covering build performance, configuration cache, version catalogs, convention plugins, KSP, and CI optimization.
---

This topic focuses on Android Gradle Plugin and build-system engineering.

Android Gradle problems are rarely solved by reading one concept article. Teams usually need to fix slow builds, failed AGP upgrades, KSP/Kotlin version conflicts, unstable CI, and messy module dependencies. This page reorganizes the build-system notes around AGP 9 migration and build governance.

The goal is to make build speed and build reliability measurable engineering concerns.

## Migration Checklist

1. Freeze the version matrix for Gradle, AGP, Kotlin, KSP, JDK, and Android Studio.
2. Use Build Scan or structured build logs to determine whether time is spent in configuration, task execution, KSP/KAPT, resource processing, or R8.
3. Enable Configuration Cache compatibility checks module by module instead of changing the whole repository at once.
4. Move dependency versions into Version Catalog and move repeated build logic into Convention Plugins.
5. Add CI gates for build duration, cache hit rate, lint, unit tests, and artifact verification.

## AGP 9 Concerns

- Built-in Kotlin: AGP 9 enables built-in Kotlin support by default, so upgrades must handle the relationship between Kotlin Gradle Plugin and KSP versions.
- Default behavior changes: build features, R8, NDK behavior, and compileSdk consumer constraints can affect older projects.
- Test fixtures and IDE support: migration has to validate Android Studio behavior, not just command-line builds.
- Plugin compatibility: custom Gradle plugins, bytecode instrumentation, resource processing, and publishing plugins need separate verification.

## Core Reading

- [Mobile Engineering](/en/android-engineering/)
- [How to analyze slow Android Gradle builds: from configuration time to task execution](/blog/2026-06-01-android-gradle构建慢怎么分析/)
- [Android Gradle build optimization: Configuration Cache, KSP, and task governance](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android Gradle Version Catalog and Convention Plugins](/blog/2026-03-10-深入_android_gradle_version_catalog_与_convention_plu/)
- [Android APK build pipeline: aapt2, V4 signatures, and AGP internals](/blog/2026-05-16-深入_android_apk_构建全链路_从_aapt2_资源编译到_v4_签名验证的_agp_内部/)
- [What should Android CI/CD quality gates include?](/blog/2026-06-01-android-ci-cd质量门禁/)

## Debugging Route

- Slow builds: start with configuration time and remote cache hit rate, then inspect task hot spots.
- Slow Kotlin/KSP: inspect processor count, incremental support, module boundaries, and generated-code volume.
- Slow R8: inspect keep rules, resource shrinking, input size, and multi-variant build behavior.
- Slow CI: inspect cache directories, dependency downloads, concurrency strategy, test layering, and artifact reuse.
- Failed upgrades: reduce the problem to the smallest module first, then reintroduce plugins and custom tasks one by one.

## Official References

- [Android Gradle plugin release notes](https://developer.android.com/build/releases/gradle-plugin)
- [AGP 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes)
- [Migrate to built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin)

## Related Topics

- [Kotlin and Coroutines](/en/kotlin-coroutines/): Kotlin, KSP, K2, and compiler changes directly affect the Android build pipeline.
- [Android Performance](/en/android-performance/): performance gates should connect Macrobenchmark, startup time, and production metrics into CI.
