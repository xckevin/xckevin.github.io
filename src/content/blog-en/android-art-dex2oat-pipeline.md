---
title: "Inside the Android ART dex2oat Pipeline: From DEX Bytecode to OAT Machine Code"
lang: en
translationKey: android-art-dex2oat-pipeline
slug: android-art-dex2oat-pipeline
excerpt: "A practical walkthrough of the dex2oat pipeline, compiler filter trade-offs, JIT and AOT cooperation, and Baseline Profile startup optimization."
publishDate: '2026-02-20'
tags:
- "Android"
- "ART"
- "dex2oat"
- "Performance Optimization"
- "AOT/JIT"
seo:
  title: "Android ART dex2oat Pipeline from DEX to OAT"
  description: "Understand dex2oat, compiler filters, JIT and AOT cooperation, and Baseline Profile usage to reduce Android app cold-start time."
  pageType: article
---

During performance optimization work, one data point confused me for a long time: the same APK cold-started almost 40% faster when installed from Play Store than when installed through `adb install`. After investigation, the difference came from the dex2oat compilation strategy.

## What dex2oat actually does

When an APK is installed, the system starts `dex2oat` and compiles DEX bytecode into an OAT file. The full compilation pipeline looks like this:

```text
DEX -> dex2oat frontend parsing -> HGraph IR intermediate representation ->
optimization pass pipeline -> LIR low-level intermediate representation ->
register allocation -> machine code generation -> OAT file packaging
```

Frontend parsing converts smali-style instructions in DEX into ART's internal HGraph, an SSA-form IR. This stage also performs method inlining decisions and attempts to devirtualize virtual calls.

The optimization pipeline includes more than 20 passes: dead code elimination, loop optimization, constant folding, bounds-check elimination, and more. Which passes run depends on the Compiler Filter configuration. This is also where most compilation time is spent.

In the code generation stage, LIR goes through linear-scan register allocation, is encoded into target architecture instructions such as ARM64 or x86_64, and is written into the `.oat` file.

The generated OAT file is located at `/data/app/<package>/oat/arm64/base.odex`, next to the APK. At load time, the system can mmap this file directly and skip interpretation.

## Compiler Filter: trade-off, not silver bullet

Compiler Filter controls how far dex2oat compiles. Common levels include:

```bash
# Specify a compilation strategy at install time
adb install --fastdeploy app.apk          # Roughly equivalent to speed-profile
pm compile -m speed-profile <package>      # Runtime recompilation
```

| Filter | Behavior | OAT size | Install time |
|--------|----------|----------|--------------|
| verify | Verification only, no compilation | Smallest | Fastest |
| quicken | Generates JNI stubs, still relies on the interpreter | Small | Fast |
| speed-profile | Profile-guided compilation | Medium | Medium |
| speed | Full AOT compilation for all methods | Large | Slow |
| everything | speed plus full debug information | Largest | Slowest |

`verify` and `quicken` generate almost no machine code. Execution depends on the interpreter or JIT fallback, so they are suitable for code on the system partition that rarely runs.

`speed-profile` is the Play Store default strategy. It compiles only methods marked as "hot" in the Profile file. Installation is fast and files stay smaller, but unmarked methods still go through JIT the first time they execute.

`speed` is full AOT. All methods are compiled ahead of time. Cold starts are faster and more consistent, but installation is slower and OAT size may double. Many domestic ROMs like to run full `speed` compilation at boot, and users experience that as long installation waits.

One real pitfall: an 8MB DEX file expanded to a 23MB OAT file after full `speed` compilation. On storage-sensitive devices, extra I/O can cancel out the startup gains from compilation.

## How JIT feeds AOT

In ART's hybrid compilation model, JIT and AOT cooperate. They are not opposing strategies:

```text
First method execution -> interpreter execution
         | reaches hotness threshold, usually thousands of calls
    JIT compilation -> stored in JIT Code Cache
         | background thread triggers JIT GC
    Export Profile information, including hot method names
         | next dex2oat execution
    AOT compiles those hot methods
```

Code compiled by JIT records method names and hotness statistics, then periodically writes them into Profile files. These files are the input used by dex2oat when running `speed-profile` compilation.

Key data flow:

- JIT Code Cache has a limited size, 64MB by default, and triggers GC when full
- Profile information is written to `/data/misc/profiles/ref/<pkg>/primary.prof`
- During idle maintenance windows, the system runs `bg-dexopt` automatically and uses Profile data for AOT

The longer an app is used, the sooner frequently executed methods are AOT-compiled, and cold start gradually improves. This is the "gets faster with use" effect created by JIT-to-AOT cooperation.

## Baseline Profile: do not wait for JIT to accumulate data

If JIT needs time to collect hot methods before it can guide AOT, what happens for a freshly installed app?

The answer is Baseline Profile. It is a predefined `baseline.prof` file packaged under `assets/dexopt/` in the APK. It declares the key methods on the startup path. The concept evolved from Android 9 Cloud Profiles, but the underlying mechanism became truly stable and practical after Android 13.

```bash
# Flow for generating a Baseline Profile
# 1. Run the app and collect the startup path
adb shell cmd package compile -m speed-profile -f \
  --base-apk /data/app/<pkg>/base.apk <pkg>

# 2. Extract the Profile
adb pull /data/misc/profiles/ref/<pkg>/primary.prof
```

A Profile file is essentially a list of method signatures. When dex2oat processes it, methods in the list are compiled to machine code, while unmarked methods continue to use interpretation or JIT.

Google's data shows that adding a Baseline Profile makes Play Store app cold starts 15%-30% faster on average. The condition is that the Profile must be precise. If actually cold code is placed into the baseline file, it only wastes OAT space.

In my projects, I use Macrobenchmark to run startup tests and generate `baseline-prof.txt` automatically. CI packages it directly into the APK. Maintaining Profiles by hand is unrealistic. Method signatures can easily reach hundreds of lines, and a few code changes may invalidate them.

## Three practices that work

**Choose the right Compiler Filter.** For production app distribution, `speed-profile` plus Baseline Profile is the best combination. Do not worship full AOT. OAT growth and extra I/O often cancel out the gains from compilation. On some vendor "full compilation optimization" flows, storage becomes the bottleneck first on devices below 128GB.

**Prioritize Profile stability.** The goal of a Baseline Profile is not to cover every method. It is to precisely cover the startup path. During maintenance, watch the "methods dropped from Profile" ratio. That metric is more useful than coverage itself.

**Monitor when bg-dexopt runs.** The system triggers background AOT compilation while charging and idle. But if users frequently use the app on low battery, JIT Code Cache can GC repeatedly and slow down hot-path execution. When necessary, use `pm compile` to trigger recompilation manually so AOT covers hot methods earlier.

The Android Runtime compilation system is no longer the simple "DEX to machine code" story from years ago. Understanding the rhythm of JIT and AOT cooperation, then using Profile data to guide compilation precisely, is where the real startup-time leverage comes from.
