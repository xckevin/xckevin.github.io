---
title: 'AGP 9 升级踩坑：R8 删除 WorkManager 构造方法导致日志上报失败'
lang: zh
translationKey: agp-9-r8-workmanager-inputmerger-constructor
slug: agp-9-r8-workmanager-inputmerger-constructor
excerpt: '一次 AGP 8.6.0 升级到 9.0.1 引发的线上问题：WorkManager 2.8.1 的 InputMerger 无参构造方法被 R8 删除，日志转由兜底链路补传，采集器时间排序随之失真。'
publishDate: '2026-09-22'
tags:
  - Android
  - AGP
  - R8
  - WorkManager
  - 可观测性
seo:
  title: 'AGP 9 R8 混淆规则变化：WorkManager InputMerger 构造方法丢失排查'
  description: '复盘 AGP 9.0.1 升级后 WorkManager 2.8.1 日志上报失败：R8 严格 keep 规则删除无参构造方法，如何修复、验证 Release 产物并解释 crt_ms 排序异常。'
  pageType: article
---

Android 端 8.55.0 在适配新系统时，把 Android Gradle Plugin（AGP）从 8.6.0 升级到了 9.0.1。随后出现了一个容易被当成埋点顺序问题的现象：采集器最终收到了日志，但多条日志的 `crt_ms` 相同，按这个字段排序后，首页事件反而排在了后面。

本案中的 `crt_ms` 表示**采集器接收或入库时间**，并非客户端事件发生时间。排查发现，WorkManager 上传主链路已经失败，日志依靠定时扫描磁盘文件的兜底链路补传。数据最终到达，掩盖了正常上传路径的故障。

根因落在构建产物上：R8 删除了 `OverwritingInputMerger` 的无参构造方法，使 WorkManager 的反射实例化失败。修复是在 keep 规则中显式保留该构造方法。

本文记录已定位的原因和准备采用的修复。记录时修复版本计划于当日发布，尚不包含发布后的恢复数据；后面的回归步骤是验收建议。

## 故障范围与两条日志链路

| 项目 | 本次情况 |
| --- | --- |
| 出现问题的应用版本 | Android 8.55.0 |
| AGP 升级路径 | 8.6.0 → 9.0.1 |
| WorkManager 版本 | 2.8.1 |
| 出问题的构建 | 开启 R8 代码收缩与混淆的 Release 包 |
| 被删除的成员 | `androidx.work.OverwritingInputMerger.<init>()V` |
| 观察到的影响 | 上传主链路失败，兜底补传后，按采集器时间还原的页面顺序异常 |

正常链路先保存日志，再交给 WorkManager 异步上传：

```text
页面产生事件 → 日志批量打包 → 保存到磁盘
                                  ↓
                        创建 WorkManager 上传任务
                                  ↓
                        初始化 InputMerger → 上传
```

兜底链路定时扫描磁盘上的日志文件，发现待上传文件后直接发起上报。本次异常中，主链路在初始化 `InputMerger` 时中断，已经落盘的日志仍可被兜底链路发现，因此在已排查的日志范围内没有发现丢失。

这不等于上报功能正常，也不意味着兜底机制能保证所有情况下都不丢数据。磁盘清理、文件损坏或应用卸载仍可能影响未上传文件。本案能够确认的是：兜底机制补回了所观察到的日志，但上传时效已经发生变化。

## AGP 9 改变的是 keep 规则的隐含行为

AGP 9 的[官方行为变更说明](https://developer.android.com/build/releases/agp-9-0-0-release-notes#behavior-changes)指出，`android.r8.strictFullModeForKeepRules` 默认值变为 `true`。因此，下面的规则不再隐含保留无参构造方法：

```proguard
-keep class A
```

如果运行时需要它，就应明确声明：

```proguard
-keep class A {
    <init>();
}
```

官方表格比较的是 AGP 8.13 与 9.0 的默认值，本项目实际跨越的是 8.6.0 到 9.0.1。排查其他项目时，还应检查 `gradle.properties` 和构建参数是否显式覆盖了这个属性。

这里有两个容易混淆的概念。第一，AGP 8.0 就已经默认启用了 R8 full mode；本次变化是 keep 规则对构造方法的隐含保留行为，不能概括成“AGP 9 首次开启 full mode”。参见 [AGP 8.0 发布说明](https://developer.android.com/build/releases/agp-8-0-0-release-notes#default-changes)。

第二，`-keep class A` 不能简单理解成“只保留类名”。普通 `-keep` 也约束类本身的删除、改名和优化；问题在于**保留类，不等于显式保留通过反射调用的成员**。严格规则下，所需构造方法必须写进成员块。相关语义见 [R8 keep 规则说明](https://developer.android.com/topic/performance/app-optimization/add-keep-rules)。

## WorkManager 2.8.1 为什么受影响

### 类保住了，构造方法没有保住

WorkManager 2.8.1 的 `work-runtime` AAR 中包含这条 consumer rule：

```proguard
-keep class * extends androidx.work.InputMerger
```

它没有成员块，依赖了旧行为对无参构造方法的隐含保留。可以在 Google Maven 发布的 [WorkManager 2.8.1 AAR](https://dl.google.com/dl/android/maven2/androidx/work/work-runtime/2.8.1/work-runtime-2.8.1.aar) 的 `proguard.txt` 中核对，而不应使用当前开发分支的规则推断旧版本行为。

`OverwritingInputMerger` 是一个公开的 `InputMerger` 子类。该版本 Java 源码没有显式声明构造方法，因此编译后具有公开的无参构造方法。问题出现在后续 R8 收缩阶段：本案的 Release 产物中，类还在，`<init>()V` 已被删除。

`<init>` 表示实例构造方法，`()` 表示没有参数，`V` 是其字节码描述符中的返回类型标记。定位时要检查这个具体成员，不能仅凭类名还存在就判断反射安全。

### 反射失败后，上传 Worker 尚未开始执行

WorkManager 2.8.1 先尝试配置的 `InputMergerFactory`。当它返回 `null` 时，`createInputMergerWithDefaultFallback()` 才回退到 `InputMerger.fromClassName()`。本案失败的是这个默认反射分支，关键调用如下：

```java
Class<?> clazz = Class.forName(className);
return (InputMerger) clazz.getDeclaredConstructor().newInstance();
```

当类存在但无参构造方法缺失时，`getDeclaredConstructor()` 会失败。该方法的 `catch (Exception)` **会调用 `Logger` 记录错误，然后返回 `null`**。因此，更准确的描述是异常没有继续向业务调用方抛出，而非库内部完全没有日志。这些实现可在官方 [2.8.1 sources JAR](https://dl.google.com/dl/android/maven2/androidx/work/work-runtime/2.8.1/work-runtime-2.8.1-sources.jar) 的 `InputMerger.java` 和 `InputMergerFactory.java` 中核对。

继续看同一版本的 `WorkerWrapper.java`：非周期任务分支创建 `InputMerger` 后，如果结果为 `null`，就记录错误、调用 `setFailedAndResolve()`，然后返回。该路径会将任务标记为失败，在正常执行路径中甚至还没走到创建业务 Worker 的步骤。

这解释了为什么只监控上传请求的响应码或业务 `doWork()` 内部异常，可能看不到本次失败：网络上传尚未开始。它也不是业务 Worker 返回 `Result.retry()` 后进入退避重试的情况。

这里的 `InputMerger` 合并的是 WorkRequest 的输入 `Data`，并不负责合并埋点日志，也不是让 `crt_ms` 相同的组件。另外，2.8.1 的周期任务在这段代码中走另一条输入处理分支，不能把结论扩大成“所有 WorkManager 任务都会在这里失败”。

## 为什么日志补回来了，页面顺序却不对

本案里存在两个不同的时间轴：

| 时间轴 | 表示什么 | 能否直接还原页面行为顺序 |
| --- | --- | --- |
| 客户端事件发生时间 | 用户行为实际发生的时间 | 需要结合时钟与会话内顺序判断 |
| `crt_ms` | 采集器接收或入库时间 | 不能；会受排队、补传和写入时机影响 |

主链路失败后，较早产生的首页日志可能滞留在磁盘，等到兜底扫描才送达。多条日志集中补传，也可能使接收或入库时间相同、非常接近。此时按 `crt_ms` 排序，得到的是接收或入库时间顺序，无法据此还原客户端页面访问顺序。

还需要保留一个边界：**相同的 `crt_ms` 本身不能解释首页为什么一定排在最后。** 同值记录的相对顺序还取决于二级排序键、读取或写入顺序，以及查询系统的行为。当前证据足以说明 `crt_ms` 不适合承担事件顺序语义；若要解释某条首页日志的具体位置，还需要检查对应批次和查询排序条件。

对于后续的数据设计，可以把以下字段分开保存，而不是让一个时间戳承担全部含义：

- 事件首次产生时记录的 `event_time_ms`，重试和补传时不改写。
- `session_id` 与会话内单调递增的 `event_seq`，辅助还原本地事件顺序。
- 稳定的 `event_id`，让主链路和兜底链路共用同一去重标识。
- 独立的采集器时间，以及上传路径、批次和尝试次数，便于观察延迟与补传。

这些是改进建议，不代表当前系统已经具备相应字段。客户端时钟可能漂移，序号也需要处理进程重启和并发分配；它们的作用是提供可核对的事件语义，而不是建立跨设备的绝对时间顺序。

## 修复：显式保留公开无参构造方法

本次修复是在应用实际参与 Release 构建的混淆规则文件中增加：

```proguard
-keep class * extends androidx.work.InputMerger {
    public <init>();
}
```

这条规则保留匹配的 `InputMerger` 子类及其公开无参构造方法，覆盖本案中的 `OverwritingInputMerger`。它没有把整个 `androidx.work` 包的所有成员都保留下来。

如果只想覆盖这个具体实现，也可以使用范围更窄的规则：

```proguard
-keep class androidx.work.OverwritingInputMerger {
    public <init>();
}
```

两者是范围选择，不需要为了这个问题同时添加。本次采用前一条，以覆盖其他同样依赖公开无参构造方法的 `InputMerger` 子类。`public <init>();` 不会保留非公开构造方法或带参构造方法；若自定义实现使用其他签名，需要按实际创建路径处理。

后续可以评估升级 WorkManager，但应检查目标版本发布 AAR 中的 consumer rules，并验证实际 Release 产物。仅凭依赖版本号变大，不能证明反射入口已经安全。

## 如何验证修复，避免兜底链路再次掩盖问题

验证要同时覆盖构建产物和真实上传路径。Debug 包正常、编译成功，或者采集器最终收到了日志，都不足以单独证明修复有效。

### 先确认规则进入了目标构建

下面是应用工程中的排查示例，模块名和变体名需要按项目调整：

```bash
./gradlew :app:dependencyInsight \
  --dependency work-runtime \
  --configuration releaseRuntimeClasspath

./gradlew :app:assembleRelease

rg -n -A 4 'InputMerger' \
  app/build/outputs/mapping/release/configuration.txt
```

依赖解析结果用于确认实际打包的版本；`configuration.txt` 用于确认合并后的 R8 配置包含修复规则。随后还需要检查最终 APK 的 DEX，确认 `OverwritingInputMerger` 中存在公开的 `<init>()V`。如果发布 AAB，应检查对应安装 APK 中的 DEX。

`mapping.txt` 中有类名、原始 AAR 中有构造方法，或者配置文件中写了 keep，都不能单独证明最终产物保留了该成员。

### 再验证主链路与兜底链路

| 回归场景 | 验收重点 |
| --- | --- |
| 开启收缩的 Release 包触发正常上报 | 上传 Worker 确实开始执行，任务成功，采集器收到预期事件 |
| 测试环境隔离兜底扫描 | 主链路能够独立完成上报，避免补传造成假阳性 |
| 人为制造暂时上传失败后恢复 | 磁盘文件可补传，同一事件不会重复计数 |
| 连续产生首页及后续页面事件 | 用事件语义核对顺序，单独检查 `crt_ms` 的接收时间含义 |

观察项应包括相关 WorkRequest 的 `WorkInfo` 状态、业务 Worker 启动记录和 InputMerger 实例化错误，而不仅是网络请求结果。主链路成功率、兜底上报占比、最老待传文件年龄，也比“今天总共收到了多少日志”更容易暴露类似故障。

这些步骤需要在应用工程及其测试环境执行。本文核对了官方版本说明和 WorkManager 2.8.1 发布源码，不将上述验收建议当作已经完成的线上验证。

## AI 扫描相似风险，人工确认实际使用路径

修复这个入口后，还用 AI 扫描了其他可能受影响的位置，发现一个名为 `InitializationProvider` 的候选项。人工确认该候选在当前应用中已不再使用，因此没有将它作为本次必须修复的运行路径。

这个结论仅适用于本项目里的那个候选类，不能推广到其他项目的同名类，也不能据此认为所有初始化 Provider 都可以忽略。

类似扫描适合寻找“通过类名反射创建对象”和“keep 规则未明确保留所需成员”的交集。人工复核则需要继续确认具体类、合并后的 Manifest、依赖和初始化入口、最终 DEX，以及实际执行证据。只搜索 `Class.forName` 或只检查 Manifest，都无法覆盖全部动态创建路径。

这次问题暴露了两个独立的缺口：构建升级让旧规则里未写明的构造方法依赖显现出来；兜底补传又让主链路失败在总量指标中不够明显。修复 keep 规则恢复的是运行所需成员，而发布后的验收还需要证明正常上传路径恢复，并持续区分事件时间和采集器时间。

## 延伸阅读

- [Android Gradle 与 AGP 9 迁移](/android-gradle-agp-9/)：梳理构建工具升级与验证范围。
- [Android WorkManager 调度机制](/blog/android-workmanager-scheduling/)：理解约束、调度和任务链。
- [Android CI/CD 质量门禁](/blog/android-ci-cd-quality-gates/)：把 Release 产物和关键链路验证纳入发布流程。
