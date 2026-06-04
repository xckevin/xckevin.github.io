---
title: "Dynamic Multilingual Localization on Android"
lang: en
translationKey: android-dynamic-multilingual-localization
slug: android-dynamic-multilingual-localization
excerpt: "A practical Android localization approach that hooks Resources, LayoutInflater, and custom view attributes to support dynamically delivered multilingual copy."
publishDate: 2024-03-23
tags:
- "Android"
- "Internationalization"
- "Localization"
- "Dynamic Resources"
seo:
  title: "Dynamic Multilingual Localization on Android with Resources Hooks"
  description: "A practical guide to dynamic Android localization by wrapping Context, proxying Resources.getText, overriding XML attributes, and handling AppCompat."
  pageType: article
---
## Background

### Current State and Problems

For an international engineering team, multilingual support is essential. In our current development workflow, product managers and local colleagues manually enter translations into PRD-related spreadsheet documents, and developers on each client copy those strings into code.

**This approach has several problems:**

1. **Low efficiency**: because previously translated similar copy cannot be managed effectively, product and local teams must retranslate copy for each new requirement or retrieve historical translations from online systems. Translation efficiency is low.
2. **High cost**: developers on each client need to copy every string from the document spreadsheet into code. This is time-consuming and expensive.
3. **High risk**: with languages such as Spanish and Portuguese involved, developers may not recognize the content and are likely to make copy-paste mistakes.
4. **Frequent releases**: copy is packaged into compiled artifacts. Every text change requires each client to release again, making the workflow cumbersome.

## Hooking Android Text Retrieval APIs

On Android, text is mainly displayed in two ways.

### 1. Setting Text in Code

```plain
// There are several common ways to set text in code.

textView.setText(R.string.module_key)

String tip = getContext().getResources().getString(tipId)

val str = UtilCommon.getApplication().getString(strId)
```

In the code above, all ways of setting or retrieving text eventually read resources through `context.getResources().getText(resId)`.

To intercept all text retrieval methods, the fundamental solution is to hook `Resources.getText` and add our own logic inside `getText`.

### 2. Setting Text in XML Layouts

```plain
<TextView
    android:id="@+id/tv_reminder"
    android:layout_width="0dp"
    android:layout_height="wrap_content"
    android:gravity="center"
    android:textSize="10sp"
    android:textColor="#FF999999"
    android:text="@string/key2"
    android:hint="@string/key2"/>
```

For text set in layout files, attributes are already assigned when XML is parsed and Views are created. To hook this path and check for text updates, we can only inspect the View after creation and then override the relevant attributes.

### Hooking System Methods

To hook the system `Resources.getText` method when code reads text, the key idea is to hook the system `Resources` object.

The `Resources` object comes from the `Context` object, so the real key is hooking the system `Context`.

There are mainly two kinds of `Context`: the Application Context and the Activity Context. We need to wrap the Context at the corresponding `attach` points and replace it with our own Context.

**Modify the Application `attachBaseContext`**

```plain
class App : Application() {
    ......
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(VolcI18nSdk.wrapContext(base))
    }
    ......
}
```

**Modify the base Activity `attachBaseContext`**

```plain
class BaseActivity : Activity() {
    ......
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(VolcI18nSdk.wrapContext(base))
    }
    ......
}
```

`VolcI18nSdk.wrapContext(base)` returns our wrapper object, `I18nContextWrapper`.

```plain
class I18nContextWrapper(private val base: Context) : ContextWrapper(base) {
    private var proxyResources: ProxyResources? = null
    override fun getResources(): Resources {
        if (proxyResources == null) {
            proxyResources = ProxyResources(base.assets, base.resources.displayMetrics, base.resources.configuration)
            proxyResources!!.originResources = base.resources
        }
        return proxyResources!!
    }
}
```

`I18nContextWrapper` extends the system `ContextWrapper` and overrides `getResources`, replacing the `Resources` object with our proxy implementation. The `getResources` method returns our wrapped proxy class, `ProxyResources`.

```plain
class ProxyResources(assets: AssetManager, metrics: DisplayMetrics, config: Configuration) : Resources(assets, metrics, config) {

    var originResources: Resources? = null

    override fun getText(id: Int): CharSequence {
        val key = getResourceEntryName(id)
        var result: CharSequence? = stringsMap?.get(key)
        if (result == null) {
            // Not found in dynamic copy; fall back to the system implementation.
            result = super.getText(id)
        }
        return result.replace("\\{\\{[^{]*\\}\\}".toRegex(), "%s")
    }

    companion object {
        var stringsMap: Map<String, String>? = null
        var showKey: Boolean = false
    }
}
```

Android string resources are referenced through `R.string.module_key`. At compile time, `R.string.module_key` is compiled into a fixed `resId` integer. Therefore, inside `ProxyResources.getText(resId)`, we need to use the arsc table to reverse-map the `resId` to its key string, then look up whether that key has an updated value in the delivered resource file.

`stringsMap` is the dynamically delivered map of updated strings. `ProxyResources#getText` checks first whether the key has an updated dynamic value. If found, it returns that value directly. Otherwise, it calls `super.getText` and follows the system lookup path.

After implementing this approach, we added debug logs for self-testing. We expected every `getString` call to be hooked and routed into `ProxyResources#getText`. In practice, however, only `getApplication().getString` was hooked successfully. `getString` and `setText` inside Activity were not hooked.

After reading the source code, we found that because we use AppCompat with version >= 1.2.0 (`appcompat:1.6.1`), `BaseActivity` extends `AppCompatActivity`:

```plain
public class AppCompatActivity
@Override
protected void attachBaseContext(Context newBase) {
    super.attachBaseContext(getDelegate().attachBaseContext2(newBase));
}
```

In `AppCompatActivity#attachBaseContext`, the Context is already delegated through `AppCompatDelegate#attachBaseContext2`, so our override of `attachBaseContext` in `BaseActivity` becomes ineffective.

**Solution**: override `getDelegate()` and proxy the Delegate as well.

```plain
class BaseActivity : Activity() {
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(VolcI18nSdk.wrapContext(base))
    }
    override fun getDelegate(): AppCompatDelegate {
        return I18nSdk.getAppCompatDelegate(super.getDelegate())
    }
}
```

**AppCompatDelegateProxy**

```plain
class AppCompatDelegateProxy(private val delegate: AppCompatDelegate) : AppCompatDelegate() {

    override fun attachBaseContext2(context: Context): Context {
        val context = delegate.attachBaseContext2(context)
        if (context is ContextThemeWrapper) {
            kotlin.runCatching {
                val member = context::class.java.getDeclaredField("mResources")
                member.isAccessible = true
                member.set(context, context.baseContext.resources)
            }
        }
        return context
    }
}
```

`delegate.attachBaseContext2` wraps the incoming Context again. The returned `ContextThemeWrapper` has an `mResources` object created internally, not our `ProxyResources`. Here, reflection is used to assign `mResources` again.

After this change, another debug pass confirmed that `getApplication().getString`, `textView.setText` inside Activity, and `getContext().getResources().getString` were all hooked and routed to `ProxyResources#getText`. The dynamic text update logic was proven viable.

### Hooking System Text Attributes

The approach above only hooks text retrieval from code. Android also has text assigned through XML layout attributes, and that path does not go through `Resources#getText`. We can only hook it by overriding attributes after View creation.

Android lets us set our own `LayoutInflater.Factory` and implement or override `onCreateView`:

```plain
class I18nLayoutInflaterFactory(val activity: AppCompatActivity) : LayoutInflater.Factory2 {

    override fun onCreateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? {
        val view: View? = if (name.startsWith(I18nSdk.packageName)) {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.N_MR1) {
                kotlin.runCatching {
                    val field = LayoutInflater::class.java.getDeclaredField("mConstructorArgs")
                    field.isAccessible = true
                    val args = field.get(activity.layoutInflater)
                    if (args is Array<*> && args[0] == null) {
                        (args as Array<Any?>)[0] = context
                    }
                }
            }
            activity.layoutInflater.createView(name, null, attrs)
        } else {
            activity.delegate.createView(parent, name, context, attrs)
        }

        if (view is TextView) {
            overrideText(view, attrs)
            overrideHint(view, attrs)
        }
        return view
    }

    private fun overrideText(view: TextView, attrs: AttributeSet) {
        val typedArray = view.context.obtainStyledAttributes(attrs, intArrayOf(android.R.attr.text))
        val stringResource = typedArray.getResourceId(0, -1)
        if (stringResource != -1) {
            view.text = view.resources.getText(stringResource)
        }
        typedArray.recycle()
    }

    private fun overrideHint(view: TextView, attrs: AttributeSet) {
        val typedArray = view.context.obtainStyledAttributes(attrs, intArrayOf(android.R.attr.hint))
        val stringResource = typedArray.getResourceId(0, -1)
        if (stringResource != -1) {
            view.hint = view.resources.getText(stringResource)
        }
        typedArray.recycle()
    }
}
```

`overrideText` and `overrideHint` override the `text` and `hint` attributes of `TextView`. During this process, they call `view.resources.getText`, and `view.resources` is our wrapped `ProxyResources`. This funnels all text retrieval into `ProxyResources.getText`.

Set `I18nLayoutInflaterFactory` on `layoutInflater`:

```plain
class BaseActivity : Activity() {
    ......
    override fun onCreate(savedInstanceState: Bundle?) {
        layoutInflater.factory2 = I18nLayoutInflaterFactory(this)
        ......
    }
}
```

### Custom View Attributes

After the two hook paths above are implemented, more than 95% of Android text display cases are covered. One category remains: custom text attributes on custom Views.

Custom attributes are usually read through `typedArray.getString` in native code.

In `I18nSdk`, we provide `getTypeArrayString` to read custom attribute text:

```plain
fun getTypeArrayString(context: Context, typedArray: TypedArray, index: Int): String? {
    val stringResource = typedArray.getResourceId(index, -1)
    var result: String? = if (stringResource != -1) {
        context.getString(stringResource)
    } else {
        typedArray.getString(index)
    }
    return result
}
```

The idea is simple. If the custom attribute is a resource reference, retrieve the string through `context.getString`, which eventually goes through our centralized `ProxyResources.getText`. If it is not a resource reference, call `typedArray.getString` and read the constant text directly.

**Summary**: system text retrieval, system attribute overriding, and custom text attributes are all funneled into `ProxyResources.getText`. Dynamic text update logic, placeholder replacement, and similar behavior only need to be maintained in `ProxyResources`.

## Pitfall Notes

By hooking the system Context objects, including Application and Activity Context, we routed all text retrieval methods into `ProxyResources.getText`. Similar approaches are used in the industry, such as [Volcengine's VolcI18nSDK](https://www.volcengine.com/docs/6411/176533).

Hooking system Context objects comes with risks. The following are issues we encountered in practice.

### 1. Problems Caused by Hooking Application Context

Android `ActivityThread` contains the following code:

```plain
private void handleReceiver(ReceiverData data) {
    ....
    context = (ContextImpl) app.getBaseContext();
    ....
}
```

`handleReceiver` is triggered when a broadcast is sent. Here, `app` is the Application. After `app.getBaseContext()` is called, the result is force-cast to `ContextImpl`. Because we hooked the Application Context, `app.getBaseContext()` returns our wrapped `I18nContextWrapper`, and the force cast to `ContextImpl` causes a `ClassCastException`.

**Solution**: override the Application `getBaseContext` method.

```plain
@Override
public Context getBaseContext() {
    Context context = super.getBaseContext();
    if (context instanceof I18nContextWrapper) {
        return ((I18nContextWrapper) context).getBaseContext();
    }
    return context;
}
```

If the retrieved Context is our wrapped `I18nContextWrapper`, take its inner `baseContext` instead. The result is the original Context, that is, a `ContextImpl` instance.

### 2. Android 7.0 Compatibility Issue

`LayoutInflater.Factory2` has a compatibility issue on Android 7.

To hook system text attributes, we set our own `LayoutInflater.Factory2`:

```plain
val view: View? = if (name.startsWith(I18nSdk.packageName)) {
    activity.layoutInflater.createView(name, null, attrs)
} else {
    activity.delegate.createView(parent, name, context, attrs)
}
```

For custom Views under our package name, we create them through `activity.layoutInflater.createView`. On Android 7, `activity.layoutInflater` has a hidden bug: when `layoutInflater#mConstructorArgs[0]` is not initialized, Android 7 has no fallback compatibility logic.

Look at the `LayoutInflater` source from Android SDK 33:

```plain
public final View createView(String name, String prefix, AttributeSet attrs)
        throws ClassNotFoundException, InflateException {
    Context context = (Context) mConstructorArgs[0];
    if (context == null) {
        context = mContext;
    }
    return createView(context, name, prefix, attrs);
}
```

When `mConstructorArgs[0]` is null, `mContext` is used as a fallback. Android 7.0 and 7.1 do not include this compatibility logic.

**Solution**: on Android 7.1 and below, use reflection to check whether `mConstructorArgs[0]` is null and assign it when necessary.

```plain
val view: View? = if (name.startsWith(I18nSdk.packageName)) {
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.N_MR1) {
        kotlin.runCatching {
            val field = LayoutInflater::class.java.getDeclaredField("mConstructorArgs")
            field.isAccessible = true
            val args = field.get(activity.layoutInflater)
            if (args is Array<*> && args[0] == null) {
                (args as Array<Any?>)[0] = context
            }
        }
    }
    activity.layoutInflater.createView(name, null, attrs)
} else {
    activity.delegate.createView(parent, name, context, attrs)
}
```
