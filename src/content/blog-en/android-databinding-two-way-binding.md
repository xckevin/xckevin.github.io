---
title: "Android DataBinding Two-Way Binding: From ObservableField to StateFlow"
lang: en
translationKey: android-databinding-two-way-binding
slug: android-databinding-two-way-binding
excerpt: "A deep dive into Android DataBinding two-way binding, generated binding code, invalidation loops, and the architectural move from ObservableField and LiveData to StateFlow and Compose."
publishDate: '2025-07-18'
tags:
- "Android"
- "DataBinding"
- "Kotlin"
- "Jetpack Compose"
- "Architecture"
seo:
  title: "Android DataBinding Two-Way Binding: ObservableField to StateFlow"
  description: "Understand DataBinding generated code, invalidation loops, and the evolution from ObservableField and LiveData to StateFlow and Compose."
  pageType: article
---

During a modularization effort, I found this code in an old module:

```xml
<EditText
    android:text="@={viewModel.name}"
    android:enabled="@{viewModel.isEditable}" />
```

That single `@=` introduced a piece of compile-time "magic": DataBinding generated nearly 2,000 lines of Java code behind the scenes. Instead of staring at generated code line by line, it is more useful to work backward from the two-way binding mechanism and understand what it actually does.

## DataBinding's compile-time code generation

DataBinding's core work happens during the `compileDebugJavaWithJavac` phase. The annotation processor scans every XML file with a `<layout>` tag and generates a `ViewDataBinding` subclass for each one.

For `activity_main.xml`, the generated core structure looks like this:

```text
ActivityMainBinding
  - Field bindings, such as EditText and TextView references
  - setViewModel(), which sets binding variables
  - executeBindings(), the core refresh logic
```

`executeBindings()` is the entry point for understanding DataBinding. Every time data changes, this method is called. It walks through all binding expressions and updates the corresponding Views. The simplified core code looks like this:

```java
@Override
protected void executeBindings() {
    String nameValue = mViewModel.getName();
    boolean editableValue = mViewModel.getIsEditable();
    // One-way binding: setText directly
    TextViewBindingAdapter.setText(this.nameView, nameValue);
    // Listener registration for two-way binding
    if (mDirtyFlags & DIRTY_FLAG_NAME) {
        TextViewBindingAdapter.setTextWatcher(this.editView,
            mCallback, nameValue); // TextWatcher is registered here
    }
}
```

Two-way binding relies on the Dirty Flag mechanism. DataBinding maintains a bitmap for each binding variable, and only fields marked as dirty trigger View updates. That avoids refreshing everything.

## The two-way binding invalidation loop

`@={}` does one more thing than `@{}`: it registers a reverse listener on the View.

When the user types into an EditText, `TextWatcher.onTextChanged` fires, and DataBinding calls the ViewModel setter to update the data. The easy pitfall here is an **invalidation loop**:

1. User input triggers TextWatcher, which calls `viewModel.setName(newValue)`
2. ViewModel data changes, so ObservableField notifies all subscribers
3. DataBinding receives the notification, so `executeBindings()` is called
4. `executeBindings()` calls setText on the EditText again

If the ViewModel setter performs formatting, such as trimming leading and trailing spaces, users see the "space disappears immediately after input" problem. The fix is to perform an equality check in the setter:

```kotlin
fun setName(value: String) {
    val trimmed = value.trim()
    if (name.get() != trimmed) {
        name.set(trimmed)
    }
}
```

Here `name` is declared as `ObservableField<String>`. ObservableField is an observable wrapper around a mutable value. Its notify mechanism is based on `BaseObservable` and `notifyPropertyChanged(BR.name)`. Every `set` triggers a notification, regardless of whether the value actually changed. That equality check is therefore required, not a nice-to-have.

## From ObservableField to LiveData and StateFlow

ObservableField has one unavoidable problem: it is **completely unrelated to Android lifecycle**. After an Activity is destroyed, DataBinding can still hold references, so the memory leak risk is real.

Google's 2018-era solution was to combine it with LiveData:

```kotlin
// In the ViewModel
val name = MutableLiveData<String>()

// Used with a BindingAdapter in XML
@BindingAdapter("android:text")
fun setText(view: TextView, value: LiveData<String>?) {
    value?.observe(view.findViewTreeLifecycleOwner()) { text ->
        if (view.text.toString() != text) {
            view.text = text
        }
    }
}
```

`findViewTreeLifecycleOwner()` binds the LiveData observer to the Fragment or Activity lifecycle that owns the View. When the screen is destroyed, the subscription is cancelled automatically. That is the key to avoiding leaks.

But LiveData has its own drawbacks: main-thread constraints, no backpressure control, and limited support for chained operations. These limitations directly contributed to the popularity of Kotlin Flow and StateFlow in MVVM architecture.

I personally prefer using StateFlow directly, dropping XML `@={}` expressions, and collecting state manually in code:

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.name.collect { name ->
            binding.editText.setText(name)
        }
    }
}

// Reverse update with TextWatcher or doAfterTextChanged
binding.editText.doAfterTextChanged { editable ->
    viewModel.updateName(editable.toString())
}
```

The cost is losing the convenience of declarative XML binding. What you get back is explicit subscription and cancellation timing, controllable state update order, and no need to fight DataBinding's generated code.

## The evolution of declarative UI

Looking back over the last decade, DataBinding's `@={}` syntax was one of Google's early experiments with declarative UI. Its core idea, **describe what the UI should be rather than how to mutate it into that state**, kept getting reinforced in later architectures.

The three stages are clear:

**2015-2018: DataBinding plus ObservableField**

Declarative binding lived in XML, but the underlying implementation was still imperative `findViewById` and `setText`. Generated compile-time code hid the binding logic, and debugging failures was difficult.

**2019-2021: LiveData or StateFlow plus ViewBinding**

XML expressions were dropped, and state observation moved into Kotlin code. ViewBinding only replaced `findViewById`; the ViewModel fully owned data-binding responsibilities. Debuggability improved a lot in this stage.

**2021 to now: Jetpack Compose**

XML is gone. UI itself is a mapping function from state to components. `@={}` becomes `remember { mutableStateOf() }`, and two-way binding no longer needs an extra mechanism. State changes trigger recomposition automatically.

```kotlin
var name by remember { mutableStateOf("") }
TextField(
    value = name,
    onValueChange = { name = it }
)
```

The granularity of declarative UI kept improving through the whole evolution. DataBinding's granularity is the XML expression. LiveData's granularity is a single LiveData object. Compose's granularity reaches each `State<T>` variable.

## Tradeoffs in real projects

For the old module from the opening example, the final treatment had two steps:

1. **Remove `@={}` two-way binding**, replace it with LiveData plus manual listeners in code, and first solve the invalidation loop
2. **Use Compose directly for new screens**, while leaving old screens on a DataBinding and ViewBinding mix instead of forcing consistency for its own sake

My technical-selection judgment is straightforward: if your team is already using Kotlin, you can skip DataBinding and go directly to Compose. DataBinding's learning cost, understanding generated code, debugging binding issues, and learning XML expression syntax, is not lower than Compose's declarative mental model. Its payoff is much smaller.

If you are still maintaining an old DataBinding project, two rules are enough for daily work: add equality checks to every ObservableField setter, and use `addOnPropertyChangedCallback` with logs to debug two-way binding. After hitting enough pitfalls, you realize these are the two practical tools this mechanism really leaves for everyday development.
