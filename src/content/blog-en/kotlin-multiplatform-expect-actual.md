---
title: "Kotlin Multiplatform Engineering: expect/actual and Cross-Platform Architecture"
lang: en
translationKey: kotlin-multiplatform-expect-actual
slug: kotlin-multiplatform-expect-actual
excerpt: "A production-focused guide to Kotlin Multiplatform, covering expect/actual boundaries, three-layer architecture, XCFramework configuration, and Compose Multiplatform collaboration."
publishDate: '2026-04-18'
tags:
- "Kotlin Multiplatform"
- "Android"
- "iOS"
- "Cross-Platform Architecture"
- "Compose Multiplatform"
seo:
  title: "Kotlin Multiplatform Engineering: expect/actual and Cross-Platform Architecture"
  description: "A practical KMP guide covering expect/actual boundaries, shared architecture, XCFramework setup, Compose Multiplatform, and Kotlin/Native debugging."
  pageType: article
---

KMP (Kotlin Multiplatform) became officially stable at the end of 2023, but its real move into large-scale production happened in the 2025-2026 window. Our team started migrating core business logic to KMP in Q3 last year and hit plenty of problems along the way. This article skips Hello World and focuses on the issues that show up once KMP becomes an engineering system.

---

## The Right Way to Use expect/actual

`expect/actual` is KMP's core mechanism, but many teams use it in the wrong place. They treat it as a dumping ground for platform differences, pushing all kinds of logic into it. Eventually, `actual` implementations are scattered across modules, and the maintenance cost becomes higher than writing separate code for each platform.

The right mental model is: **`expect/actual` should declare platform capabilities, not fork business logic**.

A typical valid use case is platform logging:

```kotlin
// commonMain
expect class PlatformLogger(tag: String) {
    fun d(message: String)
    fun e(message: String, throwable: Throwable? = null)
}

// androidMain
actual class PlatformLogger actual constructor(private val tag: String) {
    actual fun d(message: String) = Log.d(tag, message)
    actual fun e(message: String, throwable: Throwable?) {
        Log.e(tag, message, throwable)
    }
}

// iosMain
actual class PlatformLogger actual constructor(private val tag: String) {
    actual fun d(message: String) = NSLog("[$tag] $message")
    actual fun e(message: String, throwable: Throwable?) {
        NSLog("[$tag] ERROR: $message - ${throwable?.message}")
    }
}
```

A common anti-pattern is exposing platform-specific types from an `expect` function, such as putting Android's `Context` into a `commonMain` interface. That forces the iOS `actual` implementation to maintain a fake `Context` object, which is a self-inflicted problem.

The issue gets trickier when an `expect class` needs inheritance. KMP does not allow an `expect class` to extend another class; it can only implement interfaces. That restriction becomes painful when wrapping platform components such as database drivers or network clients. **The solution is to use interfaces plus factory functions instead of `expect class`**:

```kotlin
// commonMain
interface DatabaseDriver {
    fun execute(sql: String): Long
    fun query(sql: String): List<Map<String, Any?>>
}

expect fun createDatabaseDriver(name: String): DatabaseDriver
```

With this design, the implementation classes on the `actual` side can freely inherit from platform SDK classes, which gives you much more flexibility.

---

## Module Layering: Where Shared Code Should Stop

This is the hardest question to align on during KMP adoption. I have seen two extremes: one team puts everything into `commonMain`, leaving `if (isAndroid)` checks everywhere; another team shares only data models while keeping business logic separate, which makes KMP little more than ceremony.

The layering model we ended up shipping uses three layers:

```
┌─────────────────────────────────────┐
│  UI Layer (Compose Multiplatform /  │
│           SwiftUI / React Native)   │
├─────────────────────────────────────┤
│  Shared Business Logic              │
│  (ViewModel / UseCase / Repository) │ ← KMP commonMain
├─────────────────────────────────────┤
│  Platform Services                  │
│  (DB / Network / Crypto / FS)       │ ← expect/actual
└─────────────────────────────────────┘
```

**The middle layer, Shared Business Logic, is where KMP has the highest value density**. Put ViewModels, UseCases, and Repository interfaces here. Drive state with Kotlin Coroutines and Flow. The UI layer on each platform only subscribes to state and triggers events.

Repository interfaces live in `commonMain`, while concrete data sources are injected on each platform:

```kotlin
// commonMain - Repository interface
interface ArticleRepository {
    fun getArticles(): Flow<List<Article>>
    suspend fun refresh(): Result<Unit>
}

// commonMain - ViewModel (using a KMP ViewModel library or your own wrapper)
class ArticleViewModel(
    private val repo: ArticleRepository
) : ViewModel() {
    val articles = repo.getArticles()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun refresh() = viewModelScope.launch {
        repo.refresh().onFailure { /* handle error */ }
    }
}
```

On iOS, use a helper to bridge `StateFlow` to Combine. Kotlin provides options such as `KmpObservableViewModel`, and hand-written wrappers are also common. One detail has bitten us in practice: iOS must subscribe to `StateFlow` **on the main thread**. Otherwise, SwiftUI updates can throw threading exceptions. This is hard to spot during debugging and often appears only when UI refreshes start behaving strangely.

---

## Build Artifacts and Gradle Configuration

KMP build artifacts differ fundamentally between Android and iOS, and that difference affects CI strategy and release cadence.

On Android, KMP produces a standard AAR that is published to Maven through Gradle, just like a regular Android library.

On iOS, KMP outputs an XCFramework. The correct `build.gradle.kts` setup is to create an `XCFramework` instance and aggregate the target frameworks:

```kotlin
kotlin {
    val xcf = XCFramework("SharedKit")
    listOf(
        iosX64(), iosArm64(), iosSimulatorArm64()
    ).forEach {
        it.binaries.framework {
            baseName = "SharedKit"
            isStatic = true // A static library reduces dynamic linking cost at startup.
            xcf.add(this)
        }
    }
}
```

**Static library (`isStatic = true`) versus dynamic library is a choice worth thinking through**. A static library is compiled into the main app bundle, so there is no dynamic linking at startup and iOS cold start is slightly better. A dynamic library can be shared by multiple targets and works well when you have several App Extensions. We chose a static library because the project had no extensions, and static libraries also caused fewer linking issues with CocoaPods.

For Gradle dependency management, a KMP project's `build.gradle.kts` can get bloated quickly. Use the `sourceSets` block to isolate dependencies by platform and keep platform-specific implementations out of `commonMain`:

```kotlin
sourceSets {
    commonMain.dependencies {
        implementation(libs.kotlinx.coroutines.core)
        implementation(libs.kotlinx.serialization.json)
        implementation(libs.ktor.client.core)
    }
    androidMain.dependencies {
        implementation(libs.ktor.client.okhttp)
        implementation(libs.kotlinx.coroutines.android)
    }
    iosMain.dependencies {
        implementation(libs.ktor.client.darwin)
    }
}
```

One pitfall we hit: `ktor-client-darwin` needs additional `linkerOpts` when running unit tests on the iOS simulator. Otherwise, you may get linker errors. The fix is to explicitly add `-framework CFNetwork` to the `iosSimulatorArm64` target.

---

## Compose Multiplatform Collaboration and Layering

Compose Multiplatform (CMP) entered a more stable phase for iOS after 1.6, and Web support makes "one UI codebase for three platforms" feasible. My view is still conservative: **the payoff from sharing UI depends on the team, but the payoff from sharing business logic applies to every team**.

If you decide to use CMP for shared UI, keep one rule in mind: Composable functions can live in `commonMain`, but **platform-specific UI capabilities such as camera, map, and WebView must be wrapped as Composable `expect` declarations**. Do not reference platform SDKs directly.

```kotlin
// commonMain
@Composable
expect fun MapView(
    modifier: Modifier = Modifier,
    latitude: Double,
    longitude: Double
)

// androidMain
@Composable
actual fun MapView(modifier: Modifier, latitude: Double, longitude: Double) {
    AndroidView(
        modifier = modifier,
        factory = { context -> MapView(context).apply { /* init */ } }
    )
}

// iosMain - Embed MKMapView through UIKitView
@Composable
actual fun MapView(modifier: Modifier, latitude: Double, longitude: Double) {
    UIKitView(
        modifier = modifier,
        factory = { MKMapView() },
        update = { view -> /* set region */ }
    )
}
```

In our project, pure content UIs such as lists, detail pages, and forms are shared through CMP. Pages that depend heavily on platform capabilities, such as maps, camera, and payments, remain separately implemented on Android and iOS. Navigation is coordinated through a route protocol in the shared ViewModel. That boundary is clear in real engineering work and does not create many gray areas.

---

## Engineering Details Worth Recording

**Kotlin/Native memory model migration**. KMP has used the new memory model by default since 1.7.20, which removes the old strict object ownership constraints and makes cross-thread object sharing much safer. If older code depends on `freeze()` or specific old-memory-model behavior, migration can introduce subtle bugs. These issues do not usually fail loudly; they often show up as incorrect state in multithreaded scenarios. Run dedicated concurrency tests on critical paths under the new memory model.

**Platform coverage for unit tests**. `commonMain` code can run tests on the JVM through `jvmTest` or `androidUnitTest`, which is fast and CI-friendly. But Kotlin/Native differs from the JVM in subtle ways, including numeric overflow behavior and string encoding details. For critical paths, also run `iosSimulatorArm64Test`. It is slower, but it catches platform-difference bugs.

**Incremental compilation in Xcode integration**. When a KMP iOS framework is integrated with Xcode, incremental builds often trigger a full Kotlin compilation by default, which can make build time spike. The fix is to enable `kotlin.incremental.multiplatform=true` in `gradle.properties` and use it with the Gradle Build Cache. After enabling this in CI, our iOS build time dropped from about 8 minutes to about 3 minutes.

---

## My Take

KMP's engineering maturity is now good enough for production. Ecosystem libraries such as Ktor, SQLDelight, and Koin have stable KMP support. The biggest uncertainty is not the technology itself, but **the team's Kotlin/Native debugging capability**. When crashes happen in the Native layer, stack traces are far less readable than JVM stack traces, and the team needs dedicated familiarity with debugging KMP artifacts in LLDB.

If your project is Android-led and needs to share core logic with iOS, KMP is currently my top recommendation. The benefits are clear and the risks are manageable. If the iOS team strongly prefers SwiftUI, start by sharing only the logic layer and let each platform keep its own UI. That is usually easier to land than forcing CMP across the whole app.
