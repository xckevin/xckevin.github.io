---
title: 深入 KSP 全链路：从注解扫描到代码生成的编译期元编程
excerpt: 深入解析 KSP 替代 KAPT 的技术原理，从 SymbolProcessor、Resolver 到 CodeGenerator，揭示其跳过 Java Stub、原生理解 Kotlin AST 带来的编译性能飞跃（55 秒→9 秒），并给出完整的迁移实践指南。
publishDate: '2026-01-22'
tags:
- Kotlin
- KSP
- 编译期元编程
- 性能优化
- 注解处理
seo:
  title: 深入 KSP 全链路：从注解扫描到代码生成的编译期元编程
  description: 深入解析 KSP 如何替代 KAPT 实现编译速度质的飞跃（55s→9s），从 SymbolProcessor、Resolver 到 CodeGenerator，全面剖析 KSP 架构设计与迁移实践。
---

我在做组件化路由框架时，KAPT 的编译耗时涨到了 40 多秒。换 KSP 后降到 6 秒，一行注解逻辑没改，只换了处理器。这个差距值得拆开看。

## KAPT 为什么慢

要理解 KSP，先看它替代了什么。KAPT 本质是 Kotlin 编译器的兼容层——先让 Kotlin 编译器生成 Java Stub 文件，再交给 Java 的 APT 处理，最后把生成的 Java 代码合并回编译流程。

整条链路是：Kotlin 源码 → Java Stub → APT 处理 → 生成 Java 代码 → 合并编译。Stub 文件包含类、方法、属性的声明，不含方法体。中型项目里，Stub 生成就能吃掉 10-20 秒。

Java APT 基于 Javac 的 Round 机制，每轮处理一批注解。Kotlin 编译器和 Javac 是两个进程，通过文件系统交换数据，IO 开销绕不开。

KSP 直接跳过这套流程。它读取 Kotlin 编译器的 AST，在编译前端阶段完成符号解析和代码生成。核心差异在于：KSP 不过渡到 Java 体系，它原生理解 Kotlin 语法——扩展函数、声明点型变、属性委托这些概念，KAPT 的 Stub 表示要么丢失要么扭曲，KSP 直接建模。

## SymbolProcessorProvider：插件化注册入口

KSP 的入口是 `SymbolProcessorProvider` 接口，一个函数完成注册：

```kotlin
interface SymbolProcessorProvider {
    fun create(environment: SymbolProcessorEnvironment): SymbolProcessor
}
```

KAPT 需要继承 `AbstractProcessor` 并处理 `@SupportedAnnotationTypes`、`@SupportedSourceVersion` 等注解，KSP 的接口更干净。`SymbolProcessorEnvironment` 里装着两个关键对象：`Resolver` 和 `CodeGenerator`，外加运行时选项和日志。

注册方式用 SPI。在 `resources/META-INF/services/` 下放一个文件，文件名为接口全限定名，内容为实现类全限定名：

```
// resources/META-INF/services/
// com.google.devtools.ksp.processing.SymbolProcessorProvider
// 内容：
// com.example.MyProcessorProvider
```

Gradle 插件扫描这个目录完成发现。和 KAPT 的 `@AutoService` 注解 + 注解处理器的鸡生蛋问题不同，KSP 的 SPI 是纯文件配置，零依赖。

实际项目配置：

```kotlin
// build.gradle.kts
plugins {
    id("com.google.devtools.ksp") version "2.0.0-1.0.21"
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
```

没有单独的生成路径配置，不用清理 Stub 目录——KSP 的输出直接参与 Kotlin 编译的后续阶段。

## Resolver：符号解析

`Resolver` 是 KSP 的符号查询入口。KAPT 里你拿到的是 `javax.lang.model.element.Element`，KSP 用 `KSNode` 统一建模。

两者对 Kotlin 特性的支持差异很大。以声明点型变为例：

```kotlin
interface Source<T> {
    fun next(): T
}
fun demo(s: Source<String>) {
    // ...
}
```

在 KAPT 中，`s` 的类型表示会丢失 `out` 投影信息——Java 的类型系统没这个概念。KSP 的 `KSReferenceElement` 直接保留完整的型变信息。

`Resolver` 核心 API：

```kotlin
interface Resolver {
    fun getSymbolsWithAnnotation(
        annotationName: String, 
        inDepth: Boolean = false
    ): Sequence<KSAnnotated>
    
    fun getClassDeclarationByName(
        name: KSName
    ): KSClassDeclaration?
    
    fun getDeclarationsFromPackage(
        packageName: String
    ): Sequence<KSDeclaration>
}
```

`getSymbolsWithAnnotation` 返回 `Sequence` 而非 `Set`——配合 Kotlin 的 `filter`、`map` 链式处理，按需计算，避免一次加载全部符号到内存。

多轮处理是 KSP 的一个重要设计。KSP 支持最多 `KSVersion.CURRENT.maxRoundCount` 轮，每轮生成的代码在下一轮可被解析。这解决了"生成的代码上也需要注解"的场景，Room 就是靠这个机制处理 `@Dao` 接口生成的实现类上的注解。

```kotlin
class MyProcessor : SymbolProcessor {
    override fun process(resolver: Resolver): List<KSAnnotated> {
        val symbols = resolver.getSymbolsWithAnnotation(
            "com.example.Route"
        ).toList()
        
        symbols.forEach { symbol ->
            if (symbol !is KSClassDeclaration) return@forEach
            generateRouterClass(symbol)
        }
        
        return symbols.filter { it is KSFunctionDeclaration }
    }
}
```

`process()` 返回的 `List<KSAnnotated>` 告诉 KSP 框架这些符号还没处理完，下一轮继续。想阻止后续处理，返回空列表即可。

## CodeGenerator：增量编译与依赖管理

`CodeGenerator` 不只把字符串写到文件，它管理了一套依赖追踪和增量编译机制。

```kotlin
interface CodeGenerator {
    fun createNewFile(
        dependencies: Dependencies,
        packageName: String,
        fileName: String,
        extensionName: String = "kt"
    ): OutputStream
    
    fun associate(
        sources: List<KSFile>, 
        packageName: String, 
        fileName: String,
        extensionName: String = "kt"
    )
    
    val generatedFile: List<KSFile>
}
```

`dependencies` 参数决定增量编译的行为。它告诉 KSP 这个生成文件和哪些源文件有关联，源文件没变时 KSP 直接复用上次输出。

踩过一个坑：把 `KSFile` 作为依赖传入，但忽略了注解所在文件和实际修改的依赖文件可能不同。增量编译没触发重新生成，debug 了一下午。正确的做法是传入所有参与该文件生成的源文件：

```kotlin
val sources = resolver.getSymbolsWithAnnotation("com.example.Route")
    .flatMap { it.containingFile?.let { f -> listOf(f) } ?: emptyList() }
    .toList()

codeGenerator.createNewFile(
    dependencies = Dependencies(
        aggregating = false, 
        sources = sources.toTypedArray()
    ),
    packageName = "com.example.generated",
    fileName = "RouterRegistry"
).use { stream ->
    stream.write(generatedCode.toByteArray())
}
```

`aggregating` 标志位：设为 `true` 表示输出文件聚合了多个源的信息，任一源变化都触发重新生成；`false` 按普通依赖规则处理。路由表天生是 aggregating 的，设对了能避免漏生成。

## 多平台支持

KSP 可以声明处理各平台的注解，处理器代码写一次，在 `commonMain` 中注册即可自动应用到所有平台。没有 KAPT 那种 JVM 生成一套、JS 再生成一套的割裂感。

实际项目里我实现过一个 `@Serializable` 风格的序列化处理器，common 代码用 KSP 生成各平台序列化器，Kotlin/JS 和 Kotlin/Native 端零额外代码。

## 迁移实践

从 KAPT 迁移不需要改注解声明，注解定义本身不受影响。要迁移的是处理器。

第一步，替换 Gradle 插件：

```kotlin
// 移除
plugins {
    kotlin("kapt")
}
// 替换为
plugins {
    id("com.google.devtools.ksp")
}

// 依赖声明从 kapt 改为 ksp
// kapt("com.example:processor:1.0")
// ↓
ksp("com.example:processor:1.0")
```

第二步，重写 Processor。KAPT 的 `AbstractProcessor` 换成 `SymbolProcessorProvider` + `SymbolProcessor`，`processingEnv.typeUtils` 换成 `Resolver`。这个过程通常是删代码而不是加代码——Model 层不需要了，构建 TypeMirror 的模板代码也不需要了。

第三步，确认注解保留策略。KSP 默认处理 `@Retention(SOURCE)` 和 `@Retention(BINARY)` 的注解，KAPT 只处理前者。如果你的注解处理器依赖运行时注解，需要显式过滤。

换到 KSP 后增量编译也更可预测。KAPT 的 Stub 生成在增量模式下经常触发全量编译，KSP 的依赖追踪粒度精确到 `KSFile` 级别。注解密集的模块，全量编译从 55 秒降到 9 秒，增量编译从 18 秒降到 2 秒。

KSP 不是 KAPT 的性能优化版，是设计哲学的转变：用编译器原生的视角理解 Kotlin 代码，而不是降级到 Java 的表现层。注解处理从"编译的额外步骤"变成了"编译的前端环节"——这才是快的根源。
