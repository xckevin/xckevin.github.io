---
title: "Jetpack Compose 高级应用与原理（3）：Compose 布局模型：声明式的测量与放置"
excerpt: "「Jetpack Compose 高级应用与原理」系列第 3/3 篇：Compose 布局模型：声明式的测量与放置"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Jetpack Compose
  - UI
  - 声明式
series:
  name: "Jetpack Compose 高级应用与原理"
  part: 3
  total: 3
seo:
  title: "Jetpack Compose 高级应用与原理（3）：Compose 布局模型：声明式的测量与放置"
  description: "「Jetpack Compose 高级应用与原理」系列第 3/3 篇：Compose 布局模型：声明式的测量与放置"
---
# Jetpack Compose 高级应用与原理（3）：Compose 布局模型：声明式的测量与放置

> 本文是「Jetpack Compose 高级应用与原理」系列的第 3 篇，共 3 篇。在上一篇中，我们探讨了「高级状态管理：超越 remember { mutableStateOf(...) }」的相关内容。

## 五、Compose 布局模型：声明式的测量与放置

Compose 使用一套独立的、基于 Modifier 和 Layout Composable 的声明式布局系统。

### 1. 核心思想

父布局向下传递约束（Constraints），子布局根据约束和自身内容确定尺寸（Size），然后父布局根据子布局的尺寸将其放置（Place）在合适的位置。

### 2. 布局阶段（Layout Phase）

在 Composition 之后发生，包含两个主要步骤：

- **测量（Measure）：**
  - 通常是**单遍**完成（与 View 系统可能多遍不同）；
  - 父 LayoutNode 向下传递 Constraints（包含最小/最大宽度和高度）；
  - 子 LayoutNode 根据收到的 Constraints 和自身的测量逻辑（可能是固定的，或基于内容），决定自己的尺寸，并将尺寸结果向上传递。

- **放置（Placement）：**
  - 在测量完成后，父 LayoutNode 根据子节点的测量尺寸和自身的布局逻辑（如 Column 是垂直排列，Row 是水平排列），决定每个子节点的 (x, y) 坐标位置；
  - 父节点调用子节点的 `placeAt(x, y)` 方法完成放置。

### 3. Modifier——UI 装饰与行为的链式应用

- **作用：** Modifier 是 Compose 中用于修改 Composable 外观（大小、内边距、背景、边框）、添加行为（点击、滚动、拖动）、改变布局方式（权重、对齐）或添加语义信息的主要方式；
- **链式调用：** `Modifier.padding(16.dp).background(Color.Blue).clickable { }`。顺序非常重要，后面的 Modifier 作用于前面 Modifier 处理后的结果；
- **内部机制：** 每个 Modifier 会包装其后的元素（可能是另一个 Modifier 或最终的 LayoutNode），并可能影响测量、布局、绘制或输入处理等阶段。

### 4. 固有特性测量（Intrinsic Measurements）

- **场景：** 某些布局（如 Row、Column）在确定自身尺寸（特别是 `wrap_content` 时）或子元素尺寸之前，需要知道子元素在给定约束下的「固有」最小或最大尺寸。例如，Row 可能需要知道所有子元素中最高的高度，以确定自身的高度；
- **机制：** 允许父布局在主测量传递之前，查询子布局的固有尺寸（`minIntrinsicWidth`、`maxIntrinsicWidth`、`minIntrinsicHeight`、`maxIntrinsicHeight`）。子布局需要能够根据传入的高度（查询宽度时）或宽度（查询高度时）约束来提供这些固有尺寸。

### 5. 自定义布局

- **Layout(...) Composable：**
  - **最常用**的自定义布局方式；
  - 提供一个 `content: @Composable () -> Unit` lambda 来定义子元素；
  - 提供一个 `measurePolicy: MeasurePolicy` lambda 来实现测量和布局逻辑；
  - MeasurePolicy lambda 接收 measurables（子元素的列表，可以调用 `measurable.measure(constraints)` 来测量它们）和 constraints（来自父布局的约束）；
  - 测量完所有子元素（得到 Placeable 对象列表）后，需要计算自身的尺寸，并通过 `layout(width, height) { ... }` 作用域来放置所有子元素（调用 `placeable.placeAt(x, y)`）。

- **SubcomposeLayout(...)：**
  - **场景：** 需要在**布局阶段**根据可用空间或其他条件**动态地决定**测量哪些子元素。例如，BoxWithConstraints 就是基于它实现的，它会根据自身的约束条件来决定传递给 content lambda 的约束；
  - **机制：** 允许在 measure lambda 中调用 subcompose 来组合和测量一部分子内容；
  - **开销：** 比 Layout 更昂贵，因为它可能涉及多次组合和测量传递。仅在必要时使用。

### 6. LayoutNode Tree

- Compose 运行时内部维护的树状结构，代表了 UI 的最终布局结果；
- 每个节点（LayoutNode）包含了测量结果、放置位置、绘制信息（可能指向一个 RenderNode）以及关联的 Modifiers；
- Compose 框架通过遍历 LayoutNode 树来执行绘制操作。

---

## 六、Compose 性能优化：让 UI 如丝般顺滑

虽然 Compose 旨在提高开发效率，但仍需关注性能以避免卡顿。

### 1. 核心目标

- **减少不必要的重组（Recomposition）：** 这是最关键的优化点。利用好 Skipping 机制；
- **降低 Composition/Layout/Draw 各阶段的成本：** 让每次执行尽可能快。

### 2. 关键优化技术

- **保证稳定性（Stability）：**
  - **优先使用不可变数据：** 对传入 Composable 的数据，尽量使用 `val`、原始类型、String、`kotlinx.collections.immutable` 集合；
  - **封装不稳定类型：** 如果必须使用可变类，将其封装在 `@Stable` 或 `@Immutable` 注解的状态持有器中，并通过 State 暴露必要的数据；
  - **显式注解：** 对自定义的、确实符合稳定/不可变契约的类添加 `@Stable` 或 `@Immutable` 注解；
  - **检查 Lambda 稳定性：** 传递给 Composable 的 Lambda 是隐式稳定的。但如果 Lambda 捕获了不稳定的变量，可能导致问题。

- **最小化状态读取范围：**
  - **只读需要的数据：** 不要在高层 Composable 读取底层才需要的细粒度状态。通过参数将处理好的数据向下传递；
  - **提升状态要适度：** 虽然状态提升是好模式，但过度提升（将所有状态提到最顶层）可能导致顶层状态变化时，大量无关的 Composable 被无效重组（即使它们可能被 skip）。

- **延迟状态读取（Defer Reads）：**
  - **使用函数引用/Lambda：** 对于事件回调，传递函数引用（`::doSomething`）或简单的 lambda（`{ doSomething(id) }`）通常优于传递一个在 Composable 作用域内创建的、捕获了当前状态的复杂 lambda 实例。后者可能因捕获不稳定状态或每次重组都创建新实例而阻止 Skipping。

- **使用 derivedStateOf：** 优化基于多个状态的复杂计算。

- **优化列表（LazyColumn、LazyRow）：**
  - **提供 key：** 为 items 提供稳定的、唯一的 key（`key = { item.id }`）。这能帮助 Compose 识别列表项的移动、添加、删除，并复用 Composable 实例，极大优化列表变化的性能；
  - **设置 contentType：** 为不同类型的列表项提供不同的 contentType（`contentType = { item.type }`）。这使得 Compose 可以在不同类型的项之间复用底层的 LayoutNode 等资源（类似于 RecyclerView 的 ViewHolder 复用）；
  - **保持 Item Composable 简洁：** 不要在 itemContent lambda 中执行耗时操作。Item 内部的状态管理也要高效。

- **使用基线配置文件（Baseline Profiles）：**
  - **作用：** 为应用的关键用户旅程（如启动、列表滚动）预先编译 Compose 代码（AOT），减少运行时的解释执行和 JIT 编译开销，显著改善首次运行性能和流畅度；
  - **生成与应用：** 通过 `androidx.benchmark:benchmark-macro-junit4` 库录制和生成 Profile 文件，将其包含在应用发布包中。

- **分析重组（Recomposition Analysis）：**
  - **Layout Inspector（AS Electric Eel+）：** 可以显示每个 Composable 的重组次数和跳过次数。高亮显示正在重组的部分。是定位不必要重组的利器；
  - **Compose Compiler Metrics：** 编译器可以输出报告，包含每个 Composable 的稳定性信息、是否可跳过等；
  - **手动包裹：** 将怀疑有问题的 Composable 用一个简单的包装 Composable 函数包起来，观察包装函数的重组情况，逐步缩小范围。

- **优化自定义布局：** 确保 measure 和 place 逻辑高效，避免冗余计算。

- **Modifier 链优化：** 某些 Modifier 组合可能比其他组合更高效，虽然通常影响不大，但极端情况下值得分析。

---

## 七、测试 Compose UI

Compose 提供了专门的测试框架。

### 1. 核心依赖

`androidx.compose.ui:ui-test-junit4`。

### 2. ComposeTestRule

测试入口点，用于在测试环境中托管 Compose UI：

- `createComposeRule()`：用于纯 Compose UI 测试（不依赖 Activity）；
- `createAndroidComposeRule<MyActivity>()`：用于测试与 Activity 集成的 Compose UI。

### 3. 查找节点（Finders）

使用**语义（Semantics）**来定位 Composable 是**最佳实践**，因为它将测试与具体的实现细节（如层级结构、Text 内容）解耦：

- `onNodeWithText("...")`、`onNodeWithContentDescription("...")`、`onNodeWithTag("myTag")`（通过 `Modifier.testTag("myTag")`）；
- 也可以通过层级查找（`onRoot()`、`onChildren()`、`onParent()`），但不推荐。

### 4. 执行操作（Actions）

模拟用户交互：

- `performClick()`、`performScrollTo()`、`performTextInput("...")`、`performGesture { ... }`（用于复杂手势）。

### 5. 断言（Assertions）

验证 UI 状态：

- `assertIsDisplayed()`、`assertIsEnabled()`、`assertTextEquals("...")`、`assertContentDescriptionEquals("...")`、`assertExists()`、`assertDoesNotExist()`。

### 6. 测试隔离

通过 `composeTestRule.setContent { MyComposable(...) }` 直接设置要测试的 Composable，传入 Mock 或 Fake 数据/回调，实现对单个 Composable 或屏幕的隔离测试。

### 7. 同步

Compose 测试框架会自动等待 UI 进入空闲状态（没有待处理的布局、绘制、动画）再执行操作和断言，简化了测试编写。

---

## 八、互操作性：Compose 与 View 系统共存

在现有项目中引入 Compose 或在 Compose 中使用旧 View 组件是常见需求。

### 1. 在 View 中使用 Compose

- **ComposeView：** 一个 Android View，可以在 XML 布局中使用或在代码中创建。通过调用其 `setContent { @Composable ... }` 方法来嵌入 Compose UI；
- **场景：** 在现有 Activity/Fragment 中逐步引入 Compose 编写的部分界面。

### 2. 在 Compose 中使用 View

- **AndroidView(factory = { context -> MyCustomView(context) }, update = { view -> view.setData(myState) })：** 一个 Composable 函数，允许将传统的 Android View 嵌入到 Compose UI 层级中；
  - `factory`：负责创建 View 实例（只调用一次）；
  - `update`：在 factory 执行后以及后续每次重组时执行（如果依赖的状态变化），用于根据 Compose 的状态更新 View 的属性；
- **场景：** 复用现有的复杂自定义 View、使用尚未有 Compose 等价物的 View（如 WebView、MapView）。

### 3. 主题与样式互操作

- **Accompanist 库：** 提供了 `accompanist-themeadapter-material` 和 `accompanist-themeadapter-appcompat` 等库，可以帮助在 Compose 和基于 XML 的 Material/AppCompat 主题之间共享颜色、排版等样式属性，实现视觉统一。

### 4. 注意事项

- **性能：** 在 Compose 和 View 的边界处可能存在一定的性能开销。尽量减少边界数量；
- **上下文与生命周期：** 需要注意 Context 的传递和组件生命周期的管理；
- **焦点与输入：** 跨边界的焦点管理和输入事件传递可能需要额外处理；
- **用途：** 主要用于**渐进式迁移**或**复用现有组件**，新界面应优先考虑纯 Compose 实现。

---

## 九、结论：拥抱声明式，精通其道

Jetpack Compose 不仅是 Android UI 开发的范式转变，更是一个设计精良、功能强大的现代工具集。它通过声明式 API、与 Kotlin 的深度集成以及强大的运行时优化，旨在提升开发效率和 UI 性能。

然而，要真正发挥 Compose 的威力，不能止步于表面。必须深入理解其**运行时核心**（Composition、Recomposition、Stability、Skipping）、**状态管理哲学**（Snapshot 系统、状态提升、衍生状态）、**副作用的安全处理机制**、**声明式布局模型**以及**独特的性能优化点**。

虽然 Compose 致力于简化 UI 开发，但在构建复杂、高性能应用时，对其内部原理的深刻理解和对最佳实践的严格遵循仍然是不可或缺的。掌握 Compose 的高级应用与原理，意味着能够自信地构建下一代 Android 界面，高效地解决性能瓶颈，并推动团队拥抱声明式 UI 开发的未来。

---

**「Jetpack Compose 高级应用与原理」系列目录**

1. 引言：声明式 UI 的范式革命
2. 高级状态管理：超越 remember { mutableStateOf(...) }
3. **Compose 布局模型：声明式的测量与放置**（本文）
