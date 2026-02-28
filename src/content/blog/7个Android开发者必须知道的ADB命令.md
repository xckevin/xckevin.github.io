---
title: 7 个 Android 开发者必须知道的 ADB 命令
excerpt: ADB（Android Debug Bridge）是 Android 开发中不可或缺的调试工具。本文将介绍 7 个实用且高效的 ADB 命令，它们虽不常被提及，却能显著提升开发效率，让安装应用、捕获日志、推送文件等操作变得轻松自如。
publishDate: 2024-07-29
tags:
  - Android
  - ADB
  - 调试工具
seo:
  title: 7 个 Android 开发者必须知道的 ADB 命令
  description: ADB（Android Debug Bridge）是 Android 开发中不可或缺的调试工具。本文将介绍 7 个实用且高效的 ADB 命令，它们虽不常被提及，却能显著提升开发效率，让安装应用、捕获日志、推送文件等操作变得轻松自如。
---
ADB（Android Debug Bridge）是 Android 开发中不可或缺的调试工具。本文将介绍 7 个实用且高效的 ADB 命令，它们虽不常被提及，却能显著提升开发效率，让安装应用、捕获日志、推送文件等操作变得轻松自如。

## 1. ADB 屏幕录制命令

ADB 的屏幕录制功能对开发者非常实用，尤其适用于创建视频演示、应用导览，或捕获难以用截图描述的错误。通过简单的终端命令，即可开始录制设备屏幕，并控制比特率、时长等录制参数。

基本命令如下：

```bash
adb shell screenrecord /sdcard/screenrecord.mp4
```

该命令会在设备 `/sdcard/` 目录下生成 `screenrecord.mp4` 文件。录制完成后，可通过以下命令将视频拉取到电脑：

```bash
adb pull /sdcard/screenrecord.mp4
```

## 2. 使用 ADB 安装和卸载应用

ADB 支持直接从终端安装和卸载应用，无需手动操作设备界面，非常适合频繁测试不同版本或需要自动化构建流程的开发者。

安装 APK 的基本命令如下：

```bash
adb install /path/to/yourApp.apk
```

若 APK 为已安装应用的更新版本，可使用 `-r` 参数实现覆盖安装，无需先卸载：

```bash
adb install -r yourApp.apk
```

卸载应用的基本命令如下：

```bash
adb uninstall com.example.app
```

若希望在卸载时保留应用数据，可使用 `-k` 参数：

```bash
adb uninstall -k com.example.app
```

## 3. 使用 ADB 捕获和保存屏幕截图

ADB 支持直接从终端截取设备屏幕，在测试应用或排查问题时非常方便。截图会先保存在设备上，再通过 `adb pull` 传输到电脑。

基本命令如下：

```bash
adb shell screencap /sdcard/screenshot.png
```

将截图拉取到电脑：

```bash
adb pull /sdcard/screenshot.png
```

## 4. 使用 ADB 调试 Wi-Fi 连接

ADB 支持通过 Wi-Fi 无线连接设备，在无法使用数据线或需要更大活动空间时非常有用。

首先，需通过 USB 连接设备以完成初始配置。连接后，执行以下命令在端口 5555 上启用 Wi-Fi 调试：

```bash
adb tcpip 5555
```

然后获取设备 IP 地址，可通过设备 Wi-Fi 设置查看，或执行：

```bash
adb shell ip route
```

最后，使用 IP 地址通过 Wi-Fi 连接设备：

```bash
adb connect <device_ip>:5555
```

调试结束后，可通过以下命令断开连接：

```bash
adb disconnect <device_ip>:5555
```

## 5. 通过 ADB 授予或移除权限

ADB 可直接管理应用权限，无需通过系统设置或应用界面，适用于自动化测试、CI/CD 流水线及日常调试。

授予权限的基本命令如下：

```bash
adb shell pm grant <package_name> <permission>
```

例如，授予应用相机权限：

```bash
adb shell pm grant com.example.app android.permission.CAMERA
```

撤销权限的基本命令如下：

```bash
adb shell pm revoke <package_name> <permission>
```

## 6. 使用 ADB 进行网络配置和测试

网络条件会显著影响应用表现。在不同网络环境下测试应用（如弱网、断网）对评估其可靠性至关重要。ADB 提供了模拟不同网络环境、调试连接问题的能力。

禁用 Wi-Fi 的基本命令如下：

```bash
adb shell ifconfig wlan0 down
```

恢复 Wi-Fi 连接：

```bash
adb shell ifconfig wlan0 up
```

此外，可结合代理、模拟器等第三方工具，进一步模拟带宽限制或不稳定网络条件。

## 7. 使用 ADB 启动和停止服务

ADB 可直接控制 Android 应用中的服务。服务是 Android 中用于执行后台任务（如同步数据、播放音乐、处理网络请求）的核心组件，无需用户直接交互。

通过 ADB 从终端启动和停止服务，便于测试和调试，无需操作设备界面。

启动服务的基本命令如下：

```bash
adb shell am startservice <service_name>
```

例如，启动名为 SyncService 的数据同步服务：

```bash
adb shell am startservice com.example.app/.SyncService
```

停止服务的基本命令如下：

```bash
adb shell am stopservice com.example.app/.SyncService
```

## 结语

ADB 堪称 Android 开发者的「瑞士军刀」。无论是安装 APK、录制屏幕、管理权限，还是启动和停止服务，ADB 都能提供高效、灵活的控制能力。熟练掌握这些命令，可以显著提升开发与调试效率，让你更自如地管理、测试和优化应用。

将 ADB 融入日常工作流程，不仅能节省时间，还能更精细地调优应用性能与行为。建议多加练习这些命令，逐步掌握 ADB 的更多高级用法。
