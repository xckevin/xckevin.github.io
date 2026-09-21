---
title: 'Android Reflection Under the Hood: Hidden API Greylist Bypass to Runtime Dynamic Proxy Metaprogramming'
lang: en
translationKey: android-reflection-hidden-api-dynamic-proxy
slug: android-reflection-hidden-api-dynamic-proxy
excerpt: Starting from a NoSuchMethodException crash, this article examines how Android's reflection mechanism works at the ART layer, the filtering logic of the three-tier hidden API greylist, and the applicable boundaries of three bypass approaches — meta-reflection replacement, setHiddenApiExemptions, and clearing flag bits via JNI — then discusses dynamic proxy production engineering and the engineering trade-offs of metaprogramming.
publishDate: '2026-08-11'
tags:
- Android
- Reflection
- Dynamic Proxy
- Hidden API
- ART
seo:
  title: Android Reflection & Hidden API Bypass to Dynamic Proxy
  description: Explore Android reflection internals, hidden API greylist bypass techniques, and dynamic proxy engineering trade-offs.
  pageType: article
---

## A Crash That Sparked a Deep Investigation

Two years ago I was building a system-level tool that needed to intercept IPC calls to `ActivityManagerService`. The code was written, but the reflective call to `IActivityManager.Stub.asInterface()` crashed immediately:

```
java.lang.NoSuchMethodException: android.app.IActivityManager$Stub.asInterface []
```

Enumerating the method table with `getDeclaredMethods()` showed that this method was clearly present on Android 9, but on Android 10 it had simply vanished. AOSP hadn't deleted it — it had been swallowed by the **hidden API restriction mechanism**.

That crash ultimately led me down a complete path: from the underlying principles of reflection, through greylist bypass, to the production engineering of dynamic proxies.

## The Essence of Reflection: Linear Lookup in the Method Table

The core logic of reflection isn't mysterious. `Class.getDeclaredMethod()` ultimately reaches the native layer inside ART:

```java
// java.lang.Class → art/runtime/native/java_lang_Class.cc
public Method getDeclaredMethod(String name, Class<?>... parameterTypes) {
    return getMethod(name, parameterTypes, false); // false = 不递归父类
}
```

In ART, every Class object maintains an `ArtMethod` array ordered by declaration. Reflective lookup performs linear matching over this array: it compares the method name and parameter type signature (Signature) one by one, returns a `Method` object on a match, and throws an exception if the traversal ends without finding anything.

**Android 9 introduced a key change**: Google inserted a filter into this lookup process. The method is indeed in the array, but before lookup it calls `ShouldDenyAccessToMember()` (in `art/runtime/hidden_api.cc`), which reads the hidden API flag bits embedded in `ArtMethod.access_flags_` and determines whether the current caller has permission to see the method. If not, the method is treated as nonexistent.

## Three Tiers of the Greylist

Google divided non-SDK interfaces into four levels, maintained in CSV files under `frameworks/base/config/hiddenapi-*`:

| Level | Flag bits | Android 9 behavior | Android 10+ behavior |
|------|--------|---------------|------------------|
| whitelist | 0 | Allowed | Allowed |
| greylist | 1 | Toast warning | Toast warning |
| greylist-max-o | 2 | Toast warning | **Blocked** |
| blacklist | 3 | Blocked | Blocked |

On Android 9 the greylist was still relatively lenient — it showed a toast reminder and let you through. By Android 10, `greylist-max-o` was promoted straight to blacklist status — that is the root cause of the widespread `NoSuchMethodException`.

The check also layers on a **domain** dimension: code on the boot classpath is unrestricted, the system server is next, and ordinary apps face the strictest rules. The same hidden method can be called by a system service but not by your app.

## Three Routes Around the Greylist

### Route 1: Meta-reflection to Replace the ArtMethod

First proposed by weishu's FreeReflection, the idea is clever: since the check logic reads the flag bits of the ArtMethod, "borrow" an ArtMethod structure whose flag bits mark it as whitelist and replace only the method entry address inside it.

```java
// 1. 找到 Method 对象内部引用的 ArtMethod 字段
Field artMethodField = Method.class.getDeclaredField("artMethod");
artMethodField.setAccessible(true);
// 2. 拿白名单方法的 ArtMethod 结构
Object whiteArtMethod = artMethodField.get(getDeclaredMethod);
// 3. 塞给目标 Method 对象，直接把目标方法整个指向白名单方法的 ArtMethod
artMethodField.set(targetMethod, whiteArtMethod);
```

One easy misconception needs correcting: this does not "clear only the hidden API flag bits while preserving the target method's execution logic." What it actually does is **point the target `Method` object entirely at the whitelist method's `ArtMethod` structure** — including its method entry address, parameter types, return type, and all other information. After calling `artMethodField.set(targetMethod, whiteArtMethod)`, the `targetMethod` object has effectively become a "shell disguised as a whitelist method." The real reason the check is bypassed is that the check logic only looks at the `ArtMethod` flag bits, and this structure now comes wholly from the whitelist method. FreeReflection actually only needs any accessible SDK method as a "reinforcement" (commonly `Class.getDeclaredMethod` itself) to obtain a valid `ArtMethod`; it doesn't need to actually execute that method, because the goal is only to "obtain an ArtMethod reference that can pass the check." The method you actually want to call later still has to be genuinely executed through some other means (such as the original Method reference kept when the reflection was created). This approach therefore applies to "bypassing the discovery-phase check (such as `getDeclaredMethod` itself)" rather than modifying the execution logic of the target method itself.

### Route 2: setHiddenApiExemptions

The half-open door left after Android 10:

```java
Method exemptMethod = Class.forName("dalvik.system.VMRuntime")
    .getDeclaredMethod("setHiddenApiExemptions", String[].class);
VMRuntime runtime = VMRuntime.getRuntime();
exemptMethod.invoke(runtime, (Object) new String[]{"L"});
```

Passing `"L"` exempts all classes from the check. This method is itself a public API and can be invoked via reflection directly, but whether it actually takes effect is strictly constrained: it mainly applies to **debuggable apps (`android:debuggable="true"`)** or test processes launched through instrumentation. Calling it on a normal release-signed package does not guarantee the restriction is actually lifted — the platform still enforces hidden API restrictions on non-debuggable apps. This route is therefore basically only usable for local debugging, internal test tools, or debug build artifacts in CI; don't count on it working in a release package shipped to production.

### Route 3: Clearing the Flag Bits Directly via JNI

The ultimate tool when you have native capability:

```cpp
void bypass(JNIEnv* env, jobject method) {
    void* art_method = env->FromReflectedMethod(method);
    // 根据 Android 版本定位 access_flags 偏移量
    uint32_t* flags = (uint32_t*)((char*)art_method + offset_map[sdk_int]);
    *flags &= ~kAccHiddenApiBits; // 直接抹掉隐藏标记位
}
```

The cost is **version-adaptation hell**. The `ArtMethod` structure may change on every Android version, and the offset of `access_flags` differs. In my project I maintained an offset mapping table from API 21 to 35, and every major version upgrade required running tests first to confirm it. The deepest pit I hit was during the Android 13 beta, when three consecutive preview builds changed the structure three times.

## Dynamic Proxy in Production

Why bother bypassing hidden APIs? In 80% of the cases I've seen, it's to construct a dynamic proxy that intercepts system service calls.

The standard path: obtain the Binder returned by `IActivityManager.Stub.asInterface()` → wrap it with `Proxy.newProxyInstance()` → inject logic in the `InvocationHandler`:

```java
Object original = asInterfaceMethod.invoke(null, binder);
Object proxy = Proxy.newProxyInstance(
    original.getClass().getClassLoader(),
    original.getClass().getInterfaces(),
    (proxyObj, method, args) -> {
        if ("startActivity".equals(method.getName())) {
            // 植入 Intent 修改或日志记录
        }
        return method.invoke(original, args);
    }
);
```

One easy pitfall: **the Java-layer `invoke()` and the Binder-layer `transact()` are two separate proxy layers.** If some caller bypasses the Java interface and sends a raw Parcel directly via `Binder.transact()`, your Proxy can't intercept it at all. You need to also wrap the Binder's `mRemote` field:

```java
Field remoteField = Binder.class.getDeclaredField("mRemote");
remoteField.setAccessible(true);
IBinder originalRemote = (IBinder) remoteField.get(binder);
remoteField.set(binder, new BinderProxyDelegate(originalRemote));
```

A clarification is warranted: the reliability of this approach shouldn't be overestimated. `mRemote` is likewise an AOSP internal implementation detail; whether the field lives in `android.os.Binder` (the local implementation) or `android.os.BinderProxy` (the remote proxy), and its exact type and name, can vary across Android versions. In earlier versions the relevant implementation relied more on the native-layer `IBinder` pointer, and there is no guarantee the same field name can be located on every Android major version. When actually integrating, you need to verify it one by one on your target device matrix and degrade gracefully when the field doesn't exist or reflection fails — don't treat it as a fixed scheme that succeeds on every device and version.

## The Engineering Boundaries of Metaprogramming

After doing Android metaprogramming for so long, my verdict is: **reflection and dynamic proxies are scalpels, not everyday tools.**

Only three kinds of scenarios suit them. Debugging-tool development, injecting only into debug builds and fully removing it at release. System-level modules — plugin frameworks, hot fixes, permission management, and other low-level components that can't avoid hidden APIs. Temporary patches, urgently working around system bugs and removing them after the official fix.

The unsuitable scenarios are actually more numerous. Using reflection to replace normal calls in business logic only buys runtime performance overhead and stability risk. Long-term dependent frameworks — every Android major version requires adaptation, and maintenance costs grow exponentially. Apps listed on Google Play — since 2023 Google has begun scanning for hidden API calls, and Android 14 even prints the call stack in logcat and uploads it to the privacy dashboard.

In every module that uses hidden APIs, I added an upper-bound guard:

```java
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
    Logger.w("unsupported, fallback to public API");
    return usePublicApiFallback();
}
```

No matter how clever today's bypass scheme is, it may stop working in the next Android version. Leaving yourself an escape route matters far more than finding a shortcut.
