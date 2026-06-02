---
title: "Kotlin 与协程工程实践专题"
seo:
  title: "Kotlin 协程与 Flow 原理：suspend、StateFlow、SharedFlow 与 K2"
  description: "系统整理 Kotlin 协程与 Flow 文章，覆盖 suspend CPS 变换、Continuation、Flow 冷流、StateFlow、SharedFlow、K2、KSP、Contracts、Value Class、DSL 与 Android 工程实践。"
---

这个专题围绕 Kotlin 在 Android 工程中的核心能力：协程、Flow、编译器和跨平台。目标是理解运行机制，并能把它们用在稳定的业务架构里。

## 学习路径

1. 从 suspend 编译结果理解协程不是线程。
2. 用结构化并发解释取消、异常和生命周期。
3. 用 Flow、StateFlow、SharedFlow 建立响应式数据流。
4. 关注 K2 编译器对类型推断、构建速度和迁移的影响。

## 核心文章

- [Kotlin suspend 原理：CPS 变换、Continuation 与状态机字节码](/blog/2026-04-23-kotlin_suspend_的编译器黑盒_从_cps_变换到状态机字节码的完整推演/)
- [Kotlin Flow 原理与工程实践：冷流、StateFlow、SharedFlow 对比](/blog/2026-04-23-kotlin_flow_工程化全景_从冷流惰性求值到_stateflow_sharedflow_热流/)
- [Kotlin Coroutines 与 Flow：协程调度、结构化并发和响应式数据流](/blog/kotlin-coroutines-与-flow-的高级应用与原理/)
- [Kotlin K2 编译器解析：统一前端、类型推断与 Android 构建影响](/blog/2026-04-23-kotlin_k2_编译器深度解析_从统一前端架构到智能类型推断重写的编译革新与_android_工/)

## 新增 Kotlin 专项

- [深入 Kotlin Coroutines 测试全链路：从 TestDispatcher 调度控制到 Turbine Flow 断言的协程单元测试工程实践](/blog/2026-05-15-深入_kotlin_coroutines_测试全链路_从_testdispatcher_调度控制到_/)
- [深入 Kotlin Context Receivers 上下文接收器](/blog/2026-01-16-深入_kotlin_context_receivers_上下文接收器_从_multiple_rece/)
- [深入 Kotlin Contracts 契约编程：从 SmartCast 失效到 callsInPlace 的编译器协作机制](/blog/2026-01-20-深入_kotlin_contracts_契约编程_从_smartcast_类型推断到_callsin/)
- [深入 Kotlin Sealed Class/Interface 密封类层次：从编译期穷举检查到 Compose UI 状态建模的类型安全实践](/blog/2026-01-21-深入_kotlin_sealed_class_interface_密封类层次_从编译期穷举检查到_c/)
- [深入 KSP 全链路：从注解扫描到代码生成的编译期元编程](/blog/2026-01-22-深入_kotlin_symbol_processing__ksp__全链路解析_从_symbolpr/)
- [深入 Kotlin inline class/value class 全链路：从编译期消除装箱到类型安全的零开销抽象](/blog/2026-01-23-深入_kotlin_inline_class_value_class_全链路_从编译期装箱消除到类型/)
- [深入 Kotlin 内联函数全链路解析：从 inline 字节码内联到 reified 泛型特化的编译期优化黑魔法](/blog/2026-01-26-深入_kotlin_内联函数全链路解析_从_inline_字节码内联到_reified_泛型特化的编/)
- [深入 Kotlin 类型安全构建器与 DSL 设计全链路](/blog/2026-05-27-深入_kotlin_类型安全构建器与_dsl_设计全链路_从__dslmarker_隐式作用域到_c/)

## 工程判断

- 一次性异步任务优先用 suspend。
- 连续数据流优先用 Flow。
- UI 状态优先用 StateFlow。
- 事件广播谨慎使用 SharedFlow，并明确 replay 和 buffer 策略。
- 协程泄漏通常不是语法问题，而是作用域设计问题。

## 下一步

协程和 Flow 通常会落到架构、测试和 Compose 状态管理里，建议继续阅读 [移动端工程化](/android-engineering/) 和 [Jetpack Compose 深度解析](/jetpack-compose/)。
