---
title: 深入 Android Compose 无设备截图测试全链路：从 Paparazzi JVM 渲染到 Roborazzi 像素级 Golden Test 的视觉回归工程实践
excerpt: 本文深入对比 Paparazzi 与 Roborazzi 两种 Compose 无设备截图测试方案，从渲染原理、字体阴影差异到 CI 自动化防劣化门禁，构建两套互补的视觉回归体系。
publishDate: '2026-06-01'
tags:
- Android
- Jetpack Compose
- 测试
- 视觉回归
- CI/CD
seo:
  title: 深入 Android Compose 无设备截图测试全链路：从 Paparazzi JVM 渲染到 Roborazzi 像素级 Golden Test 的视觉回归工程实践
  description: 深入对比 Paparazzi JVM 渲染与 Roborazzi 真机 Golden Test 两种方案，从 LayoutLib 渲染差异到 CI 自动化防劣化门禁，构建 Compose 组件库的视觉回归测试体系。
---

去年做 Compose 组件库建设时，设计团队提了一个让我头皮发麻的需求：每次发版前，需要对 40+ 个核心组件做视觉回归验证，确保 UI 没有意外劣化。传统做法是连真机跑 Espresso 截图然后人工比对——一轮下来至少 2 小时。

这显然不可持续。于是我开始调研**无设备截图测试（Device-Free Screenshot Testing）**，思路是在 JVM 上直接渲染 Compose UI 并生成截图，不依赖模拟器或真机。调研下来有两个主流选项：**Paparazzi** 和 **Roborazzi**。它们都能在 CI 上跑，但渲染机制有本质差异——选错了，测试结果和真机效果就对不上。

这篇文章梳理我在这两个方案上的实践经历，从渲染原理的坑到搭建一套 PR 阶段自动拦截视觉异常的防劣化门禁。

## Paparazzi 的 JVM 渲染：LayoutLib 的利与弊

Paparazzi 的核心依赖是 Android SDK 里的 **LayoutLib**——Android Studio 布局编辑器用的渲染引擎，能脱离 Android 系统直接在 JVM 上执行 View 的 measure/layout/draw 流程。

Paparazzi 通过 Gradle 插件在测试阶段启动 LayoutLib，将 Compose 组件转为 View 树，再绘制到 `BufferedImage` 上。用法不复杂：

```kotlin
@RunWith(AndroidJUnit4::class)
class ButtonTest {
  @get:Rule
  val paparazzi = Paparazzi(
    deviceConfig = DeviceConfig.PIXEL_6,
    theme = "android:Theme.Material.Light.NoActionBar"
  )

  @Test
  fun `button should render correctly`() {
    paparazzi.snapshot {
      Button(onClick = {}) { Text("Submit") }
    }
    // 生成的 PNG 在 build/paparazzi/failures 下
  }
}
```

这套方案**最大的优势是快**：纯 JVM 渲染，不用启动模拟器，一个用例 1-2 秒搞定。40 个组件的截图任务 1 分钟就能跑完。

但实际用下来，我踩了三个坑：

**第一，LayoutLib 不是真 Android 系统。** 它内部是精简版实现，很多系统行为是 mock 或空实现。`Canvas.drawRoundRect` 在 LayoutLib 里的抗锯齿效果和真机不一致——圆角卡片在 Paparazzi 截图中边缘生硬，真机上过渡平滑。

**第二，Material Ripple 效果缺失。** LayoutLib 不含 RippleDrawable 的完整实现，所有 `clickable` 组件的截图都没有水波纹。要验证按钮按压态截图，Paparazzi 做不了。

**第三，Compose 版本兼容滞后。** LayoutLib 随 Android SDK 发布，而 Compose 的 UI Toolkit 更新更快。我遇到过一次：Compose 1.6 用了新 `Modifier.Node` 实现，LayoutLib 8.3 按旧 API 解析，直接抛 `NoSuchMethodError`。只能等 SDK 更新，或者在 `build.gradle` 里锁死 Compose 版本——但这又和项目升级节奏冲突。

一个实际案例：验证 `TopAppBar` 的 `scrollBehavior` 时，Paparazzi 截图里文字的 elevation shadow 偏暗，比真机差了一个色阶。排查发现 LayoutLib 的阴影计算用的是固定方向光源，而真机 `Material3` 主题内部走了 `SpotShadow` 算法。最终我把这个组件的截图测试迁到了 Roborazzi。

## Roborazzi：用真机渲染引擎做 Golden Test

Roborazzi 走了另一条路：不试图在 JVM 上模拟 Android 系统，而是**直接在 Android 设备或模拟器上跑 Compose，通过 `captureRoboImage()` 生成截图**。本质是对 Compose 的 `semantics` 树和 `Canvas` 层的精确捕获。

依赖配置：

```kotlin
// build.gradle.kts
plugins {
  id("io.github.takahirom.roborazzi") version "1.24.0"
}

android {
  testOptions {
    managedDevices {
      devices {
        pixel6Api34(ManagedDevices) {
          device = "Pixel 6"
          apiLevel = 34
        }
      }
    }
  }
}
```

测试代码：

```kotlin
class ButtonVisualTest {
  @get:Rule
  val composeTestRule = createComposeRule()

  @Test
  fun `button matches golden screenshot`() {
    composeTestRule.setContent {
      MaterialTheme {
        Button(onClick = {}) { Text("Submit") }
      }
    }
    // 生成截图并与 baseline 对比
    composeTestRule
      .onRoot()
      .captureRoboImage()
  }
}
```

`captureRoboImage()` 会做**像素级比对（Golden Test）**：首次运行生成参考截图存入 `src/test/snapshots`，后续运行将新截图与参考图逐像素对比。差异超过阈值（默认 0%）则测试失败，`build/outputs/roborazzi` 下输出差异对比图，用红色高亮不一致区域。

**代价是速度**。Roborazzi 走 Gradle Managed Devices（GMD），需要冷启动模拟器，一个测试从 AVD 启动到截图完成约 15-20 秒。40 个组件的完整测试要跑 8-10 分钟。但这个时间花得值——截图效果和用户看到的一模一样。

## 为什么同一组件截图会不一样

为了验证两个方案的行为差异，我拿同一个 `Card` 组件，在 Paparazzi 和 Roborazzi 下分别截图，用 `compare` 工具叠加对比。

```kotlin
// 测试目标组件
@Composable
fun ProductCard(name: String, price: String) {
  Card(
    modifier = Modifier.padding(16.dp),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
    shape = RoundedCornerShape(12.dp)
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(name, style = MaterialTheme.typography.titleMedium)
      Text(price, style = MaterialTheme.typography.bodyLarge,
           color = MaterialTheme.colorScheme.primary)
    }
  }
}
```

差异集中在三个维度：

| 维度 | Paparazzi | Roborazzi |
|------|-----------|-----------|
| 阴影渲染 | LayoutLib 固定光源，边缘偏硬 | 真机 GPU 计算，自然过渡 |
| 字体渲染 | 宿主 JVM 字体（macOS/Linux），回退策略不同 | Android 系统字体，含 Noto 回退链 |
| 颜色空间 | sRGB，不做广色域映射 | 适配设备色彩配置（P3 等） |
| Ripple 动效 | **不支持** | 完整支持 |

字体渲染的差异尤其要命——中文字符在 LayoutLib 里的行高和真机不一致，多行文本的截断位置不同。Paparazzi 通过的截图，在真机上可能根本不过关。

## 构建自动化防劣化门禁

选型结论很明确：**日常组件截图用 Paparazzi 快速检查，核心交互路径和高风险组件用 Roborazzi 做 Golden Test**。两套测试跑在不同的 Gradle task 中：

```bash
# Paparazzi：快速验证基础渲染，PR 每次触发
./gradlew :library:verifyPaparazziDebug

# Roborazzi：Golden Test，合并到主分支时触发
./gradlew :library:recordRoborazziDebug  # 首次生成 baseline
./gradlew :library:verifyRoborazziDebug   # 后续与 baseline 对比
```

在 GitHub Actions 里，我把这两步拆到不同阶段：

```yaml
# .github/workflows/visual-regression.yml
jobs:
  paparazzi-fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Paparazzi screenshots
        run: ./gradlew :library:verifyPaparazziDebug

  roborazzi-golden:
    needs: paparazzi-fast
    runs-on: ubuntu-latest
    strategy:
      matrix:
        api-level: [34]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
      - name: Enable KVM  # GMD 需要硬件加速
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
      - name: Run Golden Tests
        run: ./gradlew :library:verifyRoborazziDebug
```

踩过的一个坑是 **baseline 更新时机**。UI 有意图的修改（比如主色调调整）会导致所有 Golden Test 失败，这时要更新 baseline。我定了一条规则：baseline 更新走独立 PR，必须有设计师或 UI 负责人 approve 才能合并。用 GitHub CODEOWNERS 自动化审批：

```
# .github/CODEOWNERS
src/test/snapshots/  @design-reviewers
```

PR 中包含 snapshot 目录变更，会自动要求设计团队 review。

## 像素差异的调试策略

Roborazzi 报告差异时，`build/outputs/roborazzi` 下会生成三张图：`_compare`（差异标记图）、`_actual`（实际截图）、`_expected`（baseline）。红色区域就是不一致的像素。

实际排查下来，大部分「假阳性」来自三个源头：

1. **时间相关组件**：时钟、倒计时文案每次跑都不一样，要 mock 时间源
2. **设备像素比（DPR）差异**：GMD 模拟器的 DPR 和 CI 主机不一致，用 `@Config(qualifiers = "w360dp-h640dp-xhdpi")` 强制指定
3. **动画帧截取**：在动画中间帧截图导致内容不稳定，用 `composeTestRule.waitForIdle()` 确保渲染完成

处理时间依赖，一个实用技巧是用 `CompositionLocalProvider` 注入固定的 `TimeProvider`：

```kotlin
compositionLocalOf<TimeProvider> provides TimeProvider.Fixed(
  LocalDateTime.of(2026, 6, 1, 10, 0)
)
```

## 两套方案的配合策略

一个季度迭代下来，我的分工策略是：

Paparazzi 负责**结构级验证**——组件是否存在布局破损、文字溢出、对齐异常。这类问题占 UI 缺陷的 70% 以上，LayoutLib 的精度足够，而且快，每次 push 都跑也不影响 CI 排队。

Roborazzi 负责**像素级验证**——主色调、阴影、圆角、字重这些设计师肉眼能看出差异的细节。只在 merge 到主分支时跑，10 分钟的耗时可以接受。

还有一个容易被忽略的收益：**截图即文档**。所有组件的 Golden Image 都在 `src/test/snapshots` 目录下，设计师直接浏览 PNG 就能了解当前组件库的 UI 状态，不用拉代码编译运行。

这套体系跑了 3 个月，拦截了 4 次因主题变量改动导致的全局样式劣化。其中一次是有人在 `ColorScheme` 里调整了 secondary 色值，所有 `OutlinedTextField` 的边框颜色变淡——Paparazzi 没检测出来（LayoutLib 对边框渲染做了简化），但 Roborazzi 的 Golden Test 在合并时直接挂了。这个 case 让我确信：两套方案缺一不可。
