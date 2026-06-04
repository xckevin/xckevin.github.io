---
title: "Android OTA System Updates: From A/B Partitions to Virtual A/B Snapshots"
lang: en
translationKey: android-ota-ab-virtual-ab
slug: android-ota-ab-virtual-ab
excerpt: "A deep dive into Android's OTA update pipeline, covering A/B seamless updates, update_engine incremental payloads, rollback protection, dynamic partitions, Virtual A/B snapshots, and practical debugging commands."
publishDate: '2026-03-11'
tags:
- "Android"
- "OTA"
- "Incremental Updates"
- "Virtual A/B"
- "A/B Seamless Updates"
seo:
  title: "Android OTA Updates: A/B Partitions, update_engine, and Virtual A/B"
  description: "Trace Android OTA updates through A/B slots, update_engine deltas, rollback protection, dynamic partitions, and Virtual A/B snapshots."
  pageType: article
---

## Why A/B seamless updates exist

Android 7.0 introduced A/B seamless updates in 2016. The goal was straightforward: users should barely notice an OTA. The old Recovery-mode flow, where the device rebooted into a flashing screen and made users stare at a progress bar for several minutes, was hard to justify.

The A/B design keeps two copies of system partitions: slot A and slot B. When the device is running from slot A, the update package is written directly to slot B. After reboot, the bootloader switches to slot B. If boot fails, the device automatically falls back to slot A. This mechanism depends on two core components: **bootctrl HAL**, which marks the boot slot, and the **update_engine** daemon, which downloads and writes the update package.

The cost is also very real: duplicate partitions can cut available storage sharply. A 3 GB `system` partition becomes 6 GB when duplicated, which low-end devices cannot easily absorb. Dynamic Partitions and Virtual A/B were both driven by this storage pressure.

## The four stages of update_engine incremental updates

The `update_engine` source lives under `system/update_engine`. It is the execution engine for the whole OTA process.

### Fetch update metadata

The client requests update information from the OTA server and receives the payload SHA-256, size, and download URL:

```json
{
  "url": "https://ota.example.com/payload.bin",
  "size": 156000000,
  "metadata_signature": "MEUCIQD...",
  "hash": "a3f8b2c1..."
}
```

`update_engine` first verifies the metadata signature to make sure the source is trusted, then enters the download phase.

### Delta download and streaming writes

An incremental package contains only the differences between the old and new versions, usually reducing package size by 60% to 80% compared with a full package. The delta algorithm uses **puffdiff**, a Google-built approach that is more memory-efficient than bsdiff. There are two main operation types:

- **REPLACE**: writes new data blocks directly
- **PUFFDIFF**: patches old data into new data

Downloaded data is not staged as a full file on disk. It is streamed directly into slot B. The `DeltaPerformer` class handles this step:

```cpp
bool DeltaPerformer::Write(const void* bytes, size_t count,
                           brillo::ErrorPtr* error) {
  while (buffer_offset_ < count) {
    InstallOperation* op = &operations_[current_operation_];
    if (op->type() == InstallOperation::REPLACE) {
      // REPLACE: write directly to the target partition
      memcpy(dest + op->dst_extent(), bytes + buffer_offset_, size);
    } else if (op->type() == InstallOperation::PUFFDIFF) {
      // PUFFDIFF: read old data from the source partition and patch it in memory
      ApplyPuffPatch(source_data, patch_data, dest + op->dst_extent());
    }
    buffer_offset_ += size;
    current_operation_++;
  }
  return true;
}
```

The streaming design has a practical payoff: the system can process data as it downloads instead of waiting for the entire package. That is especially useful on storage-constrained devices.

### Commit and slot switching

After writing completes, `update_engine` calls bootctrl to mark slot B as active, updates the `remaining_attempts` counter, and waits for the user to reboot. The bootloader reads the mark and tries to boot from slot B.

## The two layers of rollback protection

Rollback protection is more than "switch back if the new version fails." In practice, there are two layers.

**The first layer is the boot attempt counter.** bootctrl HAL maintains `remaining_attempts`. If the system crashes during boot or hits a kernel panic, the bootloader decrements the counter and retries. When attempts run out, it switches back to the old slot. The user usually notices nothing beyond an automatic reboot.

**The second layer is version rollback protection.** Android Verified Boot (AVB) guarantees that the system can only move forward, not backward. Each partition's `vbmeta` stores a **rollback_index**, and the update package index must be greater than or equal to the current value:

```bash
$ avbtool info_image --image vbmeta.img
Rollback Index: 5
```

This blocks attacks that flash an older build to bypass security patches. I once hit a trap while building a system update workflow: the test environment upgraded and downgraded frequently, which pushed `rollback_index` up to the 2^32 limit. Every later normal package failed verification. The only recovery was to unlock the bootloader and reset it manually with `avbtool`.

## Dynamic Partitions and Virtual A/B

### Dynamic Partitions: merging physical partitions

Storage is the biggest pain point in A/B. Android 10's **Dynamic Partitions** put `system`, `vendor`, `product`, and related partitions into one physical `super` partition, then allocate logical partitions inside it on demand:

```bash
$ lpdump /dev/block/by-name/super
Slot 0:
  system_a:  1.2 GB (extents: 0x80000-0x2580000)
  vendor_a:  400 MB (extents: 0x2580000-0x2d80000)
  product_a: 800 MB (extents: 0x2d8000-0x3d80000)
```

Two A/B logical partition sets share the same `super` partition, and reducing total usage from 8 GB to 5 GB is common. During OTA, the system only adjusts logical partition sizes and locations. It writes `super` header metadata through `liblp` instead of repartitioning the device.

### Virtual A/B: snapshots instead of full duplicates

Dynamic Partitions reduce waste, but A/B still needs two logical partition sets. Android 11's **Virtual A/B** changed the model with **dm-snapshot**, the Device Mapper snapshot mechanism.

During update, the system does not create a full slot B partition. Instead, it creates snapshots over the running slot A, and all writes are redirected to a **COW (Copy-On-Write) device**. Slot B is effectively a stack of snapshot devices plus COW files:

```bash
# Sketch of creating a snapshot for the system partition
dmsetup create system_b-cow-img --table \
  "0 $SIZE snapshot $BASE_DEVICE $COW_DEVICE P 8"
```

The COW device stores only changed blocks. Unchanged blocks are read directly from the base partition. Most OTAs modify only 10% to 20% of system files, so the COW device often needs only a few hundred MB. In Virtual A/B mode, `update_engine` writes to the snapshot device rather than the physical partition:

```cpp
bool PartitionWriter::WriteExtents(
    const InstallOperation& op, uint64_t block_offset) {
  // target_device is a snapshot device path, for example /dev/block/dm-3
  int fd = open(target_device_.c_str(), O_WRONLY);
  lseek64(fd, block_offset * kBlockSize, SEEK_SET);
  write(fd, patched_data, data_size);
  close(fd);
  return true;
}
```

### Merge and compression

After the update finishes, the `snapuserd` user-space daemon gradually writes COW changed blocks back into the original partitions in the background. This process is the **merge**. Android 12 added COW compression to reduce write amplification:

```bash
$ snapshotctl dump
snapshot status: merging
bytes merged: 156/2048 MB (7.6%)
compression: lz4
```

Before merge completes, the system is in a transitional state and cannot accept another OTA. `update_engine` polls merge progress through `snapshotctl` and releases the update lock after completion.

## Practical debugging toolbox

These commands are useful when debugging OTA issues:

```bash
# Check the current slot and update state
adb shell getprop ro.boot.slot_suffix
adb shell bootctl get-current-slot

# Inspect the super partition layout, especially partition sizes and extents
adb shell lpdump /dev/block/by-name/super

# Capture update_engine logs and filter by operation phase
adb logcat -s update_engine:* | grep -E "payload|merge|delta"

# Trigger an OTA update manually for debugging
adb push payload.bin /data/ota_package/
adb shell update_engine_client --payload=file:///data/ota_package/payload.bin \
    --update --headers="FILE_HASH=xxx;FILE_SIZE=xxx"
```

When an OTA fails, start with `last_attempt_error` in the `update_engine` logs. In roughly 80% of cases, the cause is signature verification failure or insufficient partition space. The remaining 20% usually comes from COW device creation problems or I/O timeouts during merge.

From physical A/B partitions to Virtual A/B snapshots, the evolution of Android OTA architecture follows a clear direction: **keep the seamless update experience while continuously reducing storage overhead**. Understanding the delta engine, COW snapshots, and merge mechanism is the prerequisite for debugging hard system update failures.
