---
title: "Android 16 KB Pages: Verify ELF and APK Alignment"
lang: en
translationKey: android-16kb-page-size-elf-ndk
slug: android-16kb-page-size-elf-ndk
excerpt: "Make an Android native app work on 16 KB page-size devices: build the ELF correctly, package it correctly, and verify both artifacts."
publishDate: '2026-05-27'
updatedDate: '2026-09-22'
tags:
- "Android"
- "NDK"
- "Performance Optimization"
- "Memory Management"
- "ELF"
seo:
  title: "Android 16 KB Pages: ELF and APK Alignment Guide"
  description: "Build and verify Android 16 KB support: NDK ELF LOAD alignment, AGP packaging, AAB checks, APK checks, and runtime tests."
  pageType: article
---

An Android native app is ready for a 16 KB page-size device only when **both** the shared libraries' ELF `LOAD` segments and the APK's uncompressed `.so` entries are aligned for 16 KB. Updating one linker flag or seeing an APK install on a 4 KB phone is not proof.

Android 15 introduced support for 16 KB-page devices. It does not mean every Android 15 device uses that page size. Treat this as a compatibility target for apps with native code, including transitive AARs, game engines, and `libc++_shared.so`—not as a performance claim. The platform documentation says 16 KB alignment works on 4 KB and 16 KB kernels; it does not promise a universal speed-up.

## Separate the two alignment problems

`p_align` in an ELF program header governs how the dynamic linker can map a `PT_LOAD` segment. ZIP alignment governs where an **uncompressed** `.so` entry begins inside the APK, so it can be mapped directly from the archive. They are independent checks.

| Artifact | What to inspect | Passing result |
| --- | --- | --- |
| Each arm64-v8a/x86_64 `.so` | ELF `PT_LOAD` alignment | `p_align` is `0x4000` (16 KB) or larger |
| Release AAB | bundle config | `PAGE_ALIGNMENT_16K` |
| Installed/distributed APK | ZIP alignment | `zipalign -c -P 16 -v 4` succeeds |

Compressed native libraries avoid the ZIP-entry mapping requirement, but they do **not** make a 4 KB-aligned ELF compatible. Keep checking the ELF files.

## Build native code with the right toolchain

With NDK r28 or newer, 16 KB ELF alignment is the default. With NDK r27 or older, add the linker flags to every final shared library:

```cmake
# CMakeLists.txt; apply to each target that produces a .so
target_link_options(nativecore PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384")
```

For `ndk-build` the equivalent is:

```make
# Android.mk
LOCAL_LDFLAGS += -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384
```

Do not assume a static `.a` archive has a `LOAD` header; the final linked `.so` is what matters. Prebuilt `.so` dependencies must be supplied again by their vendor or rebuilt from source. For old NDKs, also review `libc++_shared.so`: Android's compatibility guide calls out NDK r26 and earlier copies that are not 16 KB-aligned.

Check the result rather than parsing a hand-written column number:

```bash
readelf -lW app/build/intermediates/cxx/Release/*/obj/arm64-v8a/libnativecore.so
# In every LOAD row, the final Align value should be 0x4000 or greater.
```

Android provides `check_elf_alignment.sh`, which reports `ALIGNED` or `UNALIGNED` for the arm64-v8a libraries in an APK. It is safer for a CI gate because it examines every packaged library.

## Package an AAB that Play can install

For uncompressed `.so` files, use AGP 8.5.1 or later. Android documents an important trap: AGP 8.3–8.5 may appear 16 KB-aligned locally, but `bundletool` did not zipalign generated APKs by default, so an APK produced from the AAB can fail to install. AGP 8.5.1+ is the durable fix.

```bash
# Release AAB: the expected line contains PAGE_ALIGNMENT_16K.
bundletool dump config --bundle=app-release.aab | grep alignment

# APK: exit status 0 means uncompressed .so entries meet the 16 KB rule.
"$ANDROID_SDK_ROOT/build-tools/<version>/zipalign" \
  -c -P 16 -v 4 app-release.apk
```

`zipalign -c` only verifies; it does not repair an already signed production APK. Build again through the supported Gradle/AGP path. A nonzero result identifies a packaging failure, while `PAGE_ALIGNMENT_4K` from the bundle config means the bundle requests the old rule.

## Remove 4 KB assumptions in native code

The kernel page size is a runtime property. Never use `4096`, `PAGE_SIZE`, or bit masks derived from it as a portable allocation or mapping boundary. Obtain it at runtime and round safely:

```c
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

bool round_up_to_page(size_t value, size_t *rounded) {
  const long configured_page = sysconf(_SC_PAGESIZE);
  if (configured_page <= 0 || rounded == NULL) return false;

  const size_t page = (size_t)configured_page;
  if (value > SIZE_MAX - (page - 1)) return false; // Prevent value + page - 1 overflow.
  *rounded = ((value + page - 1) / page) * page;
  return true;
}
```

The caller must handle `false` rather than use an uninitialized result. This matters for `mmap` lengths and offsets, shared-memory formats, custom allocators, and tests that hard-code 4096; an `mmap` offset also has its own page-alignment requirement. Rounding a 4 KB request on a 16 KB device may allocate a 16 KB page; whether that matters depends on the workload, so measure its memory effect before redesigning an allocator.

## A release checklist that catches the real failure modes

1. Build a release AAB after upgrading to AGP 8.5.1+ and NDK r28+ where possible.
2. Check all packaged `.so` files, including third-party AARs, with the Android alignment script or `readelf`.
3. Confirm `PAGE_ALIGNMENT_16K` on the AAB and run `zipalign -c -P 16 -v 4` on an APK generated from it.
4. Run functional and native-memory tests on the experimental 16 KB Android Emulator images described by Android Studio. Test startup, `dlopen`, media/graphics code, and any custom `mmap` path.
5. Put the artifact checks in CI. A pass means alignment is correct; it does not certify application behavior, which still needs device/emulator testing.

The system also has a 16 KB compatibility mode for some 4 KB-aligned apps. It is useful for diagnosis, not a release strategy: Android explicitly recommends genuine 16 KB alignment for reliability and stability.

## Official references and related reading

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) documents the AGP/NDK requirements, checker script, AAB inspection, and emulator setup.
- [Android's 16 KB page-size architecture](https://source.android.com/docs/core/architecture/16kb-page-size/16kb) explains the platform-side ELF rules and runtime page-size concerns.
- [zipalign reference](https://developer.android.com/tools/zipalign) defines `-P 16` for uncompressed shared libraries.
- [Native memory diagnosis with malloc_debug and heapprofd](/en/blog/android-native-memory-malloc-heapprofd/) is useful if 16 KB testing exposes a native allocation problem.
- [Android Studio CPU and memory profiling](/en/blog/android-studio-profiler-cpu-memory/) covers the measurement tools to use before making performance claims.
