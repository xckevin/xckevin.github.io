---
title: Android 动态模块化交付全链路：从 App Bundle 构建到 SplitCompat 运行时加载的按需分发架构
excerpt: 深入解析 Android 动态模块化交付全链路，涵盖 App Bundle 构建拆分、SplitCompat ClassLoader 注入机制、Play Feature Delivery 按需分发，以及包体积优化的实战踩坑与收益。
publishDate: '2026-05-24'
tags:
- Android
- App Bundle
- 动态模块化
- SplitCompat
- 性能优化
seo:
  title: Android 动态模块化交付全链路：从 App Bundle 构建到 SplitCompat 运行时加载的按需分发架构
  description: 从 App Bundle 构建、Split APK 生成到 SplitCompat ClassLoader 注入与 Play Feature Delivery 按需分发，全面解析 Android 动态模块化交付体系，包含反射修改 parent 链原理、资源加载、MultiDex 兼容与包体积优化实战。
---

去年接手一个海外项目时，APK 已经膨胀到 120MB。砍代码、压缩资源效果有限，真正的突破口是把"用户现在用不到的东西"拆出去——这就涉及 Android 动态模块化交付体系。下面从 App Bundle 构建、Split APK 生成，到 SplitCompat 运行时加载和 Play Feature Delivery 按需安装，把完整链路串一遍。

## App Bundle 的本质：编译期拆分而非打包期

传统 APK 构建将所有代码和资源打进一个文件。App Bundle（AAB）改变了这个逻辑：**构建产物不再是可安装的 APK，而是一个包含所有模块原始资源的中间格式**。

```bash
# 构建 AAB，不再是 assembleRelease
./gradlew bundleRelease
# 产物：app/build/outputs/bundle/release/app.aab
```

AAB 内部结构的关键在 `BundleConfig.pb` 和 `splits/` 目录：

```
app.aab
├── BundleConfig.pb          # 描述模块拆分策略
├── base/                    # 基础模块（始终安装）
│   ├── manifest/
│   ├── dex/
│   └── res/
├── feature1/                # 动态功能模块
└── feature2/
```

Google Play 收到 AAB 后，根据目标设备配置（屏幕密度、CPU 架构、语言）**重新签名**生成一组 Split APK。base APK 始终交付，其他 Split APK 按条件分发。这意味着你不需要为 x86 和 arm64 各打一个包——Play 会自动裁剪。

我踩过的一个坑：manifest 中 `android:extractNativeLibs` 如果设为 false，Split APK 中的 .so 文件无法按预期加载，必须额外处理。原因是 Split APK 的 native lib 路径不参与标准提取流程。

## SplitCompat：绕过 ClassLoader 双亲委派

动态模块的代码不在 base.apk 中，运行时如何加载其中的类？Android 的标准 ClassLoader 使用双亲委派模型——`PathClassLoader` 只加载 base.apk 中的 dex，不会"看到" Split APK。

SplitCompat 的思路是**在 Application 的 ClassLoader 中注入 Split APK 的 dex 路径**：

```java
// SplitCompat 内部大致逻辑（简化）
public static void install(Context context) {
    // 1. 找到所有已安装的 Split APK
    File[] splitApks = getSplitApkPaths(context);
    
    // 2. 创建包含 Split dex 的 ClassLoader
    ClassLoader splitLoader = createSplitClassLoader(splitApks);
    
    // 3. 将 splitLoader 设置为 PathClassLoader 的 parent
    //    这样双亲委派会先找 splitLoader
    Field parentField = ClassLoader.class.getDeclaredField("parent");
    parentField.setAccessible(true);
    parentField.set(context.getClassLoader(), splitLoader);
}
```

核心手段是**反射修改 ClassLoader 的 parent 链**，而非替换 ClassLoader 本身。这保证了 Application 实例的 ClassLoader 引用不变，Split APK 中的类却可以被发现。

Google 在 `SplitCompatApplication` 中走得更远——通过 `SplitCompat.install()` 在 `attachBaseContext` 阶段完成注入，确保 Application 初始化时所有模块已经可用：

```java
public class MyApplication extends SplitCompatApplication {
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base); // SplitCompat.install() 在这里
        // 此时动态模块的代码已可访问
    }
}
```

资源加载也需要单独处理。Split APK 的 `resources.arsc` 不会自动合并，Google 通过 `SplitCompatResourcesLoader` 将 Split APK 的资源 ID 表注入 `AssetManager`——Android 6.0 以前不少动态加载框架出资源错乱，根源就在这里。

## 不具备动态加载条件的模块怎么处理

SplitCompat 利用反射修改 ClassLoader 的 parent 链来间接加载模块代码，这带来了几个绕不开的问题：

**组件未注册**
- Split APK 中的 Activity/Service 必须在 base 模块的 AndroidManifest 中声明，或者通过反射接管启动流程
- Instant Run 的做法是插桩——在编译期替换所有 Activity 启动调用

**资源访问路径变更**
- `getClass().getResource()` 和 `ClassLoader.getResource()` 只查询当前 ClassLoader 关联的 dex
- 动态模块的资源文件需通过 `AssetManager.addAssetPath()` 提前注入

**ClassLoader 隔离的边界**
- 如果同一个类同时出现在 base 和 Split APK 中，双亲委派先命中哪个取决于注入的 parent 链顺序
- 我在实际项目里遇到过 OkHttp 版本冲突——base 用 3.x，动态模块依赖了 4.x，SplitCompat 加载了 4.x 导致运行时 NoSuchMethodError
- 解决方式是统一依赖版本，配合 Gradle 的 `implementation` 而非 `api` 控制传递范围

## Play Feature Delivery：从打包到用户设备的最后一公里

构建系统生成了 Split APK，Play 负责在合适时机把模块推送到用户设备。三种交付模式：

| 模式 | 安装时机 | 适用场景 |
|---|---|---|
| install-time | 应用安装时 | 核心功能的辅助模块 |
| on-demand | 用户触发时 | 非核心功能 |
| conditional | 满足条件时自动安装 | 特定国家/地区的功能 |

按需安装的流程：用户点击某个功能 → 应用通过 Play Core SDK 发起请求 → Play Store 下载 Split APK → 安装到应用私有目录 → SplitCompat 接管类加载。

```kotlin
// 请求按需模块安装
val manager = SplitInstallManagerFactory.create(context)
val request = SplitInstallRequest.newBuilder()
    .addModule("feature_camera") // 模块名对应 build.gradle 中的 dynamicFeature
    .build()

manager.startInstall(request)
    .addOnSuccessListener { /* 安装完成，可启动模块中的 Activity */ }
    .addOnFailureListener { /* 网络问题或存储不足 */ }
```

模块安装路径在 `/data/data/<包名>/splitcompat/` 下，每个模块有独立的版本号管理。需要注意：用户清除应用数据后，SplitCompat 目录下的文件也会被清除，模块需要重新下载。如果你的 on-demand 模块比较大（比如 AR 功能依赖的模型文件），需要监听清除事件并主动预加载。

## 踩坑备忘录

**1. MultiDex 与 SplitCompat 的交互**

Android 5.0 以下设备需要 MultiDex，而 MultiDex 本身也会修改 ClassLoader 链。SplitCompat 必须在 MultiDex 之后执行，否则 dex 加载顺序错乱。在 `attachBaseContext` 中先调 `MultiDex.install()`，再调 `SplitCompat.install()`。

**2. ProGuard 规则**

动态模块的入口类（通过 `Class.forName()` 加载的类）必须 keep。反射修改 ClassLoader 的逻辑也需要排除混淆：

```proguard
-keep class com.google.android.play.core.splitcompat.SplitCompat { *; }
-keep class * extends com.google.android.play.core.splitinstall.SplitInstallSessionState { *; }
```

**3. 测试覆盖**

本地无法完整模拟 Play Feature Delivery。用 `bundletool` 生成设备专属 APK 集合进行本地安装测试：

```bash
bundletool build-apks --bundle=app.aab --output=app.apks
bundletool install-apks --apks=app.apks
```

这会在设备上安装完整的 Split APK 结构，而非单个 fat APK，能验证 SplitCompat 的实际运行时行为。CI 中缺少这一步的话，动态加载问题可能到线上才暴露。

动态模块化交付在减少初始安装包体积上效果显著——那个 120MB 的项目拆分后首次下载降到 45MB，安装转化率提升了约 12%。代价是架构复杂度增加，团队需要理解 ClassLoader 机制才能排查问题。如果不是包体积已经明显影响业务指标，我不建议为了"架构优雅"去上这套方案。
