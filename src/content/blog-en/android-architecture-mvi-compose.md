---
title: "Android Architecture Evolution: From MVC Confusion to MVI in Compose"
lang: en
translationKey: android-architecture-mvi-compose
slug: android-architecture-mvi-compose
excerpt: "A practical walkthrough of Android architecture patterns from MVC and MVP to MVVM and MVI, with Compose-focused guidance for unidirectional data flow."
publishDate: '2026-05-23'
tags:
- "Android"
- "Jetpack Compose"
- "MVI"
- "Architecture"
- "Kotlin"
seo:
  title: "Android Architecture Evolution: MVC, MVP, MVVM, and MVI in Compose"
  description: "Trace Android architecture from MVC to MVI, including MVP interface bloat, MVVM event pitfalls, and practical unidirectional data flow in Compose."
  pageType: article
---

Three years ago I inherited an e-commerce project where a single Activity contained more than 2,000 lines of code. Business logic, network requests, and UI updates were all mixed together. Changing one button state meant searching through four or five methods. MVC was not the real problem. The problem was that we had never used it correctly.

## MVC: A Misunderstood Starting Point

Early Android MVC had a built-in weakness: Activity and Fragment acted as both Controller and View. In standard MVC, the View observes changes in the Model. In Android, the Activity directly holds View references, so Controller and View are coupled inside the same class.

```java
// Typical Android "MVC": Activity does everything
public class LoginActivity extends AppCompatActivity {
    void onLoginClick() {
        // Business logic -> Controller responsibility
        if (username.isEmpty()) {
            // UI update -> View responsibility
            errorText.setVisibility(View.VISIBLE);
            return;
        }
        api.login(username, password, new Callback() {
            void onSuccess(User user) {
                // Back to View responsibility again
                welcomeText.setText("Hello " + user.name);
            }
        });
    }
}
```

That is not architecture. It is putting all the code into one file. The responsibility boundaries become so blurry that you cannot even find a clean mock entry point, let alone write useful unit tests.

## MVP as a Layering Attempt

MVP abstracts the View into an interface. The Presenter holds a View reference and coordinates logic. The Activity gets thinner, but the View interface starts to grow.

```java
public interface LoginView {
    void showLoading();
    void hideLoading();
    void showError(String msg);
    void navigateToHome();
    // Every new UI state adds another method
}
```

In real projects, View interfaces often grew to more than 30 methods. The Presenter also had to manually manage attach/detach to avoid memory leaks. My usual mitigation was a `BasePresenter` template that centralized the lifecycle handling, but the template code was still significant.

The more subtle issue is temporal coupling caused by imperative View commands. `showLoading()` must be followed by `hideLoading()`. If the call order is wrong, the UI behavior breaks. Two layers that were supposed to be decoupled become tied together again through an implicit calling protocol.

## MVVM and the Shift to Data-Driven UI

MVVM introduced ViewModel and DataBinding, replacing imperative calls with data-driven UI. The View observes `LiveData` or `StateFlow` in the ViewModel and refreshes automatically. The manual call pattern from the Presenter era disappears.

```kotlin
class LoginViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun login(username: String, password: String) {
        _uiState.update { it.copy(isLoading = true) }
        viewModelScope.launch {
            // Business logic
            _uiState.update { it.copy(user = result, isLoading = false) }
        }
    }
}
```

This is an order of magnitude cleaner than MVP. But MVVM has a difficult problem: one-off events. SnackBar messages and navigation should be consumed exactly once, but `StateFlow` is persistent. That led to many solutions such as `SingleLiveEvent`, `Channel`, and other event wrappers. In some codebases, different screens used different event mechanisms.

In 2021, I joined a technical selection discussion where half the team preferred `SharedFlow`, while the other half wanted to model events as State with a `consumed` flag. The root cause was that MVVM never clearly defined the boundary between State and Event.

## MVI: Intent as the Model

MVI makes that blurry area explicit. It has three core pieces:

- **Model**: a single immutable UI state, usually a data class. It is not the same thing as a traditional domain model.
- **View**: renders UI from State and sends Intent for user actions.
- **Intent**: an abstraction of user actions, not Android's `Intent` class.

The core design is that user actions do not directly change the UI. They declare intent. A middle layer computes a new State from the current State. With unidirectional data flow (UDF), data always moves in one direction:

```
User -> Intent -> Model(State) -> View -> User
```

```kotlin
// State: immutable data class
data class LoginState(
    val username: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null
)

// Intent: sealed class for user actions
sealed class LoginIntent {
    data class UpdateUsername(val value: String) : LoginIntent()
    data class UpdatePassword(val value: String) : LoginIntent()
    object SubmitLogin : LoginIntent()
}
```

After a ViewModel or Reducer receives an Intent, it computes a new State from the current State. The process is side-effect-free, predictable, and testable. Given an initial State and a sequence of Intents, the output State sequence is fully deterministic.

## Why Compose and MVI Fit Naturally

Compose's declarative UI model is essentially `UI = f(State)`. MVI's reducer model is `newState = reducer(currentState, intent)`. Together they form a functional loop:

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

Compose recomposition updates only the Composables whose inputs changed. MVI's immutable State is a good source for triggering recomposition. With `mutableStateOf` or `collectAsState`, the Compose compiler can track which Composable read which field and refresh at a fine granularity.

One trap I have hit in production is State equality. If a data class contains `List` fields, default equality can behave unexpectedly depending on the actual collection implementation and mutation pattern. Prefer stable immutable values: use `@Stable` carefully with Kotlin data classes, or use Kotlin 1.9+ immutable collection types so the Compose compiler can skip unnecessary recompositions correctly.

## Three Practical Pitfalls

**Do not create Intent and State for every screen.** A settings page or static content page is often fine with ViewModel + StateFlow. MVI is most valuable in **multi-source interaction scenarios**, where buttons, network callbacks, timers, and other inputs can all modify the same UI state. UDF helps prevent accidental state overwrites.

**Model side effects explicitly.** Network calls and database writes should not be hidden inside a Reducer. I use `kotlinx.coroutines.flow` with `flatMapLatest` to split an Intent stream into pure calculation and side-effect branches. The result of the side effect flows back as a new Intent or State transition:

```kotlin
// Side effects flow back without breaking unidirectional data flow
intents.flatMapLatest { intent ->
    when (intent) {
        is LoginIntent.SubmitLogin -> flow {
            emit(LoginState(isLoading = true))
            val result = authRepo.login(username, password)
            emit(result.toLoginState()) // Result becomes a new State
        }
        else -> emptyFlow()
    }
}
```

**Test the full State space.** MVI's determinism makes testing easier, but I have seen too many test suites cover only the happy path. The full matrix is all valid State combinations multiplied by all Intents. I recommend using a Kotlin property-based testing framework such as Kotest to generate State combinations instead of hand-writing dozens of test cases.

My current default choice is Compose + MVI for new projects. For older projects, I usually keep MVVM and gradually normalize event handling around `Channel<Event>` or `SharedFlow`. The point of architecture is not chasing new patterns. It is keeping code understandable and maintainable for the team at every stage.
