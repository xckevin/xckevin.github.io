---
title: "Forms Are Not UI—They Are State Machines"
lang: en
translationKey: compose-declarative-form-state-management
slug: compose-declarative-form-state-management
excerpt: "A practical Compose pattern for modeling forms as state machines: field state, form orchestration, dynamic lists, and cross-field linkage."
publishDate: '2026-08-02'
tags:
- "Jetpack Compose"
- "State Management"
- "Android Forms"
seo:
  title: "Compose Form State: Build Forms as State Machines"
  description: "A practical guide to managing Compose forms with FieldState, FormState, list keys, derived state, and debounced cross-field linkage."
  pageType: article
---

## Forms Are Not UI, They Are State Machines

Last year, while refactoring an e-commerce backend SKU configuration form, I got stuck on Compose form state management. A page with dynamic spec combinations, cross-field validation, and asynchronous duplicate checks, built with the traditional View mindset—where each EditText manages its own state and validation happens en masse at submit—quickly ballooned toward 800 lines.

Compose's declarative paradigm is actually very form-friendly, provided you **design the form as a state machine, not pile it up as UI.**

Form state has three dimensions: each field's value (Value), validation results (Error), and dependencies between fields (Dependency). These three dimensions are mutually coupled; handled poorly, you get bugs like "I changed field A, but field B's validation state didn't update." The problem is that the official documentation only covers the basics of `TextField` and barely addresses how to organize these three dimensions in an engineering way.

## Field-Level State: Single Source of Truth

The most common bad case for a validated input:

```kotlin
// ❌ 状态分散，容易不一致
var text by remember { mutableStateOf("") }
var error by remember { mutableStateOf<String?>(null) }

OutlinedTextField(
    value = text,
    onValueChange = { 
        text = it
        error = validate(it)  // 每次输入都校验，频繁触发重组
    },
    isError = error != null,
    supportingText = { error?.let { Text(it) } }
)
```

The problem isn't syntax; it's muddled responsibilities: `onValueChange` both changes the value and performs validation, coupling validation logic to the UI. There's an even more subtle issue—if validation involves network requests, input frequency can hammer the API directly.

Fields should be encapsulated into independent state holders:

```kotlin
class FieldState(
    initial: String = "",
    private val validators: List<(String) -> String?> = emptyList()
) {
    var value by mutableStateOf(initial)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    
    fun onChange(newValue: String) {
        value = newValue
        error = null  // 输入时清掉错误，提交时再校验
    }
    
    fun validate(): Boolean {
        error = validators.firstNotNullOfOrNull { it(value) }
        return error == null
    }
}
```

**Don't validate on input; validate centrally on submit**—this decision came from real experience. Real-time validation makes users see red error hints before they've finished typing, which hurts the experience; switching to unified validation at submit reduced user complaints sharply.

`FieldState` only exposes `onChange` and `validate` to the outside; external code cannot change `value` directly, guaranteeing a **single source of truth**. Validation rules are declared through the constructor-injected `validators` list, so adding a new rule doesn't require changing internal class logic.

## Form-Level Orchestration: Composition over Inheritance

With individual fields handled, a form is more than just a collection of fields. When submitting, you need to know which fields failed, compute overall validity, and handle field interactions.

Split them into two layers: `FieldState` manages a single field, and `FormState` handles orchestration:

```kotlin
class FormState {
    val name = FieldState(
        validators = listOf(
            { if (it.isBlank()) "名称不能为空" else null },
            { if (it.length < 2) "名称至少 2 个字符" else null }
        )
    )
    val email = FieldState(
        validators = listOf(
            { if (!it.contains("@")) "邮箱格式不正确" else null }
        )
    )
    
    val isValid: Boolean
        get() = listOf(name, email).all { 
            it.error == null && it.value.isNotBlank() 
        }
    
    fun validateAll(): Boolean {
        return listOf(name, email).map { it.validate() }.all { it }
    }
    
    fun snapshot(): Map<String, String> {
        return mapOf("name" to name.value, "email" to email.value)
    }
}
```

Use **composition** rather than inheritance, because fields vary too much across forms, and an inheritance tree would balloon quickly. Composition lets each `FieldState` declare its own validator list independently; extending means adding rules without changing structure.

In a Composable:

```kotlin
@Composable
fun RememberFormState() = remember { FormState() }

@Composable
fun MyForm(form: FormState = RememberFormState()) {
    Column {
        FormField(field = form.name, label = "名称")
        FormField(field = form.email, label = "邮箱")
        Button(onClick = {
            if (form.validateAll()) submit(form.snapshot())
        }) { Text("提交") }
    }
}
```

`remember { FormState() }` ensures Compose recomposition doesn't rebuild `FormState`, so state persists for the entire composition lifecycle.

## Dynamic Forms: State Identity in Lists

Static fields are easy; dynamic forms are the real challenge. Consider an add/remove shipping address list. The core issue is: **when list items are added or removed, how does Compose correctly identify each item's state?**

```kotlin
@Composable
fun AddressList(
    addresses: List<Address>,
    fieldStates: Map<String, FieldState>,
    onRemove: (String) -> Unit
) {
    LazyColumn {
        items(
            items = addresses,
            key = { it.id }  // 用业务 id，别用 index
        ) { address ->
            val field = fieldStates[address.id] ?: return@items
            AddressCard(
                address = address,
                field = field,
                onRemove = { onRemove(address.id) }
            )
        }
    }
}
```

`key = { it.id }` is the key. If you use the default index as the key, you hit a classic pitfall: after deleting index=1, the item originally at index=2 reuses index=1's `FieldState`, causing half-edited content to leak into another row.

When deleting, remember to clean up state synchronously:

```kotlin
fun removeAddress(id: String) {
    addresses = addresses.filter { it.id != id }
    addressFields.remove(id)  // 内存泄漏就藏在这一行
}
```

If you omit `remove(id)`, `addressFields` keeps growing, and those `FieldState` objects hold `mutableStateOf`, so they are never garbage-collected.

## Cross-Field Linkage: Derived State and Debouncing

The hardest part of a form isn't validation; it's linkage. "Select a province and the city list refreshes"; "check 'Other' and a custom input appears." Writing linkage logic directly in `onValueChange` turns the code into a tangle.

The solution is to **declare linkage relationships as derived state**.

```kotlin
// 省份-城市联动
class AddressFormState {
    val province = FieldState()
    val city = FieldState()
    
    // 城市字段是否可用，由省份值派生
    val cityEnabled: Boolean
        @Composable get() = province.value.isNotBlank()
    
    // 城市选项列表，由省份值派生
    @Composable
    fun cityOptions(): List<String> {
        val p = province.value
        return remember(p) {
            if (p.isBlank()) emptyList()
            else cityRepository.queryByProvince(p)
        }
    }
}
```

`@Composable` getters act as reactive dependencies—when `province.value` changes, the UI that depends on it recomposes automatically. The Compose Snapshot system's dependency tracking works directly here.

But network calls cannot be placed directly inside a Composable. `queryByProvince` is written synchronously here; in real projects it is asynchronous. The correct approach is to use `LaunchedEffect` for debouncing:

```kotlin
@Composable
fun rememberCityOptions(province: String): List<String> {
    var options by remember { mutableStateOf(emptyList<String>()) }
    LaunchedEffect(province) {
        if (province.isBlank()) {
            options = emptyList()
        } else {
            delay(300)  // 防抖，用户连续切换省份时不发请求
            options = cityRepository.queryByProvince(province)
        }
    }
    return options
}
```

`LaunchedEffect(province)` triggers only when province changes, and its built-in coroutine scope automatically cancels the previous request when province changes again—solving debouncing and race conditions at once.

## Practical Advice

This approach has run in several mid-to-large projects for more than a year, and the pitfalls have turned into experience:

**Don't use third-party form libraries.** Compose's `mutableStateOf` + `remember` is already flexible enough. Third-party DSLs actually limit extensibility—complex form customization needs vary wildly, and writing 200 lines of state management code costs less than adapting a library.

**Route asynchronous validation through the ViewModel layer.** For things like username duplicate checks, add a `suspend fun validateAsync()` to `FieldState` and call it with `viewModelScope`, rather than writing coroutines directly in the Compose layer.

**Model complex linkage with sealed classes.** When there are more than five linkage relationships, hand-written derived state is easy to miss. Use sealed classes to model the form's display modes (edit, read-only, stepped), then render different UI with `when` branches—the intent is far clearer than piling up `if-else`.

Form architecture has no silver bullet, but decoupling state management from the UI layer and modeling field relationships declaratively can shrink the code from 800 lines to 300—with half the bugs.
