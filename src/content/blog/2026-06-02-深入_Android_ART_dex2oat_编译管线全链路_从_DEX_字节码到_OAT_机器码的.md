---
title: 深入 Android ART dex2oat 编译管线：从 DEX 字节码到 OAT 机器码的 AOT/JIT 混合编译
excerpt: 系统梳理 dex2oat 编译管线的完整流程，解析 Compiler Filter 各档位取舍、JIT 与 AOT 的协同机制，以及如何用 Baseline Profile 精准引导编译来压缩 App 冷启动耗时。
publishDate: '2026-06-02'
tags:
- Android
- ART
- dex2oat
- 性能优化
- AOT/JIT
seo:
  title: 深入 Android ART dex2oat 编译管线：从 DEX 字节码到 OAT 机器码的 AOT/JIT 混合编译
  description: 详解 dex2oat 编译管线、Compiler Filter 各档策略、JIT 与 AOT 混合编译协同机制及 Baseline Profile 实践，助你有效压缩 Android App 冷启动耗时。
---

做性能优化时，有个数据让我困惑了很久：同一个 APK，Play Store 下载安装的冷启动比 adb install 快了近 40%。排查后发现，差异就出在 dex2oat 的编译策略上。

## dex2oat 到底做了什么

安装 APK 时，系统拉起 `dex2oat`，把 DEX 字节码编译成 OAT 文件。整条编译管线如下：

```
DEX → dex2oat 前端解析 → HGraph IR 中间表示 → 
优化 Pass 流水线 → LIR 低级中间表示 → 
寄存器分配 → 机器码生成 → OAT 文件打包
```

前端解析负责把 DEX 里的 smali 风格指令转成 ART 内部的 HGraph——一种 SSA 形式的 IR。这阶段会做方法内联判断和虚调用去虚拟化尝试。

优化流水线内置了 20+ 个 Pass：死代码消除、循环优化、常量折叠、边界检查消除等。执行哪些 Pass，取决于 Compiler Filter 配置，这也是编译耗时的大头。

代码生成阶段，LIR 经线性扫描算法做寄存器分配后，编码为目标架构指令（ARM64 或 x86_64），写入 `.oat` 文件。

生成的 OAT 文件位于 `/data/app/<package>/oat/arm64/base.odex`，和 APK 同目录。系统加载时直接 mmap 这个文件，跳过解释执行。

## Compiler Filter：取舍而非银弹

Compiler Filter 控制 dex2oat 编译到什么程度。常用几档：

```bash
# 安装时指定编译策略
adb install --fastdeploy app.apk          # 相当于 speed-profile
pm compile -m speed-profile <package>      # 运行时重编译
```

| Filter | 行为 | OAT 大小 | 安装耗时 |
|--------|------|----------|----------|
| verify | 只做验证，不编译 | 最小 | 最快 |
| quicken | 生成 JNI 桩，仍靠解释器 | 小 | 快 |
| speed-profile | 按 Profile 引导编译 | 中等 | 中等 |
| speed | 全量 AOT 编译所有方法 | 大 | 慢 |
| everything | speed + 全量调试信息 | 最大 | 最慢 |

verify 和 quicken 几乎不生成机器码，执行时全靠解释器或 JIT 兜底，适合系统分区里运行频率极低的代码。

speed-profile 是 Play Store 默认策略，只编译 Profile 文件标记为 "hot" 的方法。安装快、文件小，但未标记的方法首次执行要走 JIT。

speed 是全量 AOT，所有方法提前编译。冷启动快、一致性高，代价是安装慢、OAT 体积可能翻倍。国内很多 ROM 喜欢开机时用 speed 全量编译，用户感知到的就是安装等待时间长。

实际踩过的坑：8MB 的 DEX 文件，用 speed 全量编译后 OAT 膨胀到 23MB。对存储敏感的机型来说，IO 开销可能抵消编译带来的启动收益。

## JIT 如何反哺 AOT

ART 的混合编译模型里，JIT 和 AOT 是协同关系，不是对立关系：

```
方法首次执行 → 解释器执行
         ↓ 达到热度阈值（通常几千次调用）
    JIT 编译 → 存入 JIT Code Cache
         ↓ 后台线程触发 JIT GC
    导出 Profile 信息（热点方法名）
         ↓ 下次 dex2oat 执行
    AOT 编译这些热点方法
```

JIT 编译出的代码会记录方法名和热度统计，定期写入 Profile 文件。这个文件就是 dex2oat 执行 speed-profile 编译的依据。

关键数据流：

- JIT Code Cache 大小有限（默认 64MB），满了触发 GC
- Profile 信息写入 `/data/misc/profiles/ref/<pkg>/primary.prof`
- 系统在 idle 维护窗口自动执行 `bg-dexopt`，读取 Profile 做 AOT

App 用得越久，高频方法就越早被 AOT 编译，冷启动会逐步改善。这就是 JIT → AOT 协同带来的「越用越快」。

## Baseline Profile：不必等 JIT 慢慢攒

如果 JIT 需要时间积累才能引导 AOT，新安装的 App 怎么办？

答案是用 Baseline Profile。它是一个预定义的 `baseline.prof` 文件，打包在 APK 的 `assets/dexopt/` 目录下，声明启动路径上的关键方法。这个概念从 Android 9 的 Cloud Profiles 开始演进，到 Android 13 之后底层机制才真正稳定可用。

```bash
# 生成 Baseline Profile 的流程
# 1. 运行 App 并采集启动路径
adb shell cmd package compile -m speed-profile -f \
  --base-apk /data/app/<pkg>/base.apk <pkg>

# 2. 提取 Profile
adb pull /data/misc/profiles/ref/<pkg>/primary.prof
```

Profile 文件本质是方法签名列表。dex2oat 处理时把列表中的方法编译成机器码，未标记的方法继续解释或 JIT 执行。

Google 的数据显示，引入 Baseline Profile 后 Play Store App 冷启动平均快了 15%-30%。但前提是 Profile 要精准——如果把实际不热的代码放进基线文件，只会浪费 OAT 空间。

我在项目里用 Macrobenchmark 跑启动测试，自动生成 `baseline-prof.txt`，CI 直接打包进 APK。人肉维护 Profile 不现实，方法签名动辄几百行，改几行代码就可能失效。

## 三个可落地的实践

**选对 Compiler Filter。** 线上分发的 App，speed-profile 配 Baseline Profile 是最优组合。不要迷信全量 AOT——OAT 膨胀带来的 IO 开销往往抵消编译收益。国内某些厂商的「全量编译优化」在 128GB 以下机型上，存储空间先到瓶颈。

**Profile 稳定性优先。** Baseline Profile 的目标不是追求覆盖所有方法，而是精准覆盖启动路径。维护时关注「掉出 Profile 的方法比率」，这个指标比覆盖率本身更有参考价值。

**监控 bg-dexopt 的执行时机。** 系统在充电 + idle 时触发后台 AOT 编译，但如果用户在低电量时频繁使用 App，JIT Code Cache 会频繁 GC，拖慢热路径执行。必要时用 `pm compile` 手动触发重编译，让 AOT 尽早覆盖高频方法。

Android Runtime 的编译体系已经不是几年前那个简单的「DEX 转机器码」了。理解 JIT 和 AOT 的协同节奏、善用 Profile 精准引导编译，才是压缩启动耗时的杠杆点。
