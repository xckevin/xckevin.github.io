---
title: Kotlin Multiplatform 工程化深度实践：expect/actual 机制与跨平台架构分层落地
excerpt: 深入探讨 KMP 生产环境落地的核心问题，涵盖 expect/actual 正确使用姿势、三层架构分层方案、XCFramework 编译配置及 Compose Multiplatform 协同策略，聚焦真实工程踩坑与解法。
publishDate: '2026-04-18'
tags:
- Kotlin Multiplatform
- Android
- iOS
- 跨平台架构
- Compose Multiplatform
seo:
  title: Kotlin Multiplatform 工程化深度实践：expect/actual 机制与跨平台架构分层落地
  description: 深入解析 KMP 生产环境工程化实践，包括 expect/actual 使用边界、三层架构分层设计、XCFramework 静态库配置、Compose Multiplatform 协同分层及 Kotlin/Native 调试要点。
---

KMP（Kotlin Multiplatform）在 2023 年底正式 Stable，但真正大规模进入生产环境是在 2025-2026 年这个窗口。我们团队从去年 Q3 开始把核心业务逻辑层迁移到 KMP，踩了不少坑，这篇文章不讲 Hello World，只聊工程化阶段真实遇到的问题。

---

## expect/actual 的正确使用姿势

`expect/actual` 是 KMP 的核心机制，但很多团队用偏了——把它当成"平台差异的垃圾桶"，什么逻辑都往里塞，最终 `actual` 实现散落在各个模块，维护成本反而比双端分开写更高。

正确的思路是：**`expect/actual` 只做平台能力的声明，不做业务逻辑的分叉**。

典型的合理用法是封装平台日志：

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

常见的反模式是在 `expect` 函数中暴露平台特有类型，比如把 `Context` 放到 `commonMain` 接口里。这会迫使 iOS 侧的 `actual` 实现维护一个假的 `Context` 对象，纯属自找麻烦。

更棘手的问题出现在 `expect class` 有继承关系时。KMP 不允许 `expect class` 继承其他类，只能实现接口。封装数据库驱动、网络客户端这类平台组件时这个限制会让你头疼。**解法是用接口 + 工厂函数替代 `expect class`**：

```kotlin
// commonMain
interface DatabaseDriver {
    fun execute(sql: String): Long
    fun query(sql: String): List<Map<String, Any?>>
}

expect fun createDatabaseDriver(name: String): DatabaseDriver
```

这样 `actual` 侧的实现类可以自由继承平台 SDK 的类，灵活度高很多。

---

## 模块分层：共享代码的边界在哪里

这是工程化阶段最难达成共识的问题。我见过两种极端：一种团队把所有代码都塞进 `commonMain`，结果大量 `if (isAndroid)` 判断散落全文；另一种团队只共享数据模型，业务逻辑还是各端自己写，KMP 形同虚设。

我们最终落地的分层方案是三层结构：

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

**中间层（Shared Business Logic）是 KMP 价值密度最高的地方**。这里放 ViewModel、UseCase 和 Repository 接口，用 Kotlin Coroutines + Flow 驱动状态，两端 UI 层只负责订阅状态和触发事件。

Repository 接口定义在 `commonMain`，具体数据源实现通过依赖注入在各平台注入：

```kotlin
// commonMain - Repository 接口
interface ArticleRepository {
    fun getArticles(): Flow<List<Article>>
    suspend fun refresh(): Result<Unit>
}

// commonMain - ViewModel（用 KMP 版 ViewModel 或自行封装）
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

iOS 侧用 `StateFlow` 转 Combine 的工具类（Kotlin 官方提供了 `KmpObservableViewModel` 等方案，或者手写 wrapper）。有个实践细节踩过坑：iOS 侧订阅 `StateFlow` 时**必须在主线程**，否则 SwiftUI 更新会抛线程异常，这个问题在调试时非常隐蔽，往往要到 UI 刷新出问题才暴露。

---

## 编译产物差异与 Gradle 配置

KMP 编译产物在 Android 和 iOS 有本质区别，这个差异会影响 CI 策略和发布节奏。

Android 侧输出标准 AAR，走 Gradle 发布到 Maven，和普通 Android 库没有区别。

iOS 侧输出 XCFramework，`build.gradle.kts` 的正确配置方式是用 `XCFramework` 实例聚合各 target 产物：

```kotlin
kotlin {
    val xcf = XCFramework("SharedKit")
    listOf(
        iosX64(), iosArm64(), iosSimulatorArm64()
    ).forEach {
        it.binaries.framework {
            baseName = "SharedKit"
            isStatic = true // 静态库减少启动时动态链接开销
            xcf.add(this)
        }
    }
}
```

**静态库（`isStatic = true`）vs 动态库是个值得认真考虑的选择**。静态库编译进主包，启动时无需动态链接，iOS 冷启动性能略好；动态库可以被多个 target 共享，适合有多个 App Extension 的场景。我们选了静态库，项目中没有 Extension，静态库在 CocoaPods 集成时链接问题也更少。

Gradle 依赖管理上，KMP 项目的 `build.gradle.kts` 很容易膨胀。用 `sourceSets` 块隔离各平台依赖，避免平台特定实现污染 `commonMain`：

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

一个踩过的坑：`ktor-client-darwin` 在 iOS 模拟器上跑单元测试时需要额外配置 `linkerOpts`，不然会报链接错误。解决方式是在 `iosSimulatorArm64` target 里显式添加 `-framework CFNetwork`。

---

## Compose Multiplatform 的协同分层

Compose Multiplatform（CMP）在 1.6 之后 iOS 支持进入稳定期，加上 Web 支持，让"一套 UI 代码三端运行"变得可行。但我对这件事的判断比较保守：**UI 层共享的收益因团队而异，共享业务逻辑层的收益对所有团队都成立**。

如果决定用 CMP 做 UI 共享，有一点要注意：Composable 函数本身可以放 `commonMain`，但**平台特定的 UI 能力（相机、地图、WebView）必须通过 `expect` 封装为 Composable**，不能直接引用平台 SDK。

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

// iosMain - 通过 UIKitView 嵌入 MKMapView
@Composable
actual fun MapView(modifier: Modifier, latitude: Double, longitude: Double) {
    UIKitView(
        modifier = modifier,
        factory = { MKMapView() },
        update = { view -> /* set region */ }
    )
}
```

在我们的项目里，列表页、详情页、表单这类纯内容 UI 用 CMP 共享，地图、相机、支付这类重度平台能力的页面还是双端各自实现，通过路由协议在共享 ViewModel 里协调跳转。这个边界在实际工程中比较清晰，不会有太多灰色地带。

---

## 几个值得记录的工程细节

**Kotlin/Native 内存模型迁移**。KMP 1.7.20 之后默认启用新内存模型，不再有严格的对象所有权限制，跨线程共享对象安全了很多。如果旧代码依赖 `freeze()` 或旧内存模型的特定行为，迁移时会有隐性 bug——这类问题不会有明显报错，通常表现为多线程场景下数据状态异常。建议把关键路径的逻辑在新内存模型下专门跑一轮并发测试。

**单元测试的平台覆盖**。`commonMain` 的代码可以在 JVM 上跑测试（通过 `jvmTest` 或 `androidUnitTest`），速度快，适合 CI。但 Kotlin/Native 在某些细节上和 JVM 有微妙差异，比如数字溢出行为和字符串编码。关键路径的逻辑建议同时跑 `iosSimulatorArm64Test`，虽然慢，但能发现平台差异 bug。

**Xcode 集成的增量编译问题**。KMP iOS 框架在 Xcode 里做增量编译时，默认每次都会触发完整的 Kotlin 编译，构建时间会暴增。解决方案是在 `gradle.properties` 里开启 `kotlin.incremental.multiplatform=true`，配合 Gradle Build Cache 使用。我们 CI 上开启后 iOS 构建时间从 8 分钟降到 3 分钟左右。

---

## 我的判断

KMP 现在的工程成熟度已经够用了，Ktor、SQLDelight、Koin 这些生态库的 KMP 支持也都稳定。最大的不确定性不在技术，而在**团队的 Kotlin/Native 调试能力**——崩溃一旦发生在 Native 层，堆栈信息的可读性和 JVM 差距很大，需要专门熟悉用 LLDB 调试 KMP 产物。

如果你们是 Android 团队主导、需要把核心逻辑共享给 iOS 的场景，KMP 是我目前最推荐的方案，收益明确，风险可控。如果 iOS 团队有强烈的 SwiftUI 偏好，先共享逻辑层、UI 层各自实现，比强推 CMP 更容易落地。
