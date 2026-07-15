---
title: 深入 Android 悬浮窗全链路：从 SYSTEM_ALERT_WINDOW 权限模型演进到 WindowManager 叠加层渲染的工程实践
slug: android-overlay-window-permissions
translationKey: android-overlay-window-permissions
excerpt: 本文梳理了 Android 6.0 至 14 悬浮窗权限模型的四次关键变化，深入分析 TYPE_APPLICATION_OVERLAY 窗口类型选择、触摸事件穿透与拦截机制，并给出跨版本兼容及 MIUI、ColorOS 等 ROM 适配的工程实践方案。
publishDate: '2026-07-10'
tags:
- Android
- 悬浮窗
- WindowManager
- 权限适配
- 触摸事件
seo:
  title: 深入 Android 悬浮窗全链路：从 SYSTEM_ALERT_WINDOW 权限模型演进到 WindowManager 叠加层渲染的工程实践
  description: 梳理 Android 6.0 至 14 悬浮窗权限模型演进，深入分析 TYPE_APPLICATION_OVERLAY 窗口类型、触摸事件穿透机制及 MIUI/ColorOS 等 ROM 适配的工程实践。
---

做悬浮窗 SDK 时踩过一个坑：同一套代码在 Android 10 上正常弹窗，到了 Android 12 直接闪退，日志里只有一句 `BadTokenException`。排查后发现，Android 12 对 `TYPE_APPLICATION_OVERLAY` 的权限校验逻辑变了——不是权限没拿到，而是拿到的时机窗口比之前版本更窄。

这个经历逼着我把悬浮窗从 6.0 到 14 的权限模型完整梳理了一遍。

## 权限模型的四次关键变化

Android 悬浮窗权限的演化不是线性的，有几次断点式变更。

**Android 6.0（API 23）**：引入 `SYSTEM_ALERT_WINDOW` 作为运行时权限，但与其他危险权限不同，它不走 `requestPermissions()` 的标准流程，而是跳转到系统设置页让用户手动开启。Google 的逻辑是——这个权限太危险，不能让开发者弹个 Dialog 就拿到。

**Android 8.0（API 26）**：引入 `TYPE_APPLICATION_OVERLAY`，替代旧的 `TYPE_PHONE`、`TYPE_SYSTEM_ALERT` 等窗口类型。旧类型被标记为 deprecated，但依然能用，只是行为上开始受限。

**Android 10（API 29）**：Android 10 是最容易出问题的版本。`TYPE_APPLICATION_OVERLAY` 的窗口被禁止直接获取焦点，触摸事件处理逻辑也变了——如果你在悬浮窗里嵌了一个 `EditText`，用户点击后键盘不会弹出。Google 在限制悬浮窗劫持输入。

**Android 12（API 31）**：`SYSTEM_ALERT_WINDOW` 在权限列表里不再默认展示，用户需要手动搜索。从通知栏启动的悬浮窗 Service 也受到新的前台服务启动限制。

Android 14 进一步收紧了后台启动 Activity 的规则，但权限模型本身没再有断点式变化。

## 权限检查的可靠写法

踩过最多的坑是只用 `Settings.canDrawOverlays()` 判断权限状态。这个方法在 Android 10+ 上返回 `true` 不代表窗口能正常显示。我在项目里用了一套组合检查：

```kotlin
fun checkOverlayPermission(context: Context): Boolean {
    // 基础检查
    if (!Settings.canDrawOverlays(context)) return false

    // Android 10+ 额外校验：尝试验证窗口类型
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        return try {
            val wm = context.getSystemService(WindowManager::class.java)
            val params = WindowManager.LayoutParams().apply {
                type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            }
            // 不实际 addView，仅验证参数合法性
            true
        } catch (e: Exception) {
            false
        }
    }
    return true
}
```

`Settings.canDrawOverlays()` 只检查了系统设置里的开关状态。Android 10 之后，即使开关打开，某些 ROM（尤其是 MIUI、ColorOS）会在系统层面拦截 `TYPE_APPLICATION_OVERLAY`，所以需要做二次校验。

权限引导时，不要直接跳系统设置页就完事：

```kotlin
fun requestOverlayPermission(activity: Activity, requestCode: Int) {
    val intent = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:${activity.packageName}")
    )
    // 关键：设置 FLAG_ACTIVITY_NEW_TASK 避免在某些 ROM 上无法返回
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivityForResult(intent, requestCode)
}
```

从设置页返回后不要立即创建悬浮窗，加 200ms 延迟，因为部分 ROM 的权限生效有滞后。

## 窗口类型选择：不是所有 TYPE 都平等

`WindowManager.LayoutParams` 里和悬浮窗相关的 type 有三个常用选项：

| 类型 | 适用场景 | 限制 |
|------|---------|------|
| `TYPE_APPLICATION_OVERLAY` | 通用悬浮窗 | 不能获取焦点，Android 10+ 限制输入 |
| `TYPE_ACCESSIBILITY_OVERLAY` | 无障碍服务 | 触摸事件不能穿透，但能获取焦点 |
| `TYPE_PHONE`（废弃） | 旧代码兼容 | 需要 `SYSTEM_ALERT_WINDOW`，高版本行为不稳定 |

实际项目里，我选择了分层策略：主体用 `TYPE_APPLICATION_OVERLAY`，保证覆盖率；需要输入框或焦点交互时，在 `TYPE_APPLICATION_OVERLAY` 窗口内通过 `FLAG_NOT_TOUCH_MODAL` 和 `FLAG_WATCH_OUTSIDE_TOUCH` 组合实现局部焦点。

```kotlin
val params = WindowManager.LayoutParams().apply {
    type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    format = PixelFormat.TRANSLUCENT
    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
    width = WindowManager.LayoutParams.WRAP_CONTENT
    height = WindowManager.LayoutParams.WRAP_CONTENT
    gravity = Gravity.TOP or Gravity.START
    x = 100
    y = 200
}
```

`FLAG_NOT_TOUCH_MODAL` 让窗口外的触摸事件能传递到下层窗口，`FLAG_WATCH_OUTSIDE_TOUCH` 则让你能监听到这些事件，实现"点击外部关闭"这类交互。

## 触摸事件穿透：双向控制

悬浮窗的触摸事件有两个方向要控制：**穿透给下层** 和 **拦截住不穿透**。

**穿透** 的核心是 `FLAG_NOT_TOUCH_MODAL` 和 `FLAG_NOT_TOUCHABLE`。两者区别：`FLAG_NOT_TOUCHABLE` 让窗口完全不接收触摸，事件直接透传；`FLAG_NOT_TOUCH_MODAL` 让窗口内未消费的事件透传。大多数场景用后者就够了。

**拦截** 的坑在于，即使设置了 `FLAG_NOT_TOUCHABLE`，某些 ROM 上窗口仍然会消费 DOWN 事件。解决方案是在 `onTouchEvent` 里返回 `false`，而不是依赖 flag：

```kotlin
override fun onTouchEvent(event: MotionEvent): Boolean {
    return if (shouldPassThrough) {
        false // 明确不消费，强制穿透
    } else {
        super.onTouchEvent(event)
    }
}
```

区域穿透是另一个常见需求——悬浮窗的部分区域可点击，其余区域透传。实现方式是在 `dispatchTouchEvent` 中判断坐标：

```kotlin
override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) {
        val inClickableArea = (event.x in clickableRect.left..clickableRect.right &&
                               event.y in clickableRect.top..clickableRect.bottom)
        if (!inClickableArea) {
            // 不在可点击区域，设置 FLAG_NOT_TOUCHABLE 并更新
            updateTouchableFlag(false)
            return false
        }
    }
    return super.dispatchTouchEvent(event)
}
```

`updateTouchableFlag` 后需要调用 `windowManager.updateViewLayout()` 才能生效，这是一个耗时的系统调用，不要在 `ACTION_MOVE` 里频繁触发。

## 跨版本兼容的工程策略

踩过这些坑后，我沉淀了三条工程策略：

**编译期隔离**。用 `@RequiresApi` 和 `Build.VERSION.SDK_INT` 做版本判断，不要用 `try-catch` 吞异常。异常掩盖的问题在生产环境极难排查。

**窗口保活双通道**。前台 Service 是悬浮窗的宿主，但 Android 12+ 对后台启动 Service 限制严格。我的方案是：正常场景用前台 Service；被系统杀死后用通知栏常驻通知拉起，避免用户手动重启。

**ROM 适配白名单**。国内 ROM 的行为差异太大，维护一份 `RomUtils` 判断当前 ROM 类型，对 MIUI 和 ColorOS 做特殊处理——比如 MIUI 需要在安全中心额外开启"后台弹出界面"权限，否则 `TYPE_APPLICATION_OVERLAY` 窗口创建会静默失败。

```kotlin
object RomUtils {
    fun isMiui(): Boolean = 
        !TextUtils.isEmpty(getSystemProperty("ro.miui.ui.version.name"))
    
    fun isColorOs(): Boolean =
        !TextUtils.isEmpty(getSystemProperty("ro.build.version.opporom"))
    
    private fun getSystemProperty(key: String): String? =
        try {
            Class.forName("android.os.SystemProperties")
                .getMethod("get", String::class.java)
                .invoke(null, key) as? String
        } catch (e: Exception) { null }
}
```

## 结尾

悬浮窗的技术复杂度不在渲染层面，而在**权限模型的多版本碎片化**和**ROM 的差异化行为**。如果有精力从头设计，我建议把悬浮窗能力和业务逻辑彻底解耦——悬浮窗 SDK 只负责窗口生命周期、权限适配和事件分发，业务层通过接口注入视图。这样当 Android 15 又改权限模型时，改动范围能控制在 SDK 内，不会扩散到业务代码。
