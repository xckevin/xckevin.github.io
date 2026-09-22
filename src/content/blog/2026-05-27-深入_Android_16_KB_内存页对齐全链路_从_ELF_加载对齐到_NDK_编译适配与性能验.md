---
slug: android-16kb-page-size-elf-ndk
translationKey: android-16kb-page-size-elf-ndk
title: Android 16 KB 页适配：同时验证 ELF 与 APK 对齐
excerpt: 面向含原生代码应用的 16 KB 页适配指南：构建 ELF、打包 AAB/APK、验证产物，并在模拟器中完成行为测试。
publishDate: '2026-05-27'
updatedDate: '2026-09-22'
tags:
- Android
- NDK
- 性能优化
- 内存管理
- ELF
seo:
  title: "Android 16 KB 页适配：ELF 与 APK 对齐验证"
  description: "完整说明 Android 16 KB 页适配：NDK ELF LOAD 对齐、AGP 打包、AAB/APK 检查与运行时验证。"
  pageType: article
---

含原生代码的 Android 应用要在 16 KB 页设备上可靠运行，必须同时满足两件事：共享库 ELF 的 `LOAD` 段按 16 KB 对齐，且 APK 中**未压缩**的 `.so` 条目也按 16 KB ZIP 对齐。只改链接参数，或只在 4 KB 页手机安装成功，都不能证明已适配。

Android 15 开始支持 16 KB 页设备，并不表示所有 Android 15 设备都使用 16 KB 页。应把它视为 NDK、游戏引擎、三方 AAR 及 `libc++_shared.so` 的兼容性要求，而不是必然的性能收益。官方说明 16 KB 对齐的库仍可运行在 4 KB 和 16 KB 内核上，但没有承诺所有工作负载都会变快。

## 先区分两个独立问题

ELF 程序头的 `p_align` 决定动态链接器如何映射 `PT_LOAD` 段；ZIP 对齐决定未压缩 `.so` 在 APK 内的起始位置，以便直接映射。两者必须分别检查。

| 产物 | 检查项 | 通过条件 |
| --- | --- | --- |
| 每个 arm64-v8a/x86_64 `.so` | ELF `PT_LOAD` 对齐 | `p_align` 为 `0x4000`（16 KB）或更大 |
| release AAB | bundle 配置 | 出现 `PAGE_ALIGNMENT_16K` |
| 分发 APK | ZIP 对齐 | `zipalign -c -P 16 -v 4` 成功 |

压缩 `.so` 可以避开 APK 内直接映射的 ZIP 对齐要求，但不能让 4 KB 对齐的 ELF 变为兼容；仍要检查每个 ELF。

## 用正确的 NDK 构建最终 `.so`

NDK r28 及以上默认生成 16 KB ELF 对齐。NDK r27 及更低版本，需要为每个最终共享库添加链接参数：

```cmake
# CMakeLists.txt：对每个输出 .so 的 target 生效
target_link_options(nativecore PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384")
```

`ndk-build` 的等价写法：

```make
# Android.mk
LOCAL_LDFLAGS += -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384
```

不要检查静态 `.a` 库来替代最终产物：它没有 `LOAD` 程序头，真正需要检查的是链接后的 `.so`。预编译 `.so` 必须由供应商重新提供或从源码重建。官方还特别指出，NDK r26 及更早版本的某些 `libc++_shared.so` 并非 16 KB 对齐。

```bash
readelf -lW app/build/intermediates/cxx/Release/*/obj/arm64-v8a/libnativecore.so
# 每个 LOAD 行最后的 Align 应为 0x4000 或更大。
```

Android 官方提供 `check_elf_alignment.sh`，可对 APK 内 arm64-v8a 库输出 `ALIGNED` 或 `UNALIGNED`。它比手工解析列位置更适合作为 CI 门禁。

## AAB 打包同样需要验证

未压缩 `.so` 建议使用 AGP 8.5.1 或更高版本。官方记录了一个容易漏掉的边界：AGP 8.3–8.5 在本地可能看似完成 16 KB 对齐，但 `bundletool` 默认不会对生成 APK 做 zipalign，导致由 AAB 交付的 APK 可能无法安装。升级到 AGP 8.5.1+ 才是稳定解法。

```bash
# 正确输出中应有 PAGE_ALIGNMENT_16K。
bundletool dump config --bundle=app-release.aab | grep alignment

# 退出码 0 表示 APK 中未压缩 .so 满足 16 KB ZIP 对齐。
"$ANDROID_SDK_ROOT/build-tools/<version>/zipalign" \
  -c -P 16 -v 4 app-release.apk
```

`zipalign -c` 只做验证，不会修复已签名的线上 APK。失败时应通过受支持的 Gradle/AGP 构建路径重新产出；AAB 输出 `PAGE_ALIGNMENT_4K` 则说明它仍在请求旧的打包规则。

## 清理代码中的 4 KB 假设

内核页大小是运行时属性。不要把 `4096`、`PAGE_SIZE` 或由其推导的位掩码当作通用映射边界；通过运行时查询并安全向上取整：

```c
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

bool round_up_to_page(size_t value, size_t *rounded) {
  const long configured_page = sysconf(_SC_PAGESIZE);
  if (configured_page <= 0 || rounded == NULL) return false;

  const size_t page = (size_t)configured_page;
  if (value > SIZE_MAX - (page - 1)) return false; // 防止 value + page - 1 溢出
  *rounded = ((value + page - 1) / page) * page;
  return true;
}
```

调用方必须处理 `false`，而不是继续使用未初始化结果。重点检查 `mmap` 的长度与 offset、共享内存格式、自定义分配器和把 4096 写死的测试；`mmap` 的 offset 还必须满足其自身的页对齐要求。16 KB 设备上，4 KB 请求可能实际占用一个 16 KB 页；是否值得改分配策略应先实测内存影响。

## 可执行的发布检查单

1. 尽量升级到 AGP 8.5.1+ 与 NDK r28+，构建 release AAB。
2. 用官方脚本或 `readelf` 检查所有打包 `.so`，包括三方 AAR。
3. 确认 AAB 为 `PAGE_ALIGNMENT_16K`，并对由它生成的 APK 运行 `zipalign -c -P 16 -v 4`。
4. 在 Android Studio 提供的实验性 16 KB AVD 上测试启动、`dlopen`、媒体/图形代码和自定义 `mmap` 路径。
5. 把产物检查放入 CI。通过代表对齐正确，不代表业务行为已验证。

系统还提供给部分 4 KB 对齐应用的 16 KB 兼容模式，它可用于诊断，不应作为发布策略；官方明确建议完成真实 16 KB 对齐以获得可靠性与稳定性。

## 官方资料与延伸阅读

- [支持 16 KB 页面大小](https://developer.android.com/guide/practices/page-sizes?hl=zh-CN)：AGP/NDK 要求、检查脚本、AAB 检查和模拟器。
- [AOSP：16 KB 页面大小架构](https://source.android.com/docs/core/architecture/16kb-page-size/16kb?hl=zh-CN)：平台 ELF 规则与运行时页大小问题。
- [zipalign 参考](https://developer.android.com/tools/zipalign)：`-P 16` 对未压缩共享库的定义。
- [Android 原生内存诊断：malloc_debug 与 heapprofd](/blog/android-native-memory-malloc-heapprofd/)：16 KB 测试发现原生内存问题后的排查方法。
- [Android Studio CPU 与内存性能分析](/blog/android-studio-profiler-cpu-memory/)：在宣称性能收益前应使用的测量工具。
