---
title: "Android App 启动优化应该先看哪些指标？"
slug: android-startup-metrics
excerpt: "整理 Android 启动优化的关键指标、阶段拆分、Perfetto trace 观察点和线上治理优先级。"
publishDate: '2026-06-01'
tags:
- "Android"
- "启动优化"
- "Perfetto"
seo:
  title: "Android App 启动优化指标：冷启动、首帧、TTID 与 Perfetto 分析"
  description: "介绍 Android App 启动优化应关注的冷启动、首帧、TTID、主线程阻塞、Binder 调用和 Perfetto trace 指标。"
---

启动优化不要先改代码，先确定指标。否则很容易把耗时从一个阶段挪到另一个阶段，报告里看起来变快，用户实际看到的首屏没有任何改善。

我更倾向把 Android 启动看成一条链路：进程创建、应用初始化、首个 Activity 创建、首帧绘制、首屏内容可交互。每个阶段都有自己的观测点，不能只盯着一个 `Application.onCreate()`。

## 先分清几个启动时间

冷启动是进程不存在时从 Launcher 点击到首屏展示的过程，包含 Zygote fork、应用进程初始化、类加载、资源加载、主 Activity 创建和首帧渲染。温启动通常复用已有进程，热启动甚至只是把已有 Activity 拉回前台。三者混在一起统计，会让优化结论失真。

线上指标里至少拆四类：

- **Process start**：从点击到应用进程可运行，受系统负载、fork、包体积和冷页加载影响。
- **Application init**：`attachBaseContext`、`ContentProvider` 初始化、`Application.onCreate()` 的总耗时。
- **First frame**：Activity 创建后第一次 `Choreographer#doFrame` 完成并提交给渲染管线。
- **First useful content**：用户真正能看到核心内容的时间，很多业务比系统首帧更关心这个。

Google Play Console、Firebase Performance 和自建埋点给出的启动时间口径不完全一样。做专项前先把口径写清楚，后面所有优化和复盘都以同一套口径对齐。

## Perfetto 里应该先看什么

启动 trace 不要从几十条轨道里随机点。先圈定时间窗口：Launcher 发起启动、应用进程出现、主线程执行 `bindApplication`、Activity 生命周期、首帧上屏。这个窗口确定后，再从主线程往外展开。

主线程上重点看这些信号：

- `ActivityThread.main` 到 `handleBindApplication` 之间是否有明显空洞。
- `ContentProvider` 是否在 Application 之前抢占了大量初始化时间。
- `Application.onCreate()` 内是否有磁盘 I/O、网络库初始化、数据库打开、反射扫描。
- `Activity.onCreate/onStart/onResume` 是否同步做了首屏以外的业务。
- `Choreographer#doFrame` 到 `DrawFrame` 是否被布局、图片解码或同步 Binder 调用阻塞。

如果主线程在等待，继续看等待原因：是 Binder transaction 卡在系统服务，还是被 `monitor contention` 锁住，还是 CPU 被后台线程抢满。启动优化最忌只看到主线程“慢”，却不追到底层原因。

## 四类最常见的启动瓶颈

第一类是过早初始化。统计、推送、IM、广告、AB 实验、埋点 SDK 都喜欢放进 `Application.onCreate()`，最后冷启动像开会一样等所有人发言。处理方式不是简单扔到后台线程，而是按“首屏必要性”拆分：首屏必需同步初始化，首屏后立即需要的延迟到首帧后，不确定是否用到的改成懒加载。

第二类是磁盘 I/O。SharedPreferences 首次加载、数据库打开、读取大 JSON、扫描本地文件都可能触发冷页读取。Perfetto 里可以看 `disk` 轨道，也可以用 StrictMode 在 debug 包里提前暴露。启动阶段的原则是少读、顺序读、晚点读。

第三类是类加载和反射。大型路由表、DI 容器、JSON 反射、插件化框架都会增加 class loading 成本。能用 KSP/注解处理在编译期生成索引，就不要在启动时扫描 classpath。能把反射调用收敛到首屏后，就不要卡在主线程。

第四类是首帧太“真实”。很多页面在第一帧就加载完整列表、复杂图片、动画、多个 Fragment 和二级模块。启动首帧应该先展示骨架和核心信息，把非首屏区域延迟到首帧之后。优化目标不是少做事，而是让第一帧只做必须的事。

## 线上治理看 p95，不看平均值

启动优化的收益不能只看开发机。低端机、冷页状态、安装后首次启动、系统负载、灰度用户的机型分布都会改变结果。平均值很容易被高端机稀释，建议至少看 p50、p90、p95、p99。

一个比较实用的门禁是：每次发布记录启动 p95、首帧 p95、`Application.onCreate()` p95、首屏可交互 p95；如果任何一项比上个稳定版本劣化超过阈值，就阻断发布或进入专项复盘。启动优化不是一次性项目，而是需要版本门禁守住的工程纪律。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：Android 性能优化](/android-performance/)
- [Android 启动优化：从 Zygote fork 到首帧上屏的 Perfetto 实战](/blog/2026-04-19-android_冷启动全链路优化工程实践_从_zygote_fork_到首帧上屏的_systrace/)
- [Android App 启动优化专项：指标、链路、工具与治理方案](/blog/app启动优化专项/)
- [Android Perfetto 入门：Trace 抓取、轨道分析与性能定位](/blog/android-perfetto/)
<!-- /seo-internal-links -->
