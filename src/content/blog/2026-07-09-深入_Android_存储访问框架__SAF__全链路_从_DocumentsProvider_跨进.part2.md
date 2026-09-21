---
title: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构（2）：DocumentFile：统一访问的最后一公里"
excerpt: "「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列第 2/2 篇：DocumentFile：统一访问的最后一公里"
publishDate: 2026-07-09
displayInBlog: false
series:
  name: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构"
  part: 2
  total: 2
seo:
  title: "深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构（2）：DocumentFile：统一访问的最后一公里"
  description: "「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列第 2/2 篇：DocumentFile：统一访问的最后一公里"
---


> 本文是「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列的第 2 篇，共 2 篇。在上一篇中，我们探讨了「SAF 的核心抽象：Uri 即一切」的相关内容。

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

`DocumentFile.fromTreeUri()` 和 `DocumentFile.fromSingleUri()` 的差异不是"能读能写"和"只能读"的区别，而是**是否支持目录级操作**：前者拿到的对象支持 `createDirectory` / `createFile`，是针对整个目录树授权的；后者对应单个文档，具体能不能读写取决于该 Uri 被授予的权限模式（比如通过 `ACTION_OPEN_DOCUMENT` 拿到的 Uri，只要授予了写权限，`fromSingleUri` 返回的 `DocumentFile` 同样可以调用 `canWrite()` 为 true 并正常写入）。真正决定读写能力的是 Uri 授权时的 Flag（`FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION`），不是 `fromSingleUri` 这个工厂方法本身。

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

---

**「深入 Android 存储访问框架 (SAF) 全链路：从 DocumentsProvider 跨进程到 DocumentFile 的云存储与本地文件统一访问架构」系列目录**

1. SAF 的核心抽象：Uri 即一切
2. **DocumentFile：统一访问的最后一公里**（本文）
