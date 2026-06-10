---
title: "Android TV and Google TV Development: Leanback, D-Pad Focus, and Large-Screen UX"
lang: en
translationKey: android-tv-google-tv-leanback-focus
slug: android-tv-google-tv-leanback-focus
excerpt: "A TV-first Android engineering guide covering D-Pad interaction, Leanback architecture, focus management, remote-control events, and phone-to-TV adaptation."
publishDate: '2026-06-08'
tags:
- "Android TV"
- "Google TV"
- "Jetpack Compose"
- "Leanback"
- "UX"
seo:
  title: "Android TV Development: Leanback and Focus Management"
  description: "Build Android TV apps with D-Pad interaction, Leanback navigation, focus management, remote-control handling, and phone-to-TV adaptation."
  pageType: article
---

Three years ago, I took over a TV video app and started with a familiar phone-oriented Activity. It launched in the emulator, but pressing the remote did almost nothing. That moment made the difference clear: phone interaction and TV interaction are two different systems.

Understanding focus is the first lesson of TV development.

## D-Pad Driven Interaction

On phones, users touch the target directly. Touch events travel from `dispatchTouchEvent` down the view tree. On TV, users move between controls with up, down, left, and right keys. The system must maintain a current focused view and compute the next focused view for each direction.

Android's default focus search is based on spatial proximity. It works for regular layouts, but complex grids can produce surprising jumps.

```kotlin
binding.detailCard.nextFocusLeftId = R.id.nav_menu
binding.detailCard.nextFocusRightId = R.id.detail_action_btn
```

For production TV screens, explicitly assigning `nextFocusLeft`, `nextFocusRight`, `nextFocusUp`, and `nextFocusDown` is often more reliable than relying entirely on automatic focus search.

## Leanback Navigation Architecture

Google provides Leanback for TV-first UI. The classic entry is `BrowseSupportFragment`, which gives you a left navigation rail and a content area.

```kotlin
class MainFragment : BrowseSupportFragment() {
    override fun onCreateHeaders(): Array<HeaderItem> {
        return arrayOf(
            HeaderItem(0, "Recommended"),
            HeaderItem(1, "Movies"),
            HeaderItem(2, "Shows")
        )
    }
}
```

Leanback manages many focus transitions for you: header-to-content movement, row navigation, and card selection. The tradeoff is styling rigidity. If the product wants custom tab navigation, custom rails, or a nonstandard layout, you may need to go beyond Leanback.

For new work, Compose for TV is usually more flexible. For existing View-based TV apps, Leanback remains a pragmatic starting point.

## Three Core Focus Problems

**Problem 1: D-Pad does nothing.** The view is not focusable. Non-button views such as `TextView`, `ImageView`, and custom containers must be explicitly made focusable.

```xml
<ImageView
    android:id="@+id/poster"
    android:focusable="true"
    android:clickable="true"
    android:background="?attr/selectableItemBackground" />
```

`clickable` also matters because the center key maps to click behavior.

**Problem 2: focus disappears after data updates.** RecyclerView updates can recreate or rebind ViewHolders and lose the currently focused item. Avoid broad `notifyDataSetChanged()` and restore focus after updates when necessary.

```kotlin
val focusedPosition = (layoutManager as GridLayoutManager)
    .findFirstVisibleItemPosition()

adapter.notifyItemRangeChanged(0, newList.size)

recyclerView.post {
    recyclerView.findViewHolderForAdapterPosition(focusedPosition)
        ?.itemView
        ?.requestFocus()
}
```

**Problem 3: focus has no visual affordance.** On TV, the focused item must be obvious from several meters away. Use scale, border, shadow, or color changes. Keep the animation short and predictable.

## Remote-Control Keys and Long Press

TV remotes are not limited to directional keys. Back, menu, play/pause, fast-forward, rewind, and long-press behaviors often matter.

Handle key events at the right layer:

```kotlin
override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN) {
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER -> return handleSelect()
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> return togglePlayback()
        }
    }
    return super.dispatchKeyEvent(event)
}
```

Avoid swallowing all keys globally. Let child views handle normal focus movement, and intercept only product-level shortcuts or playback controls.

Long press should be explicit. If you use it for context menus or quick actions, make the visual feedback immediate so the user understands the press is being recognized.

## Adapting from Phone to TV

Phone layouts cannot simply be scaled up. TV needs:

- larger focus targets.
- fewer items per screen.
- clear hierarchy from a distance.
- no reliance on hover or touch gestures.
- predictable D-Pad order.
- safe margins for overscan and living-room viewing.

For cross-device code, share the data and domain layers, but build a TV-specific presentation layer. Reusing phone screens directly usually creates focus traps and unreadable layouts.

The engineering mindset is also different. Phone UX optimizes for direct manipulation. TV UX optimizes for guided navigation. Once focus becomes a first-class state in your architecture, TV development becomes much less mysterious.
