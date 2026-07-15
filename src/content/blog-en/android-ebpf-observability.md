---
title: "Android eBPF for Network Monitoring and Performance Tracing"
lang: en
translationKey: android-ebpf-observability
slug: android-ebpf-observability
excerpt: "An end-to-end look at eBPF on Android, from verified kernel programs to BpfNetMaps and Perfetto-based observability."
publishDate: '2026-06-30'
tags:
- "Android"
- "eBPF"
- "Observability"
- "Perfetto"
seo:
  title: "Android eBPF Observability and Network Monitoring"
  description: "Learn how Android eBPF enables kernel-level network monitoring and performance tracing."
  pageType: article
---

When doing Android network optimization, I encountered a thorny problem: online users reported abnormal power consumption, but the regular `TrafficStats` API can only get the process-level traffic sum - the real-time rate cannot be seen, and it cannot be associated with specific network requests. The team tried `tcpdump` to add post-processing, but the performance overhead was too high to push the full volume. This requirement made me pay attention to a low-key but extremely critical capability in the Android kernel-eBPF.

## What is eBPF and what does it have to do with Android?

eBPF (extended Berkeley Packet Filter) is a tiny sandbox virtual machine running in the Linux kernel. It allows you to inject custom code into the kernel event path for execution without modifying the kernel source code or loading the kernel module.

Android has gradually introduced eBPF support since the 4.9 kernel. After Android 12, eBPF has become the underlying core facility for network monitoring and performance tracking. Different from using eBPF on the server side for load balancing or DDoS defense, eBPF on the Android side mainly solves two problems: zero-overhead network traffic statistics and kernel-level performance event tracking.

The so-called "zero overhead" is relative to upper-level APIs such as `TrafficStats`. `TrafficStats` essentially reads `/proc/net/xt_qtaguid/` records. The data comes from the hook point of netfilter. Each packet must be matched by iptables rules. The traffic is large, and the cost is very considerable.

The idea of ​​eBPF is completely different: sink the observation logic to the kernel event source, directly perform lightweight counting at the hook point where the data packet passes, and then expose the summary results to the user state through the BPF map - an efficient data structure shared between the kernel state and the user state.

## Complete life cycle of BPF program

The BPF program is divided into four steps from writing to mounting.

**Compile. ** BPF programs are written in a restricted subset of the C language and compiled to BPF bytecode via Clang/LLVM. The Android build system has built-in BPF compiler support, and the source code is placed under `system/bpf/`.

**verify. ** The kernel's BPF verifier performs static analysis before loading the program. Check items include: no infinite loop (DAG traversal), no out-of-bounds memory access, and no use of uninitialized variables. Only programs that pass verification will be loaded.

**JIT compilation. ** The verified BPF bytecode is translated by the kernel JIT compiler into native instructions for the current CPU. ARM64 devices are ARM64 instructions, and x86 simulators are x86 instructions. eBPF ultimately runs on bare metal, instead of interpreting and executing bytecodes. This is the root cause of its high performance.

**Mount. ** The program is attached to a kernel event source: tracepoint, kprobe, cgroup hook, XDP, etc. The most commonly used ones in Android are cgroup-level socket filters and tracepoints.

```c
// Simplified BPF example: count cgroup sock-create events.
#include <bpf_helpers.h>

// BPF map definition—the interface userspace reads from.
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
    return 1; // 1 allows the operation rather than blocking it.
}
```

The core behavior of this code: every time the socket creation event is triggered, find the corresponding counter by UID and increment it atomically. The entire logic is executed in kernel mode and does not involve any user mode context switching.

## BpfNetMaps: Core facility for Android network traffic statistics

BpfNetMaps (`BpfNetMaps` module in `netd`) introduced in Android 9 replaces the old xt_qtaguid mechanism. What it does is to mount the BPF program on the critical path of data packets entering and exiting the cgroup, and aggregate the traffic through tags (application tags in Android).

There are two mount points:

- `cgroup/skb_priority` (`cgroupskb`): triggered when a packet enters the socket send queue
- `cgroup/skb_egress`: triggered when the data packet leaves the cgroup and is ready to go through the network stack

Taking egress (upstream) as an example, the core data structure is a BPF map:

```c
// key: {ifindex, tag, uid}, value: {rx_bytes, tx_bytes, rx_packets, tx_packets}
bpf_map_def SEC("maps") stats_map = {
    .type = BPF_MAP_TYPE_HASH,
    .key_size = sizeof(struct stats_key),
    .value_size = sizeof(struct stats_value),
    .max_entries = 10000,
};
```

The BPF processing flow of each package does not exceed 100 instructions. Compared with netfilter, which traverses dozens of rule chains, the efficiency is improved several times.

The user mode regularly calls the `trafficSwapActiveStatsMap()` interface of `netd` through `NetworkStatsService` to atomically read and clear the data in the kernel map and feed it to the upper-layer statistics system. According to actual measurements, when the Gigabit network is fully loaded, the CPU overhead of the BPF path is less than 0.3%, while xt_qtaguid can reach 3-5% under the same conditions.

## Extending from network to performance tracking

After Android 12, performance tracking also uses eBPF as a core data source.

Taking `perfetto` as an example, it supports collecting kernel events through ftrace and eBPF. The problem with ftrace is that each tracepoint trigger must write to the ring buffer. Under high-frequency events (such as `sched_switch`), the buffer will quickly fill up and events will be lost. eBPF can perform aggregation on the kernel side first, and only write the summary to the map, and the user mode can pull it on demand.

One implementation scenario is GPU memory tracing. Android mounts the BPF program on `gpu_mem_total` tracepoint and aggregates GPU memory allocation by process:

```c
SEC("tracepoint/kmem/gpu_mem_total")
int trace_gpu_mem(struct trace_event_raw_gpu_mem *ctx) {
    uint32_t pid = bpf_get_current_pid_tgid() >> 32;
    // Update total_gpu_kb in the map for this pid.
    // ...
}
```

Compared with the previous use of `procrank` or polling `/proc`, this method does not interfere with the memory behavior of the application under test during acquisition.

## Pitfalls and trade-offs experienced

In actual engineering, Android eBPF has several hard constraints that cannot be circumvented.

**The number of instructions in a BPF program has an upper limit. ** The early kernel limit was 4096 instructions, and newer kernels relaxed it to 1 million. However, the Android universal kernel is still conservative in order to take into account compatibility. The program logic should not be too complex, and complex logic should be handled in user mode.

**map size is fixed. ** The `stats_map` of `BpfNetMaps` defaults to 10000 records, which is generally sufficient for hundreds of applications running simultaneously. But in the event of a short connection storm - a large number of temporary sockets are quickly created and destroyed - the map may be filled up. Android 14 introduces the map type with LRU elimination strategy to alleviate this problem.

**eBPF cannot block packets. ** This is a key difference between Android and traditional network scenarios. Under the Android security model, the return value of the BPF program is `1` (allow) or `0` (drop), but there are almost no scenarios on C-side devices that require packet loss in the kernel. Android only uses eBPF for observation, not control.

My take: Don't try to replace all existing monitoring solutions with eBPF. Its advantages in high-frequency counting and kernel event aggregation are overwhelming, but complex business logic and long-tail data storage should still be completed in user mode. Understand eBPF as the "intelligent pre-aggregation layer" between the kernel and user mode - if the scenario is used correctly, the effect will be far better than traditional methods.
