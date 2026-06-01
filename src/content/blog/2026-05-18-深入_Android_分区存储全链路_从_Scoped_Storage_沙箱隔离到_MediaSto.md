---
title: 深入 Android 分区存储全链路：从 Scoped Storage 沙箱隔离到 MediaStore 数据库映射
excerpt: 本文从 FUSE 文件系统拦截、MediaStore 数据库映射到三层权限模型，完整解析 Android Scoped Storage 的架构原理，并给出从临时豁免到彻底迁移的实战适配策略。
publishDate: '2026-05-18'
tags:
- Android
- 分区存储
- Scoped Storage
- MediaStore
- 文件系统
seo:
  title: 深入 Android 分区存储全链路：从 Scoped Storage 沙箱隔离到 MediaStore 数据库映射
  description: 全面解析 Android Scoped Storage 架构：FUSE 内核拦截机制、MediaStore 数据库映射原理、三层权限模型及 SAF 兼容迁移路径，附实战适配经验。
---

做 Android 10 适配时，团队遇到了一个典型问题：以前能正常读取相册图片的代码，targetSdkVersion 升到 29 后直接返回了空列表。翻文档才发现，Android 引入了分区存储（Scoped Storage），整个文件访问模型被重构了。

Scoped Storage 背后是一套完整的全链路架构：从内核层 FUSE 文件系统拦截，到 MediaStore 数据库抽象，再到应用层权限模型的层层校验。理清这条链路，比记住几个 API 名称有用得多。

## FUSE 拦截层：应用进程看到的「假」文件系统

Android 10 开始默认启用 FUSE（Filesystem in Userspace）层拦截文件访问请求。应用通过 `File` API 访问共享存储时，请求不会直达底层文件系统，而是先经过 FUSE 守护进程。

```bash
# 查看设备是否启用 FUSE
adb shell mount | grep fuse
# 典型输出：/storage/emulated on ... type fuse ...
```

FUSE 层的核心逻辑是：**根据调用进程的 UID 和权限标签，决定是否放行文件操作**。当一个应用试图用 `new File("/sdcard/DCIM/photo.jpg")` 读文件时，调用链如下：

1. libc 的 `open()` 进入 VFS（虚拟文件系统）
2. VFS 将请求路由到 FUSE 驱动
3. FUSE 驱动将请求传递给用户空间的 `sdcard` 守护进程
4. `sdcard` 检查调用者权限，放行或返回 `EACCES`

这套机制在 Android 4.4 就已存在，但 Android 10 把它从「可选」变成了「强制」。对 targetSdkVersion >= 29 的应用，FUSE 会对 `/sdcard` 下的非应用专属目录执行严格拦截——即使声明了 `READ_EXTERNAL_STORAGE` 也绕不过去。

排查线上问题时，我用 `strace` 跟踪过一次真实调用：`openat()` 系统调用被 FUSE 拦截后，内核直接返回了 `-EACCES`，而 logcat 里 MediaProvider 没有任何日志。请求根本没到达应用层，**在内核态就被挡下来了**。

## MediaStore 数据库映射：从文件路径到内容 URI

FUSE 拦截只是第一道关卡。Scoped Storage 的真正抽象层是 MediaStore 数据库——一个 SQLite 实例，将文件系统路径映射为结构化的内容 URI。

核心字段：

| 字段 | 说明 |
|------|------|
| `_id` | 媒体记录主键 |
| `_data` | 文件系统绝对路径 |
| `_display_name` | 文件名 |
| `mime_type` | MIME 类型 |
| `date_modified` | 修改时间 |
| `owner_package_name` | 归属应用包名 |

应用插入媒体文件时，MediaProvider 接收 ContentValues，在数据库里创建记录，系统再将文件写入实际存储位置。查询时反过来：先查数据库获取 `_id`，再通过 content URI 读写数据流。

```kotlin
// 通过 _id 构造内容 URI，而不是拼 _data 路径
val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME)
contentResolver.query(
    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, null, null, null
)?.use { cursor ->
    while (cursor.moveToNext()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID))
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        // 用 contentResolver.openInputStream(uri) 读取，不要用 File(uri.path)
    }
}
```

Android 10 之后，`_data` 字段对第三方应用不再可靠。即使能查出路径字符串，FUSE 层也会拒绝直接文件访问。正确做法是以 content URI 为唯一操作句柄，所有 I/O 通过 ContentResolver 完成。

## 权限模型的三层架构

Scoped Storage 的权限控制分为三层，每层独立决策。

**App-Owned 目录**

每个应用在 `/sdcard/Android/data/<package>/` 下有专属目录，读写不需要任何权限。应用卸载时该目录会被清理，适合放缓存和私有文件。

**MediaStore 贡献者模型**

应用对自己创建的媒体文件拥有完整访问权。对于其他应用创建的媒体文件：图片、视频、音频凭 `READ_EXTERNAL_STORAGE` 即可读取；写入时通过 MediaStore API 插入，系统自动处理归属。这个模型的核心思路是「你贡献的你能管，别人的你只能看」。

**MANAGE_EXTERNAL_STORAGE（宽泛文件访问）**

这个权限提供了对所有文件的完全访问能力，类似旧版 `WRITE_EXTERNAL_STORAGE`。但它需要通过 Google Play 审核，只允许文件管理器、备份工具等特定类型的应用使用。

```xml
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
```

我在一个文件管理类应用中提交这个权限声明时，Play 审核被打回三次。最后提交了详细的功能说明、操作录屏和用户反馈截图才通过。如果业务不是刚需，**不要把这当作适配捷径**。

## 兼容适配路径：从豁免到彻底迁移

Google 提供了 `requestLegacyExternalStorage` 作为临时豁免：

```xml
<application android:requestLegacyExternalStorage="true" ...>
```

这个标记让 FUSE 层对旧路径访问放行，但只在 Android 10 生效——Android 11 及以后**直接忽略此标记**，没有商量余地。

我所在团队采用了三步走策略：

1. **审计所有文件操作**：用 lint 扫描 `File`、`FileInputStream`、`FileOutputStream` 的使用点
2. **按场景分类替换**：媒体文件切 MediaStore API，文档文件切 SAF（Storage Access Framework），应用私有数据保留 File API
3. **逐步取消豁免**：先上 `requestLegacyExternalStorage=true` 保证不发版 crash，再逐个模块迁移，最后移除标记

SAF 的接入相对直接——通过 `ACTION_OPEN_DOCUMENT` 让用户选择文件，系统返回 content URI，应用持有这个 URI 就拥有对应文件的读写权限，重启后通过 `takePersistableUriPermission` 依然有效。

```kotlin
// SAF 打开文件并获得持久化权限
val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
}
startActivityForResult(intent, REQUEST_CODE)

// onActivityResult 中
val uri = data?.data
contentResolver.takePersistableUriPermission(uri!!, Intent.FLAG_GRANT_READ_URI_PERMISSION)
```

SAF 返回的 URI 是系统生成的，不同设备上格式可能不同。不要试图解析 URI 结构，只把它当作不透明句柄使用。

## 实践建议

做了多个 Android 10+ 项目的适配后，三条经验：

1. **尽早规划**：从项目初期就按 Scoped Storage 模型设计文件操作。有一个项目在 deadline 前两周才启动适配，最后砍了两个 feature 才赶上发版。

2. **区分场景选择 API**：媒体文件用 MediaStore，文档用 SAF，应用私有数据用 `context.filesDir`。不要试图用 `MANAGE_EXTERNAL_STORAGE` 覆盖所有场景——Play 审核和 Android 后续版本都可能收紧。

3. **自动化测试覆盖**：单元测试用 `ShadowContentResolver` 模拟 MediaStore 行为，集成测试在 Android 10+ 真机上验证。我们在 Android 9 设备上跑通的功能，上线后大量 Android 11 用户反馈闪退——根因就是测试环境与目标系统不匹配。

Scoped Storage 的架构本质是：**用数据库抽象替换路径访问，用 FUSE 拦截保障沙箱边界**。理解这两层的协作关系，适配工作就从「改 API」变成了「换思维」。
