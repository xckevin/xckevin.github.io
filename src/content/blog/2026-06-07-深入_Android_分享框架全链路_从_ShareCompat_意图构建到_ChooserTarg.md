---
title: 深入 Android 分享框架全链路：从 ShareCompat 意图构建到 ChooserTarget 动态目标的架构解析
slug: android-share-framework-chooser-targets
translationKey: android-share-framework-chooser-targets
excerpt: 深入剖析 Android 分享框架全链路：从 ShareCompat 意图构建、Chooser 界面目标解析，到 Direct Share 动态目标服务的实现，以及在 Jetpack Compose 中的适配方案与常见踩坑经验。
publishDate: '2026-06-07'
tags:
- Android
- Kotlin
- Jetpack Compose
- Intent
- 架构设计
seo:
  title: 深入 Android 分享框架全链路：从 ShareCompat 意图构建到 ChooserTarget 动态目标的架构解析
  description: 深度解析 Android 分享框架全链路，涵盖 ShareCompat 意图构建、Chooser 目标匹配、ChooserTargetService 动态目标实现，以及 Jetpack Compose 适配要点和常见踩坑经验。
---

去年做一个社交 App 的分享功能时，产品要求"把最近聊过的好友直接显示在分享框首页"。原以为调个 `Intent.createChooser()` 就能收工，结果 Android 的分享框架比预想的深得多——Intent 解析、Chooser 界面渲染、Direct Share 的动态目标服务，每一层都有独立的机制。

这篇文章把整条链路拆开来讲。

## 分享入口：ShareCompat 做了什么

系统分享框的起点是一个携带 `ACTION_SEND` 或 `ACTION_SEND_MULTIPLE` 的 Intent。直接 `new Intent()` 也能跑，但 `ShareCompat` 封装了 MIME 类型推断、数据流安全读写这些脏活，是官方推荐的入口：

```kotlin
val shareIntent = ShareCompat.IntentBuilder(context)
    .setType("text/plain")
    .setText("分享一段文字")
    .createChooserIntent()
    .apply {
        putExtra(Intent.EXTRA_TITLE, "选择分享方式")
    }
startActivity(shareIntent)
```

`createChooserIntent()` 内部调了 `Intent.createChooser(targetIntent, title)`，返回的不是原始 SEND Intent，而是一个包装后的 `ACTION_CHOOSER` Intent。这个包装动作把原始 SEND Intent 塞进了 `EXTRA_INTENT`，系统因此走上了一条完全不同的分发路径——跳过常规的 Activity 匹配，直接进入 Chooser 专属流程。

MIME 类型不能乱填。`ShareCompat.IntentBuilder` 会根据你传入的 content URI 自动推断：纯文本走 `text/plain`，图片走 `image/*`，混合内容走 `text/plain` 加 `EXTRA_STREAM`。手动构造时漏掉 MIME 类型是分享功能最常见的 bug——系统匹配不到任何接收方，分享框直接白屏，Logcat 里只有一条不起眼的 `No activity found`。

## Chooser 界面如何匹配目标

`ACTION_CHOOSER` Intent 到达 `ActivityManagerService` 后，系统不会直接弹界面，而是先走 `IntentResolver` 解析。分三步：

**第一步：解析原始 SEND Intent。** 系统取出 `EXTRA_INTENT`，通过 PackageManager 的 `queryIntentActivities()` 检索所有声明了对应 `intent-filter` 的 Activity。`text/plain` 会匹配到微信、Telegram、Notes 等一切能处理纯文本的应用。

**第二步：合并 Chooser 专属目标。** `EXTRA_INITIAL_INTENTS` 可以放入自定义的 `ComponentName` 目标，这些项会固定在分享列表顶部。`ShareCompat` 默认不填这个字段，但你可以手动注入：

```kotlin
val initialIntents = arrayListOf<Intent>()
resolveInfoList.forEach { resolveInfo ->
    val targetIntent = Intent(shareIntent).apply {
        component = ComponentName(
            resolveInfo.activityInfo.packageName,
            resolveInfo.activityInfo.name
        )
    }
    initialIntents.add(targetIntent)
}
intent.putExtra(Intent.EXTRA_INITIAL_INTENTS, initialIntents.toTypedArray())
```

**第三步：查询 Direct Share 目标。** 这是 Android 6.0 引入的能力。系统检查哪些已安装应用注册了 `ChooserTargetService`，并发 bind 这些 Service，获取动态目标列表——聊天 App 可以借此返回最近聊过的 5 个联系人，直接展示在分享框的快捷区域。

三步完成，`IntentResolver` 输出一个 `List<ResolveInfo>`，交给 `ChooserActivity` 渲染。

## Direct Share：动态目标服务的实现

Direct Share 的核心是 `ChooserTargetService`——一个运行在目标应用进程里的 Service，系统在需要显示分享框时通过 bind 方式拉起。

```xml
<service
    android:name=".MyChooserTargetService"
    android:permission="android.permission.BIND_CHOOSER_TARGET_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.service.chooser.ChooserTargetService" />
    </intent-filter>
</service>
```

最关键的约束：`onGetChooserTargets()` 必须在 **10 秒内** 返回，超时系统直接丢弃结果。这意味着你不能在里面做网络请求，只能读本地缓存或数据库。

```kotlin
class MyChooserTargetService : ChooserTargetService() {
    override fun onGetChooserTargets(
        targetActivityName: ComponentName,
        matchedFilter: IntentFilter
    ): List<ChooserTarget> {
        val recentContacts = contactRepository.getRecent(5)
        return recentContacts.map { contact ->
            ChooserTarget(
                contact.name,           // 显示名称
                loadIcon(contact),      // 图标（Bitmap）
                contact.score.toFloat(), // 排序权重，越大越靠前
                targetActivityName,
                Bundle().apply {
                    putString("contact_id", contact.id)
                }
            )
        }
    }
}
```

`score` 不是绝对优先的排序依据。系统会将 `score` 与 `PinnedTargets`（用户固定过的目标）做加权混合，最终排序由 `ChooserListAdapter` 的 `TargetInfoComparator` 决定。实际项目中我发现，`score` 在 0.7 以上的目标基本能稳定排在非固定项的首位。

图标容易踩坑。`ChooserTarget` 的图标需要 `Bitmap` 而非 drawable 资源 ID，Android 12 之后图标会经过 `IconFactory` 做圆形裁剪和缩放。返回超大尺寸的 Bitmap 不仅浪费内存，还会被系统强制缩放成模糊效果，建议控制在 96×96 dp 以内。

## Compose 中的分享适配

如果你的 App 已经迁到 Compose，分享动作需要和传统 View 体系的 `IntentChooser` 交互。Compose 没有内建的分享组件，靠 `LocalContext` 和 `rememberLauncherForActivityResult` 桥接：

```kotlin
@Composable
fun ShareButton(text: String) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { /* 分享无返回处理 */ }

    Button(onClick = {
        val intent = ShareCompat.IntentBuilder(context)
            .setType("text/plain")
            .setText(text)
            .createChooserIntent()
        launcher.launch(intent)
    }) {
        Text("分享")
    }
}
```

一个 Compose 特有的坑：`rememberLauncherForActivityResult` 必须在 `onClick` 之前注册，不能在回调里动态创建。原因是 `ActivityResultRegistry` 在 Compose 首次组合时就完成了注册——我做 Compose 迁移时因为这个顺序问题卡了半天，分享按钮点了没反应，Logcat 里干干净净没有任何异常。

用 `ShareCompat.IntentBuilder` 配合 ContentProvider 分享文件时，记得在 Compose 的 `DisposableEffect` 里清理临时文件。Compose 的重组会导致多次生成 content URI，而你只有最后一次是有效的，前面的那些会变成无人引用的垃圾文件，积多了 FileProvider 的缓存目录就爆了。

## 踩坑与建议

`ShareCompat.createChooserIntent()` 返回的 Intent 已经带了 `Intent.FLAG_ACTIVITY_NEW_TASK`，不要在 Compose 里再套一层 `with(Intent.FLAG_ACTIVITY_NEW_TASK)`，否则分享框会出现在独立任务栈中，用户按返回键回不到你的 App——体验上像是被踢出了应用。

`ChooserTargetService` 每次打开分享框都会被调用。如果 `onGetChooserTargets()` 里做了磁盘 I/O，快速连续打开分享框时会有明显卡顿。建议用内存缓存加异步刷新的策略：首次返回缓存数据，后台线程更新缓存供下次使用。

Android 10 将 Direct Share 的展示数量从 8 个砍到 4 个，Android 11 进一步废弃了 `ShareTarget` 的快捷方式绑定，推荐改用 `ShortcutManager` 的动态快捷方式做分享目标注册。如果你的 App 还在用老的 `ChooserTargetService` 方案，尽快迁到 `shareTarget` 的 ShortcutInfo 实现——不是功能性的区别，而是老接口在新系统上展示优先级会持续下降。
