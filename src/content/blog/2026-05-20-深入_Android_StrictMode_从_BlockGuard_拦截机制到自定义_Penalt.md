---
title: StrictMode 从开发辅助到 CI 质量门禁的实践
excerpt: 分享将 StrictMode 从调试工具升级为 CI 质量门禁的实践，涵盖 BlockGuard 拦截机制、JSON 结构化输出与线上软拦截方案。
publishDate: '2026-05-20'
tags:
- Android
- StrictMode
- ANR
- 性能优化
- CI/CD
seo:
  title: StrictMode 从开发辅助到 CI 质量门禁的实践
  description: 通过 BlockGuard 拦截机制与结构化 JSON 日志输出，将 StrictMode 集成到 CI 流程作为质量门禁，有效降低线上 ANR 率。
---

项目里遇到过一个头疼的问题：线上 ANR 率始终压在 0.1% 左右降不下去。排查后发现，大部分 ANR 不是由复杂计算造成的，而是**主线程 IO** 和**不经意间的 Binder 调用**。这些违规在开发阶段完全可以通过 StrictMode 检出，但团队要么没开，要么开了没人在意弹窗。

StrictMode 在我司的定位变了——从开发辅助工具升级为 CI 质量门禁的一环。这篇文章梳理背后的拦截机制和我们做的定制化改造。

## StrictMode 在诊断工具链中的位置

Android 性能诊断通常有三层：

**第一层：StrictMode**，负责在开发/测试阶段拦截主线程违规操作，成本最低。

**第二层：Trace/Systrace**，用于复现场景下的方法级耗时分析。

**第三层：ANR trace + Logcat**，线上兜底，信息有限且事后回溯。

大多数团队直接把 StrictMode 当 debug 开关，开发期弹个红框完事。但它的拦截能力在**开发阶段就能暴露 70% 以上的潜在 ANR 诱因**，价值被低估了。

## BlockGuard：StrictMode 的拦截内核

理解 StrictMode 需要先理解它底层依赖的 `BlockGuard`。BlockGuard 是 Android 在 libcore 层实现的一套**线程级策略检查机制**，核心设计如下：

```java
// BlockGuard 核心接口
public class BlockGuard {
    private static final ThreadLocal<Policy> threadPolicy = new ThreadLocal<>();

    // VmPolicy 同理，用于 VM 级别违规（如 Activity 泄露）
    private static final ThreadLocal<Policy> vmPolicy = new ThreadLocal<>();

    public static void setThreadPolicy(Policy policy) {
        threadPolicy.set(policy);
    }
}
```

`ThreadLocal<Policy>` 的设计让每个线程独立持有策略，不干扰线程池中的其他线程。这和 ANR 机制中 `Looper` 按线程绑定的思路一致。

拦截点分布在系统关键路径上。以主线程磁盘 IO 为例，`FileInputStream` 的读写最终会调到 libcore 的 `IoBridge`，这里埋了检查点：

```java
// IoBridge.java（简化）
public static int read(FileDescriptor fd, byte[] bytes, ...) {
    BlockGuard.getThreadPolicy().onReadFromDisk();
    return Libcore.os.read(fd, bytes, ...);
}
```

`onReadFromDisk()` 触发时回调 StrictMode 注册的 penalty 处理器。网络 IO、Binder 调用同理，分别在 `URLConnection` 和 `Binder.java` 中埋点。

BlockGuard 的 `Policy` 默认是 `LAX_POLICY`——**所有检查默认关闭**。不显式调用 `StrictMode.enableDefaults()` 的话，StrictMode 实际上什么都没做。我在接手一个老项目时就踩过这个坑：build.gradle 配了 strictMode 开关，但初始化代码被注释掉了，白跑了一年。

## 自定义 Penalty：从弹窗到结构化输出

默认的 penalty 策略很粗暴：

```java
StrictMode.setThreadPolicy(new StrictMode.ThreadPolicy.Builder()
    .detectDiskReads()
    .penaltyDialog()    // 弹红框
    .penaltyDeath()     // 直接崩
    .build());
```

`penaltyDialog()` 在自动化测试里完全没用，`penaltyDeath()` 会把违规变 crash，测试直接中断。我们需要的是**结构化的违规日志**，能对接 CI 平台做门禁判断。

改造思路：利用 `penaltyLog()` 作为基础通道，但日志格式不够结构化。更彻底的做法是用反射获取 BlockGuard 内部状态，在自定义 `Penalty` 处理器中输出 JSON：

```kotlin
object StrictModeJsonPenalty : StrictMode.OnThreadViolationListener {
    override fun onThreadViolation(violation: Violation) {
        val entry = JSONObject().apply {
            put("type", "thread_violation")
            put("stack", violation.stackTrace.joinToString("\n"))
            put("policy", violation.policy)
            put("timestamp", System.currentTimeMillis())
        }
        Log.w("StrictModeJson", entry.toString())
    }
}
```

配合 `StrictMode.setThreadPolicy()` 中的 `penaltyListener()` 回调，每个违规都会输出一行可解析的 JSON。CI 抓取 logcat 后解析 `StrictModeJson` tag，统计违规次数和类型。

`penaltyListener` 是 API 28 引入的。低版本设备需要走反射注入 `BlockGuard.Policy` 的实现类，核心思路是替换 `BinderProxy` 中的策略实例来劫持回调链。这部分代码略长，不再展开。

## 构建 CI 质量门禁

有了结构化的违规输出，下一步是把它嵌入 CI 流程。我们的做法分三个阶段：

**开发阶段（IDE）**：通过 Gradle 插件在 `debug` buildType 中自动注入 StrictMode 初始化代码，确保所有 debug 包默认开启检测。规则写在 `strictmode-rules.yaml` 里，插件启动时解析并生成初始化代码。

```groovy
// build.gradle 中的开关
strictMode {
    enabled = true
    detectAll = true
    penalty = ['log', 'json']  // json 用于 CI，log 用于本地调试
}
```

**自动化测试阶段**：在 UI 测试的 `@Before` 里注册 `StrictModeJsonPenalty`，测试结束后统计违规。这里要**排除系统级别的违规**，比如 `ViewGroup.dispatchDraw` 内部的 IO——这些是平台行为，开发者改不了。

**合码门禁**：提交 MR 时触发自动化测试，违规数超过阈值直接阻断合入。阈值按模块配置，新模块零容忍，存量模块允许在一定时间内逐步收敛。

半年内，主线程 IO 违规从每周 120+ 降到个位数，线上 ANR 率从 0.12% 压到 0.03%。StrictMode 不是唯一因素，但它让问题在开发阶段就暴露了，省去了后续大量排查成本。

## 生产环境的"软拦截"

线上 build 要不要开 StrictMode？我们的结论是：**开，但只做软拦截**。

线上代码中通过 `StrictMode.allowThreadDiskReads()` 显式标记的合法 IO 不会被计入，其余违规上报到埋点系统。这样做有两个好处：

- 发现**测试用例没覆盖到的违规路径**，反哺自动化测试
- 收集各机型的违规分布，定位 ROM 兼容性问题

线上 penalty 只做日志采集，不做任何阻塞操作。代价是 BlockGuard 每次 IO 调用多一层检查，实测 CPU 开销在 0.3% 以内，可以接受。

## 实践建议

**不要只开 disk/network 检测**。`detectCustomSlowCalls()` 和 `detectResourceMismatches()` 在 API 23+ 可用，能检出 `Object.finalize()` 耗时和 CloseGuard 资源泄露。尤其是后者，我们在迁移 Kotlin 时发现大量 `Closeable` 未正确关闭的问题。

**自定义 penalty 优先用 JSON 格式**。Logcat 的纯文本过滤太脆弱，后续想统计"哪个 Activity 违规最多"还得解析字符串，不如一开始就结构化。

**阈值设得激进一点**。新项目直接设为 0，存量项目按模块设递减阈值，给团队明确的收敛预期。温和的门禁大概率会变成"先合入再说"。
