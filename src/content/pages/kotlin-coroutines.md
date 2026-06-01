---
title: "Kotlin 与协程工程实践专题"
seo:
  title: "Kotlin 协程与 Flow 原理：suspend、StateFlow、SharedFlow 与 K2"
  description: "系统整理 Kotlin 协程与 Flow 文章，覆盖 suspend CPS 变换、Continuation、Flow 冷流、StateFlow、SharedFlow、K2 编译器与 Android 工程实践。"
---

这个专题围绕 Kotlin 在 Android 工程中的核心能力：协程、Flow、编译器和跨平台。目标是理解运行机制，并能把它们用在稳定的业务架构里。

## 学习路径

1. 从 suspend 编译结果理解协程不是线程。
2. 用结构化并发解释取消、异常和生命周期。
3. 用 Flow、StateFlow、SharedFlow 建立响应式数据流。
4. 关注 K2 编译器对类型推断、构建速度和迁移的影响。

## 核心文章

- [Kotlin suspend 原理：CPS 变换、Continuation 与状态机字节码](/blog/2026-04-23-Kotlin_suspend_%E7%9A%84%E7%BC%96%E8%AF%91%E5%99%A8%E9%BB%91%E7%9B%92_%E4%BB%8E_CPS_%E5%8F%98%E6%8D%A2%E5%88%B0%E7%8A%B6%E6%80%81%E6%9C%BA%E5%AD%97%E8%8A%82%E7%A0%81%E7%9A%84%E5%AE%8C%E6%95%B4%E6%8E%A8%E6%BC%94/)
- [Kotlin Flow 原理与工程实践：冷流、StateFlow、SharedFlow 对比](/blog/2026-04-23-Kotlin_Flow_%E5%B7%A5%E7%A8%8B%E5%8C%96%E5%85%A8%E6%99%AF_%E4%BB%8E%E5%86%B7%E6%B5%81%E6%83%B0%E6%80%A7%E6%B1%82%E5%80%BC%E5%88%B0_StateFlow_SharedFlow_%E7%83%AD%E6%B5%81/)
- [Kotlin Coroutines 与 Flow：协程调度、结构化并发和响应式数据流](/blog/Kotlin%20Coroutines%20%E4%B8%8E%20Flow%20%E7%9A%84%E9%AB%98%E7%BA%A7%E5%BA%94%E7%94%A8%E4%B8%8E%E5%8E%9F%E7%90%86/)
- [Kotlin K2 编译器解析：统一前端、类型推断与 Android 构建影响](/blog/2026-04-23-Kotlin_K2_%E7%BC%96%E8%AF%91%E5%99%A8%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90_%E4%BB%8E%E7%BB%9F%E4%B8%80%E5%89%8D%E7%AB%AF%E6%9E%B6%E6%9E%84%E5%88%B0%E6%99%BA%E8%83%BD%E7%B1%BB%E5%9E%8B%E6%8E%A8%E6%96%AD%E9%87%8D%E5%86%99%E7%9A%84%E7%BC%96%E8%AF%91%E9%9D%A9%E6%96%B0%E4%B8%8E_Android_%E5%B7%A5/)

## 工程判断

- 一次性异步任务优先用 suspend。
- 连续数据流优先用 Flow。
- UI 状态优先用 StateFlow。
- 事件广播谨慎使用 SharedFlow，并明确 replay 和 buffer 策略。
- 协程泄漏通常不是语法问题，而是作用域设计问题。

## 下一步

协程和 Flow 通常会落到架构和测试里，建议继续阅读 [移动端工程化](/android-engineering/)。
