---
title: 深入 Android 架构模式演进：从 MVC 的混乱到 MVI 单向数据流在 Compose 中的声明式架构实践
excerpt: 本文梳理 Android 架构模式从 MVC、MVP、MVVM 到 MVI 的演进，剖析各阶段核心痛点，分享 Compose 下 MVI 单向数据流的落地实践与避坑经验。
publishDate: '2026-05-23'
tags:
- Android
- Jetpack Compose
- MVI
- 架构设计
- Kotlin
seo:
  title: 深入 Android 架构模式演进：从 MVC 的混乱到 MVI 单向数据流在 Compose 中的声明式架构实践
  description: Android 架构从 MVC 到 MVI 的演进全解析：剖析 MVC 职责混乱、MVP 接口膨胀、MVVM 事件处理困境，详解 Compose 下 MVI 单向数据流的声明式架构实践与三大避坑指南。
---

三年前接手过一个电商项目，Activity 里塞了 2000 多行代码，业务逻辑、网络请求、UI 更新全搅在一起。改一个按钮状态要找遍四五个方法。不是 MVC 错了，是我们从来没用对过。

## MVC：被误读的起点

Android 早期的 MVC 有个先天缺陷：Activity/Fragment 既是 Controller 又是 View。标准 MVC 里 View 通过观察者模式感知 Model 变化，但在 Android 中 Activity 直接持有 View 引用，Controller 和 View 耦合在同一个类里。

```java
// 典型的 Android "MVC"：Activity 包办一切
public class LoginActivity extends AppCompatActivity {
    void onLoginClick() {
        // 业务逻辑 → Controller 职责
        if (username.isEmpty()) {
            // UI 更新 → View 职责
            errorText.setVisibility(View.VISIBLE);
            return;
        }
        api.login(username, password, new Callback() {
            void onSuccess(User user) {
                // 又回到了 View 职责
                welcomeText.setText("Hello " + user.name);
            }
        });
    }
}
```

这不是架构，这是把所有代码塞进一个文件。职责边界模糊到连 mock 入口都找不到，更谈不上单元测试。

## MVP 的分层尝试

MVP 把 View 抽象成接口，Presenter 持有 View 引用并负责协调逻辑。Activity 瘦下来了，但 View 接口开始膨胀。

```java
public interface LoginView {
    void showLoading();
    void hideLoading();
    void showError(String msg);
    void navigateToHome();
    // 每加一个 UI 状态就要加一个方法
}
```

真实项目里 View 接口动辄 30 多个方法，Presenter 还得手动管理 attach/detach 避免内存泄漏。我的处理方式是写了个 BasePresenter 模板类统一收口，但模板代码量依然不少。

更隐蔽的问题是 Presenter 命令式驱动 View 带来的时序耦合——`showLoading()` 之后必须跟 `hideLoading()`，调用顺序写错了 UI 行为就乱。本该解耦的两层被隐式的调用协议重新绑在一起。

## MVVM 与数据驱动的转向

MVVM 引入 ViewModel 和 DataBinding，用数据驱动 UI 替代命令式调用。View 观察 ViewModel 中的 LiveData 或 StateFlow 自动刷新，Presenter 时代的手动调用消失了。

```kotlin
class LoginViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun login(username: String, password: String) {
        _uiState.update { it.copy(isLoading = true) }
        viewModelScope.launch {
            // 业务逻辑
            _uiState.update { it.copy(user = result, isLoading = false) }
        }
    }
}
```

比 MVP 简洁了一个量级。但 MVVM 有一个棘手问题：一次性事件的处理。SnackBar 提示、页面跳转这类操作，执行一次就该消费掉，但 StateFlow 是持久化的。于是出现了 SingleLiveEvent、Channel 等各种方案，同一个项目的不同页面甚至用了不同方式。

2021 年我做过一次技术选型讨论，团队一半人倾向 SharedFlow，另一半主张把事件也建模成 State（加个 `consumed` 标记）。争论的根源是 MVVM 从未明确定义 State 和 Event 的边界。

## MVI：意图即模型

MVI 把这个模糊地带做了严格定义。三个核心组件：

- **Model**：单一不可变的 UI 状态（data class），不等于传统数据模型
- **View**：接收 State 渲染 UI，发送 Intent 表达用户操作
- **Intent**：用户操作的抽象，不是 Android 的 `Intent` 类

MVI 的核心设计是：用户操作不直接改 UI，而是声明意图，由中间层基于当前 State 计算新 State。配合单向数据流（UDF），数据始终只沿一个方向流动：

```
User → Intent → Model(State) → View → User
```

```kotlin
// 状态：不可变 data class
data class LoginState(
    val username: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null
)

// 意图：用户操作的密封类
sealed class LoginIntent {
    data class UpdateUsername(val value: String) : LoginIntent()
    data class UpdatePassword(val value: String) : LoginIntent()
    object SubmitLogin : LoginIntent()
}
```

ViewModel 或 Reducer 收到 Intent 后，基于当前 State 计算新 State。整个过程无副作用、可预测、可测试——给定初始 State 和 Intent 序列，输出的 State 序列完全确定。

## Compose 与 MVI 的天然契合

Compose 的声明式 UI 本质就是 `UI = f(State)`，和 MVI 的 `newState = reducer(currentState, intent)` 构成函数式闭环：

```kotlin
@Composable
fun LoginScreen(
    state: LoginState,
    onIntent: (LoginIntent) -> Unit
) {
    Column {
        TextField(
            value = state.username,
            onValueChange = { onIntent(LoginIntent.UpdateUsername(it)) }
        )
        Button(
            enabled = !state.isLoading,
            onClick = { onIntent(LoginIntent.SubmitLogin) }
        )
        state.error?.let {
            Text(it, color = Color.Red)
        }
    }
}
```

Compose 的重组机制（Recomposition）只更新发生变化的 Composable。MVI 的不可变 State 正好是触发重组的合适数据源——用 `mutableStateOf` 或 `collectAsState`，Compose 编译器能精确追踪哪个 Composable 读取了哪个字段，做到最小粒度刷新。

实际项目中踩过一个坑：State 的 equals 实现。如果 data class 包含 List 类型字段，默认 equals 比较引用而非内容。建议用 `@Stable` 注解配合 Kotlin data class，或直接用 Kotlin 1.9+ 的 `ImmutableList`，确保 Compose 编译器能正确跳过不必要的重组。

## 实践的三个坑

**不要每个页面都建 Intent 和 State。** 设置页、静态内容页用 ViewModel + StateFlow 就够了。MVI 的价值在**多交互源场景**——多个按钮、网络回调、定时器都可能修改同一片 UI 状态时，UDF 能避免状态被意外覆盖。

**副作用要显式建模。** 网络请求、数据库读写不应该藏在 Reducer 里。我用 `kotlinx.coroutines.flow` 的 `flatMapLatest` 把 Intent 流拆成纯计算和副作用两个分支，副作用的结果以新 Intent 形式回流：

```kotlin
// 副作用以新 Intent 回流，不破坏单向数据流
intents.flatMapLatest { intent ->
    when (intent) {
        is LoginIntent.SubmitLogin -> flow {
            emit(LoginState(isLoading = true))
            val result = authRepo.login(username, password)
            emit(result.toLoginState()) // 结果作为新 State
        }
        else -> emptyFlow()
    }
}
```

**测试 State 的完整状态空间。** MVI 的确定性让测试变得简单，但我见过太多只测 happy path 的案例。State 的所有合法组合 × 所有 Intent 才构成完整测试矩阵。推荐用 Kotlin 的 property-based testing 框架（如 Kotest）自动生成 State 组合，而不是手写几十个 test case。

我现在的默认选型：新项目 Compose + MVI，老项目在 MVVM 基础上逐步收束事件处理方式，统一到 `Channel<Event>` 或 `SharedFlow`。架构的意义不在于追新，而在于代码在每个阶段都能被团队理解和维护。
