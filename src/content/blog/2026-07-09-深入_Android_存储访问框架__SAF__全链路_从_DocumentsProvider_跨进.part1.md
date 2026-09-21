---
title: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构（1）：SAF 的核心抽象：Uri 即一切"
excerpt: "「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列第 1/2 篇：SAF 的核心抽象：Uri 即一切"
publishDate: 2026-07-09
displayInBlog: false
series:
  name: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构"
  part: 1
  total: 2
seo:
  title: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构（1）：SAF 的核心抽象：Uri 即一切"
  description: "「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列第 1/2 篇：SAF 的核心抽象：Uri 即一切"
---


> 本文是「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列的第 1 篇，共 2 篇。

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

假设要做一个「应用沙盒目录」提供器，让用户通过系统文件管理器浏览 App 的私有文件。下面是核心方法节选（`DocumentsProvider` 是抽象类，除了下面几个还必须实现 `queryDocument`，否则无法通过 `ContentResolver` 拿到单个文档的元信息，实际项目中还需要 `getDocumentType`、`createDocument`、`deleteDocument` 等方法配合具体需求）：

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

    // queryDocument 是抽象方法，必须实现——用于返回单个文档的元信息（比如打开文件详情、复制/移动操作时都会调用）
    override fun queryDocument(documentId: String?, projection: Array<out String>?): Cursor {
        val file = resolveFile(documentId)
        val cursor = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
        cursor.newRow().apply {
            add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, documentId)
            add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name)
            add(DocumentsContract.Document.COLUMN_MIME_TYPE, getMimeType(file))
            add(DocumentsContract.Document.COLUMN_SIZE, file.length())
            add(DocumentsContract.Document.COLUMN_FLAGS, getFlags(file))
            add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.lastModified())
        }
        return cursor
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

    // 这里用文件的绝对路径直接作为 documentId 只是演示用法。
    // 生产代码中必须做路径校验：documentId 一旦来自外部（比如被篡改的 Uri），
    // 直接拼接/解析容易被构造出 "../" 之类的路径穿越 payload，越权访问 rootDir 之外的文件。
    // 正确做法是校验 resolveFile 返回的 File 的 canonicalPath 必须以 rootDir 的 canonicalPath 为前缀，
    // 或者用不透明的 ID（如数据库自增 ID、UUID）映射真实路径，而不是直接暴露文件系统路径。
    private fun resolveFile(documentId: String?): File {
        val file = File(rootDir, documentId ?: "")
        val canonicalRoot = rootDir.canonicalPath
        val canonicalFile = file.canonicalPath
        require(canonicalFile.startsWith(canonicalRoot)) {
            "Path traversal detected: $documentId"
        }
        return file
    }

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

除了上面出现的方法，`queryDocument` 是抽象方法，没有实现会导致类无法编译（也是本节最容易被忽视的一处坑）。`resolveFile` 里的路径校验同样关键——如果 documentId 直接来自外部输入且未做规范化校验，攻击者可以构造包含 `..` 的 documentId 跳出 `rootDir` 访问任意文件，这是路径型 documentId 方案的常见安全隐患，务必在 provider 侵入点做校验。

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

---

> 下一篇我们将探讨「DocumentFile：统一访问的最后一公里」，敬请关注本系列。

**「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列目录**

1. **SAF 的核心抽象：Uri 即一切**（本文）
2. DocumentFile：统一访问的最后一公里
