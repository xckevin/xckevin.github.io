---
title: "Android Overlay Windows: Permissions, WindowManager, and Compatibility"
lang: en
translationKey: android-overlay-window-permissions
slug: android-overlay-window-permissions
excerpt: "Build reliable Android overlay windows across platform versions, with permission handling, touch behavior, and OEM compatibility guidance."
publishDate: '2026-07-10'
tags:
- "Android"
- "WindowManager"
- "Permissions"
- "System UI"
seo:
  title: "Android Overlay Window Permissions and WindowManager"
  description: "A practical guide to Android overlay permissions, TYPE_APPLICATION_OVERLAY, and compatibility."
  pageType: article
---

I encountered a pitfall when making a floating window SDK: the same set of code popped up normally on Android 10, but crashed directly on Android 12, and there was only one sentence of `BadTokenException` in the log. After investigation, it was found that the permission verification logic for `TYPE_APPLICATION_OVERLAY` in Android 12 has changed - it is not that the permission is not obtained, but that the window of opportunity to obtain it is narrower than that of the previous version.

This experience forced me to completely sort out the permission model of the floating window from 6.0 to 14.

## Four key changes to the permissions model

The evolution of Android floating window permissions is not linear, and there are several breakpoint changes.

**Android 6.0 (API 23)**: `SYSTEM_ALERT_WINDOW` is introduced as a runtime permission, but unlike other dangerous permissions, it does not follow the standard process of `requestPermissions()`, but jumps to the system settings page for the user to manually turn it on. Google's logic is that this permission is too dangerous and cannot be obtained by developers just by playing Dialog.

**Android 8.0 (API 26)**: Introduced `TYPE_APPLICATION_OVERLAY` to replace the old `TYPE_PHONE`, `TYPE_SYSTEM_ALERT` and other window types. The old type is marked as deprecated, but still works, but the behavior is beginning to be limited.

**Android 10 (API 29)**: Android 10 is the most buggy version. The window of `TYPE_APPLICATION_OVERLAY` is prohibited from directly obtaining focus, and the touch event processing logic has also changed - if you embed an `EditText` in the floating window, the keyboard will not pop up after the user clicks it. Google is limiting floating windows from hijacking input.

**Android 12 (API 31)**: `SYSTEM_ALERT_WINDOW` is no longer displayed by default in the permission list, and users need to search manually. The floating window Service launched from the notification bar is also affected by the newForeground service startup restrictions.

Android 14 further tightens the rules for starting activities in the background, but there are no breakpoint changes in the permission model itself.

## Reliable way to write permission check

The most common pitfall is to only use `Settings.canDrawOverlays()` to determine the permission status. Just because this method returns `true` on Android 10+ does not mean that the window can be displayed normally. I use a set of combined checks in my project:

```kotlin
fun checkOverlayPermission(context: Context): Boolean {
    // Basic check
    if (!Settings.canDrawOverlays(context)) return false

    // Android 10+: validate the window type as an additional check.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        return try {
            val wm = context.getSystemService(WindowManager::class.java)
            val params = WindowManager.LayoutParams().apply {
                type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            }
            // Do not actually add the view; validate only the parameters.
            true
        } catch (e: Exception) {
            false
        }
    }
    return true
}
```

`Settings.canDrawOverlays()` only checks the switch status in the system settings. After Android 10, even if the switch is turned on, some ROMs (especially MIUI and ColorOS) will intercept `TYPE_APPLICATION_OVERLAY` at the system level, so a second verification is required.

When booting with permissions, do not jump directly to the system settings page:

```kotlin
fun requestOverlayPermission(activity: Activity, requestCode: Int) {
    val intent = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:${activity.packageName}")
    )
    // Important: FLAG_ACTIVITY_NEW_TASK avoids a broken back stack on some ROMs.
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivityForResult(intent, requestCode)
}
```

Do not create a floating window immediately after returning from the settings page. Add a 200ms delay because there is a lag in the permissions of some ROMs taking effect.

## Window type selection: not all TYPEs are equal

There are three common options for the type related to floating windows in `WindowManager.LayoutParams`:

| Type | Applicable scenarios | Limitations |
|------|---------|------|
| `TYPE_APPLICATION_OVERLAY` | Universal floating window | Cannot get focus, Android 10+ limits input |
| `TYPE_ACCESSIBILITY_OVERLAY` | Accessibility services | Touch events cannot penetrate, but can gain focus |
| `TYPE_PHONE` (obsolete) | Old code compatibility | Requires `SYSTEM_ALERT_WINDOW`, the behavior is unstable in higher versions |

In the actual project, I chose a layered strategy: use `TYPE_APPLICATION_OVERLAY` for the main body to ensure coverage; when an input box or focus interaction is required, local focus is achieved through a combination of `FLAG_NOT_TOUCH_MODAL` and `FLAG_WATCH_OUTSIDE_TOUCH` in the `TYPE_APPLICATION_OVERLAY` window.

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

`FLAG_NOT_TOUCH_MODAL` allows touch events outside the window to be passed to the underlying window, and `FLAG_WATCH_OUTSIDE_TOUCH` allows you to monitor these events and implement interactions such as "click outside to close".

## Touch event penetration: two-way control

There are two directions to control the touch event of the floating window: **penetration to the lower layer** and **interception without penetration**.

The core of **Penetration** is `FLAG_NOT_TOUCH_MODAL` and `FLAG_NOT_TOUCHABLE`. The difference between the two: `FLAG_NOT_TOUCHABLE` allows the window to not receive touches at all, and events are directly transmitted transparently; `FLAG_NOT_TOUCH_MODAL` allows unconsumed events in the window to be transparently transmitted. The latter is sufficient for most scenarios.

The pitfall of **Interception** is that even if `FLAG_NOT_TOUCHABLE` is set, the window on some ROMs will still consume DOWN events. The solution is to return `false` in `onTouchEvent` instead of relying on flag:

```kotlin
override fun onTouchEvent(event: MotionEvent): Boolean {
    return if (shouldPassThrough) {
        false // Explicitly do not consume the event; force it to pass through.
    } else {
        super.onTouchEvent(event)
    }
}
```

Area penetration is another common requirement - some areas of the floating window can be clicked, and the remaining areas are transparent. The implementation is to determine the coordinates in `dispatchTouchEvent`:
```kotlin
override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) {
        val inClickableArea = (event.x in clickableRect.left..clickableRect.right &&
                               event.y in clickableRect.top..clickableRect.bottom)
        if (!inClickableArea) {
            // Outside the clickable area: set FLAG_NOT_TOUCHABLE and update.
            updateTouchableFlag(false)
            return false
        }
    }
    return super.dispatchTouchEvent(event)
}
```

`windowManager.updateViewLayout()` needs to be called after `updateTouchableFlag` to take effect. This is a time-consuming system call. Do not trigger it frequently in `ACTION_MOVE`.

## Cross-version compatible engineering strategy

After going through these pitfalls, I settled on three engineering strategies:

**Compile time isolation**. Use `@RequiresApi` and `Build.VERSION.SDK_INT` for version determination, and do not use `try-catch` to swallow exceptions. Exception masking problems are extremely difficult to troubleshoot in a production environment.

**Window keepalive dual channel**. The foreground Service is the host of the floating window, but Android 12+ has strict restrictions on starting the Service in the background. My plan is: use the front-end Service in normal scenarios; use the notification bar to pull up the permanent notification after being killed by the system to avoid the user's manual restart.

**ROM Adaptation Whitelist**. The behavior of domestic ROMs is very different. Maintain a copy of `RomUtils` to determine the current ROM type and perform special processing for MIUI and ColorOS - for example, MIUI needs to enable the "background pop-up interface" permission in the security center, otherwise the `TYPE_APPLICATION_OVERLAY` window creation will fail silently.

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

##End

The technical complexity of floating windows is not at the rendering level, but at the multi-version fragmentation of the permission model and the differentiated behavior of ROM. If you have the energy to design from scratch, I recommend completely decoupling the floating window capability and business logic - the floating window SDK is only responsible for the window life cycle, permission adaptation and event distribution, and the business layer injects the view through the interface. In this way, when Android 15 changes the permission model, the scope of the change can be controlled within the SDK and will not spread to business code.
