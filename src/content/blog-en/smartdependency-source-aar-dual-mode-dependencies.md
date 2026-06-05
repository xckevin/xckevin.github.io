---
title: "SmartDependency: A Source/AAR Dual-Mode Dependency System for Modular Android Projects"
lang: en
translationKey: smartdependency-source-aar-dual-mode-dependencies
slug: smartdependency-source-aar-dual-mode-dependencies
excerpt: "In large Android projects, dependency mode directly affects developer productivity. This article introduces a source/AAR dual-mode dependency system that lets developers open source modules on demand while CI and release builds return to the real binary shape."
publishDate: '2026-06-04'
tags:
- "Android"
- "Gradle"
- "Modularization"
- "Dependency Management"
- "Engineering Productivity"
seo:
  title: "SmartDependency: Source/AAR Dual-Mode Dependencies for Android"
  description: "Design a source/AAR dual-mode dependency system for large Android projects with unified registration, configuration switching, versioning, and CI rules."
  pageType: article
---

Modularity is a must-have for large Android projects, but modularization doesn't automatically boost efficiency. I experienced this firsthand in a project with multiple app shells, business modules, domain modules, infrastructure modules, and optional dynamic feature modules. The dependency graph is complex, and the build variants are numerous. If we load everything as source code, every developer gets dragged into the entire codebase, leading to slow Gradle configuration, Kotlin compilation caches, and IDE indexing—so slow that writing a single-module app starts to look tempting again.

When updating a state page, we really only need to open the `feature_state`, `state_domain`, and necessary infrastructure source code. All other stable modules can safely use AARs. But the problem is: how do we make the cost of switching between "source code mode" and "AAR mode" sufficiently low?

## Why Dual-Mode Dependencies Are Necessary

Full source code dependencies are great for debugging but bloat configuration, compilation, and indexing times. A seemingly simple page change might trigger configurations and validations across many unrelated modules. Full AAR dependencies are closer to the release state, but developers face issues like invisible source code, unstable breakpoints, and long modification chains when debugging cross-module logic. This is especially true when a business module depends on multiple foundation modules; local debugging might require repeatedly publishing local packages, which is a poor experience.

What's even trickier is that a build passing with local source dependencies doesn't guarantee parity with a build using AAR dependencies in the release environment. Source code projects often contain indirect dependencies that aren't explicitly declared but are visible, which might manifest as missing packages in AAR mode. Resource names, obfuscation rules, and consumer configurations behave differently in binary form.

Therefore, the problem isn't "is source code better than AAR," but rather "when should we use source code, when should we use AAR, and how do we keep the switching cost low?"

## Core Design: Unified Registration + Configuration Switching

The core idea behind SmartDependency is to maintain a "Module Coordinate Table" and a "Source Mapping Table" within the build logic. The Module Coordinate Table describes the logical module name, Maven coordinates, and default version. The Source Mapping Table describes which local Gradle project corresponds to a logical module when source mode is enabled.

Dependency declarations are wrapped into the form of `smartApi("feature.profile")` or `smartImplementation("foundation.network")`. The build script reads the current mode and, if the module is in the source whitelist, it generates `project(":feature:profile")`; otherwise, it generates the binary coordinate.

```kotlin
data class ModuleSpec(
    val name: String,
    val artifact: String,
    val sourceProject: String
)

val registry = mapOf(
    "feature.profile" to ModuleSpec(
        name = "feature.profile",
        artifact = "group:feature-profile:1.2.3",
        sourceProject = ":feature:profile"
    ),
    "foundation.log" to ModuleSpec(
        name = "foundation.log",
        artifact = "group:foundation-log:2.0.0",
        sourceProject = ":foundation:log"
    )
)

fun DependencyHandler.smartImplementation(moduleName: String) {
    val spec = registry.getValue(moduleName)
    val sourceEnabled = localConfig.sourceModules.contains(moduleName)
    if (sourceEnabled) {
        add("implementation", project(spec.sourceProject))
    } else {
        add("implementation", spec.artifact)
    }
}
```

But just replacing dependencies isn't enough. If all source modules are still included in the Gradle project, the IDE indexing and configuration time won't significantly decrease. Therefore, we also need to perform the same check during the `settings` phase, only including the necessary projects:

```kotlin
val sourceModules = readLocalSourceModuleList()

registry.values.forEach { spec ->
    if (sourceModules.contains(spec.name)) {
        include(spec.sourceProject)
        project(spec.sourceProject).projectDir = file(resolvePath(spec.name))
    }
}
```

A critical constraint is that dependency resolution and project inclusion must use the same configuration. Otherwise, the dependency script can end up referencing a project that the `settings` file has not included.

## Two Key Integration Points in Real Projects

This solution has two concrete build integration points: `settings.gradle` handles "whether the module is included in the Gradle project," and SmartDependency in `buildSrc` handles "whether the dependency ultimately points to a source project or a local/remote AAR coordinate." Both points must be addressed simultaneously. Otherwise, replacing dependencies while still including all source modules will not significantly reduce IDE indexing time; trimming `settings.gradle` while business modules still hardcode `project(":xxx")` dependencies will cause compilation failures in AAR mode.

Another highlight is `configurePublishing(project)`, which publishes Android library modules to a local Maven repository and, combined with `preferProjectModules()`, ensures source modules are prioritized. This creates a closed loop: develop in source mode, confirm, publish a snapshot, and then switch back to AAR mode to verify transitive dependencies, consumer configurations, resource exposure, and binary boundaries.

## Configuration Input and CI Constraints

The configuration entry can be designed to prioritize local files:

```properties
# local-dependency.properties
sourceModules=feature.profile,foundation.log
dependencyMode=hybrid
```

The CI environment, however, must enforce overrides via environment variables to ensure release builds always use binary dependencies:

```kotlin
val mode = env("DEPENDENCY_MODE") ?: localFile.get("dependencyMode")
if (isCiBuild()) {
    require(mode == "binary") { "CI build must use binary dependencies" }
}
```

Version governance is equally important. AAR mode must know which version each module uses, and source mode must know which release version the current source corresponds to. We centralize version information in a version directory or a platform BOM, and SmartDependency reads from it, preventing "local success but integration failure" due to version drift.

## Observability: Making the Dependency Mode Obvious

When debugging, developers often don't know exactly which artifact they are using. A simple tool output can solve this:

```text
Dependency mode: hybrid

feature.profile      source   :feature:profile
foundation.log       source   :foundation:log
foundation.network   binary   group:foundation-network:3.1.0
```

This output quickly answers three questions: Is the current module in source mode, what is the corresponding project path, and what is the binary version? In large projects, this level of observability is invaluable.

## Pitfalls During Implementation

Source mode cannot be used as an excuse to bypass module boundaries. Modules should still interact through public APIs; you shouldn't be able to directly access internal classes or test utilities just because the source code resides in the same project. Risks of boundary crossing can be mitigated using package visibility, lint checks, and dependency constraints.

AAR artifacts must be complete. Consumer obfuscation rules, resource prefixes, public dependencies, native libraries, and annotation processor outputs must all be validated in binary mode. Many modules work fine with source dependencies because the parent project "conveniently" includes certain configurations; once independently published, these gaps are exposed.

Migration must be phased. Start by integrating a few high-frequency modules with SmartDependency, and then gradually expand the scope. Don't rewrite all dependency declarations at once, or if something goes wrong, it will be hard to tell if the issue is with the script, the version, or the module itself.

---

The value of SmartDependency isn't in creating a new dependency type, but in bringing both source and AAR forms under a single set of rules. The development phase requires flexibility, while the release phase demands determinism; the build system must serve both goals simultaneously. The truly difficult part isn't just writing a Gradle helper; it's maintaining the dependency boundaries and release discipline over the long term. As long as the boundaries are unclear, source mode will amplify coupling; as long as the versions are unstable, AAR mode will amplify discrepancies. It should be treated as part of module governance, not just a standalone build trick.
