---
slug: android-permission-system-evolution
translationKey: android-permission-system-evolution
title: Android 权限：运行时授权、AppOps 与可验证测试
excerpt: 理解 Android 权限决策、版本边界与 AppOps 的作用范围，并建立按功能申请和可复现的测试流程。
publishDate: '2026-05-17'
updatedDate: '2026-09-22'
tags:
- Android
- 权限管理
- AppOps
- Android 14
- 架构解析
seo:
  title: "Android 权限：运行时授权、AppOps 与测试"
  description: "用运行时授权、受保护 API、AppOps 边界和 ADB 测试构建可靠的 Android 权限流程。"
  pageType: article
---

`checkSelfPermission()` 返回 `GRANTED` 是必要条件，却不是“后续任何操作都一定成功”的通行证。Android 会在受保护 API 处综合 Manifest 声明、运行时授权、调用身份、设备策略、角色/特权资格，以及该 API 是否使用 AppOps 来决定。正确的工程做法是在用户触发具体功能时申请最小权限，并把 `SecurityException`、取消与授权撤销当作正常分支。

这比把权限系统描述成固定“三层调用链”更准确。不同系统服务会使用不同的权限和 AppOps；有的 API 没有 AppOps 检查，而签名权限或角色限制即使在普通运行时授权通过后仍然不可用。

## 每一道检查实际说明什么

| 检查或门槛 | 它能回答的问题 | 它不能证明的问题 |
| --- | --- | --- |
| Manifest `<uses-permission>` | 应用是否声明需要此能力 | 用户是否已经授权 |
| `checkSelfPermission()` | 该运行时权限目前是否授予此应用 | 某个具体 API/操作必然允许 |
| 权限弹窗 / Activity Result | 用户此刻做了什么选择 | 授权未来仍然可用 |
| 受保护 Framework API | 这次具体调用能否继续 | 业务网络/设备操作一定成功 |
| AppOps（仅适用时） | 该 UID/package 的操作模式是否允许 | 它能替代所有权限检查 |

`AppOpsManager` 是许多敏感 API 使用的操作控制与审计层，不是普通应用的权限策略 API。三方应用不应试图修改自己的 AppOps 模式；应调用公开功能 API，处理其失败，并仅在有明确恢复路径时引导用户进入设置页。

## 按功能申请，而不是首次启动全要

Activity Result API 将回调与功能绑定，使拒绝分支清晰可测：

```kotlin
private val requestCamera = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
) { granted ->
    if (granted) startCameraPreview()
    else showCameraExplanationOrSettingsLink()
}

fun onScanReceiptClicked() {
    if (checkSelfPermission(Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED) {
        startCameraPreview()
    } else {
        requestCamera.launch(Manifest.permission.CAMERA)
    }
}
```

每次恢复到前台及调用敏感 API 前都应重新检查。用户可能在设置中撤销授权，长期未用应用可能被自动重置敏感权限，Android 11 的一次性授权也会在系统撤销时失效。不要把“已授权”持久化为应用偏好。

若公开 API 抛出 `SecurityException`，应将其作为受控失败处理。它可能是声明/授权缺失、AppOps 或策略限制，也可能是 API 自身前置条件未满足。日志只记录 API、系统版本和异常，不记录敏感数据；没有设备证据时不要臆断底层拒绝原因。

## 应写进测试的版本边界

以下是影响普通应用的主要变化，不是权限系统的完整年表：

- **Android 10（API 29）：** 分区存储与多项设备/Wi-Fi API 的位置权限要求更严格；文件路径访问要单独迁移。
- **Android 11（API 30）：** 位置、相机、麦克风可获得一次性授权；target 30+ 的长期未用应用可能自动重置敏感运行时权限；重复拒绝后系统可能不再展示弹窗。
- **Android 12（API 31）：** 用户可选概略位置。功能确实需要精确位置时，应同时申请 `ACCESS_FINE_LOCATION` 和 `ACCESS_COARSE_LOCATION`，并处理概略位置或明确说明为何不足。
- **Android 13（API 33）：** `POST_NOTIFICATIONS` 成为非豁免通知的运行时权限；多项 Wi-Fi 操作使用 `NEARBY_WIFI_DEVICES`，扫描仍受位置规则约束；媒体读取按类型拆分。
- **Android 14（API 34）：** 请求图片/视频媒体权限时，target 34+ 应支持“选择的照片”路径（`READ_MEDIA_VISUAL_USER_SELECTED`），或者在满足需求时使用系统照片选择器。

target SDK 也会改变细节，所以要按实际 OS 与 target SDK 组合测试，不能只用一个 `if (SDK_INT >= …)` 抹平全部规则。

## 不猜测，直接复现设备状态

以下 ADB 命令只应用于你可控制的测试设备。`dumpsys package` 能显示运行时授权标志，但不能单独证明每个受保护 API 的最终结果。下面序列可复现相机未授权状态：

```bash
PACKAGE=com.example.app
PERMISSION=android.permission.CAMERA

adb shell pm revoke "$PACKAGE" "$PERMISSION"
adb shell pm clear-permission-flags "$PACKAGE" "$PERMISSION" user-set user-fixed
adb shell dumpsys package "$PACKAGE"
```

结果解释：下一次应用内请求应有资格展示系统弹窗。若没有，检查 Manifest 是否声明、请求是否来自可见 Activity，以及 target SDK 规则。官方将 `USER_SET` 定义为曾被用户拒绝，`USER_FIXED` 用于调试重复拒绝的永久拒绝状态。不要用 `pm grant` 强行授予正常用户无法取得的权限，否则会掩盖真实流程。

支持的设备上，还可用 Android 的 AppOps 记录回调与工具审计数据访问，找出自己或 SDK 的意外访问后删除它，或向用户明确解释用途。

## 官方资料与延伸阅读

- [请求运行时权限](https://developer.android.com/training/permissions/requesting?hl=zh-CN)：请求流程、一次性授权、撤销与自动重置。
- [Android 11 权限更新](https://developer.android.com/about/versions/11/privacy/permissions?hl=zh-CN)：重复拒绝标志与 ADB 检查命令。
- [Android 13 通知运行时权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission?hl=zh-CN)：`POST_NOTIFICATIONS` 行为与测试状态。
- [数据访问审计](https://developer.android.com/privacy-and-security/auditing-access)：面向应用开发者的 AppOps 审计能力。
- [Android ContentProvider IPC 与权限控制](/blog/android-contentprovider-ipc/) 和 [Android Binder 原理](/blog/android-binder/)：受保护 IPC 调用的 Framework 背景。
