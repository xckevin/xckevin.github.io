---
title: Android 多语言动态化实践
excerpt: 作为国际化技术团队，多语言能力必不可少。目前在我们的开发流程中，多语言翻译由产品与本地同事手工录入 PRD 相关文档表格，再由各端开发同学复制粘贴到代码中。
publishDate: 2024-03-23
tags:
  - Android
  - 国际化
  - 多语言
  - 动态化
seo:
  title: Android 多语言动态化实践
  description: 作为国际化技术团队，多语言能力必不可少。目前在我们的开发流程中，多语言翻译由产品与本地同事手工录入 PRD 相关文档表格，再由各端开发同学复制粘贴到代码中。
---
## 背景

### 现状及问题

作为国际化技术团队，多语言能力必不可少。目前在我们的开发流程中，多语言翻译由产品与本地同事手工录入 PRD 相关文档表格，再由各端开发同学复制粘贴到代码中。

**目前方式存在以下问题：**

1. **效率低**：由于无法有效管理此前翻译过的类似文案，产品与本地同事每次需对新需求的文案重新翻译，或从线上系统获取历史翻译文案，翻译效率较低。
2. **成本高**：各端同学需要将文档表格中的全部文案复制粘贴到代码中，费时费力，成本较高。
3. **风险高**：由于存在西语、葡语等小语种，各端同学无法识别，容易出现复制粘贴错误。
4. **发布频繁**：文案打包进编译文件中，每次修改文案各端都需要重新发布，流程较为繁琐。

## Android Hook 文案获取接口

Android 端显示文案的方式主要分为两类。

### 1. 代码中设置文案

```plain
// 代码中设置文案又分为以下几种情况

textView.setText(R.string.module_key)

String tip = getContext().getResources().getString(tipId)

val str = UtilCommon.getApplication().getString(strId)
```

上述代码中设置或获取文案的方式，最终资源读取都会走到 `context.getResources().getText(resId)` 方法中。

想要拦截所有获取文案的方法，根源上就是要 Hook 掉 `Resources.getText` 方法，并在 `getText` 方法中添加自己的实现逻辑。

### 2. XML 布局中设置文案

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

布局文件中设置的文案，在 XML 被解析、View 创建时属性已经赋值。因此，若要对这种情况做 Hook 以实现文案更新检查，只能在 View 创建之后进行检查，再做属性覆盖操作。

### Hook 系统方法

要在代码读取文案时 Hook 系统的 `Resources.getText` 方法，关键思路是 Hook 掉系统的 `Resources` 对象。

`Resources` 对象来自 `Context` 对象，因此关键在于 Hook 系统的 `Context` 对象。

`Context` 对象主要分为 Application 的 Context 和 Activity 的 Context 两类，我们需要在对应的 attach 节点对 Context 进行包装，封装成我们自己的 Context。

**修改 Application 的 attachBaseContext**

```plain
class App : Application() {
    ......
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(VolcI18nSdk.wrapContext(base))
    }
    ......
}
```

**修改基类 Activity 的 attachBaseContext**

```plain
class BaseActivity : Activity() {
    ......
    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(VolcI18nSdk.wrapContext(base))
    }
    ......
}
```

`VolcI18nSdk.wrapContext(base)` 返回的是封装对象 `I18nContextWrapper`。

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

`I18nContextWrapper` 继承系统的 `ContextWrapper`，实现了 `getResources` 方法，从而将 `Resources` 对象替换为我们的代理实现。这里的 `getResources` 返回的是我们封装的代理类 `ProxyResources` 对象。

```plain
class ProxyResources(assets: AssetManager, metrics: DisplayMetrics, config: Configuration) : Resources(assets, metrics, config) {

    var originResources: Resources? = null

    override fun getText(id: Int): CharSequence {
        val key = getResourceEntryName(id)
        var result: CharSequence? = stringsMap?.get(key)
        if (result == null) {
            // 动态文案中没有，走系统方法获取
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

Android 文案资源引用使用 `R.string.module_key`，在编译期 `R.string.module_key` 已被编译为某个固定的 `resId`（Int 值）。因此在 `ProxyResources.getText(resId)` 方法中，需要依赖 arsc 表将 `resId` 反查出其对应的 key-string，然后在下发的资源文件中查找该 key 是否有更新的 value。

`stringsMap` 为动态下发的更新文案 Map，`ProxyResources#getText` 方法优先检查动态文案中是否更新了该 key。若找到则直接返回结果，未找到则调用 `super.getText` 走系统方法查询。

按照上述思路开发完成后，添加调试日志进行自测。预期所有 `getString` 方法都会被 Hook 住，走到 `ProxyResources#getText` 方法中。然而实际上只有 `getApplication().getString` 成功被 Hook，Activity 中的 `getString`、`setText` 均未成功 Hook。

查看源码跟进问题后发现，由于我们使用了 AppCompat 且版本 >= 1.2.0（appcompat:1.6.1），`BaseActivity` 继承自 `AppCompatActivity`：

```plain
public class AppCompatActivity
@Override
protected void attachBaseContext(Context newBase) {
    super.attachBaseContext(getDelegate().attachBaseContext2(newBase));
}
```

`AppCompatActivity#attachBaseContext` 方法中已被 `AppCompatDelegate#attachBaseContext2` 代理，因此我们在 `BaseActivity` 中重写的 `attachBaseContext` 方法就失效了。

**解决方法**：重写 `getDelegate()` 方法，将 Delegate 类一并代理。

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

`delegate.attachBaseContext2` 会对传入的 Context 再进行一次包装，返回的 `ContextThemeWrapper` 对象中的 `mResources` 是内部自行创建的，并非我们的 `ProxyResources`。因此这里使用反射将 `mResources` 对象重新赋值。

完成上述修改后再次调试验证，无论是 `getApplication().getString`，还是 Activity 中的 `textView.setText`、`getContext().getResources().getString` 均被 Hook 住，会走到 `ProxyResources#getText` 方法。动态文案更新逻辑验证可行。

### Hook 系统文本属性

上述方案仅 Hook 住了代码中获取文案的情况。Android 中还有一类文案赋值是在 XML 布局文件中通过属性赋值，这类属性赋值不会走到 `Resources#getText` 方法。我们只能在 View 创建完成之后，通过属性覆盖的方式进行 Hook。

Android 系统允许我们设置自己的 `LayoutInflater.Factory`，并自行实现或重写 `onCreateView` 方法：

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

`overrideText`、`overrideHint` 方法分别对 TextView 的 `text`、`hint` 属性进行重载覆盖。过程中会调用 `view.resources.getText` 方法，而 `view.resources` 即我们封装的 `ProxyResources`。我们将所有文案获取都收口到 `ProxyResources.getText` 方法中。

将 `I18nLayoutInflaterFactory` 设置到 `layoutInflater` 中：

```plain
class BaseActivity : Activity() {
    ......
    override fun onCreate(savedInstanceState: Bundle?) {
        layoutInflater.factory2 = I18nLayoutInflaterFactory(this)
        ......
    }
}
```

### 自定义 View 属性

上述两套 Hook 方案落地之后，基本完成了 Android 95% 以上的文案显示 Hook 工作。还有一类遗漏：自定义 View 的自定义文案属性。

自定义属性赋值，原生方法通常通过 `typedArray.getString` 获取。

我们在 I18nSdk 中提供 `getTypeArrayString` 方法用于获取自定义属性文案：

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

思路很简单：若自定义属性是资源引用，则通过 `context.getString` 获取文案，最终会走到我们收口的 `ProxyResources.getText` 方法；若不是资源引用，则调用 `typedArray.getString` 获取常量引用文案。

**总结**：我们将系统获取文案方法、系统属性覆盖、自定义文案属性这三类显示文案，最终都收口到 `ProxyResources.getText` 方法中。动态文案更新逻辑、占位符替换逻辑等，只需在 `ProxyResources` 中维护即可。

## 踩坑记录

我们通过 Hook 系统的 Context（包含 Application、Activity 的 Context）对象，将所有获取文案的方法最终都收口到了 `ProxyResources.getText` 中。业界也采用类似方案，如火山引擎的 [VolcI18nSDK](https://www.volcengine.com/docs/6411/176533)。

Hook 系统的 Context 对象伴随一定风险，以下分享我们在实践过程中遇到的问题。

### 1. Application Context Hook 带来的问题

Android `ActivityThread` 中有如下代码：

```plain
private void handleReceiver(ReceiverData data) {
    ....
    context = (ContextImpl) app.getBaseContext();
    ....
}
```

`handleReceiver` 在发送广播时会触发。这里的 `app` 是 Application，调用 `app.getBaseContext()` 后强转为 `ContextImpl`。由于我们 Hook 了 Application 的 Context 对象，`app.getBaseContext()` 返回的是我们封装的 `I18nContextWrapper`，强转为 `ContextImpl` 时会造成 `ClassCastException`。

**解决方法**：重写 Application 的 `getBaseContext` 方法。

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

若获取到的 Context 是我们封装的 `I18nContextWrapper`，则再取内部的 `baseContext` 对象，此时得到的是原有的 Context（即 `ContextImpl` 实例）。

### 2. Android 7.0 系统兼容问题

`LayoutInflater.Factory2` 在 Android 7 系统上存在兼容问题。

我们为 Hook 系统文本属性，设置了自己的 `LayoutInflater.Factory2`：

```plain
val view: View? = if (name.startsWith(I18nSdk.packageName)) {
    activity.layoutInflater.createView(name, null, attrs)
} else {
    activity.delegate.createView(parent, name, context, attrs)
}
```

对于自己包名下的自定义 View，我们通过 `activity.layoutInflater.createView` 创建。`activity.layoutInflater` 在 Android 7 下存在隐藏 bug：当 `layoutInflater#mConstructorArgs[0]` 未初始化时，Android 7 系统未做兜底兼容。

我们来看 Android SDK 33 下的 `LayoutInflater` 源码：

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

可见当 `mConstructorArgs[0]` 为 null 时，会使用 `mContext` 作为兜底。然而在 Android 7.0、7.1 上没有这段兼容逻辑。

**解决方法**：在 Android 7.1 及以下系统，通过反射判断 `mConstructorArgs[0]` 为 null 时，对其进行赋值。

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
