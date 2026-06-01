---
title: Android App Links 深度解析：从 Digital Asset Links 域名验证到 Intent 路由分发的 Web-to-App 全链路工程实践
excerpt: 本文系统梳理 Android App Links 的完整接入链路：从 Digital Asset Links 双向信任模型、系统自动验证机制，到多场景路由差异处理与调试工具箱，分享签名配置、跨域验证、Chrome 行为差异等实际踩坑经验。
publishDate: '2026-05-20'
tags:
- Android
- App Links
- Deep Link
- Intent
- 路由分发
seo:
  title: Android App Links 深度解析：从 Digital Asset Links 域名验证到 Intent 路由分发的 Web-to-App 全链路工程实践
  description: Android App Links 全链路实践指南，涵盖 Digital Asset Links 域名验证机制、系统自动审批流程、多场景路由实战及调试工具，助你避开签名配置与跨域验证等常见坑点。
---

## 一个诡异的跳转失败

去年给一个电商 App 接入 App Links，测试环境一切正常，发到线上后用户反馈"点链接还是打开网页"。排查发现 Digital Asset Links 文件在 `https://example.com/.well-known/assetlinks.json` 能正常访问，SHA256 指纹也匹配。

反复对比后找到问题：测试包和正式包用了不同签名。App Links 的验证 **绑定的是发布签名的证书指纹**，而我在 assetlinks.json 里填的是 debug 签名。更坑的是——这个问题没有报错提示，系统静默降级成了普通 Deep Link。

这就是 App Links 区别于普通 Deep Link 的地方：**它要求域名持有者与 App 开发者双向确认身份**。如果只把 App Links 当成"自动生效的 IntentFilter"，一上线就会踩坑。

## Digital Asset Links：双向信任的锚点

App Links 的信任模型基于一个前提：能让 `https://yourdomain.com/.well-known/assetlinks.json` 返回特定内容的人，一定是域名的合法控制者。而 App 签名证书的 SHA256 指纹，保证了 App 来源的真实性。两者匹配，就构成了信任闭环。

assetlinks.json 的标准结构：

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.app",
      "sha256_cert_fingerprints": [
        "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:C6:20:FE:BA:CD"
      ]
    }
  }
]
```

三个关键字段：

- **relation**：固定值 `delegate_permission/common.handle_all_urls`，含义是"域名的 URL 处理权委托给 App"。这是唯一的合法值。
- **package_name**：App 的包名，用于区分一个域名关联多个 App 的场景。
- **sha256_cert_fingerprints**：最重要的一环。用 JDK 自带的 keytool 就能获取：

```bash
keytool -list -v -keystore release.keystore | grep SHA256
```

**这个指纹绑定的是证书而非签名文件本身**。用同一个证书签名的不同 App（比如主 App 和 Lite 版），只要包名匹配对应的条目，都能通过验证。

一个常见的误解是以为 assetlinks.json 可以放多个证书指纹做"签名兼容"。实测发现，如果你填了 debug 和 release 两个指纹，系统取 **第一条匹配的记录**，不会做"任意一个通过即可"的合并。不同 Android 版本的行为还不太一致——Android 12 之前宽松一些，13 后收紧了。

## 系统自动审批的幕后流程

App Links 的核心价值是免用户确认——点击链接直接跳转 App，不弹选择器。这个体验由一套 **系统级 Verifier 机制** 支撑。

### 验证时机与条件

系统不会在每次点击链接时都去请求 assetlinks.json。验证发生在以下时机：

1. App 安装完成后（`ACTION_PACKAGE_ADDED` 触发）
2. App 更新时（仅 Android 12+）
3. 设备重启后（重新校验已缓存的验证结果）

验证有网络条件要求：设备必须处于非计费网络，Android 13+ 还要求 DNS 可解析。我踩过的坑是测试机在内网环境，DNS 无法解析公网域名，验证始终不通过，但系统不报任何错误。

### 验证请求的真实形态

系统发出的验证请求是标准 HTTPS GET，**不带任何 User-Agent 特征**，看起来就像普通流量。用 Nginx 反代 assetlinks.json 时，不能只对特定 User-Agent 放行，原因就在这。

几个关键约束：
- 请求 **不跟随重定向**（HTTP 301/302 直接判失败）
- 超时约 5 秒
- 响应必须 `Content-Type: application/json`
- 文件大小上限 64KB

```nginx
# 服务器端正确配置
location /.well-known/assetlinks.json {
    default_type application/json;
    add_header Cache-Control "public, max-age=3600";
    try_files /static/assetlinks.json =404;
}
```

`try_files` 是关键——必须直接返回文件，不能走应用层路由。我曾经因为用了 `rewrite` 规则导致请求经过 PHP 处理，响应头被框架覆盖成 `text/html`，验证直接失败。

### 验证状态的生命周期

系统维护一个验证状态表，存储在 `Settings.Global` 中，可以通过 adb 查看：

```bash
adb shell settings get global device_policy_manager_pending_intents
# 查看 App Links 验证状态（Android 11+）
adb shell pm get-app-links com.example.app
```

输出类似：

```
com.example.app:
    ID: 3f4b5c6d...
    Signatures: [14:6D:E9:...]
    Domain verification state:
      example.com: verified
      www.example.com: legacy_failure
```

状态分四种：
- **verified**：完全信任，免确认跳转
- **unverified**：待验证，行为等同于普通 Deep Link
- **legacy_failure**：曾经验证失败，Android 12 后不再自动重试（需用户手动在设置中授权或清除缓存）
- **none**：未声明 autoVerify

`legacy_failure` 是最容易忽略的状态。如果你改过 assetlinks.json 但用户设备上 App 已安装，这个状态不会自动刷新。必须触发重新安装或手动清除：

```bash
adb shell pm clear-domain-preferences com.example.app
```

## 多场景路由实战

验证通过不代表所有场景都能按预期跳转。下面三个问题是实际项目中踩过的。

### Chrome 的"地址栏输入"与"页面内点击"

Chrome 对 App Links 的处理分成两类：

- **地址栏输入或书签打开**：即使域名已验证，Chrome 仍会显示选择器，用户需要点"在 App 中打开"。
- **页面内链接点击（`<a href>`）**：域名已验证则直接跳转 App，不弹选择器。

这个差异化设计是 Chrome 的 Intent 派发逻辑决定的，不是 Android 系统行为，代码层面无法覆盖。

如果业务大量依赖地址栏直接输入（比如线下扫码后手动输入短链），可以考虑在 Web 端用 `intent://` scheme 做兜底跳转，或者降级使用自定义 scheme。

### 跨域场景的验证范围

App Links 的验证是 **严格域名匹配**，`sub.example.com` 和 `example.com` 被视为不同实体。

在 Manifest 中声明多个 host 时：

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
    <data android:scheme="https" android:host="sub.example.com" />
</intent-filter>
```

系统会分别请求 `example.com` 和 `sub.example.com` 的 assetlinks.json。**任何一个 host 验证失败，整个 IntentFilter 都会被标记为未验证**。这是官方文档没有明确写的"全有或全无"逻辑。

### App Link 与 Custom Tab 的优先级冲突

如果 App 里嵌入了 Chrome Custom Tab，当 Custom Tab 中加载的页面包含 App Links 域名时，行为取决于 Android 版本：

- **Android 12 之前**：Custom Tab 内的链接会直接唤起 App，导致 Custom Tab 退出，体验割裂。
- **Android 12+**：系统增加 `Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER` 判断，Custom Tab 不会触发 App Links 直接跳转，改为显示"在 App 中打开"横幅。

如果业务需要 App 内 WebView/Custom Tab 跳转到 App 自身页面，直接用 `Intent` 显式跳转比走 App Links 可靠得多。

## 调试工具箱

排查 App Links 问题，按以下顺序操作最快定位：

**1. 验证文件层面**

```bash
curl -I https://example.com/.well-known/assetlinks.json
# 检查 Status 200、Content-Type: application/json
```

Google 提供了在线验证工具：`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://example.com&relation=delegate_permission/common.handle_all_urls`

**2. 系统状态检查**

```bash
adb shell dumpsys package domain-preferred-apps
adb shell pm get-app-links com.example.app
```

**3. 模拟系统验证**

```bash
adb shell pm verify-app-links --re-verify com.example.app
```

这个命令会强制触发 re-verification，输出每个域名的验证结果。线上排查时比反复安装 App 快得多。

**4. Chrome 的调试入口**

在 Chrome 地址栏输入 `chrome://interstitials`，可以看到 Chrome 内部对 App Links 的处理日志，包括为何选择或不选择直接跳转。

## 写在最后

接入 App Links，真正花时间的不在 XML 配置和 assetlinks.json 编写——这些 30 分钟就能搞定。真正的成本在：理解验证机制的异步特性，处理不同场景下的行为差异，以及建立可复用的排查流程。

我的建议是：上线前用 release 签名打一个内部测试包，在真实网络环境下跑一遍 `pm verify-app-links`，确认所有 host 都是 `verified` 状态。这一步省掉，后面排查问题的时间成本至少翻 10 倍。
