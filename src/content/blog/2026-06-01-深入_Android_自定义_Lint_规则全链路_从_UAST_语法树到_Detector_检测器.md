---
title: 深入 Android 自定义 Lint 规则全链路：从 UAST 语法树到 Detector 检测器的编译期代码规范自动化实战
excerpt: 深入解析 Android 自定义 Lint 规则的完整构建链路，从 UAST 语法树原理、Detector 实现到发布集成与调试，让代码规范在编译期自动落地。
publishDate: '2026-06-01'
tags:
- Android
- Lint
- 静态分析
- 代码规范
- Kotlin
seo:
  title: 深入 Android 自定义 Lint 规则全链路：从 UAST 语法树到 Detector 检测器的编译期代码规范自动化实战
  description: 从 UAST 语法树原理到 Detector 实现，系统讲解 Android 自定义 Lint 规则的构建、发布集成与调试，让编译期自动守护代码规范。
---

某个周二下午，Code Review 里第三次出现同一个问题：有人把 `LiveData` 直接暴露给了 Fragment。规范文档写了、周会上强调过、甚至还录了视频教程——但人总会疏忽。

当时我决定把这条规则写进 Lint，让 IDE 在编译期直接报错。

## 为什么是自定义 Lint

Android Lint 是 Google 提供的静态代码分析工具，内置 400 多条检查规则。它的核心价值不在于检查本身，而在于检查的时机——编译期，远早于 Code Review 和 CI。

自定义 Lint 实际能覆盖的场景相当宽：

- 架构约束：禁止模块间直接依赖、限制 API 调用链
- 性能规范：检测主线程 IO、强制使用指定线程池
- 命名约定：要求特定包下类名必须带后缀
- 资源规范：禁止硬编码字符串、检查图片尺寸

我们项目里维护了 20 多条自定义规则，覆盖了从模块依赖到命名约定的方方面面。代码规范不应该依赖人的自觉性。

## 从 UAST 说起

Android Lint 的检测基于 UAST（Universal Abstract Syntax Tree），它是 JetBrains 对 PSI（Program Structure Interface）的一层抽象，跨 Java 和 Kotlin。

PSI 是 IntelliJ 平台的原生 AST 表示。Java 和 Kotlin 的 AST 节点类型完全不同——UAST 在它们之上做了统一封装，让你用一套 API 同时处理两种语言的代码。

```java
// Java 代码
person.setName("Alice");

// Kotlin 代码
person.name = "Alice"
```

这两行代码在 PSI 层面是完全不同的节点类型，但通过 UAST，你都能拿到 `UCallExpression`，用 `receiver` 和 `methodName` 来判断调用目标。

使用 UAST 时不用纠结底层是 Java 还是 Kotlin，把一切当成统一的方法调用和属性访问来处理。大部分场景下，`UElement`、`UCallExpression`、`UReferenceExpression` 这三个就够用了。

## 构建一个实际的 Detector

以一个真实场景为例：禁止 Fragment 直接持有 `MutableLiveData` 引用，强制通过 ViewModel 暴露不可变类型。

### 定义 Issue

```java
val EXPOSE_MUTABLE_LIVE_DATA = Issue.create(
    id = "ExposeMutableLiveData",
    briefDescription = "禁止暴露 MutableLiveData",
    explanation = """
        MutableLiveData 应封装在 ViewModel 内部，
        对外只暴露 LiveData 类型，防止外部直接修改数据。
    """,
    category = Category.CORRECTNESS,
    priority = 8,
    severity = Severity.ERROR,
    implementation = Implementation(
        MutableLiveDataExposeDetector::class.java,
        Scope.JAVA_FILE_SCOPE
    )
)
```

`priority` 从 1 到 10，越高越严重。`Scope.JAVA_FILE_SCOPE` 按文件粒度分析，大多数场景下这是最合适的选择。

### 实现 Detector

```java
class MutableLiveDataExposeDetector : Detector(), SourceCodeScanner {

    override fun getApplicableUastTypes(): List<Class<out UElement>> {
        return listOf(UField::class.java)
    }

    override fun createUastHandler(context: JavaContext): UElementHandler {
        return object : UElementHandler() {
            override fun visitField(node: UField) {
                val type = node.type ?: return
                if (!type.canonicalText.contains("MutableLiveData")) return
                if (node.isPrivate) return  // 私有字段放行

                context.report(
                    issue = EXPOSE_MUTABLE_LIVE_DATA,
                    scope = node,
                    location = context.getLocation(node),
                    message = "将 MutableLiveData 暴露为 ${node.visibility} 可见，" +
                            "应改用 LiveData 或限制为 private"
                )
            }
        }
    }
}
```

`getApplicableUastTypes` 返回你关心的 UAST 节点类型。Lint 框架遍历 AST 时遇到匹配的节点就回调对应的 `visit` 方法。这里只关注 `UField`——类成员变量。

### 注册到 Registry

```java
class CustomIssueRegistry : IssueRegistry() {
    override val issues = listOf(EXPOSE_MUTABLE_LIVE_DATA)

    override val api: Int = CURRENT_API

    override val vendor: Vendor = Vendor(
        vendorName = "Custom Lint Rules",
        feedbackUrl = "https://your-project.com/lint-feedback"
    )
}
```

还需要在 `build.gradle` 里注册：

```groovy
jar {
    manifest {
        attributes('Lint-Registry-v2': 'com.example.lint.CustomIssueRegistry')
    }
}
```

这行配置让 Lint 框架启动时自动加载你的 Registry，缺了它规则不会生效。

## 发布与集成

自定义 Lint 规则要打包成独立的 aar 或 jar，通过 `lintChecks` 依赖引入：

```groovy
dependencies {
    lintChecks project(':lint-checks')
}
```

踩过一个坑：用 Kotlin 写 Lint 规则时，必须把 Kotlin stdlib 一起打进 jar，否则运行时找不到 Kotlin 类。解决方式是 fat jar：

```groovy
tasks.register('fatJar', Jar) {
    from sourceSets.main.output
    from { configurations.runtimeClasspath.collect { 
        it.isDirectory() ? it : zipTree(it) 
    }}
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
```

Lint 规则模块必须独立于业务代码。它只依赖 Lint API（`com.android.tools.lint:lint-api`），不需要引入你的 App 模块。一旦把业务依赖带进来，版本升级时会双双绑定，动弹不得。

## 调试技巧

Lint 开发最让人头疼的是调试。`println` 打日志效率太低，两个实用方法：

**直接用 Gradle 跑单条规则：**

```bash
./gradlew :app:lint --check ExposeMutableLiveData
```

结果输出在 `app/build/reports/lint-results.html`，可以快速验证规则是否命中。

**写单元测试：**

```kotlin
class MutableLiveDataExposeDetectorTest {

    @Test
    fun `should report error when exposing MutableLiveData`() {
        TestLintTask.lint()
            .files(
                TestFiles.java("""
                    package com.example;
                    import androidx.lifecycle.MutableLiveData;
                    
                    public class MyFragment {
                        public MutableLiveData<String> data = new MutableLiveData<>();
                    }
                """.trimIndent())
            )
            .issues(EXPOSE_MUTABLE_LIVE_DATA)
            .run()
            .expectErrorCount(1)
    }
}
```

`TestLintTask` 不需要真机环境，纯本地跑，秒级反馈。我们 15 条规则配了 40 个测试用例，每次改代码跑一遍，心里踏实。

## 这些规则应该谁来写

实际项目里，最了解架构约束的是做架构设计的人，而不是 QA。我更倾向于让模块 Owner 自己写对应模块的 Lint 规则——谁定的规范谁维护。数据库模块禁止主线程操作、网络模块限制重试次数，都应该由模块 Owner 负责。

这有个前提：团队得先把 Lint 框架、Registry 注册、发包流程搭好，降低其他人加规则的门槛。我们那边现在加一条规则大概用不了半小时。

回头想，当初花两天搭完这套自定义 Lint 体系是值的。Code Review 里省掉的噪音比这多得多——机器不会漏，但人会。
