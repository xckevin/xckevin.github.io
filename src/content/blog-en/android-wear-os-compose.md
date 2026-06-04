---
title: "Android Wear OS Compose: ScalingLazyColumn, Tiles, and DataLayer"
lang: en
translationKey: android-wear-os-compose
slug: android-wear-os-compose
excerpt: "A practical deep dive into adapting Compose UI for Wear OS, covering round-screen clipping, ScalingLazyColumn, Tile rendering constraints, and DataLayer synchronization."
publishDate: '2026-03-19'
tags:
- "Android"
- "Wear OS"
- "Jetpack Compose"
- "Tile Service"
- "Declarative UI"
seo:
  title: "Wear OS Compose: ScalingLazyColumn, Tiles, and DataLayer"
  description: "Learn how phone Compose components break on Wear OS, and how ScalingLazyColumn, Tile services, GradientEdge, and DataLayer sync solve watch UI constraints."
  pageType: article
---

Last year, I moved a set of phone-side Compose layouts directly to Wear OS. When `LazyColumn` scrolled on a round watch face, the content was clipped beyond recognition. My first reaction was, "just add padding." It was nowhere near that simple. The physical constraints of a watch screen require a completely different component model, especially for list scrolling and background services.

## How hardware constraints reshape components

Watch screens are usually 1.2 to 1.6 inches, often round, with high ppi but a tiny visible area. Two constraints directly shape component design.

**The first is the clipping area.** A round screen is still laid out inside a rectangular `FrameLayout`, so all four corners are inevitably cut off. On phones, `padding` or `clipToPadding=false` can often solve this. On a watch, that approach fails. The empty corner regions of a watch face are not a design choice; they are a physical fact.

Wear OS Material themes include built-in horizontal `percentage` padding:

```kotlin
// Horizontal inset handled by Wear OS; about 5.2% on a round watch face.
compositionLocalOf { 0.052f }
```

You do not need to handle this manually for standard components, but custom components should read the value from `WearSystem`. All standard components, such as Chip, Card, and Button, reserve this curved safe area by default.

**The second is scroll direction.** The crown rotates vertically, and vertical rotation is more natural than horizontal swiping. As a result, primary Wear OS lists are **vertically scrollable**. `HorizontalPager` is reserved for lower-frequency workflows such as switching watch faces. Returning to the failure case above, the problem with `LazyColumn` is that its items do not handle scaling at the edges of a round viewport. The first and last items can be cut directly into the bezel.

## ScalingLazyColumn: more than a watch version of LazyColumn

The core mechanism of `ScalingLazyColumn` is **viewport scaling**. The farther an item is from the screen center, the more transparent and smaller it becomes. This solves two engineering problems:

1. The user can always see the currently focused item in full.
2. Items leaving the viewport indicate their position by shrinking and fading, instead of being brutally clipped.

```kotlin
ScalingLazyColumn(
    modifier = Modifier.fillMaxSize(),
    autoCentering = AutoCenteringParams(itemIndex = 0, itemOffset = 0),
    scalingParams = ScalingLazyColumnDefaults.scalingParams(
        edgeScale = 0.6f,      // Scale edge items down to 60%.
        edgeAlpha = 0.3f       // Fade edge items to 30% opacity.
    )
) {
    items(messageList) { message ->
        ChatCard(message)
    }
}
```

`edgeScale` and `edgeAlpha` control the falloff curve. I recommend setting `edgeScale` to 0.6-0.7. Too low, and users may think the list has reached the end. Too high, and the clipping still feels obvious.

**Pitfall:** `autoCentering` uses the first list item as the anchor by default. If the top contains a header, set `itemIndex` to the first real content item. Otherwise, rotating the crown can snap the list back to the header, which feels like a bug.

### List state and visibility detection

`ScalingLazyListState` exposes `layoutInfo.visibleItemsInfo`, which gives you the currently visible items:

```kotlin
val listState = rememberScalingLazyListState()
val centerItem = listState.layoutInfo.visibleItemsInfo
    .minByOrNull { abs(it.unadjustedOffset) }

LaunchedEffect(centerItem) {
    centerItem?.let {
        viewModel.onItemFocused(it.index)
    }
}
```

Interactions such as "rotate the crown to select an item, then auto-play voice" are built on this foundation. You do not need to listen for scroll gestures. State changes map directly to business logic.

### List anchors and RotaryScroll coordination

`RotaryScrollHandler` is the Wear OS input abstraction layer. It converts crown rotation events into list scrolling. Regular cases do not need manual handling, but custom components often do:

```kotlin
@Composable
fun CustomPicker(
    state: ScalingLazyListState,
    onFling: () -> Unit
) {
    ScalingLazyColumn(state = state) { /* items */ }
    
    // Custom crown behavior: trigger a side swipe on fast rotation.
    RotaryScrollHandler { event ->
        if (event.verticalScrollPixels > 100) {
            onFling()
        }
        true
    }
}
```

Use the default behavior for common cases. **A custom RotaryScrollHandler must return true**, otherwise the event continues propagating to system gestures and the crown may stop scrolling the list.

## Tile service: a card-like micro app on the watch

If `ScalingLazyColumn` is the Wear OS version of RecyclerView, a Tile is the watch-side version of a Widget. It runs inside a restricted sandbox with several hard constraints:

- **No network access**. A Tile is a purely local rendering service.
- **No lifecycle awareness**. It is not bound to an Activity, and `onTileResourcesRequest` may run without a normal Context.
- **Only 10 seconds of runtime**. If it exceeds the time limit, the system kills the process.

These constraints mean all Tile data must be ready before the request arrives. A typical architecture is: the phone app syncs data to the watch through DataLayer, and the Tile reads from local storage.

```kotlin
class WeatherTileService : TileService() {

    override fun onResourcesRequest(requestParams: ResourcesRequest) =
        serviceScope.future {
            // Read from local DataStore; do not make network requests here.
            val weather = repository.getLatest()
            Tile.Builder()
                .setResourcesVersion(weather.version)
                .setTile(buildTile(weather))
                .build()
        }

    override fun onTileAddEvent(requestParams: AddEventRequest) {
        // Triggered when the Tile is added to the watch face. Initialize here if needed.
    }
}
```

### Declarative Tile layout: code as template

Tile layouts are not XML and not Compose. They are described through builder APIs:

```kotlin
private fun buildTile(weather: WeatherData) = Tile.Builder()
    .setTimeline(
        Timeline.fromLayoutElement(
            LayoutElementBuilders.Row.Builder()
                .setWidth(DimensionBuilders.expand())
                .addContent(
                    LayoutElementBuilders.Column.Builder()
                        .addContent(
                            LayoutElementBuilders.Text.Builder()
                                .setText("${weather.temp} degrees")
                                .setTypography(Typography.TYPOGRAPHY_DISPLAY1)
                                .build()
                        )
                        .addContent(
                            LayoutElementBuilders.Text.Builder()
                                .setText(weather.condition)
                                .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                                .build()
                        )
                        .build()
                )
                .build()
        )
    ).build()
```

The syntax is verbose, but the benefit is very high static structure. There is no recomposition and no diffing, so the rendering path is extremely short. A Tile is a prebuilt layout tree, and switching to it from the watch face is nearly zero-latency.

### Organizing Tile code with a Compose mindset

When builder nesting becomes too deep, extract layout units into factory methods:

```kotlin
object TileLayouts {
    fun primaryText(value: String) = Text.Builder()
        .setText(value)
        .setTypography(Typography.TYPOGRAPHY_TITLE1)

    fun row(vararg elements: LayoutElement) = Row.Builder()
        .apply { elements.forEach { addContent(it) } }
        .build()
}
```

Kotlin extension functions can simplify this further. In my project, this eventually became a small DSL that felt similar to `@Composable`, and each Tile's `build()` method stayed under 30 lines.

### Data synchronization between Tile and DataLayer

Tiles cannot access the network, so data must flow through Wearable DataLayer. The standard flow is:

```text
Phone app -> DataClient.putDataItem() -> Play Services -> Watch DataClient -> local storage -> Tile read
```

The IO work inside `future {}` in `onResourcesRequest` includes DataLayer reads. If sync latency causes the read to take more than 8 seconds, the Tile can show a blank screen. The fix is to **prefetch data into local Room or DataStore from a Service outside the Tile**:

```kotlin
// Independent Service that listens to DataLayer changes and persists them.
class DataSyncService : WearableListenerService() {
    override fun onDataChanged(dataEvents: DataEventBuffer) {
        // Write every changed data item into local storage.
        // The Tile reads directly from local storage when it starts.
    }
}
```

With this design, `onResourcesRequest` can finish in milliseconds.

## GradientEdge: visual guidance on a tiny screen

Watch screens are so small that users often cannot tell whether a list has more content near the edges. `ScalingLazyColumn` supports `GradientEdge` by default, adding fade indicators at the top and bottom of the list:

```kotlin
ScalingLazyColumn(
    modifier = Modifier.gradientEdge(
        ScalingLazyColumnDefaults.gradientEdge()
    )
)
```

The gradient appears only in directions where more content can be scrolled. When the user reaches the bottom, the bottom gradient disappears automatically. Under the hood, it overlays a `Canvas` drawing layer in the View hierarchy and has no meaningful performance cost.

## Practical advice

A few lessons from building list-heavy UI on Wear OS:

**Use `ScalingLazyColumn` whenever it fits.** It handles round-screen clipping, crown input, and scaling feedback. Reimplementing those pieces yourself costs far more than adapting to it.

**Treat Tiles as static snapshots, not dynamic Widgets.** Minute-level freshness is usually enough. Put data fetching completely outside the Tile. `onResourcesRequest` is a rendering entry point, not a data-request entry point.

**Always test with a round emulator.** Square and round screens have different clipping regions, and layouts that look fine on square screens can fail on real hardware. The round emulator exposes every padding problem. A layout that looks perfect on a square screen may lose the first row as soon as you switch to a round one.
