---
title: "Inside Android SplashScreen API: System Startup Windows and Compose"
lang: en
translationKey: android-splash-screen-api
slug: android-splash-screen-api
excerpt: "A deep dive into Android 12 SplashScreen API, system startup-window behavior, cold-start timing, Compose integration, migration traps, and launch UX."
publishDate: '2025-09-22'
tags:
- "Android"
- "SplashScreen"
- "Startup Optimization"
- "Jetpack Compose"
seo:
  title: "Android SplashScreen API: Startup Windows, Compose, and Migration"
  description: "Understand Android 12 SplashScreen API from system startup windows and cold-start timing to Compose integration, exit control, and migration pitfalls."
  pageType: article
---

At the end of last year, while optimizing startup for a large app, I ran into a compatibility problem. The team had used a custom `SplashActivity` to draw its launch screen for three years. After moving to `targetSdkVersion 34`, Google Play review rejected the app: Android 12 requires the system-level `SplashScreen API`, and the old approach can show two splash screens on Android 12 and later.

The migration was more involved than expected, so this article walks through the pitfalls and the underlying window mechanism.

## SplashScreen API is not another splash-screen widget

Many articles introduce `SplashScreen API` as if it were a new Jetpack-provided UI component. That framing is misleading.

The `SplashScreen` introduced in Android 12 is a **system-level window transition** mechanism. During a cold start, the system does not first start the Activity and wait for the app to draw UI. Instead, `WindowManagerService` directly submits a starting window to `SurfaceFlinger`. This window is rendered from the `windowBackground` theme attributes and does not go through the app process's layout or drawing pipeline.

```xml
<!-- themes.xml -->
<style name="Theme.App.Splash" parent="Theme.SplashScreen">
    <item name="windowSplashScreenBackground">@color/brand_blue</item>
    <item name="windowSplashScreenAnimatedIcon">@drawable/ic_logo</item>
    <item name="postSplashScreenTheme">@style/Theme.App.Main</item>
</style>
```

The three core attributes are:

- `windowSplashScreenBackground`: the splash background color, which the system can render before the app process starts
- `windowSplashScreenAnimatedIcon`: supports `AnimationDrawable` and `AnimatedVectorDrawable`; the size must not exceed one third of the screen
- `postSplashScreenTheme`: the theme automatically applied after the splash screen exits, preventing splash-theme leakage into later pages

The `SplashScreen` lifecycle begins before the first `Activity` is created. At the window layer, it sits above normal Activity windows. That is why a `SplashActivity`-based solution can produce stacked splash screens.

## Breaking down the cold-start timeline

The full cold-start path can be divided into three stages:

```text
System forks process -> Application.onCreate()
    -> first Activity.onCreate()
    -> Activity.onResume()
    -> first frame is drawn
    -> SplashScreen exits
```

After the user taps the launcher icon, Launcher sends a request through `startActivity()`. If the target process does not exist, `zygote` forks a new process. During process initialization there would otherwise be nothing on screen, but the `SplashScreen` window has already been added to the top of the window stack by `WindowManager`.

**Expensive work in `Application.onCreate()` directly extends splash-screen duration.** The `SplashScreen` exit condition is that the first Activity has completed its first frame, and Activity creation depends on Application initialization being complete.

```kotlin
// Bad: doing heavy initialization in Application
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Every extra 100 ms here is 100 ms more splash-screen time
        initThirdPartySdks()    // Synchronous initialization
        loadHeavyConfig()       // Synchronous I/O
    }
}
```

Move nonessential initialization until after the first frame:

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Keep only the minimum startup-critical initialization
        initCrashReporting()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Run heavy work after the first frame
        window.decorView.post {
            initThirdPartySdks()
            loadHeavyConfig()
        }
    }
}
```

`window.decorView.post` ensures the work runs after the first frame has been drawn, so it does not block `SplashScreen` exit.

## Seamless transition from system splash to app content

The `SplashScreen` exit timing is controlled with `setKeepOnScreenCondition`:

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // installSplashScreen must be called before super.onCreate
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        splash.setKeepOnScreenCondition {
            // Keep the splash screen until data is ready
            !mainViewModel.isDataReady.value
        }

        setContent {
            MainScreen()
        }
    }
}
```

`installSplashScreen()` must be called **before** `super.onCreate()`. If the order is reversed, the system has already completed the default splash flow, and your exit condition will not take effect.

When `SplashScreen` exits, there is a forced 200 ms settle duration to prevent visual jitter from content popping in abruptly. This duration is fixed by Google and cannot be configured.

The exit animation has two phases:

1. **Icon scale-out**: `AnimatedIcon` scales from the center to the target position or simply fades out.
2. **Background fade-out**: `Background` exits with a `fadeOut` animation.

Most apps do not need a custom exit animation. If you do, hook `OnExitAnimationListener`:

```kotlin
installSplashScreen().setOnExitAnimationListener { splashScreenView ->
    // Get the SplashScreenView reference and run your own animation
    splashScreenView.iconView
        .animate()
        .alpha(0f)
        .scaleX(1.5f)
        .scaleY(1.5f)
        .setDuration(300)
        .withEndAction {
            splashScreenView.remove()  // Must remove manually, or the window remains
        }
        .start()
}
```

`splashScreenView.remove()` cannot be omitted. Otherwise the `SplashScreen` window remains permanently in the window stack, and touch-event passthrough stops working. The first time I made this mistake, it took an entire afternoon to debug.

## Compose integration and theme handoff

Compose does not have an `Activity.setContentView()` step, but the principle is the same: `SplashScreen` exits after Compose completes its first composition and submits the first frame.

The theme handoff needs extra care. After `installSplashScreen()` and before `setContent`, switch back to the main theme manually:

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        // Switch back to the main theme immediately so the splash theme does not leak into Compose
        setTheme(R.style.Theme.App.Main)

        setContent {
            AppTheme {
                MainNavHost()
            }
        }
    }
}
```

In theory, `postSplashScreenTheme` can switch themes automatically. In Compose apps I prefer calling `setTheme` manually. In real testing, some OEM ROMs, especially heavily customized vendor builds, do not cleanly apply `postSplashScreenTheme`, which can skew `MaterialTheme` color references.

For flows that need a custom splash animation, Compose can coordinate with the exit event:

```kotlin
@Composable
fun SplashAwareContent() {
    var showSplash by remember { mutableStateOf(true) }

    Box {
        MainContent()

        if (showSplash) {
            BrandSplashOverlay(
                modifier = Modifier.fillMaxSize(),
                onFinished = { showSplash = false }
            )
        }
    }
}
```

I do not recommend drawing another fake splash layer in Compose. There are two reasons: it adds first-frame rendering cost, and the flicker caused by two overlapping splash screens is visible on low-end devices. The main advantage of the system splash screen is zero-latency rendering. Drawing another one in Compose cancels out that advantage.

## Three migration pitfalls

**Pitfall 1: Reflection workarounds fail on newer systems**

In the early Android 12 period, many teams used reflection into `WindowManagerGlobal` to disable the system splash screen and keep their old solution. After Android 14, those APIs were marked with `@UnsupportedAppUsage`, and reflection started throwing exceptions.

Do not spend time trying to bypass this. If you truly need the flexibility of the old design, the problem is not the splash screen itself. Break down what has to happen during splash: what requires Application initialization, and what can be delayed until the first `IdleHandler`.

**Pitfall 2: Confusing `ThemedSplashScreen` with `SplashScreen` compatibility**

`androidx.core:core-splashscreen:1.0.0` introduced `SplashScreen` and also supports Android 12 `ThemedSplashScreen`. On API 31 and later, the library calls the platform API instead of implementing its own splash window. On API levels below 31, however, it **creates a simulated SplashScreen window** itself. The behavior is not identical to the system version: exit animation duration differs, and `AnimatedVectorDrawable` is not supported.

```gradle
// build.gradle
dependencies {
    // Provides a similar experience on API levels below 31
    implementation("androidx.core:core-splashscreen:1.0.1")
}
```

Theme configuration needs to cover both cases. On devices below Android 12, `windowSplashScreenAnimatedIcon` animation does not loop; it plays once.

**Pitfall 3: Duplicate splash screens in multi-process apps**

When an app has multiple processes, such as an isolated WebView process, `Application.onCreate()` outside the main process does not trigger generation of the `SplashScreen` window. But if the `:web` process also declares a `SplashActivity`, it still runs the old splash logic, causing a double splash during cold start of that process.

## Practical recommendations

My migration priority is:

1. **Adopt the system splash screen first**: use `windowSplashScreenBackground` plus `windowSplashScreenAnimatedIcon` to cover 95% of needs, and move nonessential logic in `Application.onCreate` to after `decorView.post`.
2. **Then handle exit control**: use `setKeepOnScreenCondition` to control exit timing for data-dependent screens. Use it carefully: every extra 100 ms of splash time is 100 ms added to perceived startup time.
3. **Finally consider migrating old animations**: if the brand requires a complex launch animation, such as a movie-like transition from logo to home screen, `OnExitAnimationListener` is the only supported exit point. Test carefully, because Huawei and OPPO devices differ in exit-animation timing.

Startup optimization has a blunt truth: users perceive launch speed from the time when the first real content appears, not from how polished the splash screen looks. The real value of `SplashScreen API` is not making the splash screen prettier. It moves startup-window rendering from the app process to the system process and removes the blank-screen gap during process initialization. Once you see that clearly, you can use the API correctly.
