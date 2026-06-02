---
title: 深入 Android Splash Screen API 全链路：从 Android 12 系统级闪屏到 Compose 自定义启动画面的启动体验工程实践
excerpt: 深入解析 Android 12 SplashScreen API 的系统级窗口机制与冷启动全链路，涵盖 Compose 适配、迁移踩坑及实践建议。
publishDate: '2025-09-22'
tags:
- Android
- SplashScreen
- 启动优化
- Jetpack Compose
seo:
  title: 深入 Android Splash Screen API 全链路：从 Android 12 系统级闪屏到 Compose 自定义启动画面的启动体验工程实践
  description: Android 12 SplashScreen API 全链路解析：从系统级窗口机制、冷启动时间线到 Compose 接入与迁移实践，帮助开发者用系统闪屏消除启动白屏间隙。
---

去年底给一个大型 App 做启动优化，撞上了兼容性难题。团队用自定义 `SplashActivity` 画闪屏跑了三年，升到 targetSdkVersion 34 后 Google Play 审核直接拒了——Android 12 强制要求使用系统级 `SplashScreen API`，老方案在 Android 12+ 上会出双闪屏。

改造过程比预想的绕，这里串一下踩过的坑和底层窗口机制。

## SplashScreen API 不是"另一个闪屏方案"

很多文章把 `SplashScreen API` 当成 Jetpack 提供的某个新控件来介绍，这个理解偏了。

Android 12 引入的 `SplashScreen` 本质上是一套**系统级窗口过渡**机制。冷启动时，系统不会先拉 Activity 再让它画 UI，而是由 `WindowManagerService` 直接向 `SurfaceFlinger` 提交一个启动窗口。这个窗口由 `windowBackground` 主题属性渲染，不经过应用进程的布局和绘制管线。

```xml
<!-- themes.xml -->
<style name="Theme.App.Splash" parent="Theme.SplashScreen">
    <item name="windowSplashScreenBackground">@color/brand_blue</item>
    <item name="windowSplashScreenAnimatedIcon">@drawable/ic_logo</item>
    <item name="postSplashScreenTheme">@style/Theme.App.Main</item>
</style>
```

三个核心属性：

- `windowSplashScreenBackground`：闪屏背景色，系统在应用进程启动前就能渲染到屏幕上
- `windowSplashScreenAnimatedIcon`：支持 `AnimationDrawable` 和 `AnimatedVectorDrawable`，尺寸不能超过屏幕的 1/3
- `postSplashScreenTheme`：闪屏结束后自动切换的主题，防止闪屏主题泄漏到后续页面

`SplashScreen` 的生命周期在第一个 `Activity` 创建之前。它在 Window 层面的层级高于普通 Activity 窗口，这解释了为什么用 `SplashActivity` 方案时会出现两个闪屏叠加。

## 冷启动窗口的时间线拆解

完整的冷启动链路可以切成三个阶段：

```
系统 fork 进程 → Application.onCreate()
    → 第一个 Activity.onCreate()
    → Activity.onResume()
    → 第一帧绘制完成
    → SplashScreen 退出
```

用户点击图标后，Launcher 通过 `startActivity()` 发起请求。目标进程不存在时，`zygote` fork 一个新进程。进程初始化期间屏幕上什么都没有——这时 `SplashScreen` 窗口已经被 `WindowManager` 加到窗口栈顶了。

**`Application.onCreate()` 中的耗时操作会直接拖长闪屏停留时间。** `SplashScreen` 的退出条件是第一个 Activity 完成第一帧绘制，而 Activity 创建又依赖 Application 初始化完成。

```kotlin
// ❌ 错误做法：在 Application 中做大量初始化
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 这里每多 100ms，用户就多看闪屏 100ms
        initThirdPartySdks()    // 同步初始化
        loadHeavyConfig()       // 同步 IO
    }
}
```

把非必要初始化推迟到第一帧之后：

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 只保留启动必需的最小初始化
        initCrashReporting()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 第一帧后再初始化重任务
        window.decorView.post {
            initThirdPartySdks()
            loadHeavyConfig()
        }
    }
}
```

`window.decorView.post` 保证任务在第一帧绘制完成后执行，不会阻碍 `SplashScreen` 退出。

## 从系统闪屏到 App 内容的无缝过渡

`SplashScreen` 的退出时机用 `setKeepOnScreenCondition` 控制：

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // installSplashScreen 必须在 super.onCreate 之前调用
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        
        splash.setKeepOnScreenCondition {
            // 数据加载完成前保持闪屏
            !mainViewModel.isDataReady.value
        }
        
        setContent {
            MainScreen()
        }
    }
}
```

`installSplashScreen()` 必须在 `super.onCreate()` **之前**调用。顺序反了的话，系统已经走完默认闪屏流程，你设的退场条件不会生效。

`SplashScreen` 退出时有 200ms 强制静置时间（settle duration），用于防止内容突然弹出造成的视觉抖动。这个时长不可配置，是 Google 的固定设计。

退场动画分两个阶段：

1. **图标缩放退出**：`AnimatedIcon` 从中心缩放到指定位置或直接淡出
2. **背景渐隐**：`Background` 以 `fadeOut` 动画退出

需要自定义退场动画的场景不多。真需要的话，hook `OnExitAnimationListener`：

```kotlin
installSplashScreen().setOnExitAnimationListener { splashScreenView ->
    // 拿到 SplashScreenView 引用，自己写动画
    splashScreenView.iconView
        .animate()
        .alpha(0f)
        .scaleX(1.5f)
        .scaleY(1.5f)
        .setDuration(300)
        .withEndAction {
            splashScreenView.remove()  // 必须手动移除，不然窗口残留
        }
        .start()
}
```

`spashScreenView.remove()` 不能省略，否则 `SplashScreen` 窗口永久残留在窗体栈里，导致触摸事件穿透失效。这个坑我第一次写的时候花了整个下午排查。

## Compose 中的接入和主题衔接

Compose 没有 `Activity.setContentView()` 的过程，但原理一样：`SplashScreen` 在 Compose 首次组合完成且第一帧提交后退出。

主题切换点需要格外小心。`installSplashScreen()` 之后、`setContent` 之前手动切回主主题：

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        
        // 立即切回主主题，避免闪屏主题残留到 Compose 内容
        setTheme(R.style.Theme.App.Main)
        
        setContent {
            AppTheme {
                MainNavHost()
            }
        }
    }
}
```

`postSplashScreenTheme` 理论上能自动切换，但在 Compose 场景我倾向于手动 `setTheme`。实际测试中，部分 ROM（尤其是国产厂商的定制系统）上 `postSplashScreenTheme` 切不干净，会导致 `MaterialTheme` 的色彩引用出现偏差。

对于需要自定义闪屏动画的场景，Compose 侧可以配合退场事件做衔接动画：

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

但我不推荐在 Compose 侧再做一层假闪屏。两个原因：多了首帧渲染成本，而且两张闪屏重叠的闪烁感在低端机上肉眼可见。系统级闪屏的优势就是零延迟渲染，再用 Compose 画一层反而把优势抵消了。

## 迁移旧方案的三个踩坑点

**坑 1：反射绕过的方案在新系统上失效**

Android 12 早期不少团队用反射 `WindowManagerGlobal` 禁用系统闪屏来保留老方案。Android 14 后这些 API 加了 `@UnsupportedAppUsage` 标记，反射直接抛异常。

别花时间琢磨绕过去。如果你确实需要老方案那种灵活性，问题不在闪屏本身——把闪屏期间要做的事拆清楚：哪些必须 Application 初始化完成、哪些可以延后到第一个 IdleHandler。

**坑 2：`ThemedSplashScreen` 与 `SplashScreen` 的兼容混淆**

`androidx.core:core-splashscreen:1.0.0` 引入了 `SplashScreen`，同时支持 Android 12 的 `ThemedSplashScreen`。在 API 31+ 设备上，这个库做的是调用平台 API，不自己实现闪屏窗口。但在 API < 31 的设备上，它**自己创建了一个模拟的 SplashScreen 窗口**，行为跟系统版不完全一致——退场动画时长不同、不支持 `AnimatedVectorDrawable`。

```gradle
// build.gradle
dependencies {
    // API < 31 上也提供类似体验
    implementation("androidx.core:core-splashscreen:1.0.1")
}
```

主题设置需要同时覆盖两种情况。Android 12 以下设备上，`windowSplashScreenAnimatedIcon` 动画不会循环，只播一次。

**坑 3：多进程 App 的闪屏重复**

App 有多个进程时（比如 WebView 独立进程），主进程以外的 `Application.onCreate()` 不会触发 `SplashScreen` 窗口生成。但如果 `:web` 进程也定义了 `SplashActivity`，它仍然会走老的闪屏逻辑，导致这个进程冷启动时出现双闪屏。

## 实践建议

改造优先级上，我的排序是：

1. **先上系统闪屏**：用 `windowSplashScreenBackground` + `windowSplashScreenAnimatedIcon` 覆盖 95% 的需求，把 `Application.onCreate` 中非必要逻辑推到 `decorView.post` 之后
2. **再处理退场控制**：用 `setKeepOnScreenCondition` 控制数据依赖型页面的退场时机。但慎用——每多保持 100ms 闪屏，启动感知时长就多 100ms
3. **最后考虑迁移老动画**：品牌有复杂启动动画（比如从 Logo 展开到主页的 Movie 级动画）时，`OnExitAnimationListener` 是唯一出口。做好测试，华为和 OPPO 设备上退场动画时序有差异

启动优化有个残酷的事实：用户对启动速度的感知来自第一帧内容出现的时间，而不是闪屏多好看。`SplashScreen API` 的真正价值不是"让闪屏变漂亮"，而是把启动窗口的渲染从应用进程转移到系统进程，消除了进程初始化期的白屏间隙。想清楚这一点，才算真正用好了这套 API。
