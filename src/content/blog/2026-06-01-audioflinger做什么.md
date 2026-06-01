---
title: "AudioFlinger 在 Android 音频系统中负责什么？"
slug: android-audioflinger
excerpt: "解释 AudioFlinger 在 Android 音频链路中的角色，包括混音、线程、AudioTrack、低延迟播放和 AAudio。"
publishDate: '2026-06-01'
tags:
- "Android"
- "AudioFlinger"
- "音频"
seo:
  title: "AudioFlinger 是什么？Android 音频系统混音链路解析"
  description: "解释 Android AudioFlinger 的职责，覆盖 AudioTrack、混音线程、输出设备、AAudio、低延迟播放和性能问题定位。"
---

AudioFlinger 是 Android 音频系统里的核心服务之一，主要负责接收多个应用的音频数据，完成混音，再送到 HAL 和音频设备。

应用通常通过 AudioTrack、MediaPlayer、AAudio 或 OpenSL ES 输出音频。数据最终会进入 AudioFlinger，由它管理播放线程、混音策略、音量和输出设备。

## 深入阅读

- [返回专题页](/android-performance/)
- [Android 音频系统原理：AudioFlinger、混音策略与 AAudio 低延迟](/blog/2026-05-12-%E6%B7%B1%E5%85%A5_Android_%E9%9F%B3%E9%A2%91%E7%B3%BB%E7%BB%9F%E5%85%A8%E9%93%BE%E8%B7%AF_%E4%BB%8E_AudioFlinger_%E6%B7%B7%E9%9F%B3%E7%AD%96%E7%95%A5%E5%88%B0_AAudio_%E4%BD%8E%E5%BB%B6%E8%BF%9F/)
