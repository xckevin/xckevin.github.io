---
title: 深入 Android OTA 系统更新全链路：从 A/B 分区到 Virtual A/B 快照
excerpt: 深入剖析 Android OTA 系统更新全链路，涵盖 A/B 无缝更新、update_engine 增量差分机制、回滚保护、动态分区及 Virtual A/B 快照技术，并结合实战命令梳理排查思路。
publishDate: '2026-03-11'
tags:
- Android
- OTA
- 增量更新
- Virtual A/B
- A/B无缝更新
seo:
  title: 深入 Android OTA 系统更新全链路：从 A/B 分区到 Virtual A/B 快照
  description: 从 A/B 分区、update_engine 增量差分到 Virtual A/B 快照，全面解析 Android OTA 系统更新架构演进与实战排查方法。
---

## A/B 无缝更新的设计初衷

2016 年 Android 7.0 引入 A/B 无缝更新。目的很直接：OTA 不应该让用户感知到。传统 Recovery 模式那套流程——重启、进刷机界面、盯着进度条等几分钟——体验实在说不过去。

A/B 方案把系统分区做成两套，slot A 和 slot B。当前跑在 slot A 时，更新包直接写入 slot B，重启后切过去就完事。启动失败则自动退回 slot A。这套机制依赖两个核心组件：**bootctrl HAL** 标记启动槽位，**update_engine** 守护进程负责下载和写入更新包。

代价也很实在：双倍分区直接腰斩可用存储。一个 3GB 的 system 分区搞两套就是 6GB，低端设备根本扛不住。动态分区和 Virtual A/B 两大方案正是被这个痛点逼出来的。

## update_engine 增量更新的四个阶段

update_engine 源码在 `system/update_engine`，是整个 OTA 的执行引擎。

### 获取更新元数据

客户端向 OTA 服务端请求更新信息，拿到 payload 的 SHA256、大小和下载地址：

```json
{
  "url": "https://ota.example.com/payload.bin",
  "size": 156000000,
  "metadata_signature": "MEUCIQD...",
  "hash": "a3f8b2c1..."
}
```

update_engine 先校验元数据签名，确保来源可信，然后进入下载阶段。

### 差分下载与流式写入

增量包只含新旧版本之间的差异数据，体积通常比全量缩小 60%-80%。差分算法采用 **puffdiff**（Google 自研，比 bsdiff 更省内存），操作类型就两种：

- **REPLACE**：直接写入新数据块
- **PUFFDIFF**：对旧数据执行 patch 操作

下载数据不落盘，直接流式写入 slot B。`DeltaPerformer` 类负责这一步：

```cpp
bool DeltaPerformer::Write(const void* bytes, size_t count,
                           brillo::ErrorPtr* error) {
  while (buffer_offset_ < count) {
    InstallOperation* op = &operations_[current_operation_];
    if (op->type() == InstallOperation::REPLACE) {
      // REPLACE: 直接写入目标分区
      memcpy(dest + op->dst_extent(), bytes + buffer_offset_, size);
    } else if (op->type() == InstallOperation::PUFFDIFF) {
      // PUFFDIFF: 从源分区读旧数据，在内存中打 patch
      ApplyPuffPatch(source_data, patch_data, dest + op->dst_extent());
    }
    buffer_offset_ += size;
    current_operation_++;
  }
  return true;
}
```

流式设计的收益很实际：下载多少就处理多少，不用等整个包下完才开工。对存储紧张的设备尤其友好。

### 提交与槽位切换

写入完成后，update_engine 调用 bootctrl 把 active slot 标记为 B，更新 `remaining_attempts` 计数器，然后等用户重启。bootloader 读取标记，尝试从 slot B 启动。

## 回滚保护的两个层面

回滚保护不止是"坏了切回去"那么简单，实际上是两层机制。

**第一层是启动计数。** bootctrl HAL 维护 `remaining_attempts`。系统启动中途 crash 或 kernel panic 时，bootloader 自动减 1 并重试。次数耗尽后切回旧 slot。用户无感——最多感受到一次自动重启。

**第二层是版本回滚防护。** Android Verified Boot（AVB）保证系统只能升不能降。每个分区的 `vbmeta` 里存着 **rollback_index**，更新包的 index 必须 ≥ 当前值：

```bash
$ avbtool info_image --image vbmeta.img
Rollback Index: 5
```

这堵死了刷旧版本绕过安全补丁的攻击路径。我自己做系统升级方案时踩过一个坑：测试环境频繁升降级，rollback_index 快速膨胀到上限（2^32），后续正常包全部校验失败。只能 unlock bootloader 用 `avbtool` 手动重置。

## 动态分区与 Virtual A/B

### 动态分区：合并物理分区

A/B 方案最大的痛点是存储。Android 10 的**动态分区（Dynamic Partitions）**把 system、vendor、product 等统一塞进一个 `super` 物理分区，内部按需分配为逻辑分区：

```bash
$ lpdump /dev/block/by-name/super
Slot 0:
  system_a:  1.2 GB (extents: 0x80000-0x2580000)
  vendor_a:  400 MB (extents: 0x2580000-0x2d80000)
  product_a: 800 MB (extents: 0x2d8000-0x3d80000)
```

A/B 两套逻辑分区共享一个 super，总占用从 8GB 压缩到 5GB 很常见。OTA 更新时只调整逻辑分区大小和位置，用 `liblp` 库写 super header 元数据，不重新分区。

### Virtual A/B：快照代替双份

动态分区减少了浪费，但 A/B 仍需两套逻辑分区，根本矛盾没解决。Android 11 的 **Virtual A/B** 用 **dm-snapshot（Device Mapper 快照）** 彻底改变了玩法。

更新时不在 slot B 建完整分区，而是在运行的 slot A 上创建快照，所有写入重定向到 **COW（Copy-On-Write）设备**。slot B 本质是一组快照设备加 COW 文件的叠加：

```bash
# 为 system 分区创建快照示意
dmsetup create system_b-cow-img --table \
  "0 $SIZE snapshot $BASE_DEVICE $COW_DEVICE P 8"
```

COW 设备只存变更块，未变块直接读底层分区。大多数 OTA 只改动 10%-20% 的系统文件，COW 设备只需几百 MB。update_engine 在 Virtual A/B 模式下写入快照设备而非物理分区：

```cpp
bool PartitionWriter::WriteExtents(
    const InstallOperation& op, uint64_t block_offset) {
  // target_device 是快照设备路径，如 /dev/block/dm-3
  int fd = open(target_device_.c_str(), O_WRONLY);
  lseek64(fd, block_offset * kBlockSize, SEEK_SET);
  write(fd, patched_data, data_size);
  close(fd);
  return true;
}
```

### 合并与压缩

更新完成后，`snapuserd` 用户态守护进程在后台把 COW 变更块逐步写回原始分区——即 **merge**。Android 12 引入 COW 压缩，减少写入放大：

```bash
$ snapshotctl dump
snapshot status: merging
bytes merged: 156/2048 MB (7.6%)
compression: lz4
```

合并完成前系统处于过渡态，不能接下一次 OTA。update_engine 通过 `snapshotctl` 轮询合并进度，完成后释放更新锁。

## 实战工具箱

排查 OTA 问题时这几个命令很实用：

```bash
# 查看当前 slot 和更新状态
adb shell getprop ro.boot.slot_suffix
adb shell bootctl get-current-slot

# 检查 super 分区布局，重点看各分区 size 和 extents
adb shell lpdump /dev/block/by-name/super

# 抓 update_engine 日志，按 operation 阶段过滤
adb logcat -s update_engine:* | grep -E "payload|merge|delta"

# 手动触发 OTA 更新（调试用）
adb push payload.bin /data/ota_package/
adb shell update_engine_client --payload=file:///data/ota_package/payload.bin \
    --update --headers="FILE_HASH=xxx;FILE_SIZE=xxx"
```

排查 OTA 失败，第一眼看 update_engine 日志里的 `last_attempt_error`。80% 的情况是签名校验失败或分区空间不足，剩下 20% 是 COW 设备创建异常或 merge 阶段 I/O 超时。

从物理 A/B 分区到 Virtual A/B 快照，Android OTA 架构的演进主线很清楚：**在保证无缝更新体验的前提下持续压低存储开销**。理解差分引擎、COW 快照和合并机制，是排查系统更新疑难杂症的前提。
