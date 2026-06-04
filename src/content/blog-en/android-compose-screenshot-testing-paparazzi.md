---
title: "Android Compose Screenshot Testing: Paparazzi and Roborazzi"
lang: en
translationKey: android-compose-screenshot-testing-paparazzi
slug: android-compose-screenshot-testing-paparazzi
excerpt: "A practical comparison of Paparazzi and Roborazzi for device-free Compose screenshot testing, covering rendering internals, font and shadow differences, CI automation, and visual regression gates."
publishDate: '2025-07-01'
tags:
- "Android"
- "Jetpack Compose"
- "Testing"
- "Visual Regression"
- "CI/CD"
seo:
  title: "Android Compose Screenshot Testing: Paparazzi and Roborazzi"
  description: "Compare Paparazzi JVM rendering and Roborazzi golden tests for Compose, including LayoutLib differences, CI automation, and visual regression gates."
  pageType: article
---

Last year, while building a Compose component library, the design team raised a requirement that made the engineering cost immediately obvious: before every release, we needed to run visual regression checks on more than 40 core components to make sure the UI had not degraded unexpectedly. The traditional approach was to connect a real device, run Espresso screenshots, and compare them manually. One full pass took at least two hours.

That was not sustainable. I started looking into **device-free screenshot testing**: rendering Compose UI directly on the JVM and generating screenshots without an emulator or physical device. Two mainstream options came up: **Paparazzi** and **Roborazzi**. Both can run in CI, but their rendering mechanisms are fundamentally different. If you choose the wrong one, the test result may not match the real device output.

This article summarizes my experience with both approaches, from rendering pitfalls to building a PR-stage gate that catches visual regressions automatically.

## Paparazzi JVM rendering: the benefits and limits of LayoutLib

Paparazzi's core dependency is **LayoutLib** from the Android SDK. It is the rendering engine used by Android Studio's layout editor, and it can run View measure/layout/draw directly on the JVM without a full Android system.

During tests, the Paparazzi Gradle plugin starts LayoutLib, converts Compose components into a View tree, and draws them into a `BufferedImage`. The API is straightforward:

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
    // Generated PNGs are placed under build/paparazzi/failures.
  }
}
```

The biggest advantage is **speed**. It is pure JVM rendering, so there is no emulator startup. One test case usually finishes in 1 to 2 seconds. Screenshot tests for 40 components can finish in about a minute.

But in real use, I hit three issues:

**First, LayoutLib is not the real Android system.** Internally it is a simplified implementation. Many system behaviors are mocked or left empty. The anti-aliasing behavior of `Canvas.drawRoundRect` in LayoutLib differs from real devices. Rounded cards look harsher in Paparazzi screenshots, while the real device transition is smoother.

**Second, Material Ripple effects are missing.** LayoutLib does not include a complete `RippleDrawable` implementation, so screenshots of all `clickable` components miss the ripple. Paparazzi cannot verify pressed-state button screenshots.

**Third, Compose compatibility can lag.** LayoutLib is released with the Android SDK, while the Compose UI Toolkit changes faster. I once hit this with Compose 1.6: it used a new `Modifier.Node` implementation, but LayoutLib 8.3 parsed the old API path and threw `NoSuchMethodError`. The only choices were waiting for an SDK update or locking the Compose version in `build.gradle`, which conflicted with the project's upgrade schedule.

A concrete example: when validating `TopAppBar` `scrollBehavior`, the text elevation shadow in Paparazzi was one shade darker than on a real device. The root cause was that LayoutLib used a fixed-direction light source for shadow calculation, while the real `Material3` theme went through the `SpotShadow` algorithm. I eventually moved that component's screenshot tests to Roborazzi.

## Roborazzi: golden tests with the real rendering engine

Roborazzi takes the opposite approach. Instead of trying to simulate Android on the JVM, it **runs Compose directly on an Android device or emulator and generates screenshots through `captureRoboImage()`**. Conceptually, it captures the Compose `semantics` tree and `Canvas` layer precisely.

Dependency setup:

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

Test code:

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
    // Generate a screenshot and compare it with the baseline.
    composeTestRule
      .onRoot()
      .captureRoboImage()
  }
}
```

`captureRoboImage()` performs a **pixel-level comparison (Golden Test)**. The first run records a reference screenshot under `src/test/snapshots`. Later runs compare the new screenshot against the reference pixel by pixel. If the difference exceeds the threshold, which defaults to 0%, the test fails. Roborazzi writes diff images under `build/outputs/roborazzi` and highlights mismatched areas in red.

**The cost is speed.** Roborazzi uses Gradle Managed Devices (GMD), which requires emulator startup. A test from AVD boot to screenshot completion takes about 15 to 20 seconds. A full run across 40 components takes 8 to 10 minutes. But the time is worth it because the screenshot matches what users actually see.

## Why the same component produces different screenshots

To validate the behavioral differences between the two approaches, I captured the same `Card` component with Paparazzi and Roborazzi, then overlaid the results with a `compare` tool.

```kotlin
// Component under test.
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

The differences concentrated in three areas:

| Dimension | Paparazzi | Roborazzi |
|-----------|-----------|-----------|
| Shadow rendering | LayoutLib fixed light source, harder edges | Real-device GPU calculation, natural transition |
| Font rendering | Host JVM fonts on macOS/Linux, different fallback behavior | Android system fonts with the Noto fallback chain |
| Color space | sRGB, no wide-gamut mapping | Adapts to device color configuration such as P3 |
| Ripple animation | **Not supported** | Fully supported |

Font rendering differences are especially painful. Chinese characters had different line heights in LayoutLib than on real devices, which changed where multiline text was truncated. A screenshot that passes in Paparazzi may still be unacceptable on a device.

## Building an automated regression gate

The selection strategy became clear: **use Paparazzi for fast daily component screenshots, and use Roborazzi Golden Tests for core interaction paths and high-risk components**. The two test suites run in different Gradle tasks:

```bash
# Paparazzi: fast baseline rendering checks, triggered on every PR.
./gradlew :library:verifyPaparazziDebug

# Roborazzi: Golden Tests, triggered when merging to the main branch.
./gradlew :library:recordRoborazziDebug  # First run creates the baseline.
./gradlew :library:verifyRoborazziDebug  # Later runs compare against it.
```

In GitHub Actions, I split them into separate stages:

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
      - name: Enable KVM  # GMD requires hardware acceleration.
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
      - name: Run Golden Tests
        run: ./gradlew :library:verifyRoborazziDebug
```

One pitfall is **when to update the baseline**. Intentional UI changes, such as a primary color adjustment, can make every Golden Test fail. In that case the baseline needs to be updated. I set one rule: baseline updates go through a separate PR, and they must be approved by the designer or UI owner before merge. GitHub CODEOWNERS automates the review requirement:

```text
# .github/CODEOWNERS
src/test/snapshots/  @design-reviewers
```

Any PR that changes the snapshot directory automatically requires design review.

## Debugging pixel differences

When Roborazzi reports a difference, it generates three images under `build/outputs/roborazzi`: `_compare` (diff image), `_actual` (actual screenshot), and `_expected` (baseline). Red regions show mismatched pixels.

In practice, most false positives came from three sources:

1. **Time-dependent components**: clocks and countdown text differ on every run, so mock the time source.
2. **Device pixel ratio (DPR) differences**: the GMD emulator DPR may differ from the CI host. Use `@Config(qualifiers = "w360dp-h640dp-xhdpi")` to force a fixed configuration.
3. **Animation frame capture**: screenshots taken mid-animation are unstable. Use `composeTestRule.waitForIdle()` to make sure rendering has finished.

A practical trick for time dependencies is to inject a fixed `TimeProvider` through `CompositionLocalProvider`:

```kotlin
compositionLocalOf<TimeProvider> provides TimeProvider.Fixed(
  LocalDateTime.of(2026, 6, 1, 10, 0)
)
```

## How the two approaches work together

After one quarter of iteration, my division of responsibility is:

Paparazzi handles **structural validation**: whether components have broken layout, text overflow, or alignment issues. These account for more than 70% of UI defects. LayoutLib's precision is good enough for them, and it is fast enough to run on every push without blocking CI.

Roborazzi handles **pixel-level validation**: primary colors, shadows, corner radii, font weight, and other details designers can spot by eye. It only runs when merging to the main branch. A 10-minute cost is acceptable there.

One more benefit is easy to overlook: **screenshots become documentation**. Every component's Golden Image lives under `src/test/snapshots`, so designers can browse the PNG files directly to understand the current UI state of the component library without pulling code and building the app.

This system ran for three months and caught four cases where theme-variable changes caused global visual regressions. One case happened when someone adjusted the secondary color in `ColorScheme`, making every `OutlinedTextField` border lighter. Paparazzi did not catch it because LayoutLib simplified border rendering, but Roborazzi Golden Tests failed immediately during merge. That case convinced me that the two approaches are complementary, not interchangeable.
