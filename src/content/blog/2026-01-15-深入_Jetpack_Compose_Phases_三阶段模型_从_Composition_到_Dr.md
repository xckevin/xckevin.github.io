---
title: 深入 Jetpack Compose Phases 三阶段模型：从 Composition 到 Drawing 的声明式像素生产全链路
excerpt: 深入解析 Jetpack Compose 三阶段（Composition、Layout、Drawing）管线的工作原理，从状态读取的边界效应到阶段跳过机制，帮助开发者写出高性能声明式 UI。
publishDate: '2026-01-15'
tags:
- Android
- Jetpack Compose
- 性能优化
- 状态管理
- Kotlin
seo:
  title: 深入 Jetpack Compose Phases 三阶段模型：从 Composition 到 Drawing 的声明式像素生产全链路
  description: 深入解析 Jetpack Compose 的 Composition、Layout、Drawing 三阶段模型，理解状态读取如何决定重组边界，掌握阶段跳过机制与性能优化实战技巧。
---

Compose 写久了，总会遇到一个让人愣住的 bug：明明改了 `mutableStateOf` 的值，UI 却纹丝不动。排查半天发现，**状态的读取位置**决定了哪一阶段会重新执行——读在 `Modifier` 里和读在 `Canvas` 里完全是两码事。

要理解这个行为，得搞清楚 Compose 的三阶段管线。

## 三阶段概览

Compose 把"声明式组件"变成"屏幕像素"的过程拆成三个阶段：

- **Composition（组合）**：确定屏幕上要显示什么 UI 树
- **Layout（布局）**：测量每个节点的尺寸并确定位置
- **Drawing（绘制）**：将节点画到 Canvas 上

三个阶段按顺序执行，**每个阶段有独立的跳过（skip）判断**。你在哪个阶段读取状态，就决定了状态变化后哪段逻辑会被重新执行。

```
Composition  →  Layout  →  Drawing
    ↓              ↓          ↓
 创建 UI 树    测量+定位    实际绘制
    ↓              ↓          ↓
 状态读取决定是否需要重新组合
```

理解这套管线的最佳入口，是 `Modifier` 的执行时序。

## Modifier 链：三阶段的隐式调度器

每个 `Modifier` 在三个阶段都有对应的回调接口。以最基础的 `Modifier.size()` 为例：

```kotlin
// 一个自定义 Modifier 的三阶段参与方式
fun Modifier.trackedSize(size: Dp) = this.then(object : LayoutModifier {
    // Composition 阶段：什么也不做，只记录参数

    override fun MeasureScope.measure(
        measurable: Measurable,
        constraints: Constraints
    ): MeasureResult {
        // Layout 阶段：测量并确定尺寸
        val placeable = measurable.measure(constraints.copy(
            maxWidth = size.roundToPx()
        ))
        return layout(placeable.width, placeable.height) {
            placeable.placeRelative(0, 0)
        }
    }
}).then(object : DrawModifier {
    override fun ContentDrawScope.draw() {
        // Drawing 阶段：执行绘制
        drawRect(Color.Red)
        drawContent()
    }
})
```

Modifier 链是"声明"，三阶段才是"执行"。你在 `Modifier.size()` 里声明了尺寸约束，但实际测量和定位发生在 Layout 阶段——两者之间可能隔了好几层状态读取和重组判断。

Modifier 从左到右链接，但在三个阶段的执行顺序不同：

- **Composition 阶段**：Modifier 链基本不参与（用了 `composed()` 的除外）
- **Layout 阶段**：外层先收到约束，再向内传递。`Modifier.size(100.dp).padding(16.dp)` 的链路是——size 把最大宽度卡在 100dp，padding 再扣除 32dp 边距，最终内容拿到 68dp
- **Drawing 阶段**：外层先画，所有层在同一个 Canvas 上叠加

我踩过一个坑：在 `Modifier.drawBehind` 里读取状态做动画，又在 `remember` 里读同一个状态。结果 Drawing 阶段跳过失败，每次重组都触发全量重绘，帧率从 60 掉到 30。单独看每段代码都没问题，放一起就是一个隐蔽的性能炸弹。

## 状态读取的边界效应

Compose 的状态追踪是分阶段隔离的：

```kotlin
@Composable
fun ProfileCard() {
    var name by remember { mutableStateOf("Alice") }
    var badgeColor by remember { mutableStateOf(Color.Unspecified) }

    Text(
        text = name,           // 在 Composition 阶段读取
        modifier = Modifier
            .offset(x = badgeOffset)  // 在 Layout 阶段读取
            .drawBehind {
                drawCircle(badgeColor)  // 在 Drawing 阶段读取
            }
    )
}
```

三个状态各自影响不同的阶段：

- `name` 变化 → 触发 **Recomposition**（重组）
- `badgeOffset` 变化 → 触发 **Relayout**（重新布局），不重组
- `badgeColor` 变化 → 触发 **Redraw**（重新绘制），不重组也不重新布局

这就是 Compose 的粒度优势——状态变化不会导致全链路重跑，而是精确到阶段级别。UI 框架里能做到这一点的其实不多。

`Modifier.composed()` 是个特例。它把 Composition 阶段的逻辑塞进 Modifier 链，意味着每次重组都会重新执行 lambda。用它做动画状态管理很容易把 Drawing 级别的开销升级成 Composition 级别，用的时候掂量一下是否非它不可。

## 阶段跳过：为什么会跳过，什么时候会失败

`@Composable` 函数的参数在编译期被 Compose 编译器加上 `@Stable` 推断。推断为稳定类型的参数，如果值没有变化（`equals()` 返回 true），Composition 阶段直接跳过，连函数体都不进。

```kotlin
// Compose 编译器视角的等价变换
@Composable
fun Greeting(name: String) {  // String 推断为 @Stable
    Text("Hello $name")
}

// 编译器注入的跳过逻辑（伪码）
fun Greeting(name: String, %composer: Composer) {
    if (!%composer.skipping || name != %composer.rememberedValue) {
        Text("Hello $name")  // 只有值变了才执行
    }
}
```

跳过失败的几个典型场景：

1. **不稳定类型参数**：传了 `List<T>`，每次重组都 new 新实例，即使内容一致也无法跳过
2. **`composed()` 内部读状态**：Modifier 身份不稳定，Layout 阶段的跳过判决直接报废
3. **lambda 引用变化**：`Modifier.clickable { doSomething() }`，lambda 每帧都是新对象

我在实际项目中会开启 Compose 编译器的稳定性报告，CI 里加一步检查，确保核心 UI 组件的参数全部标记为 `@Stable` 或 `@Immutable`。这套机制属于"静默优化"——正常运行看不出差别，一旦退出，卡顿就肉眼可见。

## 实践建议

**用 `derivedStateOf` 降级状态读取阶段。** 能在 `derivedStateOf` 里完成纯计算推导，就别在 Composition 阶段用 `remember` 读原始状态再转换——后者会把简单计算升级为重组信号。

**Modifier 顺序就是性能边界。** 把不频繁变化的 Modifier（如固定 size）放在链前端，变化频繁的（如 animatedOffset）放在末端。这样 Layout 阶段做跳过判断时，外层不会重新测量，裁剪掉大量无用功。

**不要过早优化阶段跳过。** Compose 的跳过机制是编译期自动注入的，绝大多数场景不需要手动干预。真有性能瓶颈，先用 Layout Inspector 确认哪一阶段耗时，再对症处理。多数情况下的罪魁祸首是不稳定类型的扩散，而不是某一行具体代码。
