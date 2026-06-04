---
title: 深入 Compose Multiplatform 桌面端实战：从 JVM 窗口管理到平台互操作的跨桌面 UI 工程全链路
excerpt: 从 Electron 迁移到 Compose Desktop 的实战复盘，覆盖 JVM 窗口系统、菜单栏、拖拽、系统托盘、平台互操作及打包分发全链路，启动速度提升 60%，内存降低 70%，适合 Android/Kotlin 团队构建桌面工具。
publishDate: '2026-06-04'
tags:
- Compose Multiplatform
- Desktop
- Kotlin
- 跨平台
- 性能优化
seo:
  title: 深入 Compose Multiplatform 桌面端实战：从 JVM 窗口管理到平台互操作的跨桌面 UI 工程全链路
  description: 从 Electron 到 Compose Desktop 的迁移实战，详解 JVM 窗口系统、菜单栏、拖拽、系统托盘、平台互操作与打包分发，启动从 4s 降至 1.5s，内存从 400MB 降至 120MB。
---

去年我把一个内部工具从 Electron 重写为 Compose Desktop，初衷很简单：团队都是 Android/Kotlin 背景，不想再维护一套前端技术栈。迁移过程中最大的挑战不是 UI 绘制，而是桌面端特有的能力——窗口生命周期、系统托盘、菜单栏、拖拽，这些在 Android 上根本没概念。

## JVM 窗口系统：Compose Window 的底层封装

Compose Desktop 的窗口 API 看起来和 Android Activity 相似，底层路径完全不同。

每个 `ComposeWindow` 本质是 `java.awt.Frame` 的封装。调用 `application { Window(...) {} }` 时，框架会在 AWT 事件分发线程（EDT）上创建原生窗口，然后启动 Skia 渲染管线接管绘制。窗口事件（resize、move、focus）和 Compose 重组跑在两个线程模型上：

```kotlin
fun main() = application {
    var count by remember { mutableStateOf(0) }
    Window(
        onCloseRequest = ::exitApplication,
        title = "DevTools",
        state = rememberWindowState(width = 900.dp, height = 600.dp)
    ) {
        // Compose 重组在 Skia 渲染线程
        // 但 onCloseRequest 回调来自 AWT EDT
        Column(Modifier.padding(16.dp)) {
            Text("Count: $count")
            Button(onClick = { count++ }) { Text("+1") }
        }
    }
}
```

有一个容易踩的坑：`onCloseRequest` 等窗口事件回调运行在 AWT EDT 上，而 Compose 状态读写通常由 Skia 线程持有。Compose Desktop 内部做了线程桥接，但如果回调中执行了耗时操作，或在非 EDT 线程调用 AWT API，行为未定义。

**多窗口管理**是 Android 开发者最不习惯的部分。Android 上 Activity 栈由系统管理，桌面端你完全掌控窗口生命周期：

```kotlin
fun main() = application {
    val windows = mutableStateListOf<Window>()

    Window(onCloseRequest = ::exitApplication) {
        var settingsOpen by remember { mutableStateOf(false) }

        Button(onClick = { settingsOpen = true }) { Text("Settings") }

        if (settingsOpen) {
            Window(
                onCloseRequest = { settingsOpen = false },
                title = "Settings"
            ) {
                SettingsPanel()
            }
        }
    }
}
```

这段代码在 Android Compose 中行不通，但在 Desktop 上可以。每个 `Window` 组合函数在调用时创建独立的原生窗口，只要它在组合树中，窗口就存在。我实际项目中用这个模式实现了"点击弹出独立配置面板"，省掉了 Activity 跳转那一套。

窗口状态持久化也不复杂。`WindowState` 提供位置和大小信息，配合 `rememberWindowState` 可以直接序列化：

```kotlin
@Serializable
data class SavedWindowState(
    val x: Int, val y: Int, val width: Int, val height: Int
)

val windowState = rememberWindowState().apply {
    // 恢复上次关闭时的位置
    savedState?.let { (x, y, w, h) ->
        position = WindowPosition(x.dp, y.dp)
        size = DpSize(w.dp, h.dp)
    }
}
```

## 菜单栏：系统原生 vs 自定义渲染

Compose Desktop 的菜单栏分两条路：系统原生 MenuBar 和 Compose 自绘 DropdownMenu。

系统 MenuBar 在 macOS 上映射到屏幕顶部菜单栏，在 Windows/Linux 上附着在窗口内部。跨平台行为差异不是框架的问题，而是操作系统本身的约定：

```kotlin
Window(onCloseRequest = ::exitApplication) {
    MenuBar {
        Menu("File") {
            Item("New", onClick = { action(NewFile) }, shortcut = KeyShortcut(Key.N, ctrl = true))
            Item("Open...", onClick = { action(OpenFile) })
            Separator()
            Item("Quit", onClick = ::exitApplication, shortcut = KeyShortcut(Key.Q, ctrl = true))
        }
        Menu("Edit") {
            Item("Undo", onClick = { /* ... */ })
        }
    }
    // 主体内容...
}
```

`shortcut` 参数会按平台自动适配：macOS 使用 Cmd 键，其他平台用 Ctrl。

我踩过一个坑：macOS 要求在 `build.gradle.kts` 中设置 `-Dapple.awt.application.name=`，否则菜单栏第一项显示包名而非应用名。这个细节文档一笔带过，调试花了我半天：

```kotlin
compose.desktop {
    application {
        jvmArgs("-Dapple.awt.application.name=DevTools")
    }
}
```

如果想完全自定义样式，直接放弃 MenuBar，用 Compose 的 `DropdownMenu` 替代。代价是失去系统原生行为——macOS 的菜单栏搜索、VoiceOver 支持都不会有，如果你的用户群对无障碍有要求，这个取舍要提前想清楚。

## 拖拽：从文件到内容的通用交互

桌面端拖拽分两个场景：外部文件拖入窗口，以及控件间拖拽。

**文件拖入**用 `onExternalDrag` 修饰符，这是 Desktop 特有的 API：

```kotlin
var isDragOver by remember { mutableStateOf(false) }

Box(
    Modifier
        .fillMaxSize()
        .onExternalDrag(
            enabled = true,
            onDragStart = { isDragOver = true },
            onDragExit = { isDragOver = false },
            onDrag = { dragData ->
                if (dragData is DragData.FilesList) {
                    // 获取拖入的文件路径列表
                    processFiles(dragData.readFiles())
                }
            }
        )
        .background(if (isDragOver) Color.LightGray else Color.Transparent)
) {
    Text("Drop files here", modifier = Modifier.align(Alignment.Center))
}
```

`DragData.FilesList` 返回标准 `java.io.File` 列表。但这个 API 目前有个限制：不支持拖拽预览图，也不支持自定义拖出（DragSource）。如果你的应用需要把内容拖到 Finder 或资源管理器，只能直接调 AWT 的 TransferHandler——我试过，跟 Compose 的交互体验很差。

**控件间拖拽**走 Compose 通用 `dragAndDropSource` / `dragAndDropTarget` 方案，和 Android 一致，不做赘述。

## 系统托盘：常驻后台的最小化方案

系统托盘是桌面应用区别于移动端的关键能力，Compose Desktop 通过 `Tray` 组合函数支持：

```kotlin
Tray(
    icon = painterResource("ic_tray.png"),
    tooltip = "DevTools running",
    onAction = { window.isVisible = !window.isVisible },
    menu = {
        Item("Show Window") { window.isVisible = true }
        Item("Sync Now") { triggerSync() }
        Separator()
        Item("Quit") { exitApplication() }
    }
)
```

`icon` 在不同平台有各自的渲染尺寸要求。macOS 菜单栏图标建议 22×22 像素（模板图像），Windows 系统托盘 16×16 或 32×32。我用 `painterResource` 加载矢量 SVG 让框架自行缩放，比预切多个尺寸省事。

注意 `exitApplication()` 的调用时机。Tray 中退出必须清理所有资源，我的做法是在 `application` 块中用 `DisposableEffect` 注册清理逻辑：

```kotlin
fun main() = application {
    DisposableEffect(Unit) {
        onDispose {
            // 关闭数据库连接、停止后台任务
            cleanup()
        }
    }

    var windowVisible by remember { mutableStateOf(false) }

    Tray(/* ... */) {
        Item("Quit", onClick = ::exitApplication)
    }

    if (windowVisible) {
        Window(onCloseRequest = { windowVisible = false }) {
            // 主窗口内容
        }
    }
}
```

这样无论从窗口关闭还是托盘菜单退出，清理逻辑都能走到。

## 平台互操作：expect/actual 分治桌面差异

Compose Multiplatform 的多平台策略在 Desktop 上碰到一个现实问题：macOS、Windows、Linux 之间的差异比开发前预估的大。

最典型的场景是**文件选择对话框**。macOS 上 `FileDialog` 运行在独立 `NSOpenPanel` 中，阻塞当前窗口但不阻塞整个应用；Windows 行为类似但对话框样式不同。Linux 各发行版差异更大，GNOME 和 KDE 的文件选择器外观完全不同。

我的做法是定义 `expect` 声明统一入口，`actual` 实现处理平台差异：

```kotlin
// commonMain
expect fun showOpenFileDialog(onResult: (File?) -> Unit)

// jvmMain - macOS
@OptIn(ExperimentalForeignApi::class)
actual fun showOpenFileDialog(onResult: (File?) -> Unit) {
    if (Platform.isMacOS()) {
        // 使用 AWT FileDialog，macOS 上会映射到 NSOpenPanel
        val dialog = FileDialog(null as Frame?, "Open File", FileDialog.LOAD)
        dialog.isVisible = true
        onResult(dialog.files.firstOrNull())
    }
}
```

真实项目中我更推荐直接判断 `hostOs`，而不是用 expect/actual 区分 Desktop 内部平台。Desktop 只有一个 target（JVM），拆多个 source set 反而增加维护成本：

```kotlin
object Platform {
    val os: OS by lazy {
        val name = System.getProperty("os.name").lowercase()
        when {
            name.contains("mac") -> OS.MACOS
            name.contains("win") -> OS.WINDOWS
            else -> OS.LINUX
        }
    }
}
```

## 打包分发：工程化的最后一环

Compose Desktop 打包默认用 `packageDistributableForCurrentOS`，生成平台原生安装包。macOS 出 `.dmg`，Windows 出 `.msi` 或 `.exe`，Linux 出 `.deb` 或 `.rpm`。

实际项目中最头疼的是应用签名。macOS 不签名无法通过 Gatekeeper，用户会看到"无法验证开发者"的警告。目前 Compose Desktop 的 Gradle 插件不直接支持签名配置，需要在 `packageDmg` 后自己写脚本调用 `codesign`。Windows 类似，需要 `signtool` 处理。

另一个细节：JRE 的裁剪。默认打包带完整 JDK，体积 200MB+。用 `modules` 参数指定所需模块，可以压到 60MB 左右：

```kotlin
compose.desktop {
    application {
        nativeDistributions {
            modules("java.sql", "java.naming")  // 只保留实际用到的模块
        }
    }
}
```

模块依赖需要自己梳理，`jdeps` 工具能帮上忙。我当时先跑一次完整打包，看报缺失哪些模块，反向剔除。

---

回到开头的迁移决策：从 Electron 换到 Compose Desktop 后，应用启动从 4 秒降到 1.5 秒，内存占用从 400MB 降到 120MB。代价是失去 Web 生态的丰富组件库，以及需要自己补桌面交互的坑。

如果你团队以 Android/Kotlin 为主，Compose Desktop 应对内部工具、调试面板这类桌面应用已经足够。但对于面向终端用户的商业产品，窗口系统、托盘、打包签名这些工程细节的打磨成本需要提前算清楚。
