---
title: "Compose and View Interop: AndroidView, ComposeView, and Two-Way State"
lang: en
translationKey: jetpack-compose-view-interop
slug: jetpack-compose-view-interop
excerpt: "A practical deep dive into Compose and View interoperability, including AndroidView, ComposeView lifecycle binding, state synchronization, focus, touch conflicts, and migration strategy."
publishDate: '2026-05-19'
tags:
- "Android"
- "Jetpack Compose"
- "AndroidView"
- "State Management"
- "View Interop"
seo:
  title: "Jetpack Compose and View Interop: AndroidView, Lifecycle, and Migration"
  description: "Learn Compose and View interoperability with AndroidView, ComposeView lifecycle, state sync, focus, touch conflicts, performance, and migration strategy."
  pageType: article
---

During an incremental Compose migration, I once hit a strange bug: after embedding a `RecyclerView` into a Compose screen with `AndroidView`, list focus unexpectedly moved to the outer Compose `LazyColumn`. That caused scroll conflicts and incorrect accessibility focus. The investigation made one thing clear: View and Compose are not simply "nested" inside each other. They communicate through a full two-way bridge.

## AndroidView: inserting a View node into the Compose tree

At its core, `AndroidView` inserts a placeholder node into the Compose Slot Table, and that node hosts the actual Android View. Its factory-style API shows how lifecycle binding works:

```kotlin
@Composable
fun MyWebView(modifier: Modifier = Modifier) {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
            }
        },
        update = { webView ->
            webView.loadUrl("https://example.com")
        },
        modifier = modifier.fillMaxWidth()
    )
}
```

`factory` is called only once, when composition first creates the View. `update` runs on every recomposition. The easy trap: do not depend on the number of `update` calls for side effects. Recomposition may be triggered frequently by parent state changes. If you put non-idempotent initialization logic inside `update`, you can create repeated work or duplicate state.

Under the hood, `ViewFactoryHolder` manages the View instance. It intercepts Compose layout measurement and placement instructions, then converts them into View `measure()` and `layout()` calls. The Compose layout engine does not understand the internal structure of the View. It sees only a rectangular area with a size; measurement and drawing are delegated to the View itself.

## ComposeView: traps in the reverse bridge

`ComposeView` goes in the opposite direction: it embeds Compose UI inside the traditional View hierarchy. It extends `AbstractComposeView`, and the core method is only a few lines:

```kotlin
class MyComposeView(context: Context) : AbstractComposeView(context) {
    @Composable
    override fun Content() {
        MyComposeScreen()
    }
}
```

Lifecycle binding is the biggest trap here. `ComposeView` does not automatically infer the host Activity or Fragment lifecycle in every situation. You should configure it explicitly:

```kotlin
// Inside a Fragment
override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
    composeView.apply {
        setViewCompositionStrategy(
            ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed
        )
        setContent { /* Compose UI */ }
    }
}
```

Without `ViewCompositionStrategy`, the default behavior is `DisposeOnDetachedFromWindow`. In RecyclerView item reuse scenarios, that default can cause the composition to be destroyed and recreated repeatedly. I usually use `DisposeOnViewTreeLifecycleDestroyed` with `ViewTreeLifecycleOwner`, so the composition lifecycle matches the host. In Fragment code, this configuration is almost mandatory.

## Two-way channels for state synchronization

State synchronization between View and Compose is where things most often break. My rule is simple: choose one side as the source of truth, and let the other side only read from it or write through callbacks.

**View -> Compose** can read View state through callbacks and update Compose state:

```kotlin
var scrollOffset by remember { mutableIntStateOf(0) }

AndroidView(
    factory = { context ->
        ScrollView(context).apply {
            setOnScrollChangeListener { _, _, scrollY, _, _ ->
                scrollOffset = scrollY // Notify Compose
            }
        }
    }
)

Text("Scroll offset: $scrollOffset")
```

**Compose -> View** can call View methods and use `AndroidView.update` as an instruction channel:

```kotlin
var targetScroll by remember { mutableIntStateOf(0) }

AndroidView(
    factory = { /* ... */ },
    update = { scrollView ->
        scrollView.smoothScrollTo(0, targetScroll)
    }
)

Button(onClick = { targetScroll = 500 }) {
    Text("Scroll to 500")
}
```

**Two-way binding** is the painful case. For example, a custom chart View embedded in Compose may need touch interactions from the View to update Compose state, while Compose data changes need to redraw the View. I prefer lifting state into the ViewModel layer and letting both sides subscribe to the same data. That avoids direct View-to-Compose and Compose-to-View calls that can easily create circular dependencies.

## Focus management and touch events

Focus passes between View and Compose through a two-layer mechanism. Compose has its own focus system, represented by APIs such as `FocusRequester`. The View hierarchy uses `requestFocus()`. When a View wrapped by `AndroidView` requests focus, it notifies the outer Compose focus manager through `ViewTreeFocusCoordinator`.

One issue I hit in a real project: an `EditText` nested inside `AndroidView` caused the outer `Dialog` to close every time the keyboard appeared. The reason was a broken WindowInsets handoff. Compose's `WindowInsets` consumption and the View system's `fitsSystemWindows` behavior are separate mechanisms and are not automatically connected. The fix was to handle `WindowInsets` manually on the `AndroidView` `Modifier`:

```kotlin
AndroidView(
    modifier = Modifier
        .imePadding()           // Handle the keyboard on the Compose side
        .navigationBarsPadding(),
    factory = { context ->
        EditText(context).apply {
            // Disable the View side's own fitsSystemWindows behavior
            fitsSystemWindows = false
        }
    }
)
```

Touch dispatch also needs to be understood clearly. Compose's event system is based on `PointerInputScope`; the View event system is based on `onTouchEvent`. When `AndroidView` is placed inside a scrollable Compose container such as `LazyColumn`, the two systems can compete for touch events.

For scroll conflicts, `requestDisallowInterceptTouchEvent` is the key tool. If your `AndroidView` wraps a horizontally scrolling `HorizontalScrollView`, use this pattern:

```kotlin
AndroidView(
    modifier = Modifier.pointerInput(Unit) {
        // Prevent the Compose side from intercepting horizontal scroll
    },
    factory = { context ->
        HorizontalScrollView(context).apply {
            setOnTouchListener { _, event ->
                parent.requestDisallowInterceptTouchEvent(true)
                false
            }
        }
    }
)
```

## Practical guidance

**Migration order for incremental Compose adoption.** My experience is to replace leaf nodes first: independent Buttons and Text views, then lists and complex layouts. Do not start by wrapping the root Activity layout in a `ComposeView`; that often maximizes the communication overhead between the two UI systems.

**Be careful with performance-sensitive Views.** `SurfaceView`, `TextureView`, and `MapView` have independent rendering threads, and embedding them through `AndroidView` usually has little effect on frame rate. Complex `RecyclerView` screens are different. If you migrate them to `LazyColumn`, compare diffing cost and recomposition cost on real devices first. I usually migrate non-list screens first and leave list pages until the corresponding `LazyColumn` path is proven mature.

**Debugging technique.** In Android Studio Layout Inspector, the Compose tree and View tree are shown as separate hierarchies. When debugging nesting issues, first decide whether the issue is on the Compose composition side or the View layout side. A quick way to locate it: add `border(2.dp, Color.Red)` to the `AndroidView` `Modifier`, and wrap `ComposeView` with a red background. Visualizing the bounds often tells you within seconds whether the problem is hierarchy nesting or layout measurement.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipping](/en/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-%E9%AB%98%E7%BA%A7%E5%BA%94%E7%94%A8%E4%B8%8E%E5%8E%9F%E7%90%86/)
- [Jetpack Compose Modifier internals: Modifier.Node, layout, drawing, and event handling](/en/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/en/blog/jetpack-compose-gestures/)
<!-- /seo-internal-links -->
