---
title: 深入 Android PackageManager 全链路：从 APK 解析到 PMS 组件注册与权限校验
excerpt: 深入解析 Android PackageManager 从 APK 解析、组件注册到 Intent 匹配与权限校验的全链路机制，并结合 Dex 分包、Manifest Merger 等实战踩坑经验。
publishDate: '2025-08-15'
tags:
- Android
- PackageManager
- 权限校验
- Intent匹配
- APK解析
seo:
  title: 深入 Android PackageManager 全链路：从 APK 解析到 PMS 组件注册与权限校验
  description: 深入解析 Android PMS 全链路：APK 结构、PackageParser 解析 Manifest、四大组件索引注册、Intent 匹配的三层过滤、权限与签名校验，以及 Dex 分包、Manifest Merger 等实战踩坑经验。
---

几年前排查一个线上 crash，堆栈显示 `ClassNotFoundException`，指向一个在 `AndroidManifest.xml` 里声明过的 Activity。日志里 PMS 的 `mPackages` 明明有这条记录，`startActivity` 却找不到对应类。最终定位到分包方案中 Manifest 被篡改——组件注册了，但 dex 里根本没那个类文件。

PMS 在 Android 运行时扮演的是「组件路由表」的角色。启动 Activity、发送广播、绑定 Service，系统都要先查这张表。下面把整条链路拆开。

## APK 的本质：ZIP 包里的结构化信息

APK 是一个带签名的 ZIP 压缩包。解压后结构：

- `classes.dex / classesN.dex`：Dalvik 字节码
- `resources.arsc`：编译后的资源索引表
- `AndroidManifest.xml`：二进制形式的 Manifest
- `res/`、`lib/`、`assets/`：资源、so 库、原始文件
- `META-INF/`：签名和证书信息

`AndroidManifest.xml` 在编译时被 AAPT/AAPT2 转成二进制格式，不是可读 XML 文本，而是一段按 AXML 结构编码的二进制数据。PMS 解析时直接读这个二进制结构，不接触原始 XML。

```xml
<!-- 编译前的 Manifest -->
<activity
    android:name=".MainActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
</activity>
```

这段配置编译后变成 AXML 格式中的一系列 chunk 节点。PMS 解析到 `<activity>` 时，构造一个 `PackageParser.Activity` 对象，把 `name`、`exported`、`intent-filter` 等信息存进去。

## 安装阶段：PackageParser 与组件信息收集

安装第一步是 `PackageParser.parsePackage()`。源码在 `frameworks/base/core/java/android/content/pm/PackageParser.java`（Android 10 之后部分逻辑迁移到了 `ParsingPackageUtils`）。

核心流程两步：

**Step 1. 解析基本信息**

```java
// 简化后的 parseMonolithicPackage 逻辑
Package pkg = new Package(packageName);
AssetManager assets = new AssetManager();
assets.addAssetPath(apkPath); // 将 APK 路径加入 AssetManager

// 解析 Manifest 中的包属性
Resources res = new Resources(assets, metrics, null);
XmlResourceParser parser = (XmlResourceParser)assets.openXmlResourceParser(
    "AndroidManifest.xml");
```

`AssetManager.addAssetPath()` 不需要解压 APK——它通过 mmap 将 APK 文件映射到内存，直接在映射区读取 AXML 和 `resources.arsc`。

**Step 2. 遍历 Manifest 收集组件**

```java
// 遍历时典型的 switch-case 逻辑
while ((type = parser.next()) != XmlPullParser.END_DOCUMENT) {
    if (type == XmlPullParser.START_TAG) {
        String tagName = parser.getName();
        switch (tagName) {
            case "activity":
                Activity a = parseActivity(parser, pkg);
                pkg.activities.add(a);
                break;
            case "service":
                Service s = parseService(parser, pkg);
                pkg.services.add(s);
                break;
            case "provider":
                Provider p = parseProvider(parser, pkg);
                pkg.providers.add(p);
                break;
            case "receiver":
                Activity r = parseReceiver(parser, pkg);
                pkg.receivers.add(r);
                break;
            // permission, uses-permission, feature...
        }
    }
}
```

每种组件解析时，除了提取类名、进程属性、配置变更声明，还会收集 `IntentFilter` 列表。每个 `<intent-filter>` 被转换为 `IntentFilter` 对象，存储 action、category、data scheme 等匹配规则。

一个应用的组件信息封装在 `PackageParser.Package` 对象中，包含：

- `activities`、`services`、`providers`、`receivers` 四个 ArrayList
- 权限列表 `permissions` 和 `requestedPermissions`
- 签名信息 `mSigningDetails`

## PMS 注册：把 Package 对象写入内存索引

`PackageParser.Package` 对象只在安装过程中存在。后续运行时查询如果每次都重新解析 APK，性能扛不住。PMS 的做法是把它转换成轻量的 `AndroidPackage` 接口实例，写入两个核心数据结构：

```java
// frameworks/base/services/core/java/com/android/server/pm/
// PackageManagerService.java 的核心索引结构

// 已安装包的全量映射
final WatchedArrayMap<String, AndroidPackage> mPackages = 
    new WatchedArrayMap<>();

// 组件 IntentFilter 匹配表 — 四大组件各有自己的表
final ActivityIntentResolver mActivities = new ActivityIntentResolver();
final ServiceIntentResolver mServices = new ServiceIntentResolver();
final ProviderIntentResolver mProviders = new ProviderIntentResolver();
final ReceiverIntentResolver mReceivers = new ReceiverIntentResolver();
```

注册逻辑大致如下：

```java
// 将 Package 数据写入 PMS 索引
mPackages.put(pkg.getPackageName(), pkg);

// 注册所有 Activity 的 IntentFilter
for (ActivityInfo ai : pkg.getActivities()) {
    mActivities.addActivity(ai, "activity");
}
// 对 Service、Provider、Receiver 同理
```

`ActivityIntentResolver` 内部是一棵基于 MIME type 和 scheme 构建的匹配树。查询时，PMS 根据 Intent 的 action 和 data 快速剪枝，而不是遍历所有 filter。系统装了上百个应用之后，这个优化差异很明显。

## 运行时查询：Intent 匹配与权限校验

调用 `startActivity(intent)` 后，流程进入 AMS，AMS 调 PMS 的 `queryIntentActivities()`：

```java
@Override
public List<ResolveInfo> queryIntentActivities(Intent intent,
        @ResolveInfoFlagsBits int flags, int userId) {
    enforceCrossUserPermission(userId, "query intent activities");
    
    // 关键：在已注册的 filter 表中进行匹配
    List<ResolveInfo> result = mActivities.queryIntent(
            intent, flags, userId);
    
    // 按优先级排序后返回
    Collections.sort(result, PRIORITY_COMPARATOR);
    return result;
}
```

`queryIntent()` 内部经历三层过滤：

1. **IntentFilter 匹配**：action、category、data 必须同时满足。`action` 不能为空且必须在 filter 的 action 列表中；所有 category 必须匹配。`data` 的 type 和 scheme 用通配匹配算法，不是简单 equals。
2. **组件可见性过滤**：Android 11 引入的包可见性规则，未在 `queries` 中声明或不符合 `uses-permission` 豁免条件的包，其组件在结果中不可见。
3. **权限校验**：目标 Activity 声明了 `permission` 属性时，调用方必须持有该权限。这部分不在 `queryIntentActivities` 中做，AMS 在启动 Activity 前做最终检查。

一个容易踩坑的点：`exported` 属性在 manifest 解析时存入 `ActivityInfo.exported`，但 **Intent 匹配阶段不检查它**。实际的 exported 检查位于 AMS 的 `startActivityUnchecked()` 中。用 `queryIntentActivities` 能查到 `exported=false` 的 Activity，PMS 会返回它，但 AMS 启动时会拒绝。这个时间差在排查匹配问题时容易误判。

## 权限注册与签名校验的联动

PMS 在安装时还会处理 `<permission>` 声明：

```java
// 应用声明自定义权限
pkg.permissions.add(new PermissionInfo("com.example.CUSTOM_PERM", 
    ProtectionLevel.DANGEROUS));
```

权限信息写入 PMS 的 `mSettings.mPermissions`，持久化到 `/data/system/packages.xml`。应用卸载时，系统检查该权限是否被其他应用使用，如果只属于该应用则一并移除。

签名校验也在扫描阶段完成：

```java
// PackageParser 中的签名收集
PackageSignatures signatures = new PackageSignatures();
signatures.mSigningDetails = PackageParser.collectCertificates(
    pkg, parseFlags);
pkg.mSigningDetails = signatures.mSigningDetails;
```

签名有两层作用：安装更新时校验新旧 APK 签名一致性；`signature` 级别的权限保护。如果权限定义为 `protectionLevel=signature`，只有签名相同的应用才能使用。常见的 `sharedUserId` 场景就依赖这套机制。

## 踩过的几个坑

**Dex 分包导致组件类找不到。** Multidex 方案中，如果 `Application.attachBaseContext()` 还没初始化完所有 dex 文件，PMS 已经把全部组件注册好了。此时启动某个 Activity 就会 ClassNotFoundException。解法：在 Application 初始化最早期完成 `MultiDex.install()`，不要在 install 之前触发任何组件调用。

**Manifest Merger 导致 exported 意外为 true。** 库模块在 `<activity>` 中声明了 `<intent-filter>` 时，根据 manifest merge 规则，`android:exported` 自动变成 true。Android 12 上这会直接导致安装失败——系统要求显式声明。排查方法：直接看 `build/intermediates/merged_manifests/` 下的合并结果，别猜。

**Permission 重名冲突。** 两个应用声明了同名但 `protectionLevel` 不同的 `<permission>`，先安装的占住该权限名。后安装的如果 `protectionLevel` 不一致，安装失败并返回 `INSTALL_FAILED_DUPLICATE_PERMISSION`。如果权限已有定义，后续应用要么不声明保护级别（让系统沿用已有定义），要么保持一致。
