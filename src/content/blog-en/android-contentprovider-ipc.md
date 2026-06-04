---
title: "Android ContentProvider IPC: URI Routing, Cursor Windows, and ContentObserver Notifications"
lang: en
translationKey: android-contentprovider-ipc
slug: android-contentprovider-ipc
excerpt: "A deep dive into Android ContentProvider cross-process data sharing, covering URI routing, transparent Cursor IPC, and ContentObserver change notifications."
publishDate: '2026-05-15'
tags:
- "Android"
- "ContentProvider"
- "IPC"
- "Architecture"
- "Performance"
seo:
  title: "Android ContentProvider IPC: URI Routing, Cursor Windows, and Permissions"
  description: "Understand ContentProvider URI matching, cross-process Cursor access, permission checks, startup flow, and performance risks."
  pageType: article
---

While building a system gallery app, I needed to synchronize image index data across multiple processes. My first instinct was to share a database file, but multi-process SQLite writes quickly ran into lock contention. WAL mode did not really save it. After switching to ContentProvider and getting the flow working once, the design turned out to be much more carefully engineered than it looks at first.

This article connects the full ContentProvider data path: URI routing, cross-process Cursor transport, and ContentObserver change notifications.

## URI routing: what entry matching really means

A ContentProvider exposes data through URIs. The format is familiar:

```
content://com.example.app.provider/table/123
```

The internal matching logic is easy to overlook. Each Provider maps URIs to integer codes through `UriMatcher`, then dispatches inside `query / insert / update / delete` with a `switch`:

```java
public class MyProvider extends ContentProvider {
    private static final UriMatcher matcher = new UriMatcher(UriMatcher.NO_MATCH);
    static {
        matcher.addURI("com.example.app.provider", "user", 1);
        matcher.addURI("com.example.app.provider", "user/#", 2);
    }

    @Override
    public Cursor query(Uri uri, String[] proj, String sel,
                        String[] selArgs, String sort) {
        int code = matcher.match(uri);
        switch (code) {
            case 1: return db.query("user", proj, sel, selArgs, null, null, sort);
            case 2: return db.query("user", proj, 
                        "_id=?", new String[]{uri.getLastPathSegment()}, null, null, sort);
            default: throw new IllegalArgumentException("Unknown URI: " + uri);
        }
    }
}
```

`UriMatcher` matching is **plain string comparison**. It does not use regex semantics. `#` matches numbers only, and `*` matches arbitrary text. The order of wildcard path segments matters because matching follows registration order, and the first hit wins. In real projects, `#` is used far more often than `*` because Android data models usually rely on auto-increment IDs as primary keys.

One common pitfall: `UriMatcher.addURI` expects the authority and path to be passed separately. If you pass the full URI string, including the `content://` prefix, matching will always return `NO_MATCH`.

## Cross-process Cursor: who sends data, and who receives it

When the caller gets a `Cursor` from `ContentResolver.query()`, it is not the same Cursor object that lives in the Provider process. Android inserts a key transparent proxy layer here.

Using pre-API 29 behavior as an example, `ContentResolver` calls the Provider's `query()` over Binder. The returned object is a `CursorToBulkCursorAdaptor`. This adaptor wraps the Cursor as an `IBulkCursor`, then the caller process unwraps it through `BulkCursorToCursorAdaptor` and exposes a usable `Cursor` instance.

In pseudocode, the flow looks like this:

```java
// Provider process
Cursor cursor = db.query(...);
IBulkCursor bulkCursor = new CursorToBulkCursorAdaptor(cursor, ...);
return new CursorWindow(...); // The first data window returns with the Binder call

// Caller process
IBulkCursor bulkCursor = stub.query(...);
Cursor result = new BulkCursorToCursorAdaptor(bulkCursor);
```

**The unit of cross-process transfer is CursorWindow**, whose default size is 2 MB. The Provider fills the window, and the caller reads it. `Cursor.moveToNext()` does not trigger a Binder call for every row. It first checks whether the current window still has data, and only requests the next batch over Binder when the window is exhausted. This design greatly reduces IPC frequency.

The object returned by `ContentResolver.query()` is effectively a subclass of `CursorWrapper`. On API 29 and later, the lower-level implementation moved to a newer transport path in `ContentProviderNative`, but the public API behavior remains the same, so callers do not need to care about the difference.

## ContentObserver: the change-notification path

After data changes, cross-process notification relies on `ContentObserver` plus `ContentResolver.notifyChange()`.

```java
// Provider process
getContext().getContentResolver().notifyChange(uri, null);

// Caller process
getContentResolver().registerContentObserver(uri, true, new ContentObserver(handler) {
    @Override
    public void onChange(boolean selfChange) {
        // Query the data again
    }
});
```

The second parameter to `notifyChange` is a `ContentObserver`. Passing `null` notifies all subscribers for that URI. The notification itself is a Binder callback pushed from the Provider's process to all client processes that registered an Observer.

In delayed-notification scenarios, `onChange` may run on the UI thread. Running a direct `requery` inside it can throw `NetworkOnMainThreadException` or block the main thread. Prefer passing a background `Handler` whenever possible:

```java
new ContentObserver(new Handler(Looper.getMainLooper())) {
    @Override
    public void onChange(boolean selfChange) {
        // Main-thread callback
    }
};
```

Also pay attention to the second boolean parameter of `registerContentObserver`: `notifyForDescendants`. When set to `true`, changes to any child URI under `content://authority/table`, such as `table/1`, will trigger the observer. This is useful when listening to an entire table because you do not need to register an observer for every ID.

## A detail that is easy to miss: selfChange

If the process that registered the Observer calls `notifyChange` itself, `onChange(boolean selfChange)` receives `true`. This flag can prevent loops such as "I changed data, I received a notification, I queried again, then I changed it again." In cross-process scenarios, however, `selfChange` is always `false` because the change happened in another process.

## Practical lessons

**Design URI layers deliberately.** Do not put every table under one authority and rely only on path differentiation. Each authority maps to a Provider instance with its own database connection and lifecycle, which gives you better fault isolation when something goes wrong.

**Close Cursors promptly.** A cross-process Cursor is backed by both a Binder object and CursorWindow memory. Leaving it open leaks both resource types. Cleanup through `finalize()` depends entirely on GC timing, which is not controllable. Use try-with-resources or call `close()` in `finally`.

**Do not overuse change notifications.** Android's `notifyChange` ultimately goes through `ActivityManagerService` or, on newer versions, `ContentService` to broadcast notifications. High-frequency updates such as realtime location do not belong on ContentObserver. Broadcast or Messenger is usually a better fit there, leaving ContentProvider for structured data sharing.

ContentProvider is the quietest of the four major Android components. It has no UI and does not launch an Activity, but it is still the standard path for cross-process data sharing. Once you understand URI routing, Cursor proxies, and Observer notifications, most ContentProvider issues in day-to-day development become straightforward to locate.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Binder internals: from driver communication to the AIDL call chain](/en/blog/android-binder/)
- [Android Framework system services: AMS, WMS, and the app-process interaction model](/blog/android系统服务与framework层交互模型/)
- [Android process and thread model: Zygote, main thread, and Binder thread pools](/blog/android进程与线程模型深度剖析/)
- [Android permission system: runtime permissions, interception paths, and security boundaries](/en/blog/android-permission-system-evolution/)
<!-- /seo-internal-links -->
