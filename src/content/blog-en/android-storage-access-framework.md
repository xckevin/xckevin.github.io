---
title: "Android Storage Access Framework: DocumentsProvider and DocumentFile"
lang: en
translationKey: android-storage-access-framework
slug: android-storage-access-framework
excerpt: "Understand how SAF unifies local and cloud documents through content URIs, DocumentsProvider, URI grants, and DocumentFile."
publishDate: '2026-07-09'
tags:
- "Android"
- "Storage Access Framework"
- "DocumentsProvider"
- "ContentProvider"
seo:
  title: "Android Storage Access Framework Guide"
  description: "Learn how Android SAF, DocumentsProvider, URI permissions, and DocumentFile work together."
  pageType: article
---

The app needs to let the user select a file—perhaps a photo in a local album or a document on OneDrive. Everyone who has done it knows that the traditional solution is to connect to each cloud service SDK separately, and then maintain a set of file access abstraction layers yourself.

But when you open the system file selector, you will find that it has unified local storage and Google Drive, and users do not need to care about where the files are. Behind this experience is **SAF (Storage Access Framework)**, a built-in storage access system starting with Android 4.4.

SAF is a cross-process file access protocol based on **ContentProvider**. It decouples "where the file is" from "how to read and write", and any application that implements `DocumentsProvider` can become a file source.

## Core abstraction of SAF: Uri is everything

The design idea of SAF: **All file operations revolve around content:// Uri. ** After the application gets the Uri, it does not care whether the file is on the local disk, the cloud or the FTP server, and only operates the data stream through `ContentResolver`.
```
┌──────────────────────────────────────┐
│           Calling app                 │
│  DocumentFile / ContentResolver      │
└──────────────┬───────────────────────┘
               │ content:// Uri
               ▼
┌──────────────────────────────────────┐
│        DocumentsProvider             │
│  (System or third-party implementation) │
└──────────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        ▼              ▼
   ┌─────────┐   ┌─────────┐
   │ Local storage │   │ Cloud storage │
   └─────────┘   └─────────┘
```

Android's storage sandbox is no longer a limitation under this design, but a standardized extension point.

### Key Roles

- **DocumentsProvider**: The content provider of the file, which maps the back-end storage to a SAF-aware document tree
- **DocumentFile**: Document abstraction on the client side, encapsulating the CRUD operation of content:// Uri
- **Intent.ACTION_OPEN_DOCUMENT**: Start the system file selector and return the Uri of the document selected by the user
- **Intent.ACTION_OPEN_DOCUMENT_TREE**: Let the user select a directory and get read and write permissions for the entire directory tree

Complete call chain: `Intent starts the selector` → `User selects the file` → `System returns Uri` → `Application operates through DocumentFile` → `ContentResolver forwards to DocumentsProvider`.

## Cross-process Uri authorization mechanism

Getting the content:// Uri does not mean permanent access. SAF's permission model is designed to be very restrained, with three core rules:

1. **Temporary permission**: Granted through `Intent.FLAG_GRANT_READ_URI_PERMISSION`, it will become invalid when the Activity is destroyed
2. **Persistent Permission**: After calling `takePersistableUriPermission()`, the permission will still be valid after restarting
3. **Permissions follow the recipient**: Uri can only be accessed by a package name if it is explicitly authorized to it.

```kotlin
// Open the file picker.
fun openFilePicker() {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    startActivityForResult(intent, REQUEST_CODE)
}

// Persist the grant.
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

Persistent permissions are stored in `/data/system/urigrants.xml` and are managed by PackageManagerService. After the application is restarted, `contentResolver.persistedUriPermissions` can list all authorized Uri.

### A pit that has been stepped on

When adapting to Android 11 partition storage, I encountered a `RejectedExecutionException`: batch query `persistedUriPermissions` and then call `takePersistableUriPermission` one by one, while the ContentProvider operation ran in the binder thread pool, and it crashed when the threads were exhausted. The solution is to control the concurrency and use the `Semaphore` of the coroutine to limit the number of simultaneous queries.

## Implement a DocumentsProvider

Suppose you want to make an "Application Sandbox Directory" provider to allow users to browse the private files of the App through the system file manager. The minimal implementation is as follows:

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

Three core methods: `queryChildDocuments` returns the directory structure, `openDocument` returns a file descriptor for the client to read and write, and `queryRoots` declares the root node of the provider. To support cloud storage, download the cloud file to the local cache in `openDocument` and then return to `ParcelFileDescriptor`.

### List registration

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

`MANAGE_DOCUMENTS` is a system-level permission and cannot be declared by third-party applications. For third-party providers to be recognized by SAF, you need to use `android:grantUriPermissions="true"` with explicit `FLAG_GRANT_*` grants, granted by the initiator through `Intent`.

## DocumentFile: The last mile of unified access

`DocumentsProvider` handles the server side, and the client relies on `DocumentFile` to smooth out the differences between different providers. It wraps `content:// Uri` into an API similar to `java.io.File`:

```kotlin
fun copyFileToAppDir(sourceUri: Uri, destDir: File) {
    val docFile = DocumentFile.fromSingleUri(context, sourceUri)
    val fileName = docFile.name ?: "unknown"
    // Use the same stream operations for both local and cloud sources.
    context.contentResolver.openInputStream(docFile.uri)?.use { input ->
        File(destDir, fileName).outputStream().use { output ->
            input.copyTo(output)
        }
    }
}
```

### Directory tree operations

Use `ACTION_OPEN_DOCUMENT_TREE` to select a directory and return the root Uri of the tree. After getting it, you can create subdirectories and create new files:

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

The difference between `DocumentFile.fromTreeUri()` and `DocumentFile.fromSingleUri()`: the object obtained by the former supports `createDirectory` / `createFile`, while the latter can only read. This corresponds to SAF's permission model - file permissions and directory permissions are two different capabilities.

### Performance pitfalls

All operations on `DocumentFile` go through `ContentResolver`, including `listFiles()`. Each time the directory is enumerated, `DocumentsProvider.queryChildDocuments()` is queried across processes. When there are hundreds of files in the directory, calling `listFiles()` on the main thread will be obviously stuck - this is determined by the ContentProvider synchronous query mechanism. I am used to using `LiveData` or coroutine for asynchronous encapsulation to avoid direct calls from the main thread.

## Three modes of cloud storage access

SAF unifies the access layer, but the cloud storage access strategy needs to be selected based on the scenario.

**Mode 1: Native DocumentsProvider**

Expose your own cloud storage to all apps (similar to the Google Drive App). Implement a complete `DocumentsProvider` to map cloud API calls to Cursor and ParcelFileDescriptor. The complexity lies in offline caching strategies, incremental synchronization, and stream management of large files.

**Mode 2: Client-side SAF encapsulation**

Unified access to multiple sources only within the app. Do not implement Provider, use `DocumentFile` as the unifying abstraction. Use `FileProvider` to convert local files to content:// Uri, and use each SDK to download and package cloud files:

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

**Mode 3: System Selector + Persistent Permission**

Using the system's built-in SAF selector, the user's cloud account is logged in in the system settings. App is only responsible for obtaining Uri and persistence permissions, and uses the standard `ContentResolver` for reading and writing. This is the most lightweight solution, suitable for "file import" scenarios and does not care about the storage backend implementation.

I prefer mode three, zero maintenance cost. Unless you need in-depth file management (such as a built-in file browser), there is no need to build your own DocumentsProvider.

## Debugging verification

adb dumpsys is the tool of choice when troubleshooting SAF-related issues:

```bash
# Show the current app's persisted Uri permissions.
adb shell dumpsys package com.example.app | grep -A 20 "Uri Permissions"

# Show every app that registered a DocumentsProvider.
adb shell dumpsys package providers | grep -B 5 "DOCUMENTS_PROVIDER"
```

When persistent permissions do not take effect, first check `urigrants.xml` to confirm whether the authorization record exists, and then confirm the calling timing of `takePersistableUriPermission` - the instantaneous call of the Uri must be obtained in `onActivityResult`. Delayed or asynchronous calls may fail due to changes in the Context.

DocumentsProvider's fault tolerance is also easy to get into trouble. SAF built-in components (ExternalStorageProvider, etc.) will swallow the error and return an empty Cursor when encountering an exception, without throwing an exception. The direction of troubleshooting is to add detailed logs to the custom Provider and actively handle boundary conditions such as file non-existence and permission denial in `queryChildDocuments`.

## Selection suggestions

SAF changes file access from "path-driven" to "capability-driven". Getting the Uri is equivalent to getting the ability to read and write the file, without knowing which disk or cloud service it is on.

Decision-making ideas in actual projects:

- **Just import files**: use `ACTION_OPEN_DOCUMENT` + persistent permissions, no need to mess with Provider
- **Need to export to the directory selected by the user**: Use `ACTION_OPEN_DOCUMENT_TREE` to let the user choose
- **Expose App private files to the system file manager**: Implement lightweight `DocumentsProvider` and enable it on demand
- **Build a cloud disk App**: Complete implementation of `DocumentsProvider`, system engineering, considerable investment

SAF is not suitable for high-frequency, random reading and writing of large files - each `openDocument` may trigger a network request. Such requirements are directly connected to the SDK and do not go through the SAF channel.
