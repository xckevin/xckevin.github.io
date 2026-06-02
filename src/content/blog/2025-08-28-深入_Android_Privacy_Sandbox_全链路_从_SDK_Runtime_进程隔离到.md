---
title: 深入 Android Privacy Sandbox 全链路：从 SDK Runtime 进程隔离到 Protected Audience 再营销的隐私保护架构
excerpt: 本文系统梳理 Android Privacy Sandbox 全链路架构，从 SDK Runtime 进程隔离、Protected Audience 端侧竞价到 Attribution Reporting 归因机制，并结合实战经验给出工程迁移落地建议。
publishDate: '2025-08-28'
tags:
- Android
- Privacy Sandbox
- 广告技术
- 隐私保护
- 架构设计
seo:
  title: 深入 Android Privacy Sandbox 全链路：从 SDK Runtime 进程隔离到 Protected Audience 再营销的隐私保护架构
  description: 深入解析 Android Privacy Sandbox 全链路架构：SDK Runtime 进程隔离、Protected Audience 端侧竞价、Attribution Reporting 归因报告三大核心机制，附工程迁移落地建议。
---

## 当设备标识符不再是「免费的午餐」

2023 年某次版本迭代中，广告 SDK 上报的数据突然少了一大截。排查后发现，部分 Android 14 设备上 `ANDROID_ID` 返回了空字符串——用户关闭了跨应用追踪，Privacy Sandbox 的 `getTopics()` 取代了传统的设备标识符获取方式。

GAID（Google Advertising ID）不能再当作归因和投放的基础依赖，广告基建需要从 SDK 的进程模型到竞价逻辑整体重新设计。我所在的团队花了近 3 个月完成适配，这篇文章记录其中的技术决策。

## SDK Runtime：把广告 SDK 关进「沙箱」

传统模式下，第三方广告 SDK 以依赖库形式集成到宿主 APK，和主应用运行在同一进程，可以访问应用的所有权限：SharedPreferences、文件系统、甚至反射调用宿主组件。

SDK Runtime 改变了这个模型：广告代码运行在**独立进程**中，通过声明式 API 与宿主通信。安全边界从「信任第三方代码」变成「只允许声明式调用」。

### 进程隔离的实现

Manifest 中声明配置入口：

```xml
<!-- AndroidManifest.xml -->
<application>
    <property
        android:name="android.adservices.AD_SERVICES_CONFIG"
        android:resource="@xml/ad_services_config" />
</application>
```

```xml
<!-- res/xml/ad_services_config.xml -->
<ad-services-config>
    <custom-audiences>
        <sdk runtimeEnabled="true"
            android:name="com.example.adtech" />
    </custom-audiences>
</ad-services-config>
```

SDK 开发者以 `SandboxedSdkProvider` 作为入口分发能力：

```kotlin
class MyAdSdkProvider : SandboxedSdkProvider() {
    override fun onLoadSdk(params: Bundle): SandboxedSdk {
        val controller = AdController.build(requireContext())
        return SandboxedSdk(IBinderWrapper(controller.asBinder()))
    }
}
```

宿主通过 `SdkSandboxManager.loadSdk()` 加载 SDK，两者通过 Binder 跨进程通信。但这并非普通的 Binder IPC——SDK Runtime 进程**没有网络权限**、**不能读写外部存储**、**不能访问宿主内存空间**。

踩过的一个坑：`SandboxedSdkProvider` 里的 context 不是 Application Context，不能启动 Activity 或注册广播。如果你的 SDK 用了隐式依赖 Application 初始化的三方库，大概率崩溃。

## Protected Audience：端侧如何替代「云端画像」

Protected Audience（原 FLEDGE）的核心思路：**用户兴趣数据不出设备，竞价在端侧完成**。

### 从加入受众到端侧竞价

```kotlin
val buyer = AdTechIdentifier.fromString("com.example.adtech")
val customAudience = CustomAudience.Builder()
    .setBuyer(buyer)
    .setName("sports-enthusiasts")
    .setDailyUpdateUri(adsUri)          // 后台更新竞价数据
    .setAds(listOf(
        AdData.Builder()
            .setRenderUri(renderUri)
            .setMetadata("{ \"bid\": 0.5 }")
            .build()
    ))
    .setActivationTime(Instant.now())
    .setExpirationTime(Instant.now().plus(30, ChronoUnit.DAYS))
    .build()

adServicesClient.joinCustomAudience(customAudience)
```

`joinCustomAudience` 将用户加入「体育爱好者」这个受众。系统触发竞价时，`setDailyUpdateUri()` 指向的后台负责下发广告素材和竞价参数。对接时遇到一个问题：系统对 dailyUpdate 的缓存硬编码为 24 小时，动态调整定价需要提前一天部署，运维节奏要跟着改。

### 竞价脚本与决策逻辑

竞价逻辑不在客户端代码里写死，而是通过 **JavaScript 脚本**注入到 WebView 沙箱中执行：

```javascript
// bidding_logic.js - 在独立 WebView 沙箱中执行
function generateBid(ad, auction_signals, per_buyer_signals,
                      trusted_bidding_signals, browser_signals) {
    const bidFloor = parseFloat(ad.metadata.bid);
    const budgetRemaining = browser_signals.original_budget /
        browser_signals.original_bid_count;

    if (budgetRemaining < bidFloor) return { bid: -1 };

    return {
        bid: bidFloor,
        render: ad.renderUri,
        adComponents: [ad.componentUri]
    };
}

function reportResult(auctionConfig, browserSignals) {
    sendReportTo(browserSignals.reportingUrls.reportingUrl +
        "&bid=" + browserSignals.bid +
        "&win=" + browserSignals.winningBid);
}
```

脚本运行在与宿主完全隔离的 WebView 沙箱中，能访问的信息仅限于 `browser_signals` 传入的字段——看不到已安装应用列表、联系人等隐私数据。

### 脚本的灰度策略

竞价逻辑跑在端侧，没法像服务端那样随时 hotfix。我设计的方案：每次 `dailyUpdateUri` 返回数据时带上脚本版本号，客户端按版本号缓存，新版本覆盖旧版本。要回滚就让后台返回旧版本号。

## 归因报告：不用 Device ID 追踪转化

没有了 GAID，Privacy Sandbox 提供了 **Attribution Reporting API**。归因分两步：广告展示时注册 Source，转化时注册 Trigger，系统异步匹配生成报告。

```kotlin
// 注册 Source：广告被看到了
val source = RegisterSourceRequest.Builder()
    .setAttributionSource(
        AttributionSource.Builder()
            .setRegistrant(AdTechIdentifier.fromString("com.advertiser"))
            .build())
    .setWebDestination(Uri.parse("https://advertiser.com"))
    .setAppDestination(Uri.parse("android-app://com.advertiser"))
    .setExpiry(30, TimeUnit.DAYS)
    .build()
measurementClient.registerSource(source)
```

```kotlin
// 注册 Trigger：用户完成了购买
val trigger = RegisterTriggerRequest.Builder()
    .setAttributionSource(/* 同上 */)
    .setEventTriggers(listOf(
        EventTrigger.Builder()
            .setTriggerData(1)      // 0=浏览, 1=购买, 2=注册
            .setTriggerPriority(100)
            .setDedupKey(10001L)
            .build()
    ))
    .build()
measurementClient.registerTrigger(trigger)
```

报告类型分两种：**事件级报告**（Event-Level）触发即上报含粗略转化数据；**聚合报告**（Aggregate）加密后延迟发送，用于统计分析。

实际开发中容易踩的一个限制：`triggerData` 值域只有 0-7（3 个 bit），别指望用它传递自定义数据。更多维度的转化信息得靠聚合报告的 histogram 贡献值实现。

## 工程迁移的落地建议

**SDK 重构粒度**。SDK Runtime 要求广告逻辑独立运行，我把竞价引擎、受众管理、归因上报拆成三个独立 Module。好处是各自独立更新测试，代价是跨 Module 状态同步需要宿主中转。体量不大的 SDK 放一个 Module 就够了。

**测试环境搭建**。Privacy Sandbox API 在模拟器上行为与真机不同——`selectAds()` 经常返回空结果，因为系统需要真实端侧数据训练兴趣模型。最终我搭建了真机测试集群，CI 中加入了集成测试用例。

如果现在开始规划迁移，建议按这个顺序推进：先搞 Attribution Reporting（改动最小，立竿见影），然后是 Custom Audience 管理，最后再动 SDK Runtime 进程隔离。SDK Runtime 对现有架构冲击最大，但它从根本上解决了第三方代码的安全信任问题——这是 Privacy Sandbox 架构里我最认可的部分。
