---
title: "Android Plugin Architecture: ClassLoader Loading to Shadow"
lang: en
translationKey: android-plugin-architecture-classloader-shadow
slug: android-plugin-architecture-classloader-shadow
excerpt: "A deep dive into Android plugin architecture, from DexClassLoader dynamic loading and component proxies to resource isolation, native libraries, and Shadow."
publishDate: '2025-10-28'
tags:
- "Android"
- "Plugin Architecture"
- "ClassLoader"
- "VirtualAPK"
- "Shadow"
seo:
  title: "Android Plugin Architecture: ClassLoader, Proxies, Resources, and Shadow"
  description: "Explore Android plugin architecture from DexClassLoader and Activity proxies to resource isolation, native libraries, and Shadow's no-reflection design."
  pageType: article
---

In 2018, I took over the pluginization effort for an e-commerce app. The APK had already passed 80 MB, release cycles had stretched from two weeks to a month, and business teams were suffering. We first adopted VirtualAPK, ran it for more than half a year, hit a full round of issues, and then moved to Shadow. The hard part of Android plugin architecture is not class loading. It is negotiating with the Android framework.

## Dynamic ClassLoader loading: the starting point of every plugin system

The essence of pluginization is loading external dex files at runtime so the host can call classes inside a plugin. Java's class loading model supports this naturally. You only need a `DexClassLoader` pointing at the plugin APK.

```java
DexClassLoader pluginLoader = new DexClassLoader(
    pluginApkPath,          // Plugin APK path
    optimizedDir,           // Dex optimization output directory
    null,                   // No native lib directory; handled separately later
    context.getClassLoader() // Parent loader is the host ClassLoader
);
```

Call `loadClass("com.plugin.MainActivity")`, and a class from the plugin can be instantiated. The parent delegation model determines the lookup order, and `DexPathList` maintains the dex search list. Once the plugin dex is inserted, classes can be found. But Android-specific pieces such as Activity lifecycle, Context, and resources do not come along with it. The trouble starts there.

## Four-component proxying: the hardest part

Class loading only lets you `new` an object from a plugin class. Android's four major components - Activity, Service, BroadcastReceiver, and ContentProvider - must be registered in `AndroidManifest.xml` and scheduled by the system process. A plugin Activity has never been registered, so calling `startActivity` directly only produces `ActivityNotFoundException`.

### Stub components and proxies

VirtualAPK's idea is direct: pre-register a set of stub Activities in the host Manifest, intercept the launch flow, replace the plugin Activity with a host-side StubActivity to pass system validation, and then swap the real instance back after system creation finishes.

```text
User calls startActivity(pluginActivity)
    -> Intercepted in Instrumentation.execStartActivity()
    -> Intent replaced with a pre-registered host StubActivity
    -> AMS validation passes and creates StubActivity
    -> Intercepted in the ActivityThread callback
    -> Replaced by reflection with the real PluginActivity instance
```

Pre-launch replacement goes through `Instrumentation.execStartActivity()`. Post-creation replacement goes through `ActivityThread.mH.mCallback`. VirtualAPK chose the former, while RePlugin used the latter. Each has different tradeoffs.

### Managing plugin Activity lifecycle

After the system creates the stub Activity, its lifecycle callbacks must be delegated to the real plugin Activity. But the plugin Activity did not go through the full AMS flow, so internal fields such as `mToken`, `mApplication`, and `mWindow` are empty. `findViewById` cannot find the right View, and `getIntent` does not return the original Intent.

VirtualAPK treats the stub Activity as a shell, manually creates the plugin Activity instance, forwards system callbacks, and injects required internal fields:

```java
// Inside StubActivity.onCreate()
Reflect.on(pluginActivity)
    .set("mApplication", getApplication())
    .set("mToken", getActivityToken())
    .set("mWindow", getWindow());

pluginActivity.attach(
    getBaseContext(),    // Must be replaced with the plugin Context
    getActivityToken(),
    getApplication(),
    getIntent()           // Must be restored to the original Intent
);
pluginActivity.onCreate(savedInstanceState);
```

At this point, lifecycle forwarding is only partly solved. As soon as `getResources()`, `getAssets()`, or `getClassLoader()` is involved, the problem moves to resource partitioning.

## Resource partitioning: every plugin has its own R-file universe

In the generated Android `R` file, resource IDs increase globally, so the host and plugin inevitably collide. `findViewById(R.id.title)` might return a completely different View from the host.

### Building an independent Resources object for each plugin

Create a separate `Resources` object for every plugin so resource lookup stays inside that plugin APK:

```java
AssetManager assetManager = AssetManager.class.newInstance();
Method addAssetPath = AssetManager.class.getDeclaredMethod("addAssetPath", String.class);
addAssetPath.invoke(assetManager, pluginApkPath);

Resources pluginResources = new Resources(
    assetManager,
    hostResources.getDisplayMetrics(),
    hostResources.getConfiguration()
);
```

`addAssetPath` is a hidden API, but Android's resource loading mechanism depends on it, so frameworks call it through reflection. Once the plugin APK path is added, the plugin `Resources` object can independently resolve layouts, strings, and assets inside that APK.

### Context replacement

Every plugin call to `context.getResources()` must receive the plugin's dedicated `Resources`. `LayoutInflater` is the easiest place to break: `LayoutInflater.from(context)` internally calls `context.getResources()`. If that context is still the host Context, plugin custom Views will never inflate correctly.

The usual solution is a custom `PluginContextWrapper` that overrides `getResources()`, `getClassLoader()`, and `getAssets()`, pointing every API entry for View creation and resource loading to the plugin implementation.

```java
class PluginContextWrapper extends ContextWrapper {
    private Resources mPluginResources;
    private ClassLoader mPluginClassLoader;

    @Override
    public Resources getResources() {
        return mPluginResources;
    }

    @Override
    public ClassLoader getClassLoader() {
        return mPluginClassLoader;
    }
}
```

## SO isolation: native library loading paths

`.so` files shipped inside a plugin cannot be loaded directly with `System.loadLibrary()`, because that method only searches the default native library paths. `DexClassLoader` has a `librarySearchPath` constructor parameter, but after Android 7.0, the system added restrictions around loading `.so` files from private directories. Directly specifying a path often breaks.

A more stable approach is to unpack plugin `.so` files into a designated directory and call `System.load()` with the full path. For native libraries with dependencies, such as libA depending on libB, libB must be loaded first. Shadow later took a more thorough approach by moving all `.so` loading from `System.loadLibrary` into its own `nativeLibraryDirectories` management, avoiding collisions with host native libraries.

```java
// Unpack plugin SO files into a designated directory
File soDir = new File(context.getDir("plugin_so", Context.MODE_PRIVATE), "armeabi-v7a");
// ... unpacking logic ...

// Load in dependency order
System.load(new File(soDir, "libB.so").getAbsolutePath()); // Load dependency first
System.load(new File(soDir, "libA.so").getAbsolutePath()); // Then load dependent library
```

## From VirtualAPK to Shadow: the limits of reflection-based designs

VirtualAPK, RePlugin, and DroidPlugin belong to a generation of frameworks built around reflection plus dynamic proxying. They dig into Android framework private APIs and hijack system call paths to implement plugin behavior. Before Android 9, this worked reasonably well. Starting with Android 9, Google tightened hidden API access, and every platform upgrade brought compatibility problems.

One real issue I hit: Android 10's greylist mechanism suddenly broke a critical reflection call. A plugin system that had been stable started crashing widely after an OTA. After that kind of incident, you seriously consider a different architecture.

Shadow's core idea is to avoid reflection and use a host-plugin dual-compilation model, moving proxy logic to build time. Shadow defines three roles:

- **Manager** controls launch timing and decides when to load which plugin
- **Loader** handles dex loading, resource initialization, and `.so` management
- **PluginContainer** receives Manager commands inside the plugin process and proxies plugin lifecycle

The key difference is that Shadow does not use Intent and system Binder communication to launch plugin Activities. Instead, it fully takes over plugin-process creation and component management. Plugin Activity lifecycle is driven directly by `PluginContainer`, without going through AMS. Resource partitioning is handled by `ShadowResources` generated during plugin compilation, so runtime reflection is not needed to construct `AssetManager`.

The cost is higher integration complexity. Plugins must depend on Shadow's Gradle Plugin and compile through a modified packaging flow. The payoff is direct: no dependency on private APIs, and far fewer Android version-upgrade problems. We did not keep patching VirtualAPK for another reason as well: Shadow was maintained by the Mobile QQ team and had already been validated on hundreds of millions of devices.

## Practical choices for plugin architecture

By 2026, Google Play Dynamic Delivery and domestic ecosystems such as quick apps and mini programs have taken over many pluginization use cases. Large apps have also moved away from the model of "one host plus dozens of business plugins" toward a more pragmatic hybrid architecture: use AAB/App Bundle on-demand delivery for core flows, use independent mini-program containers for non-core business, and keep native plugins only for features that truly need deep performance optimization or system-level integration.

If I were choosing again today, I would look at three things: team size, device compatibility requirements, and long-term maintenance cost. For teams under ten people, do not build a plugin framework from scratch; use a mini-program container. For large companies that must support old devices for more than five years, Shadow remains the first choice. For mid-sized teams that want pluginization but are short on people, consider Atlas or split business modules with Android App Bundle. Not every scenario needs dynamic deployment. In many cases, "physical split plus plugin loading" is already enough.
