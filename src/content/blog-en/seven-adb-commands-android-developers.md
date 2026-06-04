---
title: "7 ADB Commands Every Android Developer Should Know"
lang: en
translationKey: seven-adb-commands-android-developers
slug: seven-adb-commands-android-developers
excerpt: "ADB is an essential Android debugging tool. These 7 practical commands make app installation, logging, screenshots, file transfer, and device control faster."
publishDate: '2024-07-29'
tags:
  - "Android"
  - "ADB"
  - "Debugging Tools"
seo:
  title: "7 ADB Commands Every Android Developer Should Know"
  description: "Learn practical ADB commands for screen recording, APK install and uninstall, screenshots, Wi-Fi debugging, permissions, networking, and services."
  pageType: article
---
ADB, or Android Debug Bridge, is one of the most important debugging tools in Android development. This article covers 7 practical and efficient ADB commands that are not always discussed, but can significantly improve development speed by making app installation, log capture, file transfer, and device control much easier.

## 1. Record the Screen with ADB

ADB's screen recording feature is especially useful for developers. It helps you create video demos, product walkthroughs, and bug reports for issues that are hard to explain with screenshots alone. With a simple terminal command, you can start recording the device screen and control parameters such as bitrate and duration.

The basic command is:

```bash
adb shell screenrecord /sdcard/screenrecord.mp4
```

This command creates a `screenrecord.mp4` file under the device's `/sdcard/` directory. After recording, pull the video to your computer with:

```bash
adb pull /sdcard/screenrecord.mp4
```

## 2. Install and Uninstall Apps with ADB

ADB can install and uninstall apps directly from the terminal, without manually interacting with the device UI. This is ideal when you frequently test different builds or need to automate a build pipeline.

The basic command for installing an APK is:

```bash
adb install /path/to/yourApp.apk
```

If the APK is an update for an already installed app, use the `-r` flag to replace the existing installation without uninstalling first:

```bash
adb install -r yourApp.apk
```

The basic uninstall command is:

```bash
adb uninstall com.example.app
```

If you want to keep app data while uninstalling, use the `-k` flag:

```bash
adb uninstall -k com.example.app
```

## 3. Capture and Save Screenshots with ADB

ADB can capture the device screen directly from the terminal, which is convenient during app testing and troubleshooting. The screenshot is saved on the device first, then transferred to your computer with `adb pull`.

The basic command is:

```bash
adb shell screencap /sdcard/screenshot.png
```

Pull the screenshot to your computer:

```bash
adb pull /sdcard/screenshot.png
```

## 4. Debug over Wi-Fi with ADB

ADB supports wireless device connections over Wi-Fi, which is useful when a USB cable is inconvenient or when you need more room to move the device.

First, connect the device over USB for the initial setup. After connecting, enable Wi-Fi debugging on port 5555:

```bash
adb tcpip 5555
```

Then get the device IP address. You can check it in the device Wi-Fi settings, or run:

```bash
adb shell ip route
```

Finally, connect to the device over Wi-Fi using its IP address:

```bash
adb connect <device_ip>:5555
```

When debugging is complete, disconnect with:

```bash
adb disconnect <device_ip>:5555
```

## 5. Grant or Revoke Permissions with ADB

ADB can manage app permissions directly, without going through system settings or the app UI. This is useful for automated testing, CI/CD pipelines, and everyday debugging.

The basic command for granting a permission is:

```bash
adb shell pm grant <package_name> <permission>
```

For example, grant camera permission to an app:

```bash
adb shell pm grant com.example.app android.permission.CAMERA
```

The basic command for revoking a permission is:

```bash
adb shell pm revoke <package_name> <permission>
```

## 6. Configure and Test Networking with ADB

Network conditions can have a major impact on app behavior. Testing under different network environments, such as poor connectivity or no connectivity, is important for evaluating app reliability. ADB gives you tools for simulating network conditions and debugging connection issues.

The basic command to disable Wi-Fi is:

```bash
adb shell ifconfig wlan0 down
```

Restore the Wi-Fi connection:

```bash
adb shell ifconfig wlan0 up
```

You can also combine ADB with proxies, emulators, and other third-party tools to simulate bandwidth limits or unstable network conditions more precisely.

## 7. Start and Stop Services with ADB

ADB can directly control services inside Android apps. Services are core Android components used for background work such as data sync, music playback, and network processing, without direct user interaction.

Starting and stopping services from the terminal makes testing and debugging easier because you do not need to operate the device UI.

The basic command for starting a service is:

```bash
adb shell am startservice <service_name>
```

For example, start a data sync service named `SyncService`:

```bash
adb shell am startservice com.example.app/.SyncService
```

The basic command for stopping a service is:

```bash
adb shell am stopservice com.example.app/.SyncService
```

## Conclusion

ADB is the Swiss Army knife of Android development. Whether you are installing APKs, recording the screen, managing permissions, or starting and stopping services, ADB gives you efficient and flexible control. Mastering these commands can significantly improve your development and debugging workflow, making it easier to manage, test, and optimize apps.

Bringing ADB into your daily workflow saves time and gives you finer control over app performance and behavior. Practice these commands regularly, then keep expanding into more advanced ADB usage.
