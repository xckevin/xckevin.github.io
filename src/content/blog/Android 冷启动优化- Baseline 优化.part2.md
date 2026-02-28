---
title: "Android 冷启动优化：Baseline 优化方案（2）：生成基准文件"
excerpt: "「Android 冷启动优化：Baseline 优化方案」系列第 2/3 篇：生成基准文件"
publishDate: 2025-11-18
displayInBlog: false
tags:
  - Android
  - 性能优化
  - 启动优化
  - Baseline Profile
series:
  name: "Android 冷启动优化：Baseline 优化方案"
  part: 2
  total: 3
seo:
  title: "Android 冷启动优化：Baseline 优化方案（2）：生成基准文件"
  description: "「Android 冷启动优化：Baseline 优化方案」系列第 2/3 篇：生成基准文件"
---
> 本文是「Android 冷启动优化：Baseline 优化方案」系列的第 2 篇，共 3 篇。在上一篇中，我们探讨了「背景」的相关内容。

## 生成基准文件

### 原理

采用插桩过程，记录从启动到首页展示的完整路径。

### 编译环境

![](../../assets/android-冷启动优化--baseline-优化-9.png)

### 代码架构

![](../../assets/android-冷启动优化--baseline-优化-10.png)

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

### 编译命令

生成基准文件的命令如下：

```plain
:benchmark:PixelXLApi33IndiaBenchmarkAndroidTest --rerun-tasks -P android.testInstrumentationRunnerArguments.class=com.urbanic.benchmark.BaselineProfileGenerator
```

参数说明：

- **benchmark**：模块名
- **PixelXLApi33IndiaBenchmarkAndroidTest**：设备配置，用于运行 mock 代码的设备信息
- **com.urbanic.benchmark.BaselineProfileGenerator**：生成基准文件的测试类

### baseline-prof.txt 文件解读

![](../../assets/android-冷启动优化--baseline-优化-11.png)

`H`、`S` 和 `P` 中的一个或多个字符用于指示相应方法在启动类型方面的标记：

- **H（Hot）**：表示方法在应用的整个生命周期内会被多次调用
- **S（Startup）**：表示方法会在启动过程中被调用
- **P（Post Startup）**：表示方法会在启动之后被调用

### 注意事项

创建基准配置文件时需注意以下事项：

- Android 5 到 Android 6（API 21 和 23）已在安装时对 APK 进行 AOT 编译，故基准配置文件对其无影响。
- [可调试应用](https://developer.android.google.cn/guide/topics/manifest/application-element#debug)绝不会经过 AOT 编译，以帮助进行问题排查。
- 规则文件必须命名为 `baseline-prof.txt`，并放在主源代码集的根目录中（与 `AndroidManifest.xml` 同级）。
- 仅在使用 Android Gradle 插件 `7.1.0-alpha05` 或更高版本（Android Studio Bumblebee Canary 5）时才会用到这些文件。
- [Bazel](https://source.android.com/docs/setup/build/bazel/introduction?hl=zh-cn) 目前不支持读取基准配置文件，也不支持将其合并到 APK 中。
- 基准配置文件的压缩后大小不得超过 1.5 MB，因此库和应用应尽量定义一小部分能够最大限度提升影响的规则。
- 如果规则过于宽泛导致编译过多，会增加磁盘访问，进而降低启动速度，应测试基准配置文件的性能。

## 接入基准文件

### 添加 Profileinstaller 依赖

```plain
dependencies {
    //...
    implementation "androidx.profileinstaller:profileinstaller:1.2.0"
}
```

### 添加 baseline-prof 文件

![](../../assets/android-冷启动优化--baseline-优化-12.png)

![](../../assets/android-冷启动优化--baseline-优化-13.png)

## 自动化验证测试

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

![](../../assets/android-冷启动优化--baseline-优化-14.png)

---

> 下一篇我们将探讨「测试结果」，敬请关注本系列。

**「Android 冷启动优化：Baseline 优化方案」系列目录**

1. 背景
2. **生成基准文件**（本文）
3. 测试结果
