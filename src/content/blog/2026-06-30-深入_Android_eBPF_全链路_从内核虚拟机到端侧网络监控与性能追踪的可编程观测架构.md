---
title: 深入 Android eBPF 全链路：从内核虚拟机到端侧网络监控与性能追踪的可编程观测架构
slug: android-ebpf-observability
translationKey: android-ebpf-observability
excerpt: 深入解析 Android 端 eBPF 架构：从 BPF 程序编译验证到 BpfNetMaps 网络流量统计，再延伸到 perfetto 性能追踪，揭示端侧可编程观测的内核级实现原理与工程取舍。
publishDate: '2026-06-30'
tags:
- Android
- eBPF
- 网络监控
- 性能优化
- Linux 内核
seo:
  title: 深入 Android eBPF 全链路：从内核虚拟机到端侧网络监控与性能追踪的可编程观测架构
  description: 本文深入解析 Android eBPF 全链路架构，涵盖 BPF 程序生命周期、BpfNetMaps 网络流量统计、perfetto 性能追踪，以及工程实践中的约束与取舍。
---

做 Android 网络优化时，我遇到了一个棘手的问题：线上用户反馈耗电异常，但常规的 `TrafficStats` API 只能拿到进程级流量总和——看不到实时速率，也关联不到具体网络请求。团队试过 `tcpdump` 加后处理，性能开销大到不敢推全量。这个需求让我开始关注 Android 内核里一个低调但极为关键的能力——eBPF。

## eBPF 到底是什么，和 Android 有什么关系

eBPF（extended Berkeley Packet Filter）是一个运行在 Linux 内核中的微型沙箱虚拟机。它允许你在不修改内核源码、不加载内核模块的前提下，把自定义代码注入内核事件路径中执行。

Android 从 4.9 内核开始逐步引入 eBPF 支持，到 Android 12 之后，eBPF 已经成为网络监控和性能追踪的底层核心设施。和服务端用 eBPF 做负载均衡或 DDoS 防御不同，Android 端的 eBPF 主要解决两个问题：零开销的网络流量统计，以及内核级性能事件追踪。

所谓"零开销"，是相对于 `TrafficStats` 这类上层 API 而言的。`TrafficStats` 本质上是读取 `/proc/net/xt_qtaguid/` 记录，数据来自 netfilter 的 hook 点，每条包都要经过 iptables 规则匹配。流量一大，这个开销非常可观。

eBPF 的思路完全不同：把观测逻辑下沉到内核事件源，在数据包经过的 hook 点直接执行轻量级计数，然后通过 BPF map——一种内核态与用户态共享的高效数据结构——把汇总结果暴露给用户态。

## BPF 程序的完整生命周期

BPF 程序从编写到挂载，分四步走。

**编译。** BPF 程序用 C 语言的一个受限子集编写，通过 Clang/LLVM 编译为 BPF 字节码。Android 构建系统内置了 BPF 编译器支持，源码放在 `system/bpf/` 下。

**验证。** 内核的 BPF verifier 在加载程序前做静态分析，检查项包括：无死循环（DAG 遍历）、无越界内存访问、无未初始化变量使用。只有验证通过的程序才会被加载。

**JIT 编译。** 验证后的 BPF 字节码通过内核 JIT 编译器翻译为当前 CPU 的原生指令。ARM64 设备上就是 ARM64 指令，x86 模拟器上就是 x86 指令——eBPF 最终跑在裸金属上，不是解释执行字节码，这是它高性能的根因。

**挂载。** 程序被 attach 到某个内核事件源：tracepoint、kprobe、cgroup hook、XDP 等。Android 中最常用的是 cgroup 级别的 socket filter 和 tracepoint。

```c
// 一个简化的 BPF 程序示例：在 cgroup 的 sock create 事件中计数
#include <bpf_helpers.h>

// BPF map 定义——这是用户态读取数据的接口
bpf_map_def SEC("maps") socket_create_counter = {
    .type = BPF_MAP_TYPE_PERCPU_HASH,
    .key_size = sizeof(uint32_t),
    .value_size = sizeof(uint64_t),
    .max_entries = 1024,
};

SEC("cgroup/sock_create")
int count_sock_create(struct bpf_sock *ctx) {
    uint32_t uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    uint64_t *val = bpf_map_lookup_elem(&socket_create_counter, &uid);
    if (val) {
        __sync_fetch_and_add(val, 1);
    }
    return 1; // 1 表示允许操作，不阻断
}
```

这段代码的核心行为：每次 socket 创建事件触发时，按 UID 查找对应的计数器并原子递增。整个逻辑在内核态执行，不涉及任何用户态上下文切换。

## BpfNetMaps：Android 网络流量统计的核心设施

Android 9 引入的 BpfNetMaps（`netd` 中的 `BpfNetMaps` 模块）替代了老旧的 xt_qtaguid 机制。它的做法是在数据包进出 cgroup 的关键路径上挂载 BPF 程序，通过 tag（Android 中的应用标记）聚合流量。

挂载点有两个：

- `cgroup/skb_priority`（`cgroupskb`）：数据包进入 socket 发送队列时触发
- `cgroup/skb_egress`：数据包离开 cgroup 准备走网络栈时触发

以 egress（上行）为例，核心数据结构是一张 BPF map：

```c
// key: {ifindex, tag, uid}, value: {rx_bytes, tx_bytes, rx_packets, tx_packets}
bpf_map_def SEC("maps") stats_map = {
    .type = BPF_MAP_TYPE_HASH,
    .key_size = sizeof(struct stats_key),
    .value_size = sizeof(struct stats_value),
    .max_entries = 10000,
};
```

每条包的 BPF 处理流程不超过 100 条指令。对比 netfilter 遍历几十条规则链，效率提升了数倍。

用户态通过 `NetworkStatsService` 定期调用 `netd` 的 `trafficSwapActiveStatsMap()` 接口，把内核 map 中的数据原子性地读出并清空，喂给上层统计系统。实测在千兆网络满载时，BPF 路径的 CPU 开销不到 0.3%，而 xt_qtaguid 在同等条件下能达到 3-5%。

## 从网络延伸到性能追踪

Android 12 之后，性能追踪也把 eBPF 作为一个核心数据源。

以 `perfetto` 为例，它支持通过 ftrace 和 eBPF 两种方式采集内核事件。ftrace 的问题在于：每个 tracepoint 触发都要写 ring buffer，高频事件（如 `sched_switch`）下会迅速打满 buffer 导致丢事件。eBPF 可以在内核侧先做聚合，只把摘要写入 map，用户态按需拉取。

一个落地场景是 GPU 内存追踪。Android 在 `gpu_mem_total` tracepoint 上挂载 BPF 程序，按进程聚合 GPU 内存分配量：

```c
SEC("tracepoint/kmem/gpu_mem_total")
int trace_gpu_mem(struct trace_event_raw_gpu_mem *ctx) {
    uint32_t pid = bpf_get_current_pid_tgid() >> 32;
    // 按 pid 更新 map 中的 total_gpu_kb
    // ...
}
```

和以前用 `procrank` 或轮询 `/proc` 相比，这种方式不会在采集时干扰被测应用的内存行为。

## 踩过的坑与取舍

在实际工程中，Android eBPF 有几个硬约束绕不开。

**BPF 程序的指令数有上限。** 早期内核限制 4096 条指令，较新内核放宽到 100 万条，但 Android 通用内核为兼顾兼容性，实际仍然保守。程序逻辑不能太复杂，复杂逻辑拆到用户态处理。

**map 大小是固定的。** `BpfNetMaps` 的 `stats_map` 默认 10000 条记录，对几百个同时运行的应用一般够用。但遇上短连接风暴——大量临时 socket 快速创建销毁——map 可能被填满。Android 14 引入了 LRU 淘汰策略的 map 类型来缓解这个问题。

**eBPF 不能阻断数据包。** 这是 Android 和传统网络场景的关键区别。在 Android 安全模型下，BPF 程序的返回值是 `1`（允许）或 `0`（丢弃），但 C 端设备上几乎没有场景需要在内核里丢包。Android 只把 eBPF 用于观测，不用于控制。

我的看法是：不要试图用 eBPF 替换所有现有监控方案。它在高频计数和内核事件聚合上的优势是压倒性的，但复杂业务逻辑和长尾数据存储仍然应该在用户态完成。把 eBPF 理解成内核与用户态之间的"智能预聚合层"——场景用对了，效果远超传统手段。
