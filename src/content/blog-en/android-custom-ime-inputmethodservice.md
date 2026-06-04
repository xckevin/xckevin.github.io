---
title: "Android Custom IME: InputMethodService, Process Isolation, and Candidates"
lang: en
translationKey: android-custom-ime-inputmethodservice
slug: android-custom-ime-inputmethodservice
excerpt: "A practical guide to Android custom input methods, covering InputMethodService, IME process isolation, InputConnection, candidate engines, and keyboard rendering."
publishDate: '2025-12-29'
tags:
- "Android"
- "Input Method"
- "IME"
- "Performance"
- "Process Architecture"
seo:
  title: "Android Custom IME: InputMethodService, Process Isolation, and Candidates"
  description: "Build a production-grade Android IME by understanding InputMethodService, process isolation, InputConnection, candidate latency, and keyboard rendering."
  pageType: article
---

While building a voice input feature, I ran into a nasty issue: starting a speech recognition Activity from `InputMethodService` made the keyboard disappear immediately. There were no useful exception logs. After a full day of debugging, the root cause turned out to be the IME process model and window layering.

Writing a demo that can type text is not hard. Building a production-grade input method requires understanding the independent process model behind it, the bidirectional IPC channel, and the rendering mechanics of keyboard UI. This article follows the same path I took while debugging the real project.

## The independent IME process model

An Android input method runs in an **independent process**, fully isolated from the host app. This is not optional; the system enforces it.

There are two hard constraints behind this design. The first is **security**: an IME can capture every keystroke, including passwords. Process isolation naturally blocks a host app from stealing input data through memory scanning, and that boundary is an intentional part of Android's security model. The second is **stability**: an input method crash must not bring down the foreground app. I tested this on low-end devices. When the IME process was killed, the host app kept running, and the system restarted the input method service.

```xml
<!-- AndroidManifest.xml -->
<service
    android:name=".MyIME"
    android:permission="android.permission.BIND_INPUT_METHOD"
    android:process=":ime">
    <intent-filter>
        <action android:name="android.view.InputMethod" />
    </intent-filter>
    <meta-data
        android:name="android.view.im"
        android:resource="@xml/method" />
</service>
```

`android:process=":ime"` specifies a private process name. The `permission` declares `BIND_INPUT_METHOD`, and the system only allows components holding that permission to bind to this Service. A normal app cannot connect to it directly.

Process isolation has an obvious cost: every cross-process operation must go through Binder. You cannot directly access the host app's View tree, and you cannot call into its in-memory data. All interaction depends on the `InputConnection` protocol.

## InputMethodService lifecycle traps

The lifecycle of `InputMethodService` is much more complex than a normal Service. It is not a simple `onCreate` to `onDestroy` path. It is a state machine designed around input focus.

The key callback order looks like this:

```kotlin
class MyIME : InputMethodService() {
    // Called once when the Service is created. Do global initialization here.
    override fun onCreate() {
        super.onCreate()
        loadDictionary() // Load the dictionary only once
    }

    // Called every time the IME receives input focus
    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        // attribute contains the input type, IME options, and related metadata
        configureForInputType(attribute)
    }

    // Called when the keyboard View is actually created
    override fun onCreateInputView(): View {
        return layoutInflater.inflate(R.layout.keyboard, null)
    }
}
```

The easiest place to make a mistake is the call order between `onStartInput` and `onCreateInputView`. The actual order is `onStartInput` -> `onCreateInputView` -> `onStartInputView`. If you touch a View in `onStartInput` before it has been created, you get a direct NPE.

My voice input bug came from this exact area. The speech Activity did not set its Window type to `TYPE_INPUT_METHOD_DIALOG`. `WindowManagerService` treated it like a normal Activity, which broke the IME window layer, causing the keyboard to lose focus and disappear. The fix was one line:

```kotlin
// In the voice Activity's onCreate
window.setType(WindowManager.LayoutParams.TYPE_INPUT_METHOD_DIALOG)
```

All windows inside the IME process must use the `TYPE_INPUT_METHOD_*` family of Window types. Only then can WMS attach them correctly to the input method window layer. When the type is wrong, disappearing keyboards and broken z-order are normal failure modes.

## InputConnection: the bidirectional protocol layer

`InputConnection` is the **only channel** between an IME and the host app. It is a Binder interface proxy that runs in the host app process, and the IME uses it for all text operation requests.

Common operations:

```kotlin
val ic = currentInputConnection

// Insert text at the cursor. The second argument is the new cursor offset.
ic?.commitText("hello", 1)

// Delete characters around the cursor
ic?.deleteSurroundingText(1, 0) // Delete 1 character before the cursor

// Read surrounding context, which is critical for predictive input
val before = ic?.getTextBeforeCursor(100, 0)
val after = ic?.getTextAfterCursor(50, 0)

// Select a specific range
ic?.setSelection(0, 5)
```

**`getTextBeforeCursor` is not universal**. Its return value depends on the host app's Editor implementation. If the host uses a custom View instead of `EditText`, the result may be an empty string or truncated data. Predictive input cannot rely on it completely.

`InputConnection` has another common pitfall: every focus change may return a new instance. **Do not cache** `currentInputConnection`. Read it again before every operation. In one real project, I wrapped it like this:

```kotlin
class ImeConnection(private val service: InputMethodService) {
    val ic: InputConnection?
        get() = service.currentInputConnection

    fun safeCommit(text: String) {
        ic?.commitText(text, 1) ?: run {
            // Fallback: InputConnection may be null in some WebView cases
        }
    }
}
```

## Candidate engine: latency is the core metric

The candidate area may look like a simple `RecyclerView`, but the engine behind it directly affects how responsive typing feels.

The core path is **key event -> pinyin segmentation -> dictionary lookup -> candidate ranking -> UI refresh**. Latency accumulates across every stage. Once the full path exceeds 200 ms, users can feel the lag.

I used a double-buffering strategy for high-frequency refreshes:

```kotlin
class CandidateEngine {
    private var displayList = listOf<Candidate>()
    private var computeList = listOf<Candidate>()
    private val lock = Any()

    fun onKeyPress(prefix: String) {
        threadPool.execute {
            val result = search(prefix)
            synchronized(lock) { computeList = result }
            mainHandler.post { swapAndNotify() }
        }
    }

    private fun swapAndNotify() {
        synchronized(lock) { displayList = computeList }
        adapter.submitList(displayList)
    }
}
```

Double buffering avoids concurrent modification and UI flicker when new data arrives while the Adapter is already being updated. Users usually type every 100 to 300 ms, so dictionary lookup should stay under 50 ms.

The dictionary data structure matters. For a small input method, SQLite with FTS is enough for prefix matching. At the million-entry scale, latency rises noticeably. In Chinese pinyin scenarios, a **Trie is 3 to 5 times faster than SQLite** in practical tests, at the cost of roughly doubled memory usage. A good compromise is a Double-Array Trie, which gives O(n) queries with better space efficiency.

## Keyboard UI rendering and touch dispatch

Drawing the keyboard View itself is not complicated. The hard part is **touch event handling**. An input method keyboard must distinguish taps from swipes. The default View `onClick` and `onLongClick` mechanisms are not precise enough, so `onTouchEvent` needs to be handled directly:

```kotlin
override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.action) {
        MotionEvent.ACTION_DOWN -> {
            pressedKey = findKeyAt(event.x, event.y)
            invalidateKey(pressedKey) // Highlight feedback
        }
        MotionEvent.ACTION_MOVE -> {
            if (distanceFromDown(event) > SLOP) {
                enterSwipeMode() // Enter swipe input mode
            }
        }
        MotionEvent.ACTION_UP -> {
            if (!isSwipeMode) onKeyClicked(pressedKey)
            clearPressedState()
        }
    }
    return true
}
```

Overdraw is another performance point to watch closely. A 40-key keyboard can draw four layers per key: background, text, shadow, and pressed state. That adds up to more than 160 draw layers. My optimization was to pre-render the static keyboard into a Bitmap and refresh only changed key regions. With a `ViewGroup.drawChild` override, unpressed keys skip `invalidate`, saving about 70% of repeated drawing.

## Practical recommendations

**Check Window types first.** IME popups, candidate floating windows, and voice UI windows must all use the `TYPE_INPUT_METHOD_*` family. If the type is wrong, many strange behaviors can trace back to it.

**`InputConnection` is a transient snapshot. Do not cache it.** Call `getCurrentInputConnection()` again before each operation, especially for methods such as `getTextBeforeCursor` that depend on host state.

**Own touch handling completely.** Do not depend on View click or long-click behavior. Input method keyboards need gesture precision far beyond what the default mechanisms provide.

The core metric for an input method is latency. From key press to committed text, users can feel delays once the full path exceeds 200 ms. Optimization usually comes down to two directions: keep dictionary lookup in memory instead of reading from disk, and use dirty-region drawing for UI refresh instead of invalidating the whole keyboard.
