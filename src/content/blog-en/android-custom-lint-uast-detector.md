---
title: "Android Custom Lint Rules: From UAST Trees to Detector Implementation"
lang: en
translationKey: android-custom-lint-uast-detector
slug: android-custom-lint-uast-detector
excerpt: "A practical end-to-end guide to Android custom Lint rules, covering UAST, Detector implementation, packaging, integration, and debugging."
publishDate: '2025-12-26'
tags:
- "Android"
- "Lint"
- "Static Analysis"
- "Code Standards"
- "Kotlin"
seo:
  title: "Android Custom Lint Rules: From UAST Trees to Detector Implementation"
  description: "Learn how to build Android custom Lint rules with UAST, implement Detectors, package checks, integrate them into builds, and debug them effectively."
  pageType: article
---

One Tuesday afternoon, the same issue appeared in code review for the third time: someone exposed `LiveData` directly to a Fragment. We had written the guideline, repeated it in weekly meetings, and even recorded a tutorial. People still miss things.

That was when I decided to encode the rule in Lint and let the IDE fail it during compilation.

## Why custom Lint

Android Lint is Google's static code analysis tool. It ships with more than 400 built-in checks. Its real value is not just the checks themselves, but when they run: at compile time, long before code review and CI become the backstop.

Custom Lint can cover a surprisingly wide range of cases:

- Architecture constraints: block direct dependencies between modules or restrict API call chains
- Performance rules: detect main-thread IO or require specific thread pools
- Naming conventions: require classes under a package to use a specific suffix
- Resource rules: block hardcoded strings or check image dimensions

In our project, we maintained more than 20 custom rules covering everything from module dependencies to naming conventions. Code standards should not depend on human discipline.

## Starting with UAST

Android Lint detection is based on UAST, short for Universal Abstract Syntax Tree. UAST is JetBrains' abstraction over PSI, or Program Structure Interface, and it works across Java and Kotlin.

PSI is the native AST representation used by the IntelliJ platform. Java and Kotlin have completely different AST node types. UAST wraps both of them behind a unified model, so one API can inspect code written in either language.

```java
// Java code
person.setName("Alice");

// Kotlin code
person.name = "Alice"
```

At the PSI level, these two lines are entirely different node types. Through UAST, however, both can be represented as a `UCallExpression`, letting you inspect the target through `receiver` and `methodName`.

When working with UAST, do not overthink whether the underlying code is Java or Kotlin. Treat everything as unified method calls and property accesses. In most cases, `UElement`, `UCallExpression`, and `UReferenceExpression` are enough.

## Building a real Detector

Take a real rule as an example: prevent a Fragment from directly holding a `MutableLiveData` reference, and require immutable exposure through a ViewModel instead.

### Define the Issue

```kotlin
val EXPOSE_MUTABLE_LIVE_DATA = Issue.create(
    id = "ExposeMutableLiveData",
    briefDescription = "Do not expose MutableLiveData",
    explanation = """
        MutableLiveData should be encapsulated inside the ViewModel.
        Expose only LiveData to prevent external mutation.
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

`priority` ranges from 1 to 10; higher means more severe. `Scope.JAVA_FILE_SCOPE` analyzes code at file granularity, which is the right choice for most rules.

### Implement the Detector

```kotlin
class MutableLiveDataExposeDetector : Detector(), SourceCodeScanner {

    override fun getApplicableUastTypes(): List<Class<out UElement>> {
        return listOf(UField::class.java)
    }

    override fun createUastHandler(context: JavaContext): UElementHandler {
        return object : UElementHandler() {
            override fun visitField(node: UField) {
                val type = node.type ?: return
                if (!type.canonicalText.contains("MutableLiveData")) return
                if (node.isPrivate) return  // Allow private fields

                context.report(
                    issue = EXPOSE_MUTABLE_LIVE_DATA,
                    scope = node,
                    location = context.getLocation(node),
                    message = "MutableLiveData is exposed with ${node.visibility} visibility. " +
                            "Use LiveData or restrict it to private."
                )
            }
        }
    }
}
```

`getApplicableUastTypes` returns the UAST node types you care about. As the Lint framework traverses the AST, it calls the corresponding `visit` method when it finds a matching node. This rule only cares about `UField`, which represents class fields.

### Register it in the Registry

```kotlin
class CustomIssueRegistry : IssueRegistry() {
    override val issues = listOf(EXPOSE_MUTABLE_LIVE_DATA)

    override val api: Int = CURRENT_API

    override val vendor: Vendor = Vendor(
        vendorName = "Custom Lint Rules",
        feedbackUrl = "https://your-project.com/lint-feedback"
    )
}
```

You also need to register it in `build.gradle`:

```groovy
jar {
    manifest {
        attributes('Lint-Registry-v2': 'com.example.lint.CustomIssueRegistry')
    }
}
```

This manifest entry lets the Lint framework automatically load your Registry at startup. Without it, the rule will never run.

## Publishing and integration

Custom Lint rules should be packaged as a standalone AAR or JAR and pulled in through a `lintChecks` dependency:

```groovy
dependencies {
    lintChecks project(':lint-checks')
}
```

One pitfall I hit: when Lint rules are written in Kotlin, the Kotlin stdlib must be packaged into the JAR. Otherwise, the runtime cannot find Kotlin classes. The fix is a fat JAR:

```groovy
tasks.register('fatJar', Jar) {
    from sourceSets.main.output
    from { configurations.runtimeClasspath.collect {
        it.isDirectory() ? it : zipTree(it)
    }}
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
```

The Lint rule module must stay independent from business code. It should depend only on the Lint API, such as `com.android.tools.lint:lint-api`, and it does not need to import your App module. Once business dependencies leak into the rule module, framework upgrades and app upgrades become tied together, making both harder to move.

## Debugging tips

Debugging is the most painful part of Lint development. `println` logs are too slow. Two techniques are much more useful.

**Run one rule directly with Gradle:**

```bash
./gradlew :app:lint --check ExposeMutableLiveData
```

The result is written to `app/build/reports/lint-results.html`, which lets you quickly verify whether the rule matched.

**Write unit tests:**

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

`TestLintTask` does not need a device. It runs locally and gives feedback in seconds. We had 40 test cases for 15 rules, and running them after every change made the rule set much easier to trust.

## Who should write these rules

In a real project, the people who understand the architecture constraints best are the people designing the architecture, not QA. I prefer having each module owner write the Lint rules for that module. Whoever defines the standard should maintain it. If the database module blocks main-thread access, or the network module limits retry behavior, the module owner should own those checks.

There is one prerequisite: the team needs to set up the Lint framework, Registry wiring, and package publishing flow first, so adding a rule is easy for everyone else. In our setup, adding a new rule now takes less than half an hour.

Looking back, spending two days to build the custom Lint system was worth it. It removed far more code review noise than it cost. Machines do not forget rules; people do.
