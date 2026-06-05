---
title: "Compose Multiplatform Desktop in Practice: JVM Windows and Platform Interop"
lang: en
translationKey: compose-multiplatform-desktop-jvm-window-platform-interop
slug: compose-multiplatform-desktop-jvm-window-platform-interop
excerpt: "A practical migration from Electron to Compose Desktop, covering JVM window management, menu bars, drag and drop, system trays, platform interop, packaging, and distribution. Startup time improved by 60% and memory usage dropped by 70%."
publishDate: '2026-06-04'
tags:
- "Compose Multiplatform"
- "Desktop"
- "Kotlin"
- "Cross-Platform"
- "Performance Optimization"
seo:
  title: "Compose Multiplatform Desktop: JVM Windows and Platform Interop"
  description: "An Electron-to-Compose Desktop migration covering JVM windows, menus, drag and drop, system tray, platform interop, packaging, and distribution."
  pageType: article
---

Last year, I rewrote an internal tool from Electron to Compose Desktop. The goal was simple: the team was already Android/Kotlin-heavy, and we did not want to maintain a separate frontend stack for an internal tool. The hardest part was not UI rendering. It was desktop-specific behavior: window lifecycle, system tray integration, menu bars, drag and drop, and packaging—areas that Android developers rarely deal with directly.

## JVM Window System: The Underlying Wrapper for Compose Window

The Compose Desktop window API looks similar to an Android `Activity`, but the underlying implementation path is completely different.

Every `ComposeWindow` is essentially a wrapper around `java.awt.Frame`. When calling `application { Window(...) {} }`, the framework creates the native window on the AWT Event Dispatch Thread (EDT) and then starts the Skia rendering pipeline to take over drawing. Window events (resize, move, focus) and Compose recomposition run on two different thread models:

```kotlin
fun main() = application {
    var count by remember { mutableStateOf(0) }
    Window(
        onCloseRequest = ::exitApplication,
        title = "DevTools",
        state = rememberWindowState(width = 900.dp, height = 600.dp)
    ) {
        // Compose recomposition runs on the Skia rendering thread
        // But onCloseRequest callback comes from the AWT EDT
        Column(Modifier.padding(16.dp)) {
            Text("Count: $count")
            Button(onClick = { count++ }) { Text("+1") }
        }
    }
}
```

There's a common pitfall: window event callbacks like `onCloseRequest` run on the AWT EDT, while Compose state reads and writes are typically managed by the Skia thread. Compose Desktop handles thread bridging internally, but if you perform long-running operations in the callback, or call AWT APIs from a non-EDT thread, the behavior is undefined.

**Multi-Window Management** is the least familiar part for Android developers. In Android, the system manages the Activity stack; on desktop, you have complete control over the window lifecycle:

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

This code wouldn't work in Android Compose, but it does on Desktop. Each `Window` composable function creates an independent native window upon invocation; as long as it's in the composition tree, the window exists. I used this pattern in my actual project to implement "click to open a separate configuration panel," bypassing the need for Activity navigation.

Window state persistence is also straightforward. `WindowState` provides position and size information, which can be directly serialized using `rememberWindowState`:

```kotlin
@Serializable
data class SavedWindowState(
    val x: Int, val y: Int, val width: Int, val height: Int
)

val windowState = rememberWindowState().apply {
    // Restore position from last close
    savedState?.let { (x, y, w, h) ->
        position = WindowPosition(x.dp, y.dp)
        size = DpSize(w.dp, h.dp)
    }
}
```

## Menu Bar: Native System vs. Custom Rendering

Compose Desktop offers two paths for the menu bar: the native `MenuBar` or a custom-drawn `DropdownMenu` using Compose.

The native `MenuBar` maps to the top menu bar on macOS and attaches within the window on Windows/Linux. The cross-platform behavioral differences aren't a framework issue, but rather an operating system convention:

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
    // Main content...
}
```

The `shortcut` parameter adapts automatically based on the platform: Cmd key on macOS, Ctrl key on others.

I ran into a snag: macOS requires setting `-Dapple.awt.application.name=` in `build.gradle.kts`, otherwise the first item in the menu bar displays the package name instead of the application name. This detail is glossed over in the documentation, and debugging it took half a day:

```kotlin
compose.desktop {
    application {
        jvmArgs("-Dapple.awt.application.name=DevTools")
    }
}
```

If you want complete style customization, abandon `MenuBar` entirely and use Compose's `DropdownMenu` instead. The trade-off is losing native system behaviors—macOS menu bar search, VoiceOver support, etc. If your user base has accessibility requirements, you must plan for this trade-off upfront.

## Drag and Drop: Universal Interaction from Files to Content

Desktop drag-and-drop involves two scenarios: dragging external files into the window, and dragging between controls.

**File Drop** uses the `onExternalDrag` modifier, which is a Desktop-specific API:

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
                    // Process the list of dropped file paths
                    processFiles(dragData.readFiles())
                }
            }
        )
        .background(if (isDragOver) Color.LightGray else Color.Transparent)
) {
    Text("Drop files here", modifier = Modifier.align(Alignment.Center))
}
```

`DragData.FilesList` returns a standard `java.io.File` list. However, this API currently has limitations: it doesn't support drag preview images, nor does it support custom drag sources. If your application needs to drag content to Finder or the resource manager, you must directly call AWT's `TransferHandler`—I tried it, and the interaction experience is poor compared to Compose.

**Control-to-Control Dragging** uses the standard Compose `dragAndDropSource` / `dragAndDropTarget` pattern, which is consistent with Android, so I won't elaborate.

## System Tray: The Minimalist Solution for Background Presence

The system tray is a key capability distinguishing desktop apps from mobile ones. Compose Desktop supports this via the `Tray` composable:

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

The `icon` has different required rendering sizes across platforms. For macOS, a 22x22 pixel icon (template image) is recommended; for Windows, 16x16 or 32x32. I used `painterResource` to load a vector SVG, letting the framework handle scaling, which was easier than pre-slicing multiple sizes.

Be mindful of when you call `exitApplication()`. When quitting from the Tray, you must clean up all resources. My approach is to register cleanup logic using `DisposableEffect` within the `application` block:

```kotlin
fun main() = application {
    DisposableEffect(Unit) {
        onDispose {
            // Close database connections, stop background tasks
            cleanup()
        }
    }

    var windowVisible by remember { mutableStateOf(false) }

    Tray(/* ... */) {
        Item("Quit", onClick = ::exitApplication)
    }

    if (windowVisible) {
        Window(onCloseRequest = { windowVisible = false }) {
            // Main window content
        }
    }
}
```

This ensures that the cleanup logic runs whether the window is closed or the tray menu triggers an exit.

## Platform Interoperability: Using expect/actual to Isolate Desktop Differences

Compose Multiplatform's multiplatform strategy hits a reality check on Desktop: the differences between macOS, Windows, and Linux are larger than anticipated during development.

The most typical scenario is the **file selection dialog**. On macOS, `FileDialog` runs in a separate `NSOpenPanel`, blocking the current window but not the entire application. Windows behaves similarly but with a different dialog style. Linux has even greater variations across distributions; GNOME and KDE file pickers look completely different.

My approach is to define an `expect` declaration for a unified entry point and use `actual` implementations to handle platform differences:

```kotlin
// commonMain
expect fun showOpenFileDialog(onResult: (File?) -> Unit)

// jvmMain - macOS
@OptIn(ExperimentalForeignApi::class)
actual fun showOpenFileDialog(onResult: (File?) -> Unit) {
    if (Platform.isMacOS()) {
        // Using AWT FileDialog, which maps to NSOpenPanel on macOS
        val dialog = FileDialog(null as Frame?, "Open File", FileDialog.LOAD)
        dialog.isVisible = true
        onResult(dialog.files.firstOrNull())
    }
}
```

In a real project, I actually recommend checking `hostOs` directly rather than using `expect/actual` to differentiate internal Desktop platforms. Desktop only has one target (JVM), and splitting into multiple source sets only increases maintenance overhead:

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

## Packaging and Distribution: The Final Engineering Polish

Compose Desktop defaults to `packageDistributableForCurrentOS`, generating native installers for the target platform. macOS produces a `.dmg`, Windows produces `.msi` or `.exe`, and Linux produces `.deb` or `.rpm`.

The most painful part of a real project is application signing. On macOS, unsigned apps fail Gatekeeper, showing the "Developer cannot be verified" warning. Currently, the Compose Desktop Gradle plugin doesn't directly support signing configuration; you have to write a script to call `codesign` after `packageDmg`. Windows is similar, requiring `signtool`.

Another detail: JRE trimming. The default package includes the full JDK, resulting in a size of 200MB+. Using the `modules` parameter to specify only necessary modules can bring it down to around 60MB:

```kotlin
compose.desktop {
    application {
        nativeDistributions {
            modules("java.sql", "java.naming")  // Only keep modules actually used
        }
    }
}
```

You need to manually map out module dependencies; the `jdeps` tool can help. I started by running a full package build to see which modules were missing, and then worked backward to exclude them.

---

Returning to the original migration decision: after switching from Electron to Compose Desktop, startup time dropped from 4 seconds to 1.5 seconds, and memory usage dropped from 400MB to 120MB. The tradeoff was losing the rich component ecosystem of the Web stack and having to handle desktop interaction details manually.

If your team is primarily Android/Kotlin-focused, Compose Desktop is more than sufficient for internal tools or debugging panels. However, for commercial products facing end-users, the effort required to polish engineering details like window systems, system trays, and package signing must be accounted for upfront.
