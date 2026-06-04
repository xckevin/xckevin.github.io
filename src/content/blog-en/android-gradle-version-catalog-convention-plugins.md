---
title: "Android Gradle Version Catalogs and Convention Plugins in Practice"
lang: en
translationKey: android-gradle-version-catalog-convention-plugins
slug: android-gradle-version-catalog-convention-plugins
excerpt: "A migration story from buildSrc to Version Catalogs and Convention Plugins in a 30+ module Android project, covering dependency governance, precompiled build logic, and practical pitfalls."
publishDate: '2026-03-10'
tags:
- "Android"
- "Gradle"
- "Build Optimization"
- "Modularization"
- "Dependency Management"
seo:
  title: "Android Gradle Version Catalogs and Convention Plugins in Practice"
  description: "Migrate Android multi-module builds from buildSrc to Version Catalogs and Convention Plugins with dependency rules, build logic, and pitfalls."
---

When I took over a 30+ module Android project last year, the dependency declarations in `build.gradle.kts` gave me headaches for weeks. The same `androidx-core-ktx` version appeared as three different numbers across three modules. Gradle sync still passed, but the classpath version used by the actual build depended on resolution order. That kind of uncertainty is painful to debug.

The team was using `buildSrc` to centralize dependencies, but the weakness was obvious: **change one dependency version, and the whole buildSrc project recompiles**. The more modules you have, the longer you wait. I started pushing the project toward Version Catalogs plus Convention Plugins. After a year of migration work and plenty of mistakes, these are the notes worth keeping.

## Why buildSrc stopped being enough

`buildSrc` is essentially a special included build. Gradle compiles it early in the configuration phase and exposes the generated class files to the root project. A typical setup looks like this:

```kotlin
// buildSrc/src/main/kotlin/Dependencies.kt
object Versions {
    const val compose = "1.6.0"
    const val hilt = "2.50"
}

object Libs {
    const val composeUi = "androidx.compose.ui:ui:${Versions.compose}"
    const val hiltAndroid = "com.google.dagger:hilt-android:${Versions.hilt}"
}
```

Referencing `Libs.composeUi` from modules looks clean, but the approach has three hard limits.

**Build performance degrades.** Any file change inside `buildSrc`, even adding a constant, causes all modules to be reprocessed during configuration. In a 30-module project, renaming one dependency could cost more than 20 seconds.

**Dependency grouping is not structured.** All dependencies usually end up flattened into one object. Once `Dependencies.kt` grows past 300 lines, reviewers have a hard time seeing which feature area a dependency belongs to.

**Reuse across projects is awkward.** `buildSrc` is tightly bound to a single project. It cannot be distributed like a library through Maven coordinates. If multiple projects need the same build logic, teams often copy and paste it.

## Version Catalogs: declarative dependency governance with TOML

Version Catalogs, introduced in Gradle 7.0, are the official answer. The core idea is simple: **declare dependency coordinates in a TOML file, and let Gradle generate type-safe accessors**.

In `gradle/libs.versions.toml`:

```toml
[versions]
agp = "8.5.0"
kotlin = "2.0.0"
compose-bom = "2024.06.00"
hilt = "2.51"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version = "1.13.0" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-android-compiler", version.ref = "hilt" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
```

The four sections have separate responsibilities:

- `[versions]`: centralizes version numbers, referenced through `version.ref`
- `[libraries]`: defines module coordinates and supports both `version` and `version.ref`
- `[plugins]`: declares Gradle plugins that can be used directly in `plugins {}`
- `[bundles]`: groups multiple libraries, which is useful for cases like "bring in the whole Compose stack"

In a module's `build.gradle.kts`, Gradle generates accessors for each declaration:

```kotlin
dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.compose.ui)
    implementation(platform(libs.compose.bom))
    implementation(libs.hilt.android)
    kapt(libs.hilt.compiler)
}
```

Gradle maps TOML `-` separators to Kotlin property paths. `androidx-core-ktx` becomes `libs.androidx.core.ktx`, with full IDE completion. Change a version once in TOML and every reference follows, without paying the `buildSrc` recompilation cost.

TOML changes affect dependency resolution only. They do not trigger `buildSrc` compilation. In our 30-module project, changing a dependency version made Android Studio sync take about 3 to 5 seconds, while the old `buildSrc` approach needed 15 to 25 seconds.

## Convention Plugins: modular distribution for precompiled scripts

Version Catalogs solve dependency management, but every module's `build.gradle.kts` can still be full of repeated plugin declarations and `android` configuration. A Compose module, for example, often repeats this block:

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    defaultConfig.minSdk = 26
    kotlinOptions.jvmTarget = "17"
    buildFeatures.compose = true
    composeOptions.kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
}
```

Convention Plugins move that boilerplate into **precompiled, standalone Gradle plugins** that modules apply on demand. One common setup is to create a `build-logic` directory, or keep using `buildSrc` only for plugin logic, then define a convention plugin:

```kotlin
// build-logic/convention/src/main/kotlin/compose-module.gradle.kts
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    defaultConfig.minSdk = 26
    kotlinOptions.jvmTarget = "17"
    buildFeatures.compose = true
    composeOptions.kotlinCompilerExtensionVersion = "1.5.14"
}
```

Then include it from the root `settings.gradle.kts`:

```kotlin
// root settings.gradle.kts
pluginManagement {
    includeBuild("build-logic")
}
```

A child module now needs only one line:

```kotlin
plugins {
    id("myproject.compose-module") // convention plugin
}
```

This is the center of a declarative build: module authors declare "what kind of module this is" inside `plugins {}`, and the concrete compiler settings live in a Convention Plugin. When the project needs to upgrade `compileSdk` or change the Compose compiler version, one file updates the whole build.

## How Version Catalogs and Convention Plugins work together

They complement each other at different layers. Version Catalogs answer "which versions do we use" at dependency resolution time. Convention Plugins answer "how do we configure this module" during project configuration.

You can use a Version Catalog inside a Convention Plugin too. The key is the `libs` extension generated from `gradle/libs.versions.toml`:

```kotlin
// build-logic/convention/src/main/kotlin/compose-module.gradle.kts
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures.compose = true
}

// Convention Plugins can also reference versions from the Version Catalog.
dependencies {
    // Use Gradle's platform mechanism to align Compose versions.
    "implementation"(platform(libs.compose.bom))
}
```

A complete module configuration can then shrink to this:

```kotlin
plugins {
    id("myproject.compose-module")
    id("myproject.hilt-module")
}

android.namespace = "com.example.feature.profile"

dependencies {
    implementation(project(":core:common"))
    implementation(libs.androidx.lifecycle.viewmodel)
}
```

The module declares only what is different: its namespace, module dependencies, and extra third-party libraries. Shared configuration moves into Convention Plugins.

## Pitfalls from the migration

The migration was not smooth. A few problems are worth calling out.

**TOML name conversion is one-way.** Gradle converts `-` into `.`, while `_` and `.` in TOML also have their own mapping rules. For example, both `androidx-core` and `androidx_core` can become `libs.androidx.core`, causing a compilation error when the names collide. My current rule is to use `-` for all library aliases, so the group's `.` and the alias's `-` stay visually distinct.

**The `plugins {}` block in a Convention Plugin cannot directly use the Version Catalog.** Writing `id(libs.plugins.kotlin.android.get().pluginId)` inside a precompiled script's `plugins {}` block does not work, because `plugins {}` is resolved before the script is compiled. The fix is to let the Convention Plugin build declare its own plugin dependencies through TOML:

```kotlin
// build-logic/settings.gradle.kts
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}
```

**Create new modules through Android Studio templates.** Creating modules by hand makes it easy to forget `include` in `settings.gradle.kts`, or to forget the right Convention Plugin. Custom Android Studio templates can offer a Convention Plugin type and remove that manual setup.

One practical tradeoff: I hardcode `compileSdk` as a string or number inside the Convention Plugin instead of referencing a Version Catalog variable. `compileSdk` is really a build environment parameter, not a dependency version. It should move with the AGP version instead of being managed independently. Putting it in TOML can make people think it is safe to upgrade alone.

## Migration path

If your project still uses `buildSrc` for dependency management, migrate in two steps.

**First, move dependency declarations to Version Catalogs.** This step is almost zero-risk. `Dependencies.kt` in `buildSrc` can coexist with TOML while modules are migrated one at a time. Once everything is replaced, run a full build and remove the old constants.

**Second, extract Convention Plugins.** Create a `build-logic` directory and precompiled scripts. Start with the cleanest modules: the ones that do not heavily customize their `android` block. After each module migration, run that module's `assemble` task before moving on.

After the migration, `buildSrc` can be removed entirely. In the 30+ module project I maintain today, the root `build.gradle.kts` went from 200 lines to 40. Individual module build scripts average under 15 lines, and creating a new module went from 10 minutes to about 30 seconds.

Two everyday tips help a lot: `./gradlew dependencies` shows the actual versions resolved from the Version Catalog, which is useful for conflict debugging; and Convention Plugin debugging can be as simple as adding a temporary `println` to the plugin script and running any task, which is often faster than setting a breakpoint.
