---
title: WebViewTest
description: 面向 Android 混合应用与 H5 页面的 WebView 测试工作台，支持 URL、扫码、本地 HTML、配置切换、App 内调试与 release WebView debugging。
publishDate: 2026-06-12
isFeatured: true
seo:
  title: WebViewTest | Android H5 与 WebView 测试工具
  description: 基于 Kotlin、Jetpack Compose 与 Android WebView 构建，提供 H5 页面加载、扫码、本地 HTML、调试面板、WebView 配置切换和 Google Play 发布链路。
  pageType: website
---

`WebViewTest` 是一款 Android H5/WebView 测试工具，面向混合应用开发、活动页验收、落地页预览、WebView 兼容性排查和 Android WebView 能力测试。

项目不是通用浏览器，而是一个单会话 WebView 测试工作台：开发者可以在真实设备或模拟器上快速加载页面、复现问题、切换 WebView 环境，并通过 App 内调试面板或 Chrome DevTools 分析页面行为。

## 核心能力

- URL 加载：支持手动输入、粘贴、刷新，并自动规范化 `http` / `https` URL
- 扫码加载：内置 CameraX + ML Kit 二维码扫描，扫码结果可直接回填并加载
- 本地 HTML：通过系统文件选择器加载 `content://` / `file://` HTML，并记录本地文件历史
- 历史记录：自动保存访问历史，区分远程 URL 与本地文件
- 配置切换：JavaScript、DOM Storage、Cookie、三方 Cookie、cache、mixed content、User-Agent、desktop mode、权限策略、全屏等
- App 内调试：Console、Errors、Page、Cookies、Storage、Source、Elements、JS Exec、Requests、Downloads
- 高级 WebView 行为：文件选择、下载、视频全屏、长按上下文菜单、Web camera/microphone/geolocation 权限
- Release 调试开关：Settings 中可手动开启 WebView debugging，并使用桌面 Chrome `chrome://inspect` 调试 release 包中的 WebView

## 技术栈

- Kotlin
- Jetpack Compose + Material3
- Android WebView + `AndroidView`
- Navigation Compose
- Room
- DataStore Preferences
- CameraX
- ML Kit Barcode Scanning
- kotlinx.serialization JSON
- JUnit / AndroidX Test / Compose UI Test

## 工程设计

项目把 WebView 测试链路拆成几个边界清晰的模块：

- `data`：Room、DataStore 与 Repository
- `debug`：调试状态、reducer、页面脚本与结果格式化
- `model`：WebTestConfig、测试用例与历史模型
- `scanner`：CameraX + ML Kit 扫码链路
- `ui`：Workbench、Settings、Scanner 与通用 Compose UI
- `util`：URL 标准化等工具
- `web`：WebView host、client、settings、权限、下载、文件选择与全屏处理

WebView 层只负责应用配置和发出事件，ViewModel 作为 UI、持久化和 WebView event 的边界，避免 WebView 直接读写数据库。

## 发布状态

项目已按 Google Play 发布链路准备，当前 Play 页面处于审核中。审核通过后可通过包名链接访问：

- https://play.google.com/store/apps/details?id=com.xckevin.android.app.webview.test

## 仓库地址

- https://github.com/xckevin/WebView-Test
