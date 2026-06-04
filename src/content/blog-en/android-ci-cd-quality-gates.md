---
title: "What Should Android CI/CD Quality Gates Include?"
lang: en
translationKey: android-ci-cd-quality-gates
slug: android-ci-cd-quality-gates
excerpt: "A practical structure for Android CI/CD quality gates across builds, tests, lint, signing, performance benchmarks, release, and rollback."
publishDate: '2026-06-01'
tags:
- "Android"
- "CI/CD"
- "Mobile Engineering"
seo:
  title: "Android CI/CD Quality Gates: Build, Test, Lint, Performance, and Release Checks"
  description: "Learn how to design Android CI/CD quality gates across Jenkins, GitLab CI, unit tests, lint, signing, benchmarks, release, and rollback."
---

The goal of Android CI/CD is not "automated packaging." It is to block quality risks before merge, release, and rollout. If a pipeline only produces an APK or AAB, it is just a remote build machine. Real CI/CD turns compilation, testing, static analysis, performance, signing, and release strategy into repeatable gates.

## Design gates by stage

I usually split Android quality gates into three layers: pre-merge, mainline build, and pre-release. They answer different questions. Mixing everything into one extremely long pipeline slows feedback and makes teams more likely to bypass the gates.

Pre-merge gates should be fast. Their job is to stop obvious mistakes from entering the main branch. They should run Debug compilation, unit tests for affected modules, incremental Lint, Ktlint/Detekt, and API compatibility checks. Ideally, this stays under 10 minutes. If it takes much longer, developers tend to batch changes or skip checks.

Mainline builds should prioritize stability. Their job is to prove that the main branch is always releasable. They should run full builds, core-module tests, integration tests, dependency vulnerability scans, duplicate-resource checks, and package-size reporting. A failed mainline build needs an owner. Otherwise the red light quickly becomes background noise.

Pre-release gates focus on risk control. Their job is to decide whether this version can enter rollout. This stage needs a Release build, signing verification, Proguard/R8 mapping archival, channel configuration, version checks, smoke tests, performance benchmarks, and rollback package preparation.

## Basic gates: make the artifact trustworthy first

The baseline gate set should include:

- Both Debug and Release builds pass, so you are not validating only the developer build.
- Unit tests pass, especially for ViewModel, Repository, domain logic, and utility classes.
- Android Lint does not allow new errors. Warnings can be reduced gradually by module.
- Signing config, `versionCode`, `applicationId`, and channel parameters are verifiable.
- Artifact hashes, mapping files, native symbols, and build logs are archived.

These checks may look ordinary, but many production incidents start here: wrong signing key, wrong environment, missing mapping file, or rollout packages that differ from production packages. The value of CI is not fewer button clicks. It is preventing low-level mistakes from entering the release flow.

## Advanced gates: move regression detection earlier

Once the basic gates are stable, add three more categories.

The first is UI smoke testing. Do not try to cover every screen on day one. Start with launch, login, the home page, and the core transaction or content flow. Compose projects can use the semantics tree for more stable assertions. Traditional View projects can organize main flows with Espresso or Maestro.

The second is performance regression. Macrobenchmark usually belongs in pre-release or nightly pipelines because it needs real devices, cold-start control, and repeated samples. Good first gate metrics include startup p95, list-scroll frame rate, key-page load time, and package-size growth. Do not put a dozen metrics into the gate at once.

The third is dependency and security control. Gradle dependency locks, license checks, known-vulnerability scans, sensitive-permission changes, and Manifest diffs should all enter the pipeline. Android dependency graphs are long, and dependency upgrades can change behavior more quietly than product code.

## Quality gates should not become release friction

The central tension is simple: stricter gates improve safety, but slower gates are easier to bypass. The answer is not lower standards. It is layering, caching, and parallelism.

Pre-merge should run only the necessary checks. Mainline and nightly should run heavier checks. Pre-release should run the checks closest to the real user environment. Gradle Build Cache, Configuration Cache, test sharding, and module impact analysis should all support that structure. CI speed is part of engineering quality.

Failure policy also has to be explicit. Compilation failures, signing errors, and core test failures must block. Ordinary Lint warnings can start as trend data. Performance metrics can have yellow and red zones: yellow requires human review, red blocks automatically. If gates do not have severity levels, teams eventually depend on personal exceptions.

## Add one more gate after release

An Android release is not finished when the package reaches the store. During rollout, keep watching crash-free rate, ANR, startup p95, core API error rate, login conversion, and install-failure rate related to package size. If a metric crosses its threshold, the pipeline should be able to pause further rollout and preserve a rollback or withdrawal path.

Mature CI/CD is not a YAML file. It is a risk-control system from commit to rollout. Automation is only the surface. What matters is that every stage knows which risks it is supposed to block.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Mobile Engineering](/en/android-engineering/)
- [Android CI/CD in practice: Jenkins, GitLab CI, build, release, and quality gates](/blog/jenkins与gitlab-ci实现android持续集成与交付从构建到发布的完整指南/)
- [Android testing engineering: JUnit, integration tests, Compose semantics, and CI](/blog/2026-05-10-深入_android_测试全链路工程实践_从_junit_单元测试到_compose_semanti/)
- [How to analyze a slow Android Gradle build](/en/blog/android-gradle-build-slow/)
<!-- /seo-internal-links -->
