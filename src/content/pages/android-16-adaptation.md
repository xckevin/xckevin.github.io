---
title: "Android 16 与系统兼容适配"
lang: zh
translationKey: android-16-adaptation
seo:
  title: "Android 16 适配指南：16 KB、权限、Wi-Fi 与界面回归"
  description: "按问题定位 Android 适配风险：16 KB 原生库对齐、权限变更、Wi-Fi API、字体与窗口行为，附排查文章、升级顺序和回归清单。"
---

准备升级 target SDK，或遇到只在特定系统上出现的故障，可以从下面的症状进入。先记录设备 Android 版本、应用 target SDK、依赖版本和复现步骤，再确定需要修改应用代码、依赖库还是构建配置。

## 按问题选择入口

| 当前问题 | 先读这篇 | 要得到的结果 |
| --- | --- | --- |
| 16 KB 设备无法加载 `.so`，或发布检查提示不兼容 | [16 KB 页大小、ELF 与 NDK 适配](/blog/android-16kb-page-size-elf-ndk/) | 区分 ELF 段对齐和 APK ZIP 对齐，找出需要升级的原生依赖 |
| 授权后仍无法访问资源，升级系统后权限流程失效 | [Android 权限系统与版本差异](/blog/android-permission-system-evolution/) | 分清运行时权限、AppOps、特殊访问和目标版本要求 |
| 连接 Wi-Fi 失败，旧 WifiManager 接口不再工作 | [Wi-Fi API 选择与连接排查](/blog/android-wifi-connection-wifimanager-wpa-supplicant/) | 根据临时连接或网络建议场景选择 API，并检查权限与系统回调 |
| 字体缺字、行高变化或文本布局不同 | [Typeface、字体回退与 Skia 渲染](/blog/android-font-rendering-typeface-skia/) | 分离字体加载、字形选择、排版和栅格化问题 |
| 内容被系统栏或键盘遮挡 | [Edge-to-Edge 与 WindowInsets](/blog/android-16-edge-to-edge-windowinsets/) | 梳理 Insets 的消费位置与界面回归范围 |
| 返回手势与页面返回栈不一致 | [Predictive Back 工程实践](/blog/android-predictive-back/) | 检查导航组件与自定义返回处理 |

## 一次升级的阅读顺序

1. 从 [API 兼容性与运行时降级](/blog/android-api-compatibility-minsdk-runtime-fallback/) 开始，列出 OS 版本、target SDK、可用 API 和降级行为。
2. 检查 [16 KB 原生依赖](/blog/android-16kb-page-size-elf-ndk/)。页大小能力与设备、系统和 native 依赖有关，不能仅凭 Android 版本号判定兼容。
3. 回归 [权限流程](/blog/android-permission-system-evolution/) 与 [Wi-Fi 连接](/blog/android-wifi-connection-wifimanager-wpa-supplicant/)，包括首次授权、拒绝后重试、撤销权限和重装。
4. 检查窗口、返回导航和 [文本显示](/blog/android-font-rendering-typeface-skia/)，保存升级前后的可复现结果。
5. 用 [性能与稳定性专题](/android-performance/) 的测量流程确认启动、掉帧和崩溃情况。

## 回归时记录什么

- 版本：设备系统、target SDK、NDK、AGP、第三方 native SDK；区分系统升级和应用升级。
- 安装：新安装、覆盖安装、旧数据恢复，以及权限已授予或被撤销的状态。
- 界面：横竖屏、大字体、分屏、键盘弹出、手势与三键导航。
- 网络：授权拒绝、连接失败、断开重连；记录回调与错误，不只看 Wi-Fi 图标。
- 验证：保留原始日志、构建产物、复现步骤和回归结果，避免把一次成功当成覆盖所有设备。

## 可选能力与进一步阅读

[App Functions 与语义入口](/blog/android-16-app-functions-semantic-index/) 属于按产品需求评估的能力建设，不是每次兼容升级都需要实现的项目。实施前核对当前官方可用范围。

平台行为以 [Android 16 官方变更说明](https://developer.android.com/about/versions/16/behavior-changes-all) 和 [面向 Android 16 的应用变更](https://developer.android.com/about/versions/16/behavior-changes-16) 为准；权限、16 KB 和 Wi-Fi 文章分别列出了相关 API 的来源。

继续阅读 [Android Framework 原理](/android-framework/)，或返回 [技术专题索引](/topics/)。
