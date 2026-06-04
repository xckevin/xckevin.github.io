---
title: "How Should You Choose Between DataStore and SharedPreferences?"
lang: en
translationKey: datastore-vs-sharedpreferences
slug: datastore-vs-sharedpreferences
excerpt: "Compares SharedPreferences, Preferences DataStore, and Proto DataStore across use cases, threading, type safety, and migration strategy."
publishDate: '2026-06-01'
tags:
- "Android"
- "DataStore"
- "SharedPreferences"
seo:
  title: "DataStore vs SharedPreferences: Choosing Android Local Configuration Storage"
  description: "Compares Android SharedPreferences, Preferences DataStore, and Proto DataStore, including thread safety, ANR risk, type safety, and migration strategy."
---

For new projects, local configuration should generally start with DataStore. In existing projects, SharedPreferences does not always need to be rewritten immediately, but main-thread access, high-frequency reads and writes, and cross-process dependencies need active cleanup.

This is not a simple case of "the new API always replaces the old API." The two options differ in threading model, data consistency, and type capabilities.

## Where SharedPreferences causes problems

SharedPreferences is fine for small, simple, low-frequency key-value configuration. It is easy to use and common in legacy projects. But it carries several engineering risks.

First, the initial load can block. SharedPreferences is backed by XML files, and the first read requires loading and parsing from disk. Accessing several files on the startup main thread can easily inflate cold-start time.

Second, while `apply()` writes to disk asynchronously, the in-memory state is updated first and the caller does not precisely control when the data is persisted. In edge cases such as process death, concurrent writes, or cross-process access, this can create consistency problems.

Third, the type model is weak. Complex structures are often shoved into JSON strings, leaving field evolution, defaults, and compatibility to business logic. Over time, that becomes an implicit data protocol that is hard to maintain.

## What Preferences DataStore is good for

Preferences DataStore is still key-value storage, but it is built on coroutines and Flow. Reads and writes are asynchronous, and data changes can be observed. It is a good replacement for new lightweight settings such as feature switches, sort order, theme choice, and user preferences.

Compared with SharedPreferences, its advantages are:

- It discourages blocking reads on the main thread.
- Reads are exposed as Flow, which fits reactive UI updates.
- Writes happen through transactional `edit`, avoiding some concurrency problems.
- It supports migration from SharedPreferences.

But Preferences DataStore is not a strongly typed model. Key names are still strings, and relationships between fields are still enforced by business code. If the configuration already has a clear structure, Proto DataStore is a better fit.

## What Proto DataStore is good for

Proto DataStore uses Protocol Buffers to define the data structure. It fits local configuration or state with a fixed schema, such as user settings, experiment configuration snapshots, complex feature-switch combinations, or offline policy parameters.

Its strengths are type safety, clear defaults, and field evolution. Adding fields, deprecating fields, and maintaining compatibility with older versions can be managed through proto rules, which is more stable than hand-written JSON.

The tradeoff is higher integration cost: you need to maintain `.proto` files, generate code, and handle migration. For three or five boolean flags, Proto DataStore may be too heavy.

## When you should use Room instead

DataStore is not a database. Once you need lists, queries, sorting, relationships, pagination, transactions, or multi-table data, you should consider Room. Stuffing a set of business records into DataStore makes querying painful and increases the write granularity.

A simple decision rule: if you are asking "how do I query part of this data by condition," do not use DataStore.

## Migration strategy

For legacy projects, do not replace all SharedPreferences files in one sweep. A safer strategy is to migrate based on risk.

Prioritize synchronous reads on the startup path, especially reads from `Application.onCreate()`, ContentProviders, or the first Activity. Prioritize high-frequency writes to avoid repeatedly flushing XML files to disk. For complex data that will be maintained long term, consider Proto DataStore or Room first.

Low-frequency, legacy, non-startup settings can stay in SharedPreferences for a while. Engineering cleanup is not about forcing API uniformity; it is about reducing real risk.

## Bottom line

Keep small legacy settings in SharedPreferences when the risk is low. Use Preferences DataStore for new simple preferences. Use Proto DataStore for structured data models. Use Room when the data needs querying or relationships.

DataStore's value is not just that it is newer. Its real value is moving local configuration from a synchronous read/write model into a coroutine and Flow-based reactive model. For modern Android apps, that is the direction that is easier to maintain over time.

<!-- seo-internal-links -->

## Further reading

- [Back to the Kotlin Coroutines and Flow topic](/en/kotlin-coroutines/)
- [Android SharedPreferences to DataStore evolution: From synchronous ANRs to reactive storage](/blog/2026-04-23-android_sharedpreferences_到_datastore_深度演进_从同步_anr/)
- [Why does a Room Flow update automatically?](/en/blog/room-flow-auto-update/)
<!-- /seo-internal-links -->
