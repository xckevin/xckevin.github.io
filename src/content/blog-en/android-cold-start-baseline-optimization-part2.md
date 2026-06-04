---
title: "Android Cold Start Optimization: Baseline Profiles (Part 2): Generating the Baseline File"
lang: en
translationKey: android-cold-start-baseline-optimization-part2
slug: android-cold-start-baseline-optimization-part2
excerpt: "Part 2 of the Android cold-start Baseline Profile series: how to generate and integrate the baseline-prof.txt file."
publishDate: '2025-11-18'
displayInBlog: false
tags:
- "Android"
- "Performance Optimization"
- "Startup Optimization"
- "Baseline Profile"
series:
  name: "Android Cold Start Optimization: Baseline Profiles"
  part: 2
  total: 3
seo:
  title: "Android Baseline Profiles Part 2: Generating baseline-prof.txt"
  description: "Learn how to generate baseline-prof.txt with Macrobenchmark, interpret H/S/P rules, integrate ProfileInstaller, and validate Android startup gains."
  pageType: article
---

> This is part 2 of the three-part "Android Cold Start Optimization: Baseline Profiles" series. In the previous article, we covered the background.

## Generating the baseline file

### Principle

Use instrumentation to record the full execution path from app launch to the home page becoming visible.

### Build environment

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-9.png)

### Code architecture

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-10.png)

```plain
package com.urbanic.benchmark

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generateBaselineProfile() {
        rule.collectBaselineProfile(PACKAGE_NAME) {
            pressHome()
            startActivityAndWait()

            // val intent = Intent(HOME_ACTIVITY_ACTION)
            // intent.`package` = packageName
            // intent.component = ComponentName(packageName, HOME_ACTIVITY_PATH)
            // startActivityAndWait(intent)
            // device.wait(Until.hasObject(By.clazz(HOME_ACTIVITY_PATH)), 5_000)
            // device.wait(Until.hasObject(By.res(packageName + ":id/content_img")), 5_000)
            // device.wait(Until.hasObject(By.res(packageName + ":id/include_navigation_bottom")), 5_000)

        }
    }

    internal companion object {
        const val HOME_ACTIVITY_PATH = "com.urbanic.home.view.NewBrandHomeActivity"
        const val HOME_ACTIVITY_ACTION = "urbanic.intent.action.benchmark"
    }
}
```

### Build command

Use the following command to generate the baseline file:

```plain
:benchmark:PixelXLApi33IndiaBenchmarkAndroidTest --rerun-tasks -P android.testInstrumentationRunnerArguments.class=com.urbanic.benchmark.BaselineProfileGenerator
```

Parameter notes:

- **benchmark**: module name
- **PixelXLApi33IndiaBenchmarkAndroidTest**: device configuration used to run the mock code
- **com.urbanic.benchmark.BaselineProfileGenerator**: test class that generates the baseline file

### Reading baseline-prof.txt

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-11.png)

One or more of the characters `H`, `S`, and `P` mark how the corresponding method is used during startup:

- **H (Hot)**: the method is called many times during the app's lifecycle
- **S (Startup)**: the method is called during startup
- **P (Post Startup)**: the method is called after startup

### Notes

Keep these points in mind when creating a Baseline Profile:

- Android 5 through Android 6, API 21 and 23, already perform AOT compilation for APKs at install time, so Baseline Profiles do not affect them.
- [Debuggable apps](https://developer.android.google.cn/guide/topics/manifest/application-element#debug) are never AOT-compiled, which helps with troubleshooting.
- The rule file must be named `baseline-prof.txt` and placed in the root of the main source set, at the same level as `AndroidManifest.xml`.
- These files are used only with Android Gradle Plugin `7.1.0-alpha05` or later, starting with Android Studio Bumblebee Canary 5.
- [Bazel](https://source.android.com/docs/setup/build/bazel/introduction?hl=en) currently does not support reading Baseline Profile files or merging them into APKs.
- A compressed Baseline Profile must not exceed 1.5 MB, so libraries and apps should define a small set of rules that deliver the largest impact.
- If rules are too broad and cause too much code to compile, additional disk access may slow down startup. Always measure the profile's performance impact.

## Integrating the baseline file

### Add the ProfileInstaller dependency

```plain
dependencies {
    //...
    implementation "androidx.profileinstaller:profileinstaller:1.2.0"
}
```

### Add baseline-prof.txt

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-12.png)

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-13.png)

## Automated validation test

```plain
package com.urbanic.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingLegacyMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun startupNoCompilation() {
        startup(CompilationMode.None())
    }

    @Test
    fun startupBaselineProfile() {
        startup(CompilationMode.Partial())
    }

    // @Test
    // fun startupFullCompilation() {
    //     startup(CompilationMode.Full())
    // }

    private fun startup(compilationMode: CompilationMode) {
        benchmarkRule.measureRepeated(packageName = PACKAGE_NAME,
            metrics = listOf(StartupTimingLegacyMetric()),
            iterations = 15,
            startupMode = StartupMode.COLD,
            compilationMode = compilationMode,
            setupBlock = { pressHome() }) {
            startActivityAndWait()
            // device.wait(Until.hasObject(By.res(packageName + ":id/content_img")), 5_000)
            // device.wait(Until.hasObject(By.res(packageName + ":id/include_navigation_bottom")), 5_000)
        }
    }
}
```

![](../../assets/android-%E5%86%B7%E5%90%AF%E5%8A%A8%E4%BC%98%E5%8C%96--baseline-%E4%BC%98%E5%8C%96-14.png)

---

> In the next article, we will cover the test results.

**Android Cold Start Optimization: Baseline Profiles series**

1. Background
2. **Generating the baseline file** (this article)
3. Test results
