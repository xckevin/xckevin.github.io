---
title: "Android Glance AppWidget Deep Dive: RemoteViews and Compose Widgets"
lang: en
translationKey: android-glance-appwidget-remoteviews-deep-dive
slug: android-glance-appwidget-remoteviews-deep-dive
excerpt: "A deep dive into the full Android Glance AppWidget pipeline, from RemoteViews cross-process rendering and the Glance translation engine to Actions, update flows, and update strategy choices."
publishDate: '2026-05-28'
tags:
- "Android"
- "Jetpack Glance"
- "AppWidget"
- "Jetpack Compose"
- "Architecture"
seo:
  title: "Android Glance AppWidget: RemoteViews, Updates, and Compose"
  description: "Understand how Glance AppWidget translates Compose-style UI into RemoteViews, including cross-process rendering, Actions, updates, and tradeoffs."
  pageType: article
---

Last year, when I took over a home-screen widget requirement, I opened the project and found 800 lines of `RemoteViews` construction code. String IDs were everywhere, almost like `findViewById`, and changing one line of layout required mentally reconstructing the rendered result. A widget should be a lightweight entry point, but the maintenance cost was higher than the main app. That is the core problem Glance tries to solve.

## The essential constraints of RemoteViews

To understand what Glance does, you first need to understand what RemoteViews is.

RemoteViews is a `Parcelable` object. It does not carry real View instances. Instead, it carries a set of View operation instructions. The widget process serializes these instructions and sends them across process boundaries to the Launcher. The Launcher deserializes them and builds the real View tree inside `AppWidgetHostView`.

```kotlin
val views = RemoteViews(packageName, R.layout.widget)
views.setTextViewText(R.id.title, "Today's tasks")
views.setImageViewResource(R.id.icon, R.drawable.ic_task)
views.setOnClickPendingIntent(R.id.root, pendingIntent)
appWidgetManager.updateAppWidget(appWidgetId, views)
```

The pain point in this mechanism is that **the UI is declarative, but the code is imperative**. You use Java or Kotlin to "set" properties line by line, while the real UI structure is hidden in an XML file. Reading the code means constantly jumping between two files. RemoteViews also supports only a small set of View types and a limited set of operations. If you want rounded corners, you often end up using `setInt` reflection to modify a property indirectly.

Glance's design goal is to provide a Compose-style declarative API on top of these underlying constraints.

## The Glance translation engine

Glance does not bring the entire Compose runtime into widgets. Instead, it implements a **restricted translation layer**. The `@Composable` functions you write in Glance do not run through the regular Compose compiler runtime path. They run through Glance's own node builder.

The core flow is:

```text
Composable function -> GlanceNode tree -> RemoteViews operation sequence -> AppWidgetManager
```

Each Glance-specific Composable corresponds to one RemoteViews layout element:

| Glance component | Mapped RemoteViews View | Key supported Modifiers |
|---|---|---|
| `Box` | `FrameLayout` | padding, background, size |
| `Row` | `LinearLayout(HORIZONTAL)` | padding, defaultWeight |
| `Column` | `LinearLayout(VERTICAL)` | padding, defaultWeight |
| `Text` | `TextView` | textSize, textColor, maxLines |
| `Image` | `ImageView` | size, cornerRadius |
| `LazyColumn` | `ListView` + `RemoteViewsService` | - |

Modifiers are the most important part of the translation engine's design. `GlanceModifier.background(Color.Red)` is eventually translated into `RemoteViews.setInt(viewId, "setBackgroundColor", color)`, which sets the property through reflection. This reflection mechanism is the source of RemoteViews extensibility. Glance compiles the Compose-style modifier chain into a set of reflection operations while staying compatible with the RemoteViews protocol.

```kotlin
class NoteWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            Column(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .padding(12.dp)
                    .background(Color.White)
                    .cornerRadius(8.dp)
            ) {
                Text(
                    text = "To-do items",
                    style = TextStyle(fontWeight = FontWeight.Bold)
                )
                // List items omitted
            }
        }
    }
}
```

The components and Modifiers you can use are controlled by a compile-time whitelist. If you use standard Compose `Modifier` or `LazyRow`, the IDE may not complain, but the runtime node tree will be missing the corresponding content. I hit this once by using `Modifier.weight(1f)` inside a `Row` instead of `GlanceModifier.defaultWeight()`. It compiled successfully, but the layout on the Launcher was completely wrong.

## Actions: the hard part of translating clicks

RemoteViews handles events entirely through `setOnClickPendingIntent`. Each clickable area binds a `PendingIntent`, with a `FillInIntent` used to distinguish the click target.

Glance wraps this layer as the `Action` interface:

```kotlin
class RefreshAction : Action {
    override suspend fun onRun(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters
    ) {
        // Run update logic here in the app process
        updateNoteWidget(context, glanceId)
    }
}

// Bind inside a Composable
Text(
    text = "Refresh",
    modifier = GlanceModifier.clickable(
        action = Action(RefreshAction::class)
    )
)
```

The translation engine does two things for Actions. First, it registers a unique `BroadcastReceiver` for each `Action`. Second, it puts the `Action` information into the `FillInIntent`. When the user taps, the Launcher sends a broadcast. Glance's `ActionReceiver` intercepts it, instantiates your `Action` through reflection, and calls `onRun`.

The cost of this mechanism is that every click goes through broadcast delivery, process wake-up, and reflection. Latency is usually between 100 ms and 300 ms. Widgets with high-frequency interaction, such as stopwatches, are not a good fit for Glance Actions.

## The full cross-process update flow

Behind a single `update()` call, data crosses at least three processes:

```text
App process                 System Server               Launcher process
   |                            |                           |
   | 1. provideGlance() builds  |                           |
   |    the GlanceNode tree     |                           |
   |                            |                           |
   | 2. Translate to            |                           |
   |    RemoteViews             |                           |
   |                            |                           |
   | 3. AppWidgetManager ------>|                           |
   |    .updateAppWidget()      | 4. Binder transfers       |
   |                            |    RemoteViews (Parcel)   |
   |                            |-------------------------->|
   |                            |                           | 5. AppWidgetHost
   |                            |                           |    .updateAppWidget()
   |                            |                           |
   |                            |                           | 6. Apply RemoteViews
   |                            |                           |    -> real View tree
```

The serialized size of RemoteViews is performance-critical. A complex widget with more than 10 text and image elements usually serializes to roughly 5-15 KB. At the Binder layer, that size is usually not the bottleneck. The real latency is in steps 1 and 2.

`provideGlance` runs as a `suspend` function on Glance's thread pool, and it can call network requests or database queries internally. The widget refresh interval is controlled by `updatePeriodMillis` or WorkManager. The system has hard limits on widget update frequency: **the minimum interval is 30 minutes** on Android 12 and later. If you need more frequent updates, the fallback is `AlarmManager` plus a foreground Service, but that adds power cost.

## When to use Glance, and when to fall back

Glance brings the widget development experience closer to main-app UI work, but it is not a silver bullet. My decision rule is:

**Good fits for Glance:**

- Information-display widgets, such as weather, schedules, and stock prices
- Layouts that contain lists, where `LazyColumn` plus `RemoteViewsService` is much easier than hand-written ListView code
- Teams already familiar with Compose that want to lower widget maintenance cost

**Poor fits for Glance:**

- Widgets that need Canvas drawing or custom animations. RemoteViews does not support them, so Glance cannot provide them either.
- Widgets with many interactive buttons. Every Action goes through the broadcast path, and the accumulated latency is obvious.
- Targets with `minSdk` below 23. Glance requires at least API 23, so lower versions must use traditional RemoteViews.

```kotlin
// Glance and traditional RemoteViews can be mixed
class HybridWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            // The part managed by Glance
            Column { /* ... */ }
        }
    }
}

// Some scenarios can operate on RemoteViews directly
fun updateLegacyPart(context: Context, appWidgetId: Int) {
    val views = RemoteViews(context.packageName, R.layout.widget_legacy)
    views.setProgressBar(R.id.progress, 100, 50, false)
    AppWidgetManager.getInstance(context).partiallyUpdateAppWidget(appWidgetId, views)
}
```

`partiallyUpdateAppWidget` can coexist with Glance. Glance can manage the static content area, while traditional RemoteViews manages unsupported pieces such as progress bars.

## Choosing an update strategy

Glance provides three update granularities:

1. **Global update** with `updateAll(context)`: updates all instances of a widget type. This is suitable when shared data changes and all instances should refresh together.
2. **Single-instance update** with `update(context, glanceId)`: updates only the specified widget instance. Use this when the user taps a button on a particular widget.
3. **Periodic update**: declared through `updatePeriodMillis` in the Manifest, or implemented with WorkManager.

I prefer putting update logic in the Repository layer so the widget and the main app share the same data source:

```kotlin
class WeatherRepository {
    // Data changes drive both the main app UI and the widget
    val weatherFlow: Flow<WeatherData> = dataSource.observe()

    suspend fun refresh() {
        val data = api.fetch()
        dataSource.save(data)
        // Widget updates are scheduled centrally by WorkManager
        WeatherWidgetUpdateWorker.enqueue()
    }
}
```

WorkManager is much more flexible here than `updatePeriodMillis`. You can add constraints, such as updating only when the network is available, set backoff policies, or even chain work. `updatePeriodMillis` depends heavily on the system `AlarmManager`, whose behavior under Doze mode is not very predictable.

---

A widget is essentially a remote view window from your app onto the home screen. Glance does not change that essence. What it changes is the construction style: from manually assembling instructions to declaratively describing UI. When writing Glance, keep the mapping in mind: every Composable eventually becomes a RemoteViews reflection operation. Once that mental model is in place, those issues where code compiles but rendering looks wrong become much easier to explain.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Jetpack Compose](/en/jetpack-compose/)
- [Jetpack Compose recomposition performance: Stability, derivedStateOf, and skipped recomposition](/blog/jetpack-compose-recomposition-performance/)
- [Jetpack Compose principles and advanced usage: state, layout, recomposition, and performance](/blog/jetpack-compose-advanced-applications-internals/)
- [Jetpack Compose Modifier internals: chained nodes, layout, drawing, and events](/blog/jetpack-compose-modifier-node/)
- [Jetpack Compose gestures: PointerInput event pipeline and nested scrolling](/blog/jetpack-compose-gestures/)
<!-- /seo-internal-links -->
