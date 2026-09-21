---
title: Android Instant Apps：停止服务后的历史架构与迁移方向
excerpt: 回顾 Android Instant Apps 的模块拆分、免安装启动与 URL 路由。Google Play Instant 已于 2025 年 12 月停止提供，本文供历史架构分析与迁移参考。
publishDate: '2026-07-27'
tags:
- Android
- Instant Apps
- App Bundle
- 模块化
- 架构设计
seo:
  title: Android Instant Apps：停止服务后的历史架构与迁移方向
  description: 回顾 Android Instant Apps 的模块拆分、免安装启动与 URL 路由。Google Play Instant 已于 2025 年 12 月停止提供，本文供历史架构分析与迁移参考。
  pageType: article
slug: android-instant-apps-url-routing
translationKey: android-instant-apps-url-routing
updatedDate: '2026-09-21'
---

> **状态更新（2026-09-21）**：Google Play Instant 已自 2025 年 12 月起停止提供：不能再通过 Google Play 发布 Instant Apps，Play 也不再向用户分发即时应用，相关 Google Play services Instant API 不再工作。下文保留历史模块化与路由设计供理解存量工程使用；新项目应采用常规应用，并按场景使用深层链接引导用户进入目标功能。 [官方文档](https://developer.android.com/topic/google-play-instant/overview)

> **⁉️ 重要提示**：Google Play Instant （Instant Apps / 即时应用）已于 2025 年 12 月停止服务——Instant App 无法再通过 Google Play 发布，相关的 Google Play services Instant API 也已失效，Play 平台不再以任何方式向用户分发 Instant 体验（官方公告：https://developer.android.com/topic/google-play-instant/overview）。官方现在建议开发者直接用 Deep Link 引导用户到完整安装的 App。本文保留作为当时技术方案的历史记录与架构设计思路参考（App Bundle 切片、沙箱启动、URL 意图路由等思路对现今的动态特征交付仍有参考价值），但不要再基于本文方案做新项目开发。

2024 年接手一个电商 SDK 项目时，产品提了一个需求：用户点击商品链接后，不等安装就能完成下单。当时团队第一反应是「小程序」，但客户端体验差异太大。最后选了 Instant Apps，踩了一圈坑才跑通全链路。

## App Bundle 切片：Instant App 的物理基础

Instant App 不是独立产物，它是 App Bundle 的一个「切片」。Google Play 通过 `dynamic delivery` 机制，从 Bundle 中按需抽取模块下发，而不是打包整个 APK。

一个支持 Instant 体验的项目通常包含三个层级：

```
app/              → 可安装应用（主入口）
feature/order/    → 订单功能模块（Instant 可访问）
base/             → 共享基础代码和资源
```

硬性约束：**Instant 模块大小上限 10 MB**。这个限制迫使你剥离一切非必要的东西——`base` 模块放共享依赖，`feature` 模块只保留单场景的最小实现。

`base/build.gradle` 中，旧版 AGP 用 `com.android.feature` + `baseFeature true` 声明这是基础切片；新版 AGP 中 `base` 走普通的 application/library 插件即可，`feature` 模块改用 `com.android.dynamic-feature`：

```groovy
apply plugin: 'com.android.feature'

android {
    baseFeature true
    // ...
}
```

编译时 AGP 把每个 `dynamic-feature` 和 `base` 模块打包成 `.apk` 子产物，连同元数据写入 AAB。Google Play 运行时根据用户请求的 URL 路径，匹配对应的 feature 模块，只下发这一个切片。

实际编译时我碰到过一个麻烦：`base` 模块引用了 `com.google.android.gms:play-services-location`，这一个依赖就 3.2 MB。加上图片资源和 Kotlin 运行时，base 直接超了 6 MB。最后的办法是用 `implementation` 替代 `api` 精细化控制依赖传递，把图片资源挪到安装模块里，Instant 模块只用矢量图标，才压进限制。

## 免安装启动：从 Play 商店到 Activity 的三段跳

Instant App 的启动和普通 APK 路径不同，拆开看是三个阶段。

**阶段一：Play 商店解析。** 用户点击链接后，Play 商店检查 URL 是否命中某个 Instant App 的 `intent-filter`。命中后不会直接下载，先校验设备是否支持 Instant 体验——需要 Android 5.0+ 且 Google Play Services 版本足够新。

**阶段二：切片下载与沙箱加载。** Play 商店只下载匹配的那个 `dynamic-feature` 切片加上 `base` 模块。下载完成后，系统在受限沙箱中启动进程，沙箱的限制包括：

- 外部存储不可访问（`READ_EXTERNAL_STORAGE` 权限被忽略）
- 后台服务启动受限（前台服务除外）
- 无法创建后台下载任务
- 应用无需预装，直接在线加载运行

**阶段三：Activity 渲染。** 系统创建 Application 实例并启动目标 Activity。用户看到界面时，整个流程通常在 **3-5 秒内** 完成——这是核心体验指标。

踩过的坑：Instant App 的 `Application` 类初始化时我做了 Firebase 远程配置拉取。在沙箱里 Firebase 初始化直接 crash，缺少 Google Play Services 的部分后台能力。解决方案是把 Firebase 初始化包裹在 `InstantApps.isInstantApp(context)` 的否定分支里：

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (!InstantApps.isInstantApp(this)) {
            FirebaseApp.initializeApp(this)
        }
    }
}
```

`ContentProvider` 的 `onCreate` 比 `Application.onCreate` 更早执行，Instant 模式下 Provider 里同样不能做重操作，否则启动时间从 3 秒飙升到 8 秒以上。

## URL 意图路由：从链接到目标页面的分发中枢

Instant App 的 url-intent 路由是整个架构中最容易被低估的部分，它的设计直接影响免安装体验能否准确触达目标页面。

### 基础路由声明

在 AndroidManifest 中声明 `intent-filter`，把 URL pattern 映射到 Activity：

```xml
<activity android:name=".feature.order.OrderActivity">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="https"
            android:host="shop.example.com"
            android:pathPrefix="/order" />
    </intent-filter>
</activity>
```

`android:autoVerify="true"` 触发 Digital Asset Links 验证。需要在 `https://shop.example.com/.well-known/assetlinks.json` 部署验证文件：

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.shop",
    "sha256_cert_fingerprints": ["XX:XX:XX:..."]
  }
}]
```

验证失败时用户每次点击链接都会弹出选择对话框，从「零等待」变成「先选再等」，体验直接崩塌。

### 深层路由分发器设计

单个 Activity 只能处理固定路径。实际场景中同一 feature 模块内可能有多个页面目标，需要一套路由分发器：

```kotlin
class InstantRouter {

    fun resolve(uri: Uri): RouteTarget? {
        val path = uri.path ?: return null

        return when {
            path.startsWith("/order/") -> RouteTarget(
                activity = OrderActivity::class.java,
                params = mapOf("orderId" to uri.lastPathSegment)
            )
            path.startsWith("/product/") -> RouteTarget(
                activity = ProductActivity::class.java,
                params = mapOf("productId" to uri.lastPathSegment)
            )
            else -> RouteTarget(activity = MainActivity::class.java)
        }
    }
}
```

只给 Instant 模式启用的路由，参数传递要精打细算——Instant App 的 Intent 分发链路比完整安装版长，参数过多会影响解析效率。我这里把参数严格控制在 3 个 key 以内。

Instant 到安装版的升级跳转，需要调用官方提供的安装提示 API。需要注意的是，`getInstantAppClient().getInstallIntentFilter()` 这个写法并不存在——官方提供的是 `InstantApps.showInstallPrompt()` 这样一个静态方法，传入 `Activity`、目标 `Intent` 以及一个请求码，系统会弹出安装引导弹框，用户确认后跳转到 Play 商店完成安装，安装完成后通过 `onActivityResult` 回调获得结果。调用时机应选在用户触发关键操作前（如下单支付），而不是页面刚打开就彈窗。

## 实践中的取舍

做完这个项目，我对 Instant App 的判断很明确：**适合轻量级交易型场景，不适合内容型或重交互场景。**

**10 MB 限制是最硬的约束。** ProGuard/R8 不是可选项，是必须的。测试时一个中等复杂度的订单页面，引入 Retrofit + Gson + OkHttp 后，DEX 已经占了 2.8 MB。加几张 WebP 图片轻松破壁。最后拆了一个极薄的网络层，只用 `HttpURLConnection` + 手动 JSON 解析，省了近 1.6 MB。

**测试链路长。** Instant App 必须通过 Play Console 的内部测试轨道分发，不能直接用 adb install。每次调试都要走「修改代码 → 打 AAB → 上传 Play Console → 生成预发布链接 → 手机扫码测试」。我把 CI 流程抽象成三步：自动打 aab → 用 `bundletool` 本地提取 Instant APK → `bundletool build-apks` 生成设备专用包，本地调试直接拿这个包，省掉上传 Play 的等待。

**Instant 模块是独立 APK 但共享进程。** 多 feature 模块之间的数据传递不能依赖单例——不同切片在不同时机进入进程，单例状态不可靠。最终选了 `SharedPreferences` + 内存 LRU 缓存的组合，不做跨进程假设。

做完 Instant App 适配后，用户从点链接到看到订单页的时间从「下载完整 APK」的 40+ 秒压到了 4 秒左右，转化率从 8% 提升到 19%。代价是模块拆分增加了约 20% 的架构设计工作量。如果你维护的是交易链路核心页面，这点投入值得；如果只是做一个产品介绍页，Deep Link 够用了。
