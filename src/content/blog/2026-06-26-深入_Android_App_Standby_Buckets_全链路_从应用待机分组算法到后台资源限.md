---
slug: android-app-standby-buckets
translationKey: android-app-standby-buckets
title: 深入 Android App Standby Buckets 全链路：从应用待机分组算法到后台资源限制梯度的省电调度机制
excerpt: 深入解析 Android App Standby Buckets 分桶机制，涵盖加权时间衰减分桶算法、JobScheduler/AlarmManager/网络的三维资源限制梯度，以及开发者降级适配策略。
publishDate: '2026-06-26'
tags:
- Android
- App Standby Buckets
- 后台任务调度
- 省电优化
- JobScheduler
seo:
  title: Android App Standby Buckets：待机分组与后台资源限制
  description: 详解 Android App Standby Buckets 从分桶算法到后台资源限制的完整链路，帮助开发者理解省电调度机制并制定降级适配策略。
  pageType: article
---

## 一个"幽灵般"的后台任务延迟

去年排查一个线上问题时，某用户的 JobService 延迟了 6 小时才执行。同样的代码在另一台设备上运行正常，日志也无报错。跟了三天，最后定位到原因——那台设备上，系统把应用打入了「Rare」待机桶，JobScheduler 的最小延迟被强制拉长到了 24 小时。

问题根源不在代码，在 Android 9 引入的 App Standby Buckets 机制。它不是边缘优化策略——自 Android 11 起，它是所有后台任务调度绕不开的约束层。

## 分桶模型：五个等级的资源配额

Android 根据用户对应用的使用频率，将每个应用动态分配到一个待机桶中。桶的等级直接决定应用能获得多少后台资源：

```text
Active (活跃)        → 正在前台使用，几乎无限制
Working Set (工作集)  → 频繁使用，轻微限制
Frequent (常用)      → 定期使用，中等限制
Rare (较少使用)      → 很少使用，严格限制
Restricted (受限)    → 从未使用或手动限制，后台几乎冻结
```

用户越少打开的应用，系统给的后台配额越少。这是省电策略从粗粒度一刀切转向基于使用行为精细调度的关键变化。官方文档对各桶的定义已经很详细，这里不再重复。重点看两件事：**系统怎么判定你的应用落入哪个桶**，以及**每个桶具体限制了什么**。

## 分桶算法：系统如何判定应用的"热度"

### 信号采集与时间戳

系统依据以下交互事件的时间戳做判定，数据记录在 `UsageStatsManager` 数据集中：

- 应用被启动（Launcher 点击、Intent 唤起）
- 用户与前台 Activity 产生交互
- 用户点击了该应用发出的通知
- 应用出现在「最近任务」视图中并被查看

这些事件按应用聚合后，输入一个**加权时间衰减模型**进行评分。

### 衰减模型的核心逻辑

系统不是简单统计"最近 N 天打开了几次"。每次交互事件按发生时间做指数衰减加权——昨天的启动权重远高于一周前的，超过约 45 天的事件几乎不贡献有效权重。

衰减函数未在文档中公开，但从 AOSP 中 `AppIdleHistory` 类的实现可以推断：系统维护了一个基于时间桶的事件计数矩阵，越近的时间桶权重越大。

用 `UsageStatsManager.queryEvents()` 可以在本地做近似推算：

```kotlin
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
val endTime = System.currentTimeMillis()
val beginTime = endTime - 45 * 24 * 60 * 60 * 1000L

val events = usm.queryEvents(beginTime, endTime)
val appEvents = events.filter { it.packageName == packageName }
// 自行按时间衰减计算权重，估算系统分桶倾向
```

系统拿到的数据比你更全——它还会综合设备充电状态、Doze 模式活跃周期等因素微调分桶结果。

### Adaptive Bucket：ML 辅助预测

Android 11 引入「自适应分桶（Adaptive Bucket）」。设备端运行轻量预测模型，基于历史使用模式推断用户接下来可能打开哪些应用，提前将其提升到更高桶位。

这解释了开发者经常遇到的一种情况：明明好几周没用某个应用，它的 Job 却还是跑得挺快——可能被预测模型提前拉升了。模型逻辑在系统服务层闭源运行，开发者无法干预，但至少说明分桶不是纯机械的时间统计。

## 限制梯度：三个维度的资源打压

分桶结果直接映射到对三大资源维度的限制。

### JobScheduler / WorkManager：不是“延迟”，是“执行时长配额”

这是受影响最广的限制，但常见的误解是把它想象成“任务被延迟多久才执行”。官方文档给出的实际机制是**滚动时间窗口内的可执行时长配额**——桶位越低，允许你的 Job 唤醒设备、占用 CPU 的总时长越少，而不是给任务加一个固定的最小延迟。WorkManager 的周期性/持久化任务底层走 JobScheduler，同样受这个配额约束。

以下是 Android 官方文档给出的近似配额（数值可能随系统版本调整，不构成保证）：

| 桶 | 常规 Job 配额 | 加急 Job（Expedited）配额 | 网络访问 |
|---|---|---|---|
| Active | 60 分钟窗口内最多约 20 分钟 | 24 小时窗口内最多约 30 分钟 | 无限制 |
| Working Set | 4 小时窗口内最多约 10 分钟 | 24 小时窗口内最多约 15 分钟 | 无限制 |
| Frequent | 12 小时窗口内最多约 10 分钟 | 24 小时窗口内最多约 10 分钟 | 无限制 |
| Rare | 24 小时窗口内最多约 10 分钟 | 24 小时窗口内最多约 10 分钟 | 禁用（后台网络访问被切断） |
| Restricted | 每天一次、单次最多约 10 分钟的批量执行窗口 | 24 小时窗口内最多约 5 分钟 | 禁用 |

几个容易被误解的细节：

- Restricted 桶不是“几乎不执行”，而是每天允许一次批量执行窗口，且**该窗口里的 Job 不能单独跑**——必须和至少一个其他 Job 同时处于运行或等待状态，系统才会触发这次批处理。
- 设备充电时，除 Restricted 桶外，其他桶基本不受执行时长限制；屏幕熄灭且进入 Doze 时，执行还会被推迟到 Doze 的维护窗口。也就是说实际生效的限制是“桶位配额”和“设备状态限制”两者中更严格的那个，而不是桶位单独决定一切。
- 用户手动把应用设为“不受限制”或应用正在前台/持有前台服务时，会豁免大部分桶位配额限制。

### AlarmManager 的频次限制

低桶位对 `setExact()` / `setWindow()` / `setExactAndAllowWhileIdle()` 等闹钟 API 施加**频次上限**（同样以近似值为准，具体以官方文档为准）：

- Working Set：每小时最多约 10 次
- Frequent：每小时最多约 2 次
- Rare：每小时最多约 1 次
- Restricted：每天最多 1 次（可以是精确闹钟或非精确闹钟）

如果你的应用依赖精确闹钟做数据同步，在 Rare 和 Restricted 桶里这类方案基本失效，需要设计降级路径。

### 网络与 FCM

Rare 和 Restricted 桶都会禁用应用的后台网络访问，不是只有 Restricted 才受影响。

FCM 高优先级消息方面需要注意一个版本变化：**Android 13 起，待机桶不再决定应用能使用多少条高优先级 FCM 消息**——之前“待机桶限制每天高优先级 FCM 条数”的说法已经过时。取而代之的是，如果系统检测到应用持续发送高优先级消息却不据此展示通知，会主动降级该应用后续消息的优先级。因此更准确的建议是：收到高优先级 FCM 消息时务必展示通知，而不是纠结“每天配额是多少”。

## 查询与调试：知道自己在哪个桶

### 运行时查询当前桶位

```kotlin
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
when (usm.appStandbyBucket) {
    UsageStatsManager.STANDBY_BUCKET_ACTIVE -> { /* 全速执行 */ }
    UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> { /* 适当降频 */ }
    UsageStatsManager.STANDBY_BUCKET_FREQUENT -> { /* 合并批次 */ }
    UsageStatsManager.STANDBY_BUCKET_RARE -> { /* 只做最小必要工作 */ }
    UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> { /* 放弃后台任务 */ }
}
```

### adb 手动干预

```bash
# 查看当前桶
adb shell am get-standby-bucket com.example.app

# 强制设置（10=Active, 20=Working Set, 30=Frequent, 40=Rare, 45=Restricted）
adb shell am set-standby-bucket com.example.app rare

# 恢复系统自动分桶
adb shell am set-standby-bucket com.example.app reset
```

`set-standby-bucket` 在用户版本设备上通常被禁用，需要在开发者选项中授权。更实用的调试手段是 `adb shell dumpsys usagestats`——它输出完整的桶分配历史和事件日志，信息量比 `am get-standby-bucket` 大得多。

### 一个易忽略的行为特征

系统在桶位变化时会发送 `ACTION_STANDBY_BUCKET_CHANGED` 广播，但**桶位下降的广播不会唤醒你的进程**。你只能在应用运行期间检查当前状态来决定当次任务的执行策略——不能在广播接收器中"被动应对"降级。

## 适配思路：设计降级执行，而非拒绝执行

团队做省电适配时，踩过一个坑：判断桶位太低就直接 return 什么都不做。这从产品角度看很糟糕——用户偶尔打开你的应用，发现数据全是旧的。

更合理的策略是**按桶位做梯度降级**：

```kotlin
fun scheduleSync(bucket: Int) {
    when (bucket) {
        STANDBY_BUCKET_ACTIVE ->
            WorkManager.enqueuePeriodicSync(minutes = 15)
        STANDBY_BUCKET_WORKING_SET ->
            WorkManager.enqueuePeriodicSync(minutes = 120)
        STANDBY_BUCKET_FREQUENT ->
            WorkManager.enqueueDailySync()
        STANDBY_BUCKET_RARE ->
            WorkManager.enqueueOnChargeOrAppOpen()
        else -> { /* Restricted：等用户打开应用再拉取 */ }
    }
}
```

WorkManager 内部已对分桶做了部分适配，但不要完全依赖它的默认行为——结合自身业务逻辑显式判断比黑盒信任更可控。

对于重度依赖推送的应用，FCM 高优先级消息（`priority=high`）会在发送时将应用临时提升至 Active 桶，但 Android 12+ 限制了频次，每天约 20 次。超过限制后消息降级，延迟不可控。如果业务确实需要实时触达，最稳妥的方式是引导用户在「电池优化」设置中将你的应用设为"不优化"。

**不受待机分桶限制的豁免场景**：应用前台运行、持有前台服务（仍受部分限制，但更宽松）、设备充电中（Restricted 桶外基本不受执行限制）、用户在系统设置中将应用设为“不受限制”。此外还有一批系统级豁免名单（如伴生设备应用、设备/资料 owner 应用、VPN 应用、默认拨号应用、拥有 `USE_EXACT_ALARM` 或 `ACCESS_BACKGROUND_LOCATION` 权限的应用等）可以绕过 Restricted 桶的自动降级触发条件。但前台服务从 Android 14 开始强制要求通知栏可见，不能作为隐蔽的后台保活手段。

## 演变轨迹与设计心态

从 Android 6 的 Doze 模式往回看，省电策略的演进是一条清晰的收紧线：

- **Doze（Android 6）**：粗暴冻结后台，不分应用
- **Standby Buckets（Android 9）**：引入分桶概念和差异化限制
- **Restricted 桶（Android 11）**：增加第五级，对"僵尸应用"极限打压
- **Android 12+**：持续收紧低桶位的时间限制和网络策略

这套机制的方向很明确：把更多后台资源集中给用户真正在用的应用，代价转嫁给了开发者——你不能假设后台任务总能按时跑完（具体的省电幅度官方没有给出可引用的量化数字，不同设备和使用场景差异也很大，这里不做具体百分比的断言）。

在设计之初就**假设自己的应用在 Rare 桶里运行**，然后为更高级桶做"功能增强"，而非为低级桶做"功能裁减"。这种反向设计能避免上线后发现后台逻辑大面积静默失效的尴尬。调试时善用 `dumpsys usagestats`，它比 API 查询暴露的系统内部状态丰富得多。
