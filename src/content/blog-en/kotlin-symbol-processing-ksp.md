---
title: "Kotlin Symbol Processing: KSP from Annotation Scanning to Code Generation"
lang: en
translationKey: kotlin-symbol-processing-ksp
slug: kotlin-symbol-processing-ksp
excerpt: "A full walkthrough of KSP as a KAPT replacement, from SymbolProcessor and Resolver to CodeGenerator, incremental builds, multiplatform support, and migration."
publishDate: '2026-01-22'
tags:
- "Kotlin"
- "KSP"
- "Compile-Time Metaprogramming"
- "Performance Optimization"
- "Annotation Processing"
seo:
  title: "Kotlin Symbol Processing: KSP from Annotation Scanning to Code Generation"
  description: "Explains how KSP replaces KAPT, skips Java stubs, understands Kotlin symbols, and improves annotation processing performance."
  pageType: article
---

While building a modular routing framework, KAPT compile time grew past 40 seconds. After switching to KSP, it dropped to 6 seconds. The annotation logic did not change; only the processor changed. That gap is worth unpacking.

## Why KAPT Is Slow

To understand KSP, first look at what it replaces. KAPT is essentially a compatibility layer for the Kotlin compiler: the Kotlin compiler first generates Java Stub files, then hands them to Java APT, and finally merges the generated Java code back into the compilation pipeline.

The full path is: Kotlin source code -> Java Stub -> APT processing -> generated Java code -> merged compilation. Stub files contain declarations for classes, methods, and properties, but no method bodies. In a medium-sized project, stub generation alone can take 10-20 seconds.

Java APT is based on Javac's round mechanism, where each round processes a batch of annotations. The Kotlin compiler and Javac are separate processes and exchange data through the file system, so the IO overhead is unavoidable.

KSP skips that whole path. It reads the Kotlin compiler's AST and performs symbol resolution and code generation during the compiler frontend phase. The core difference is that KSP does not downgrade Kotlin into the Java ecosystem. It understands Kotlin syntax natively: extension functions, declaration-site variance, and property delegation are directly modeled. KAPT's stubs either lose or distort those concepts.

## SymbolProcessorProvider: Plugin Registration Entry Point

KSP starts with the `SymbolProcessorProvider` interface. A single function registers the processor:

```kotlin
interface SymbolProcessorProvider {
    fun create(environment: SymbolProcessorEnvironment): SymbolProcessor
}
```

KAPT requires extending `AbstractProcessor` and handling annotations such as `@SupportedAnnotationTypes` and `@SupportedSourceVersion`. KSP's interface is cleaner. `SymbolProcessorEnvironment` contains two key objects, `Resolver` and `CodeGenerator`, plus runtime options and logging.

Registration uses SPI. Under `resources/META-INF/services/`, place a file whose name is the fully qualified name of the interface and whose content is the fully qualified name of the implementation class:

```
// resources/META-INF/services/
// com.google.devtools.ksp.processing.SymbolProcessorProvider
// Content:
// com.example.MyProcessorProvider
```

The Gradle plugin scans this directory for discovery. Unlike KAPT's `@AutoService` annotation plus annotation-processor bootstrapping problem, KSP's SPI is plain file configuration with zero dependencies.

A typical project configuration:

```kotlin
// build.gradle.kts
plugins {
    id("com.google.devtools.ksp") version "2.0.0-1.0.21"
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
```

There is no separate generated-path configuration, and you do not need to clean a stub directory. KSP output participates directly in the later phases of Kotlin compilation.

## Resolver: Symbol Resolution

`Resolver` is KSP's entry point for symbol queries. In KAPT you receive `javax.lang.model.element.Element`; in KSP, symbols are modeled uniformly with `KSNode`.

The two APIs differ greatly in their support for Kotlin features. Take declaration-site variance:

```kotlin
interface Source<T> {
    fun next(): T
}
fun demo(s: Source<String>) {
    // ...
}
```

In KAPT, the type representation for `s` can lose `out` projection information because Java's type system does not have the same concept. KSP's `KSReferenceElement` preserves the full variance information directly.

Core `Resolver` APIs:

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

`getSymbolsWithAnnotation` returns a `Sequence` instead of a `Set`. That works well with Kotlin's `filter` and `map` chains, computes lazily, and avoids loading every symbol into memory at once.

Multi-round processing is an important part of KSP's design. KSP supports up to `KSVersion.CURRENT.maxRoundCount` rounds. Code generated in one round can be resolved in the next round. This solves cases where generated code also contains annotations. Room relies on this mechanism to process annotations on generated implementations of `@Dao` interfaces.

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

The `List<KSAnnotated>` returned by `process()` tells the KSP framework that those symbols are not fully processed yet and should continue in the next round. Return an empty list if you want to stop further processing.

## CodeGenerator: Incremental Compilation and Dependency Management

`CodeGenerator` does more than write strings to files. It manages dependency tracking and incremental compilation.

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

The `dependencies` parameter determines incremental compilation behavior. It tells KSP which source files a generated file depends on. If those source files do not change, KSP can reuse the previous output.

One pitfall cost us an afternoon: we passed a `KSFile` as the dependency but ignored that the file containing the annotation and the files actually involved in generation might be different. Incremental compilation did not trigger regeneration. The correct approach is to pass every source file involved in generating that output:

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

The `aggregating` flag matters. Set it to `true` when an output file aggregates information from multiple sources, so any source change triggers regeneration. Set it to `false` for normal dependency rules. A route table is naturally aggregating, and setting the flag correctly prevents missed regeneration.

## Multiplatform Support

KSP can process annotations for multiple platforms. Write the processor once and register it in `commonMain`, and it can apply to every platform automatically. It does not have KAPT's split where JVM generation feels separate from JS generation.

In one real project, I implemented a serializer processor similar in spirit to `@Serializable`. Common code used KSP to generate serializers for each platform, while Kotlin/JS and Kotlin/Native needed no extra code.

## Migration Practice

Migrating from KAPT does not require changing annotation declarations. The annotations themselves are unaffected. The processor is what you migrate.

First, replace the Gradle plugin:

```kotlin
// Remove
plugins {
    kotlin("kapt")
}
// Replace with
plugins {
    id("com.google.devtools.ksp")
}

// Change dependency declarations from kapt to ksp.
// kapt("com.example:processor:1.0")
// ↓
ksp("com.example:processor:1.0")
```

Second, rewrite the processor. Replace KAPT's `AbstractProcessor` with `SymbolProcessorProvider` plus `SymbolProcessor`, and replace `processingEnv.typeUtils` with `Resolver`. This step usually removes code rather than adding it. You no longer need the model layer, and you no longer need template code for building `TypeMirror` objects.

Third, verify annotation retention. KSP processes both `@Retention(SOURCE)` and `@Retention(BINARY)` annotations by default, while KAPT processes only the former. If your annotation processor depends on runtime annotations, filter them explicitly.

Incremental compilation also becomes more predictable after the move to KSP. KAPT's stub generation often triggers full compilation even in incremental mode. KSP's dependency tracking is precise down to the `KSFile` level. In an annotation-heavy module, full compilation dropped from 55 seconds to 9 seconds, and incremental compilation dropped from 18 seconds to 2 seconds.

KSP is not just a faster version of KAPT. It is a shift in design philosophy: understand Kotlin code from the compiler's native point of view instead of downgrading it to Java's representation layer. Annotation processing changes from "an extra compilation step" into "part of the compiler frontend." That is the real source of the speedup.
