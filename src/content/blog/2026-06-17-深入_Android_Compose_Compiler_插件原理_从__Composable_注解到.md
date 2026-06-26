---
title: 深入 Android Compose Compiler 插件原理：从 @Composable 注解到 Composer 参数生成的编译器黑盒
slug: android-compose-compiler-plugin-internals
translationKey: android-compose-compiler-plugin-internals
excerpt: 本文拆解 Compose Compiler Plugin 在编译期如何将 @Composable 函数转换为带合成参数的 IR 形态，包括 $changed 位掩码编码、重组跳过逻辑生成、状态读写标记与稳定性推断规则，帮助建立对 Compose 重组行为的直觉。
publishDate: '2026-06-17'
tags:
- Android
- Compose
- Kotlin
- 编译器
- 性能优化
seo:
  title: 深入 Android Compose Compiler 插件原理：从 @Composable 注解到 Composer 参数生成的编译器黑盒
  description: 拆解 Compose Compiler Plugin 编译器插件原理，从 @Composable 注解到合成参数生成、重组跳过逻辑、状态标记与稳定性推断，掌握 Compose 性能优化的黑盒规则。
---

上周排查一个 Compose 页面的重组问题，我盯着反编译代码看了很久——源码里明明只写了一个简单的 `@Composable` 函数，编译后却多出了 `$composer`、`$changed`、`$default` 这些参数，内部还塞满了 `startRestartGroup`、`endRestartGroup` 调用。这些变换都发生在编译期，幕后推手是 Compose Compiler Plugin。

拆解一下这个编译器插件如何把声明式 UI 代码转译成 Compose Runtime 能消费的中间形态。

## 编译器插件的注册入口

Compose Compiler Plugin 是一个 Kotlin 编译器插件，通过 `ComponentRegistrar` 接口注册到编译流程中。`ComposePlugin.kt` 里注册了多个 IR 扩展，核心入口是 `IrGenerationExtension`：

```kotlin
// ComposePlugin.kt（简化）
class ComposePlugin : ComponentRegistrar {
    override fun registerProjectComponents(
        project: MockProject, 
        configuration: CompilerConfiguration
    ) {
        IrGenerationExtension.registerExtension(
            project, 
            ClassStabilityTransformer()
        )
        IrGenerationExtension.registerExtension(
            project, 
            ComposableFunctionTransformer()
        )
    }
}
```

两个关键扩展：`ClassStabilityTransformer` 负责推断类型的稳定性，`ComposableFunctionTransformer` 负责转换 `@Composable` 函数。插件介入的时机是 Kotlin 编译器的 IR 生成阶段，操作的是 **IR 树**而非源码文本。

IR（Intermediate Representation）是 Kotlin 编译器的中间表示，比 AST 更接近后端，但仍然是平台无关的。在 IR 层插入代码，兼顾了灵活性和性能。

## 补齐六个合成参数

写一个 Composable 函数时，编译器会自动补齐六个参数。以这个函数为例：

```kotlin
@Composable
fun Greeting(name: String) {
    Text("Hello $name")
}
```

编译后 IR 等价于：

```kotlin
fun Greeting(
    name: String,
    $composer: Composer<*>,
    $changed: Int,
    $default: Int,
    key1: Any?,
    key2: Any?,
    key3: Any?
) {
    // ...
}
```

每个参数各司其职：

- **`$composer`**：Compose Runtime 的核心调度器，负责组节点树、发射变更、管理重组
- **`$changed`**：位掩码，标记哪些参数的值发生了变化
- **`$default`**：标记哪些参数使用了默认值，配合 `$composer.startDefaults()` 处理
- **`key1/key2/key3`**：复合键（composition key），用于在重组时定位正确的可组合项

`$changed` 的编码逻辑：参数索引对应位掩码，第 0 位对应第 0 个参数，第 1 位对应第 1 个参数，以此类推。值 0 表示参数未变，值 1 表示参数已变，值 2 表示"不确定"——不稳定类型参数永远返回 2，强制走重组逻辑。

## 如何生成重组跳过逻辑

Compose 重组优化的核心是 **skippable** 机制。编译器插件分析每个 `@Composable` 函数的参数类型，判断稳定性，然后决定是否生成跳过逻辑。

稳定性规则直接明了：**基本类型和 String 是稳定的，data class 的字段全是稳定类型时也是稳定的，带 `@Stable` 注解的类型是稳定的**。接口和普通类默认不稳定，除非用 `@Stable` 标记。

对于参数全部稳定的函数，编译器生成如下结构：

```kotlin
$composer.startRestartGroup(0xF12345) // 重组作用域的 ID
if ($changed != 0 || $composer.skipping) {
    // 参数变了，需要重新执行
    Text("Hello $name")
} else {
    $composer.skipToGroupEnd() // 跳过，不执行函数体
}
$composer.endRestartGroup()?.updateScope { composer, forceUpdate ->
    Greeting(name, composer, forceUpdate or 1, ...)
}
```

`$changed` 是调用方传入的位掩码。调用方在重组时对比新旧参数值，设置对应位。如果所有参数都没变且非强制重绘模式，`$composer.skipping` 为 true，整个函数体被跳过。`mutableStateOf` 的值变化时只重组读取了该值的 Composable 而非整棵树，原因就在这里。

## 状态读写标记与快照感知

Compose 的状态感知依赖 `Snapshot` 系统和编译器插件的配合。Composable 函数读取 `State` 值时，编译器插入 `$composer.recordRead()`；写入时插入 `$composer.recordWrite()`。

```kotlin
@Composable
fun Counter() {
    var count by remember { mutableStateOf(0) }
    // 编译器插入: $composer.recordRead(count)
    Text("Count: $count")
    Button(onClick = { count++ }) {
        Text("Increment")
    }
}
```

`recordRead` 在当前 `SlotTable` 中注册观察者。当 `count` 在任何地方被修改（通过 `mutableStateOf` 的 `setValue`），`Snapshot` 系统标记所有注册了该状态的 Composable 为"脏"，下一帧重组时 `$changed` 会反映这个变化，触发重新执行。

编译器不需要理解业务逻辑，只负责在状态访问点插入标记代码。剩下的事情交给 `Snapshot` 和 `Composer` 在运行时处理。

## 默认参数与 `$default` 的协议

Composable 函数支持默认参数，但编译后的函数签名不能直接使用 Kotlin 的默认值机制——`$composer` 等合成参数打乱了参数位置。编译器用 `$default` 配合位掩码来解决：

```kotlin
@Composable
fun Greeting(name: String = "World", count: Int = 1) {
    Text("$name: $count")
}

// 编译后等价于：
fun Greeting(name: String, count: Int, $composer: Composer<*>, $changed: Int, $default: Int) {
    val name = if ($default and 0b01 != 0) "World" else name
    val count = if ($default and 0b10 != 0) 1 else count
    // ...
}
```

`$default` 的第 0 位表示 `name` 是否使用默认值，第 1 位表示 `count` 是否使用默认值。调用方不传某个参数时，设置对应位为 1，函数体内用 `if` 判断并赋值。所以 Composable 函数的默认参数不建议用复杂表达式——即使参数没被使用，表达式也会在每次重组时重新求值。

## 稳定性推断的边界与坑

编译器插件的稳定性推断是静态的，会犯错。我踩过的一个坑：`List` 类型的参数，内容明明是固定的，但 `List` 接口本身不是稳定类型，导致函数每次都重组。

```kotlin
// 编译器认为 List 不稳定，每次 $changed 都非 0
@Composable
fun ItemList(items: List<String>) {
    items.forEach { Text(it) }
}
```

两个方向可以解决：用 `@Stable` 注解包装类，或者用 `@Immutable` 标注。但更推荐的做法是让参数类型本身稳定——改用 `ImmutableList` 或 `kotlinx.collections.immutable` 下的类型。

Lambda 参数是另一个容易踩的坑。Lambda 默认是稳定的（对比的是引用），但如果你在每次重组时创建新的 lambda 实例，`$changed` 不会变化，函数体被跳过，UI 就不更新了。这种场景需要显式处理 lambda 内的状态读取。

## 理解编译器不是为了 hack 它

拆解 Compose Compiler 的目的不是手写编译器插件（Compose 的 IR 转换代码有上万行），而是建立对重组行为的直觉。知道编译器在状态读取处插入了 `recordRead`，你就理解为什么在 lambda 里读状态比在 Composable 函数体里读更容易出问题。知道稳定性推断的规则，遇到不该重组却重组的情况时，就能迅速定位到参数类型。

Compose 编译器插件是黑盒，但黑盒的输入输出规则是确定的。掌握这些规则，就掌握了 Compose 性能优化的钥匙。
