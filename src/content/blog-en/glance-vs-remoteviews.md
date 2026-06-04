---
title: "What Is the Difference Between Glance and RemoteViews?"
lang: en
translationKey: glance-vs-remoteviews
slug: glance-vs-remoteviews
excerpt: "Explains how Android Glance AppWidget relates to RemoteViews, where they differ, when each fits, and how to think about migration."
publishDate: '2026-06-01'
tags:
- "Android"
- "Jetpack Glance"
- "AppWidget"
- "Jetpack Compose"
seo:
  title: "Glance vs RemoteViews: Comparing Android AppWidget Options"
  description: "Compares Android Glance and RemoteViews, including declarative widgets, the RemoteViews translation layer, update behavior, limits, and use cases."
---

Glance is not a new rendering engine that replaces the lower-level Android AppWidget mechanism. It is closer to a declarative wrapper over RemoteViews. That distinction matters, because otherwise it is easy to mistake Glance for "full Compose running inside a home screen widget."

Android home screen widgets are actually rendered inside the Launcher process. Your app process cannot directly send its own View tree across process boundaries. What crosses the boundary is not a View object, but a constrained set of RemoteViews operations.

## RemoteViews is the underlying protocol

The core idea behind RemoteViews is that your app builds a description that tells the Launcher: create this layout, set this text, set this image, wire this click action. The Launcher receives that description, inflates it, and renders it inside its own process.

That mechanism has two important consequences.

First, capabilities are limited. RemoteViews supports only a subset of Views and operations. You cannot use arbitrary custom Views or run arbitrary UI logic. The mechanism is designed for cross-process safety and stability, not for the full power of a UI framework.

Second, updates are submitted in batches. After the app calls `AppWidgetManager.updateAppWidget()`, the system sends the RemoteViews to the host. A widget does not redraw reactively every frame like an Activity. It refreshes state through discrete updates.

That is why traditional RemoteViews code tends to be imperative: create a RemoteViews instance, call `setTextViewText`, `setImageViewResource`, `setOnClickPendingIntent`, and then submit the update.

## What Glance adds

Glance provides Compose-style APIs such as `Column`, `Row`, `Text`, `Image`, `Button`, and `GlanceModifier`. You write code that feels like Compose, but the result is translated into RemoteViews.

That means Glance mainly improves developer experience and state organization:

- The UI structure is closer to declarative code.
- It works more naturally with Kotlin, coroutines, DataStore, and other modern Android components.
- Component composition is clearer than hand-written RemoteViews.
- Teams already used to Compose have a lower adoption cost.

But Glance still inherits the boundaries of RemoteViews. Just because the API looks like Compose does not mean it supports full Compose layout, animation, gestures, Canvas, custom drawing, or complex state management.

## The key differences

RemoteViews is lower-level and more direct. It is a good fit for simple, stable widgets where you need tight control over the generated output. You can see exactly which View properties are updated each time, and it can be easier to handle some older-version compatibility issues.

Glance is a better fit for new widgets or widgets with moderately complex structure. It reduces boilerplate, makes the UI layer easier to split into components, and fits better with modern state streams.

That said, if a widget needs very specific RemoteViews control, depends on APIs that Glance does not cover yet, or already has stable legacy code, staying on RemoteViews is completely reasonable. Glance is not a mandatory migration target.

## Do not misunderstand the update model

Many Compose developers expect a Glance widget to automatically recompose whenever state changes, just like a Compose screen. That is not how AppWidgets work. Updates are still affected by system scheduling, frequency limits, power policy, and Launcher behavior.

Glance can generate new RemoteViews from state, but you still need to design the update triggers: scheduled updates, user-click updates, explicit updates after data changes, or background sync through WorkManager. Updating too often wastes power and may be limited by the system; updating too rarely leaves users with stale data.

## When to choose Glance

Choose Glance for a new widget when the UI is moderately complex and clearer declarative code would help. Teams already writing Compose will usually find the style easier to adopt.

If an existing RemoteViews widget is stable and only needs minor maintenance, there is no urgent need to migrate. RemoteViews remains the more reliable choice when you need complex compatibility handling, deep customization, or layout capabilities that Glance does not support.

The safest technical conclusion is this: Glance improves the AppWidget development experience, but it does not change the cross-process nature of AppWidgets. If you can accept RemoteViews' limitations, Glance is a good option.

<!-- seo-internal-links -->

## Further reading

- [Back to the Jetpack Compose topic](/en/jetpack-compose/)
- [Android Glance AppWidget internals: RemoteViews, updates, and Compose widgets](/blog/2026-05-28-深入_android_glance_appwidget_全链路_从_remoteviews_渲染桥接/)
- [Jetpack Compose principles and advanced usage: State, layout, recomposition, and performance practice](/blog/jetpack-compose-高级应用与原理/)
<!-- /seo-internal-links -->
