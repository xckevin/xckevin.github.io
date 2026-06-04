---
title: "When Should You Use Paging 3 RemoteMediator?"
lang: en
translationKey: paging3-remotemediator
slug: paging3-remotemediator
excerpt: "Explains where Paging 3 RemoteMediator fits, how network and database pagination cooperate, cache-first lists, and common misuse cases."
publishDate: '2026-06-01'
tags:
- "Android"
- "Paging 3"
- "Room"
- "Performance"
seo:
  title: "When to Use Paging 3 RemoteMediator: Network and Database Pagination Cache"
  description: "Learn when Android Paging 3 RemoteMediator fits, including network pagination, Room cache, RemoteKeys, refresh strategy, and common mistakes."
  pageType: article
---

RemoteMediator is a good fit for pagination where network data must be persisted and the database is the page's only source of truth. It is not required for every pagination use case, and it is not a mandatory first step for learning Paging 3.

To decide whether you need RemoteMediator, start with one question: must the page data be offline-capable, cacheable, recoverable, and ultimately sourced from the database for UI rendering? If the answer is no, a plain network PagingSource is probably simpler.

## The role of RemoteMediator

In Paging 3, `PagingSource` provides paged data, `Pager` exposes the paging process as a Flow, and the UI renders the list through `PagingData`. The simplest case is direct network pagination: when the user scrolls near the bottom, request the next page and display the result.

RemoteMediator adds a coordination layer. When the local database does not have enough data, it requests the network and writes the result into the database. The UI does not consume network results directly. It always reads from Room's PagingSource.

The core of this architecture is a single source of truth. The network only supplements the database. The database is the page's truth.

## Good use cases for RemoteMediator

The first category is cacheable feeds, product lists, and article lists. When users leave and come back, they should see local data first, then receive gradual network refreshes. RemoteMediator organizes local cache and remote pagination into one Paging flow.

The second category is pages that need a strong poor-network experience. If the network fails, the database can still provide old data for the UI. When the network recovers, the list can catch up and refresh.

The third category is multiple pages sharing the same list data. For example, a favorites list, search history, and channel content may need consistent caching and querying. Persisting the data avoids making each page maintain its own network state.

The fourth category is data that needs local post-processing. After the server returns the list, the client may need to merge local state, reading progress, pinned status, blocked status, or experiment assignments. Those concerns are often better modeled through the database.

## Cases where RemoteMediator is a poor fit

If the page is a one-off search result that does not need to be kept after exit, RemoteMediator is probably too heavy. A direct network PagingSource is clearer.

If the paged data is highly real-time, such as a stock order book, live comments, or an online member list, database caching may introduce stale data. RemoteMediator may not be the right tool.

If the server pagination protocol is unstable, sorting changes often, or there is no reliable cursor or remote key, RemoteMediator becomes hard to keep consistent. Duplicate items, missing pages, and broken refresh behavior usually come from this area.

## RemoteKeys are the critical part

RemoteKeys are the easiest part of RemoteMediator to get wrong. They record the previous page, next page, or refresh position for each item or query. Without reliable keys, pagination does not know where the next load should start.

Common mistakes include:

- Storing keys only by itemId without separating query, channel, or sort order.
- Failing to clear old keys on refresh, causing old and new lists to mix.
- Failing to mark `endOfPaginationReached` correctly when the server returns an empty page.
- Writing data and keys outside the same database transaction, leaving inconsistent state after a crash.

RemoteMediator writes should usually happen inside a database transaction. Clearing old data, inserting new data, and updating remote keys should either all succeed or all fail.

## How to design refresh strategy

`REFRESH`, `APPEND`, and `PREPEND` should not all use identical logic. Refresh rebuilds the list baseline. Append loads the next page. Prepend only matters when the product supports upward pagination.

Refresh also needs a cache expiration policy. Forcing refresh every time the page opens wastes traffic and damages the offline experience. Never refreshing shows stale data forever. A more reliable approach is to add timestamps to cached data, show local data immediately, then decide whether to refresh in the background based on expiration.

## Recommendation

Use RemoteMediator for lists that need "network + database + offline cache + pagination coordination." Use a plain PagingSource for lists that only need "network pagination + immediate display." When you need complex queries, filters, and local state merging, RemoteMediator becomes much more valuable.

RemoteMediator is not just a pagination tool. It is a cache-consistency tool. Once that role is clear, the implementation usually takes fewer wrong turns.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android performance optimization](/en/android-performance/)
- [Android Paging 3 deep dive: PagingSource, RemoteMediator, and pagination cache](/blog/2026-04-24-android_paging3_深度解析_从_pagingsource_分页引擎到_remoteme/)
- [Why can Room Flow update automatically?](/blog/room-flow-auto-update/)
<!-- /seo-internal-links -->
