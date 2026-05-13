---
title: Android 进程保活与资源调度深度解析：从 OOM Adj 评分机制到 LMK 低内存裁决的系统级博弈
excerpt: 深度解析 Android OOM Adj 评分机制与 LMK 从内核轮询到用户态 lmkd 再到 Cgroup 内存隔离的三次演进，提供前台 Service、WorkManager 加急任务、内存自省等保活实战策略。
publishDate: '2026-05-09'
tags:
- Android
- 进程保活
- 内存管理
- LMK
- 性能优化
seo:
  title: Android 进程保活与资源调度深度解析：从 OOM Adj 评分机制到 LMK 低内存裁决的系统级博弈
  description: 从 OOM Adj 评分到 LMK 三次演进，详解 Android 进程保活机制与系统资源调度的博弈。提供前台 Service 合规用法、WorkManager 加急任务、内存自省等实战策略。
---

两年前做 ROM 适配，测试组反馈了一个诡异问题：我们的输入法在华为机型上切后台 3 秒就被杀，某竞品能活 10 分钟。排查到最后，问题不在代码，而在 **OOM Adj（Out-Of-Memory Adjustment）**——一个由 AMS 核算、LMK 执行的数值，决定了你的进程什么时候被"处决"。

## OOM Adj：进程的"死刑优先级"

Android 给每个进程分配一个 OOM Adj 值，范围 `-1000` 到 `1001`。数值越大，内存紧张时越优先被回收。

```text
FOREGROUND_APP_ADJ        = 0    // 前台应用
VISIBLE_APP_ADJ           = 100  // 可见但非前台
PERCEPTIBLE_APP_ADJ       = 200  // 可感知（如后台播音乐）
PREVIOUS_APP_ADJ          = 700  // 上一个前台应用
HOME_APP_ADJ              = 600  // Launcher
SERVICE_ADJ               = 500  // 活跃 Service
CACHED_APP_MIN_ADJ        = 900  // 不可见缓存进程
CACHED_APP_MAX_ADJ        = 906  // 缓存进程天花板
```

这些值在 AMS 的 `updateOomAdjLocked()` 中动态计算，每次进程状态变化都会触发重新评定。计算因子包括四大组件状态、前台交互、Service 绑定关系等数十项。

关键规则：一个进程的 OOM Adj 取的是该进程中所有组件计算出的**最小值**。只要你的进程里有一个前台 Service，整个进程就按前台优先级对待。

## LMK 的三次进化

早期 Android 直接使用内核的 LMK（Low Memory Killer）驱动，读取 `/sys/module/lowmemorykiller/parameters/minfree` 中配置的内存阈值，按 Adj 从高到低杀进程。这是个轮询式被动驱逐：内存低于阈值时触发，遍历进程链表，计算 `oom_score`，找最高分进程 kill。

```bash
# 查看内核 LMK 阈值配置（单位：页面数）
cat /sys/module/lowmemorykiller/parameters/minfree
# 18432,23040,27648,32256,55296,80640
```

做系统定制时我踩过一个坑：把第三个阈值对应的 CACHED_APP 过滤值调得太激进，用户切出 App 后立刻被杀，体验极差。LMK 参数不能拍脑袋定，需要基于实际内存分布做灰度调优。

### 第一跳：从内核 LMK 到用户态 lmkd

Android 10 起，LMK 逻辑从内核空间迁移到用户态的 `lmkd` 守护进程。

内核 LMK 用的是硬编码的 `oom_score_adj` 线性映射，完全不感知 Android 框架层的进程状态语义。用户态 lmkd 可以直接从 AMS 拿到进程的 OOM Adj，决策更智能——优先回收大内存进程、权重化评分、分级触发。

更有用的是 **psi（Pressure Stall Information）** 监控：lmkd 通过读取 `/proc/pressure/memory` 实时感知内存压力，不再依赖静态水位线。内核追踪的是"最近一段时间内因内存不足被阻塞的任务比例"。

```bash
cat /proc/pressure/memory
# some avg10=5.23 avg60=2.17 avg300=0.85 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

`some` 行反映至少部分任务在等待内存，`full` 行反映所有任务都在等待。lmkd 根据 `avg10` 决定触发级别：轻度压力先回收 Adj≥900 的缓存进程，中度压力下探到 Service 层，重度压力才动前台。

### 第二跳：Cgroup 内存隔离

Android 12 引入了 Cgroup v2 内存控制器。进程不再是一人一条命一个得分，而是被分入不同的层级 group，每个 group 有独立的 `memory.max` 和 `memory.high` 限制。

```text
/system/
  └─ uid_1000/
       ├─ foreground/    ← 前台进程组，内存上限宽松
       └─ background/    ← 后台进程组，严格限制
```

这意味着即使你的进程 OOM Adj 只有 0，如果所属的 background cgroup 整体超限，cgroup 的 OOM Killer 照样动手。**OOM Adj 不再是唯一裁判。**

## 保活博弈：道高一尺，魔高一丈

Android 早期保活手段五花八门：双进程守护、一像素 Activity、前台透明悬浮窗、JNI 端口占用——本质都是在**欺骗 AMS 的 OOM Adj 计算**，给进程刷一个低分值。

Android 8.0 后 Google 逐步收紧：`startService()` 加后台限制、前台 Service 必须挂通知、后台进程不能任意启动 Activity。到 Android 14，后台进程启动前台 Service 甚至需要特定权限。

字节跳动在 InfoQ 上分享过一种做法：放弃硬保活，转向"弹性降级"。进程被回收后，WorkManager 在合适窗口重新拉起最小化任务。核心思路从"别杀我"变成"杀了我还能活"。

我认同这个方向。硬保活本质是在对抗系统的内存调度策略，短期内能"赢"，但 iOS 和 Android 的封闭趋势会让这种对抗越来越难。把精力放在冷启动速度和状态恢复上，比研究黑科技更划算。

## 实战：三个可以用的策略

**前台 Service 的合规用法。** 如果 App 确实需要后台持续运行——比如地图导航、运动记录——用 `foregroundServiceType` 声明具体类型：

```xml
<service
    android:foregroundServiceType="location|health"
    android:name=".TrackService" />
```

Android 14 后系统会校验声明类型与实际行为是否一致，挂羊头卖狗肉的 Service 会被直接 kill。

**WorkManager 的 Expedited Work。** 对于必须在 10 分钟内完成的后台任务，加急工作请求会临时提升进程优先级：

```kotlin
val request = OneTimeWorkRequestBuilder<SyncWorker>()
    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    .build()
WorkManager.getInstance(context).enqueue(request)
```

加急工作在电池优化状态下仍会被系统限流，`OutOfQuotaPolicy` 控制超配额后的回退策略。

**内存的自省机制。** 与其研究怎么不被杀，不如研究自己的内存占用。`ActivityManager.getProcessMemoryInfo()` 取 PSS 数据，`Debug.getNativeHeapAllocatedSize()` 监控 Native 层泄漏。我排查过一个 Native 泄漏，罪魁祸首是 Bitmap 在 Android 8.0 之前的未回收问题——现在 Bitmap 内存进 Java Heap 了，但 Native 库的泄漏仍然是杀进程的重灾区。

当内存上升到阈值时主动降级：清 Glide 缓存、释放非关键 View、通知用户。LMK 在 900 分砍你之前，你已经自己砍了一刀。

---

OOM Adj 和 LMK 这套机制，本质是 Android 在有限物理内存和无限 App 需求之间做资源配置。理解它，不是为了对抗它，而是跟它协作：该降级的时候主动降级，该被回收的时候从容重来。
