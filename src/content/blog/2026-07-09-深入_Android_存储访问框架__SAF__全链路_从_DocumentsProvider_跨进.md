---
title: 深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构
slug: android-storage-access-framework
translationKey: android-storage-access-framework
excerpt: 深入解析 Android SAF 存储访问框架的全链路架构，涵盖 DocumentsProvider 实现、跨进程 Uri 授权机制、DocumentFile 统一访问抽象，以及云存储与本地文件的三种植入模式选型。
publishDate: '2026-07-09'
tags:
- Android
- SAF
- DocumentsProvider
- 存储架构
- Kotlin
seo:
  title: 深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构
  description: 深入解析 Android 存储访问框架 (SAF) 全链路，从 DocumentsProvider 实现到 DocumentFile 统一访问，覆盖 Uri 授权机制、云存储集成与三种接入模式选型。
---

App 需要让用户选文件——可能是本地相册的照片，也可能是 OneDrive 上的文档。做过的都清楚，传统方案是分别对接各云服务 SDK，然后自己维护一套文件访问抽象层。

但打开系统文件选择器，你会发现它已经统一了本地存储和 Google Drive，用户不需要关心文件到底在哪。这个体验的背后是 **SAF（Storage Access Framework）**，Android 4.4 开始内置的存储访问体系。

SAF 是一套基于 **ContentProvider** 的跨进程文件访问协议。它把「文件在哪」和「怎么读写」解耦，任何实现了 `DocumentsProvider` 的应用都能成为文件来源。

## SAF 的核心抽象：Uri 即一切

SAF 的设计思路：**所有文件操作都围绕 content:// Uri 展开。** 应用拿到 Uri 后，不关心文件在本地磁盘、云端还是 FTP 服务器，只通过 `ContentResolver` 操作数据流。

```
┌──────────────────────────────────────┐
│           调用方 App                  │
│  DocumentFile / ContentResolver      │
└──────────────┬───────────────────────┘
               │ content:// Uri
               ▼
┌──────────────────────────────────────┐
│        DocumentsProvider             │
│  (系统内置 / 第三方实现)              │
└──────────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        ▼              ▼
   ┌─────────┐   ┌─────────┐
   │ 本地存储 │   │ 云存储   │
   └─────────┘   └─────────┘
```

Android 的存储沙箱在这种设计下不再是限制，而是标准化的扩展点。

### 关键角色

- **DocumentsProvider**：文件的内容提供者，把后端存储映射为 SAF 可识别的文档树
- **DocumentFile**：客户端侧的文档抽象，封装 content:// Uri 的 CRUD 操作
- **Intent.ACTION_OPEN_DOCUMENT**：启动系统文件选择器，返回用户选中文档的 Uri
- **Intent.ACTION_OPEN_DOCUMENT_TREE**：让用户选择一个目录，拿到整个目录树的读写权限

完整调用链：`Intent 启动选择器` → `用户选取文件` → `系统返回 Uri` → `应用通过 DocumentFile 操作` → `ContentResolver 转发到 DocumentsProvider`。

## 跨进程 Uri 授权机制

拿到 content:// Uri 不代表能永久访问。SAF 的权限模型设计得很克制，三条核心规则：

1. **临时权限**：通过 `Intent.FLAG_GRANT_READ_URI_PERMISSION` 授予，Activity 销毁即失效
2. **持久化权限**：调用 `takePersistableUriPermission()` 后，重启后权限依然有效
3. **权限跟随接收方**：Uri 只有明确授权给某个包名，该包名才能访问

```kotlin
// 打开文件选择器
fun openFilePicker() {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    startActivityForResult(intent, REQUEST_CODE)
}

// 持久化权限
override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == REQUEST_CODE && resultCode == RESULT_OK) {
        data?.data?.let { uri ->
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            saveUriToPreferences(uri.toString())
        }
    }
}
```

持久化权限存储在 `/data/system/urigrants.xml`，由 PackageManagerService 管理。应用重启后，`contentResolver.persistedUriPermissions` 能列出所有已授权的 Uri。

### 踩过的一个坑

适配 Android 11 分区存储时，我遇到过 `RejectedExecutionException`：批量查询 `persistedUriPermissions` 后逐个调 `takePersistableUriPermission`，而 ContentProvider 操作跑在 binder 线程池，线程耗尽就崩了。处理方案是控制并发度，用协程的 `Semaphore` 限制同时查询数量。

## 实现一个 DocumentsProvider

假设要做一个「应用沙盒目录」提供器，让用户通过系统文件管理器浏览 App 的私有文件。最小实现如下：

```kotlin
class SandboxProvider : DocumentsProvider() {

    override fun onCreate(): Boolean {
        rootDir = context?.filesDir ?: return false
        return true
    }

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val root = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION).apply {
            newRow().apply {
                add(DocumentsContract.Root.COLUMN_ROOT_ID, ROOT_ID)
                add(DocumentsContract.Root.COLUMN_TITLE, "Sandbox Files")
                add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, "/")
                add(DocumentsContract.Root.COLUMN_FLAGS,
                    DocumentsContract.Root.FLAG_SUPPORTS_CREATE or
                    DocumentsContract.Root.FLAG_LOCAL_ONLY)
            }
        }
        return root
    }

    override fun queryChildDocuments(
        parentDocumentId: String?,
        projection: Array<out String>?,
        sortOrder: String?
    ): Cursor {
        val parent = resolveFile(parentDocumentId)
        val cursor = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
        parent.listFiles()?.forEach { file ->
            cursor.newRow().apply {
                add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, file.absolutePath)
                add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name)
                add(DocumentsContract.Document.COLUMN_MIME_TYPE, getMimeType(file))
                add(DocumentsContract.Document.COLUMN_SIZE, file.length())
                add(DocumentsContract.Document.COLUMN_FLAGS, getFlags(file))
                add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.lastModified())
            }
        }
        return cursor
    }

    override fun openDocument(
        documentId: String?,
        mode: String?,
        signal: CancellationSignal?
    ): ParcelFileDescriptor {
        val file = resolveFile(documentId)
        val accessMode = when {
            "w" in (mode ?: "r") -> ParcelFileDescriptor.MODE_READ_WRITE
            else -> ParcelFileDescriptor.MODE_READ_ONLY
        }
        return ParcelFileDescriptor.open(file, accessMode)
    }

    private fun resolveFile(documentId: String?) =
        File(rootDir, documentId ?: "")

    private fun getMimeType(file: File): String {
        return if (file.isDirectory) {
            DocumentsContract.Document.MIME_TYPE_DIR
        } else {
            URLConnection.guessContentTypeFromName(file.name)
                ?: "application/octet-stream"
        }
    }
}
```

三个核心方法：`queryChildDocuments` 返回目录结构，`openDocument` 返回文件描述符供客户端读写，`queryRoots` 声明提供器的根节点。要支持云存储，在 `openDocument` 中把云端文件先下载到本地缓存，再返回 `ParcelFileDescriptor`。

### 清单注册

```xml
<provider
    android:name=".SandboxProvider"
    android:authorities="com.example.sandbox.provider"
    android:exported="true"
    android:grantUriPermissions="true"
    android:permission="android.permission.MANAGE_DOCUMENTS">
    <intent-filter>
        <action android:name="android.content.action.DOCUMENTS_PROVIDER"/>
    </intent-filter>
</provider>
```

`MANAGE_DOCUMENTS` 是系统级权限，第三方应用无法声明。要让三方提供器被 SAF 识别，需要用 `android:grantUriPermissions="true"` 搭配显式的 `FLAG_GRANT_*` 授权，由发起方通过 `Intent` 授予。

## DocumentFile：统一访问的最后一公里

`DocumentsProvider` 处理服务端，客户端靠 `DocumentFile` 抹平不同提供器的差异。它把 `content:// Uri` 包装成类似 `java.io.File` 的 API：

```kotlin
fun copyFileToAppDir(sourceUri: Uri, destDir: File) {
    val docFile = DocumentFile.fromSingleUri(context, sourceUri)
    val fileName = docFile.name ?: "unknown"
    // 无论来源是本地还是云端，都走同一套流操作
    context.contentResolver.openInputStream(docFile.uri)?.use { input ->
        File(destDir, fileName).outputStream().use { output ->
            input.copyTo(output)
        }
    }
}
```

### 目录树操作

选目录用 `ACTION_OPEN_DOCUMENT_TREE`，返回树的根 Uri。拿到后可以创建子目录、新建文件：

```kotlin
fun createFileInTree(treeUri: Uri) {
    val rootDir = DocumentFile.fromTreeUri(context, treeUri) ?: return
    val newDir = rootDir.createDirectory("exports")
        ?: throw IOException("Failed to create directory")
    val newFile = newDir.createFile("application/json", "data")
    newFile?.uri?.let { uri ->
        context.contentResolver.openOutputStream(uri)?.use {
            it.write("{}".toByteArray())
        }
    }
}
```

`DocumentFile.fromTreeUri()` 和 `DocumentFile.fromSingleUri()` 的差异：前者拿到的对象支持 `createDirectory` / `createFile`，后者只能读。这对应 SAF 的权限模型——文件权限和目录权限是两种不同能力。

### 性能暗坑

`DocumentFile` 所有操作都走 `ContentResolver`，包括 `listFiles()`。每次枚举目录都会跨进程查询 `DocumentsProvider.queryChildDocuments()`。目录下有上百个文件时，主线程调用 `listFiles()` 会明显卡顿——这是 ContentProvider 同步查询机制决定的。我习惯配合 `LiveData` 或协程做异步封装，避免主线程直接调用。

## 云存储接入的三种模式

SAF 统一了访问层，但云存储接入策略需要根据场景选择。

**模式一：原生 DocumentsProvider**

把自有云存储暴露给所有 App（类似 Google Drive App 的做法）。实现完整的 `DocumentsProvider`，把云 API 调用映射到 Cursor 和 ParcelFileDescriptor。复杂度在于离线缓存策略、增量同步和大文件的 stream 管理。

**模式二：客户端侧 SAF 封装**

只在 App 内统一访问多个来源。不实现 Provider，用 `DocumentFile` 作为统一抽象。本地文件用 `FileProvider` 转 content:// Uri，云端文件用各 SDK 先下载再包装：

```kotlin
class CloudDocumentSource(private val cloudClient: CloudClient) {
    suspend fun getDocumentUri(cloudPath: String): Uri {
        val cacheFile = File(cacheDir, cloudPath.hashCode().toString())
        cloudClient.download(cloudPath, cacheFile)
        return FileProvider.getUriForFile(
            context, "$packageName.fileprovider", cacheFile
        )
    }
}
```

**模式三：系统选择器 + 持久化权限**

利用系统内置的 SAF 选择器，用户的云端账号已在系统设置中登录。App 只负责拿 Uri 和持久化权限，读写走标准 `ContentResolver`。这是最轻量的方案，适合「文件导入」场景，不关心存储后端实现。

我倾向于模式三，零维护成本。除非需要做深度文件管理（比如内置文件浏览器），没必要自建 DocumentsProvider。

## 调试验证

排查 SAF 相关问题时，adb dumpsys 是首选工具：

```bash
# 查看当前应用的持久化 Uri 权限
adb shell dumpsys package com.example.app | grep -A 20 "Uri Permissions"

# 查看所有注册了 DocumentsProvider 的应用
adb shell dumpsys package providers | grep -B 5 "DOCUMENTS_PROVIDER"
```

持久化权限不生效时，先查 `urigrants.xml` 确认授权记录是否存在，再确认 `takePersistableUriPermission` 的调用时机——必须在 `onActivityResult` 中拿到 Uri 的瞬间调用，延迟或异步调用可能因 Context 变化导致失败。

DocumentsProvider 的容错也容易踩坑。SAF 内置组件（ExternalStorageProvider 等）在遇到异常时会吞掉错误、返回空 Cursor，不抛异常。排查方向是给自定义 Provider 加上详细日志，在 `queryChildDocuments` 中主动处理文件不存在、权限拒绝等边界情况。

## 选型建议

SAF 把文件访问从「路径驱动」变成「能力驱动」。拿到 Uri 等于拿到了对该文件的读写能力，不需要知道它在哪块磁盘、哪个云服务上。

实际项目中的决策思路：

- **只是导入文件**：用 `ACTION_OPEN_DOCUMENT` + 持久化权限，不折腾 Provider
- **需要导出到用户选中的目录**：用 `ACTION_OPEN_DOCUMENT_TREE`，让用户自己选
- **要把 App 私有文件暴露给系统文件管理器**：实现轻量 `DocumentsProvider`，按需开启
- **要做云盘 App**：完整实现 `DocumentsProvider`，系统工程，投入不小

SAF 不适合高频、大文件的随机读写场景——每次 `openDocument` 都可能触发网络请求。这类需求直接对接 SDK，不走 SAF 通道。
