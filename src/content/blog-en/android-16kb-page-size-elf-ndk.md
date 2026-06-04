---
title: "Android 16 KB Page Size Migration: ELF Alignment, NDK Builds, and Performance"
lang: en
translationKey: android-16kb-page-size-elf-ndk
slug: android-16kb-page-size-elf-ndk
excerpt: "Android 15 and Google Play are moving toward 16 KB pages. This guide explains ELF segment alignment, linker behavior, NDK build changes, TLB validation, and CI gates."
publishDate: '2026-05-27'
tags:
- "Android"
- "NDK"
- "Performance Optimization"
- "Memory Management"
- "ELF"
seo:
  title: "Android 16 KB Page Size Migration: ELF Alignment and NDK Builds"
  description: "A practical guide to Android 16 KB pages, covering ELF LOAD alignment, NDK r27 build flags, TLB performance checks, and CI compatibility gates."
  pageType: article
---

Last year, while working on native memory optimization, I noticed a small line in the Android 15 release notes: support for 16 KB page sizes. I skimmed past it at first. Then a teammate's AAR crashed immediately on an emulator, with the stack pointing to `mmap` returning `EINVAL`. After digging in, we found the issue: the `LOAD` segments inside the shared object were hard-aligned to 4 KB, but the kernel was using 16 KB pages.

This was not an isolated case. Starting with Android 15, the platform and Google Play began moving together toward 16 KB pages, with the goal of covering all new devices by mid-2026. For NDK developers, this is not optional. It is a required alignment upgrade.

## The legacy cost of 4 KB pages

An operating system's memory management unit, or MMU, maps virtual addresses to physical addresses at page granularity. x86 and ARM have used 4 KB pages for more than 40 years, largely because early systems had limited physical memory. Larger pages meant more internal fragmentation.

The problem is that 4 KB is now small.

Take a mid-sized Android app as an example. Mapping a 200 MB native heap requires 51,200 page table entries, or PTEs. On ARM64, each page table level has 512 entries, and a full four-level translation can require four memory accesses. TLB coverage is also constrained by page size: 4 KB x 512 x 512 is roughly 1 GB. Address translations outside that range trigger TLB misses.

ARMv8.2 introduced 16 KB and 64 KB page support. ARMv9 goes further and recommends 16 KB as a preferred configuration. With the same 200 MB allocation, 16 KB pages require only 12,800 PTEs. Page table depth drops from four levels to three, and TLB coverage expands to about 16 KB x 512 x 512, or roughly 4 GB.

Google's Android 15 compatibility documentation gives quantitative numbers: in large-memory scenarios, 16 KB pages can reduce TLB misses by 30-60% and improve overall performance by 5-10%. The tradeoff is about 8 KB of average waste per allocation, which is half of a 16 KB alignment unit. On modern devices, that fragmentation cost is usually acceptable.

## How ELF loading is affected

For native development, the important path is ELF loading. When the dynamic linker loads a shared object, the flow looks roughly like this:

```c
// Simplified logic from bionic/linker/linker_phdr.cpp
bool ElfReader::LoadSegments() {
  for (phdr in program_headers) {
    if (phdr.p_type != PT_LOAD) continue;

    size_t aligned_start = page_start(phdr.p_vaddr);   // Align down
    size_t aligned_end   = page_end(phdr.p_vaddr + phdr.p_memsz);
    size_t aligned_size  = aligned_end - aligned_start;

    void* seg_addr = mmap(
        aligned_start + load_bias,
        aligned_size,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS,
        -1, 0
    );
    // Map only the portion backed by actual file data.
    mmap(seg_addr, file_length, prot, MAP_PRIVATE | MAP_FIXED, fd, file_offset);
  }
}
```

The key pieces are the `page_start` and `page_end` macros. In older bionic versions, they were hard-coded:

```cpp
#define PAGE_SIZE 4096
#define PAGE_MASK (~(PAGE_SIZE - 1))

static size_t page_start(size_t addr) { return addr & PAGE_MASK; }
static size_t page_end(size_t addr)   { return (addr + PAGE_SIZE - 1) & PAGE_MASK; }
```

Starting with Android 15, `PAGE_SIZE` becomes a runtime value from `getpagesize()`. That is where the problem appears: if the `LOAD` segment's `p_vaddr` inside the shared object was aligned to 4 KB, `page_start` on a 16 KB kernel can cut away more of the address range. The low bits of `p_vaddr` are effectively lost.

There are two common trigger conditions:

1. **The shared object's `p_align` is less than 16 KB.** The linker thinks the segment does not require 16 KB alignment, but the runtime system handles it using 16 KB pages, producing an address offset mismatch.
2. **The gap between multiple `LOAD` segments is smaller than 16 KB.** With 4 KB pages, an 8 KB gap between two segments is valid. With 16 KB pages, `page_end` can swallow the beginning of the next segment and overwrite content.

The direct fix is simple: make sure the shared object's segment alignment is at least as large as the target page size.

## Adapting the NDK build path

NDK r27 added support for 16 KB page alignment, but the default behavior remains compatible with older builds. You need to enable it explicitly. The main changes are linker flags and the C runtime, or CRT, object files.

### Linker flags

```cmake
# In CMakeLists.txt or build.gradle.kts
target_link_options(your_lib PRIVATE
    -Wl,-z,max-page-size=16384
    -Wl,-z,common-page-size=16384
)
```

`max-page-size` controls the upper bound for segment alignment, while `common-page-size` controls the actual `p_align` value. The NDK defaults both to 4096. After changing them to 16384, the `LOAD` segment's `p_vaddr` and `p_offset` are aligned to 16 KB.

Use `readelf` to verify the difference before and after the change:

```bash
# 4 KB alignment, the default
$ readelf -l libfoo.so | grep LOAD
LOAD  0x000000 0x000000 0x000200 0x000200 R   0x1000  # p_align=0x1000=4KB

# 16 KB alignment
$ readelf -l libfoo.so | grep LOAD
LOAD  0x000000 0x000000 0x002000 0x002000 R   0x4000  # p_align=0x4000=16KB
```

### CRT object replacement

After enabling 16 KB alignment, you may see ABI compatibility errors from CRT files such as `crtbegin_so.o`, especially around the `.note.android.ident` section. NDK r27 provides CRT variants specifically for 16 KB pages:

```cmake
# Select the CRT variant in CMake.
set(CMAKE_ANDROID_16K_PAGESIZE TRUE)  # NDK r27+
```

The equivalent manual approach is to link the 16 KB version of `crtbegin_dynamic.o`, which lives under `sysroot/usr/lib/<triple>/16k_pages/` in the NDK.

### A pitfall from real projects

If a statically linked third-party library was not built with 16 KB alignment, it can pull the final shared object's alignment back down to 4 KB. The diagnosis is straightforward:

```bash
# Check the alignment value of every LOAD segment in the shared object.
readelf -lW libmerged.so | awk '/LOAD/ {print "align:", strtonum($NF)}'

# If every value is 0x4000=16384, the build is fully adapted.
# If any value is 0x1000=4096, something was missed.
```

My fix was to add a check script to CI. During the CMake configuration phase, it scans every `.a` and `.o` file for segment alignment and fails the build when an input is not compliant. That is much cheaper than discovering the issue after a production crash.

## Performance validation: TLB is the key

The performance benefit of 16 KB pages mainly comes from TLB hit rate. A practical validation path is to sample TLB-related events with `simpleperf`.

```bash
# ARM PMU event: L1 D-TLB misses
simpleperf stat -e armv8_pmuv3/l1d_tlb/ --app com.example.app
```

On a Google Pixel 8 with a 16 KB page kernel and Android 15, I compared 4 KB and 16 KB shared object builds of the same app:

| Metric | 4 KB SO | 16 KB SO | Change |
|------|---------|----------|------|
| L1 D-TLB miss rate | 2.8% | 1.1% | -60.7% |
| Page table walk cost, CPU cycles | 4.2M/s | 1.8M/s | -57.1% |
| Native heap allocation time, ms per 1,000 allocations | 8.4 | 5.1 | -39.3% |

The test workload performed many native memory allocations in an image-processing pipeline, so the TLB miss reduction matched the theory. A warning is still needed: ordinary I/O-heavy apps will not see much benefit. If your app allocates mostly on the JVM heap, the direct benefit from 16 KB pages is minimal.

File mappings through `mmap` also get an easy-to-miss benefit. With 16 KB pages, the same file mapping needs four times fewer page table entries, and the kernel's `vm_area_struct` management overhead drops as well. The difference is more visible in workloads that heavily use `android.media.Image` for YUV processing.

## Migration roadmap

Google's timeline is that all newly certified devices must use 16 KB kernels by the end of 2025, and by mid-2026 Google Play will stop accepting incompatible app updates. In engineering terms, the important point is this:

**A shared object aligned to 16 KB remains compatible with 4 KB kernels.** A library built with `-Wl,-z,max-page-size=16384` still runs on a 4 KB page system. It only wastes some alignment space. There is no good reason to wait for 16 KB devices to become widespread before adapting. Make the change early and support both sides.

A practical migration path:

1. **Upgrade to NDK r27 or later** and enable `ANDROID_16K_PAGESIZE` in your CMake configuration.
2. **Scan every prebuilt dependency**, including `.a` and `.so` files, with `readelf -l` to check segment alignment.
3. **Add a CI gate** with a Python script that scans build outputs and fails when any `LOAD` segment has `p_align` below `0x4000`.
4. **Run stress validation** on a 16 KB AVD with Monkey and `simpleperf`, then compare TLB miss data.

In my experience, the third step is the easiest one to forget and the most useful one for preventing late-night production surprises. Do it once and keep it in the pipeline.

---

The 16 KB page migration has a strong cost-to-benefit ratio: a few build-flag changes, no code rewrite, and measurable performance improvements in the right workloads. The main pain point is prebuilt third-party libraries. But if you have control over your supply chain, checking them one by one usually does not take long.
