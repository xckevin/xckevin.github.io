---
title: 流水线中的 ktlint 检查步骤
excerpt: 分享 Android 项目 CI/CD 流水线的完整实践：从 ktlint、Detekt 代码质量检查，到 Gradle Managed Devices 自动化测试、版本管理，再到 Firebase App Distribution 分发，总结工程化交付的实战经验。
publishDate: '2025-06-23'
tags:
- Android
- CI/CD
- 代码质量
- 自动化测试
- Firebase
seo:
  title: 流水线中的 ktlint 检查步骤
  description: Android CI/CD 流水线实战：ktlint 与 Detekt 静态分析、Gradle Managed Devices 自动化测试、版本管理及 Firebase App Distribution 分发全流程。
---

./gradlew ktlintCheck
```

如果项目还没引入 ktlint，最省事的接入方式是 ktlint-gradle 插件，配置一个 `.editorconfig` 就行，不需要额外写规则文件。

**Detekt** 做更深的静态分析：圈复杂度、空安全、命名规范。我踩过一个坑：直接把 detekt 默认规则全开，CI 误报多到团队直接关掉了这个步骤。正确做法是先只开 error 级别规则，跑一周后根据误报情况逐步收紧。

```kotlin
// detekt 配置：CI 中只阻断 error 级别
detekt {
    buildUponDefaultConfig = true
    allRules = false
    config = files("$rootDir/detekt/detekt.yml")
}
```

## 自动化测试：模拟器是稀缺资源

单元测试没什么好说的，`./gradlew test` 配 JUnit 5 + MockK，标准操作。痛点在于仪器测试。

跑仪器测试需要模拟器，而模拟器启动是 CI 里最不稳定的环节。我的方案是使用 **Gradle Managed Devices**，让 Gradle 自己管理模拟器生命周期：

```kotlin
// app/build.gradle.kts
android {
    testOptions {
        managedDevices {
            devices {
                pixel6Api34(com.android.build.api.dsl.ManagedVirtualDevice) {
                    device = "Pixel 6"
                    apiLevel = 34
                    systemImageSource = "aosp"
                }
            }
        }
    }
}
```

流水线里只需要一行：

```bash
./gradlew pixel6Api34DebugAndroidTest
```

这套方案比之前手动 `adb wait-for-device` 的方式稳定太多——模拟器启动失败、进程残留、快照损坏这类问题，Gradle 会自动重试。唯一代价是需要下载 system image（首次约 2GB），缓存后就可以忽略。

测试策略上，我只测核心链路：登录、支付、核心业务流程。UI 细节用 Compose Preview 的 screenshot test 覆盖，比仪器测试快 10 倍，维护成本也更低。

## 构建产物与版本管理

测试通过后进入构建阶段。版本号策略是个容易被忽略的细节。

每次 CI 构建都用同一个 versionName，等于给自己挖坑——测试手里的包全叫 1.0.0，反馈问题时根本分不清是哪个版本。我在流水线里用 commit hash 前 7 位作为版本后缀：

```bash
VERSION_SUFFIX=$(git rev-parse --short HEAD)
./gradlew assembleDebug \
    -PversionName="1.0.0-${VERSION_SUFFIX}"
```

Gradle 还会生成一个 `build-info.json`，记录构建时间、分支、commit，随 apk 一起上传：

```json
{
  "versionName": "1.0.0-a3f2b1c",
  "buildTime": "2026-06-01T10:23:45Z",
  "branch": "feature/payment-refactor",
  "commit": "a3f2b1c9"
}
```

这个文件在后面排查问题时比翻 CI 日志快得多——直接 grep 出对应版本的所有上下文，不用在一堆构建记录里翻找。

## Firebase App Distribution：打通交付最后一公里

包打好了，怎么送到测试手里？我见过有团队用企业微信传 apk、用网盘分享链接，还有直接丢微信群里的。这种做法有两个致命问题：没有版本追踪，没有安装反馈。

Firebase App Distribution 解决这两个问题。接入不复杂：

1. 在 Firebase Console 启用 App Distribution
2. 用 Firebase CLI 或 Gradle 插件上传
3. 配置测试人员分组

CI 中的分发步骤用 Gradle 插件：

```kotlin
// 根 build.gradle.kts
plugins {
    id("com.google.firebase.appdistribution") version "4.1.0"
}
```

```bash
# 流水线中上传并自动通知测试组
./gradlew appDistributionUploadDebug \
    -PserviceCredentialsFile=$FIREBASE_CREDENTIALS \
    -PfirebaseAppDistributionArtifacts="app/build/outputs/apk/debug/app-debug.apk" \
    -PfirebaseAppDistributionGroups="qa-team"
```

安全上有一个点：**不要**把 Firebase 服务账号的 JSON 文件提交到仓库。我用 GitHub Secrets 存 base64 编码后的内容，流水线运行时 decode 写入临时文件：

```bash
echo "$FIREBASE_SERVICE_ACCOUNT_B64" | base64 -d > /tmp/firebase-creds.json
```

测试人员收到邮件或通知后直接安装，Firebase 后台能看到谁装了哪个版本。新版本发布后，旧版本用户打开 App 会收到升级提示——这对测试反馈的时效性提升很明显。

## 工程化交付的几个实践心得

这套流水线跑了半年，几个经验：

**参数化环境切换**。不要为 dev/staging/production 各写一份 workflow 文件。用 `workflow_dispatch` 的 inputs 参数控制环境变量，一份配置覆盖所有场景。

**缓存策略要精细**。Gradle 缓存放得太宽会让流水线膨胀。`.gradle/caches` 和 `build-cache` 分别缓存，前者保留 7 天，后者 3 天就够。

**失败通知不要只看邮件**。把 CI 失败信息推到 Slack 或飞书群，带上 commit 链接和失败日志摘要。等到第二天查邮件才发现 CI 挂了，一整天合入的代码都白费了。

团队规模不大的话（5 人以下），先把静态分析加自动化分发做扎实，仪器测试可以只跑核心用例。一次性全上很容易因为维护成本高被废弃——这种「CI 僵尸化」比没有 CI 更糟糕。
