---
title: Android Framework
lang: en
translationKey: android-framework
seo:
  title: Android Framework Internals
  description: Android Framework notes covering Binder, system services, ActivityThread, PackageManager, permissions, ContentProvider, and platform internals.
---

This topic is for developers who want to understand how Android actually runs. The focus is not API usage. It is how app processes, system services, the Binder driver, and the Framework layer cooperate.

## Learning Path

1. Start with processes, threads, and the message loop.
2. Then study Binder IPC and build a mental model for cross-process calls.
3. Move on to system services and the app-to-Framework interaction path.
4. Finally, fill in ContentProvider, permissions, and security boundaries.

## Core Articles

- [Android Binder internals: from driver communication to the AIDL call chain](/blog/binder-ipc-beyond-aidl/)
- [Android Framework system services: how AMS, WMS, and app processes interact](/blog/android-system-services-framework-interaction/)
- [Android process and thread model: Zygote, the main thread, and Binder thread pools](/blog/android-process-thread-model-deep-dive/)
- [Android ContentProvider internals: URI routing, cross-process access, and permission control](/blog/android-contentprovider-ipc/)
- [Android permissions: runtime permissions, interception paths, and security boundaries](/blog/android-permission-system-evolution/)

## System Startup, Processes, and Services

- [AOSP source-reading methodology: tracing system-service calls down to native implementations](/blog/aosp-source-reading-methodology/)
- [Android init and system startup: from BootLoader to Home Screen](/blog/android-init-boot-process/)
- [Android Zygote process: from init fork to app process creation](/blog/android-zygote-init-fork-process/)
- [Android Task Stack and Activity launch modes](/blog/android-task-stack-launch-modes/)
- [Android PackageManager: APK parsing, PMS registration, and permission checks](/blog/android-packagemanager-pms-apk-parsing/)
- [Android BroadcastReceiver: registration, BroadcastQueue, and delivery scheduling](/blog/android-broadcastreceiver-broadcastqueue/)
- [Android WebView: Chromium architecture and JS Bridge security](/blog/android-webview-chromium-jsbridge/)
- [Android Watchdog: SystemServer lock monitoring and automatic restart](/blog/android-watchdog-systemserver/)
- [Android OTA updates: A/B partitions and Virtual A/B snapshots](/blog/android-ota-ab-virtual-ab/)
- [Large cross-process data transfer on Android: from Binder's 1 MB limit to ASharedMemory zero-copy channels](/blog/android-large-ipc-asharedmemory/)

## Problems This Topic Helps Answer

- Why do Android apps and system services have to work through Binder?
- How are AMS, WMS, PMS, and similar services called from app-side code?
- How do the main thread, Handler, and Binder thread pool divide responsibility?
- Why is ContentProvider both a data API and a cross-process boundary?
- Where does permission enforcement happen: before the call, during the call, or inside the system service?

## Next Step

After this topic, continue with [Android Performance Optimization](/en/android-performance/). The clearer the Framework path is, the easier it becomes to diagnose cold start, ANR, rendering, and memory issues.
