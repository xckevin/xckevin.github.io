---
title: "Android Bytecode Instrumentation with ASM and Gradle Plugins"
lang: en
translationKey: android-bytecode-instrumentation-asm-gradle
slug: android-bytecode-instrumentation-asm-gradle
excerpt: "A full walkthrough of Android compile-time bytecode instrumentation, from Gradle Plugin entry points and ASM visitors to page monitoring, privacy logs, and method timing."
publishDate: '2026-05-17'
tags:
- "Android"
- "ASM"
- "Gradle"
- "Bytecode Instrumentation"
- "AOP"
seo:
  title: "Android Bytecode Instrumentation: ASM ClassVisitor, Gradle Plugin, and Compile-Time AOP"
  description: "Learn Android compile-time bytecode instrumentation with Gradle Plugins and ASM visitors for page monitoring, privacy logging, method timing, and pitfalls."
---

While building an APM SDK, I ran into a difficult requirement: measure the `onCreate` duration for every page without asking product teams to add manual tracking in every `Activity`. Runtime Hook approaches were heavily constrained by Hidden API restrictions on Android 9 and later, so the only practical option was compile-time bytecode instrumentation.

Once that path worked, it became clear that compile-time AOP can do much more than performance monitoring. This article walks through the full path from Gradle Plugin entry points to ASM bytecode manipulation, plus three production scenarios.

## Instrumentation entry point: from Transform to AsmClassVisitorFactory

The core question in Gradle instrumentation is: **at which compilation stage, and through which API, do we access bytecode?**

Before AGP 7.0, the answer was the Transform API. It was essentially a task-chain hook that intercepted bytecode before classes were converted to DEX:

```groovy
// AGP 4.x Transform approach
class MyTransform extends Transform {
    @Override
    String getName() { return "bytecode-hook" }
    
    @Override
    void transform(TransformInvocation invocation) {
        invocation.inputs.each { input ->
            input.directoryInputs.each { dir ->
                // Walk .class files and process them with ASM.
            }
        }
    }
}
```

The problem with this API was obvious: **poor incremental build support**. It often had to scan all files on every build, which does not scale in large projects. Transform was deprecated in AGP 7.0 and removed completely in AGP 8.0.

The replacement is **AsmClassVisitorFactory**, which registers directly into AGP's bytecode processing pipeline:

```kotlin
// Recommended approach for AGP 7.0+
abstract class TimingClassVisitorFactory : AsmClassVisitorFactory<InstrumentationParameters.None> {
    override fun createClassVisitor(
        classContext: ClassContext,
        nextClassVisitor: ClassVisitor
    ): ClassVisitor {
        return TimingClassVisitor(nextClassVisitor)
    }

    override fun isInstrumentable(classData: ClassData): Boolean {
        // Process only classes under the target package to avoid unnecessary traversal.
        return classData.className.startsWith("com/example/app")
    }
}
```

Registration also moves from `android.registerTransform()` to a declarative style:

```kotlin
class MyPlugin : Plugin<Application> {
    override fun apply(project: Project) {
        project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
            .onVariants { variant ->
                variant.instrumentation.transformClassesWith(
                    TimingClassVisitorFactory::class.java,
                    InstrumentationScope.ALL
                ) {}
                variant.setAsmFramesComputationMode(FramesComputationMode.COMPUTE_FRAMES)
            }
    }
}
```

`isInstrumentable` is critical for performance. Filtering by class name here avoids creating many unnecessary `ClassVisitor` instances. In real projects, I usually read a whitelist dynamically from `gradle.properties` instead of hardcoding package names.

## ASM core: bytecode manipulation through the Visitor pattern

ASM is fundamentally an **event-driven Visitor chain**. `ClassReader` reads bytecode and invokes the `visit` methods on `ClassVisitor` in order. By inserting your own `ClassVisitor` into the chain, you can intercept and modify bytecode.

The two most common hooks look like this:

```kotlin
class MethodTimingVisitor(
    api: Int,
    next: ClassVisitor,
    private val targetMethods: Set<String>
) : ClassVisitor(api, next) {
    
    override fun visitMethod(
        access: Int, name: String, descriptor: String,
        signature: String?, exceptions: Array<out String>?
    ): MethodVisitor {
        val mv = super.visitMethod(access, name, descriptor, signature, exceptions)
        return if (name in targetMethods) {
            TimingMethodVisitor(api, mv, access, name, descriptor)
        } else mv
    }
}
```

The key design choice is to decide inside `visitMethod` whether to wrap the `MethodVisitor`. If the method is not in the target set, return the parent's `MethodVisitor` directly and skip with zero instrumentation overhead.

The actual code injection happens inside `MethodVisitor`:

```kotlin
class TimingMethodVisitor(
    api: Int, mv: MethodVisitor,
    private val access: Int, private val name: String, private val desc: String
) : MethodVisitor(api, mv) {
    
    override fun visitCode() {
        // Method entry: insert startTime = System.currentTimeMillis().
        mv.visitMethodInsn(INVOKESTATIC, "java/lang/System", "currentTimeMillis", "()J", false)
        val startLocal = if ((access and ACC_STATIC) != 0) 0 else 1
        mv.visitVarInsn(LSTORE, startLocal)
        super.visitCode()
    }

    override fun visitInsn(opcode: Int) {
        // Insert duration calculation before RETURN, ARETURN, and similar instructions.
        if (opcode in Opcodes.IRETURN..Opcodes.RETURN || opcode == Opcodes.ATHROW) {
            mv.visitMethodInsn(INVOKESTATIC, "java/lang/System", "currentTimeMillis", "()J", false)
            // Subtract the method-entry timestamp and report the result.
            // ...
        }
        super.visitInsn(opcode)
    }
}
```

One pitfall matters a lot: **local variable indexes start at 0 for static methods and 1 for instance methods** because slot 0 is `this` for instance methods. Hardcoding the index can make verification fail after instrumentation. Use `(access and ACC_STATIC) != 0` to decide dynamically.

## In practice: one instrumentation framework for three scenarios

After abstracting the mechanics above, I built a configurable instrumentation framework covering three scenarios.

**Scenario 1: page performance monitoring.** Inject timing into `Activity` and `Fragment` lifecycle methods. `visitCode` records a timestamp, and `visitInsn` calculates duration before `RETURN`, then reports it through a utility class to the APM module. Business code stays untouched, and integration cost is one plugin dependency.

**Scenario 2: privacy compliance logging.** Insert logs before and after sensitive API calls such as `getDeviceId` and `getMacAddress`:

```kotlin
// Goal: insert a log before TelephonyManager.getDeviceId().
override fun visitMethodInsn(
    opcode: Int, owner: String, name: String, descriptor: String, isInterface: Boolean
) {
    if (owner == "android/telephony/TelephonyManager" && name == "getDeviceId") {
        // Insert Logger.log("getDeviceId was called") before the call.
        mv.visitLdcInsn("getDeviceId was called")
        mv.visitMethodInsn(INVOKESTATIC, "com/example/Logger", "log", 
            "(Ljava/lang/String;)V", false)
    }
    super.visitMethodInsn(opcode, owner, name, descriptor, isInterface)
}
```

Compared with runtime Hooking, compile-time injection does not depend on reflection, is not constrained by Hidden API limits, and still works on Android 14.

**Scenario 3: method duration tracing.** Automatically inject tracing into methods annotated with a custom `@Trace` annotation. `AnnotationVisitor` reads annotation metadata, decides whether to wrap the `MethodVisitor`, and provides declarative tracking.

All three scenarios share the same `ClassVisitor` chain. Configuration decides which injection strategy to use, and different variants such as debug and release can enable different rules.

## Engineering pitfalls

Several issues came up in production.

**Stack Map Frame computation.** Java 7+ bytecode requires stack map frames at jump instructions. After ASM instrumentation changes the bytecode structure, existing frame information may become invalid. The fix is to call `setAsmFramesComputationMode(FramesComputationMode.COMPUTE_FRAMES)` during registration and let ASM recompute frames. The cost is roughly a 5% to 10% build-time increase.

**Race conditions in multi-module parallel compilation.** If instrumentation logic depends on global state, such as a method ID generator, parallel compilation can break it. My approach is to scope state to the Variant level and rely on `variant.instrumentation` isolation for safety.

**Incremental build cache invalidation.** When the result of `isInstrumentable` changes, AGP automatically recompiles affected classes. But if the `ClassVisitor` reads an external file, such as a config file, AGP will not notice that change by itself. Pass the config file hash through `InstrumentationParameters` so config changes invalidate the cache.

Compile-time AOP trades build time for runtime efficiency and cleaner application code. If your priority is maximum build speed, enable instrumentation only for core modules. If you need non-invasive monitoring, this approach is worth the investment.
