---
title: "RecyclerView DiffUtil: Myers Diff, Payloads, and AsyncListDiffer"
lang: en
translationKey: android-recyclerview-diffutil-myers-diff
slug: android-recyclerview-diffutil-myers-diff
excerpt: "A practical look at RecyclerView DiffUtil, from Myers shortest edit scripts to payload updates, AsyncListDiffer background computation, callback timing, and cache-friendly list updates."
publishDate: '2026-06-08'
tags:
- "Android"
- "RecyclerView"
- "DiffUtil"
- "Performance"
- "Algorithms"
seo:
  title: "RecyclerView DiffUtil: Myers Diff and AsyncListDiffer"
  description: "Understand RecyclerView DiffUtil internals: Myers diff, update dispatch, payloads, AsyncListDiffer, callback timing, and list performance."
  pageType: article
---

The previous RecyclerView discussion focused on view reuse and cache layers. But even a perfect cache cannot help if every data change calls `notifyDataSetChanged()`. Full refresh invalidates positions, disrupts reuse, and makes UI updates visually unstable.

The hard part of list updates is not "notify the UI"; it is computing the minimal difference between old and new lists: which items were inserted, removed, moved, or changed. DiffUtil solves this using Myers diff and emits the smallest reasonable update sequence.

## Myers Diff: Comparing Sequences, Not Just Strings

Myers diff was originally proposed for string comparison. DiffUtil adapts it to list items. Given two `List<T>` values, the goal is to find a shortest edit script from the old list to the new list.

The mental model is an edit graph. The x-axis is the old list, the y-axis is the new list. Moving right means deleting an old element, moving down means inserting a new element, and moving diagonally means the elements match.

DiffUtil does not know your item identity. You provide that through callbacks:

```kotlin
class UserDiffCallback : DiffUtil.ItemCallback<User>() {
    override fun areItemsTheSame(oldItem: User, newItem: User): Boolean {
        return oldItem.id == newItem.id
    }

    override fun areContentsTheSame(oldItem: User, newItem: User): Boolean {
        return oldItem == newItem
    }
}
```

`areItemsTheSame` answers identity. `areContentsTheSame` answers visual content equivalence. Mixing these two is the most common DiffUtil bug.

## The Three Execution Phases

DiffUtil can be understood in three phases.

First, it finds matching "snakes": diagonal ranges where old and new sequences match. This produces structural anchors.

Second, it detects inserts, deletes, moves, and changes around those anchors. Move detection is useful but more expensive, so disable it when your data source never reorders items.

Third, it dispatches update operations to the adapter:

```kotlin
val diffResult = DiffUtil.calculateDiff(callback)
adapter.submitList(newList)
diffResult.dispatchUpdatesTo(adapter)
```

In normal app code, you should not write this manually. Use `ListAdapter` or `AsyncListDiffer`, which handles background computation and ordering.

## Payload: The Underrated Incremental Update Channel

If `areItemsTheSame` returns true but `areContentsTheSame` returns false, RecyclerView calls `onBindViewHolder` again. Without payloads, you usually rebind the whole row.

Payloads let you update only the changed fields:

```kotlin
override fun getChangePayload(oldItem: User, newItem: User): Any? {
    val changes = mutableSetOf<String>()
    if (oldItem.name != newItem.name) changes += "name"
    if (oldItem.avatar != newItem.avatar) changes += "avatar"
    if (oldItem.online != newItem.online) changes += "online"
    return changes.takeIf { it.isNotEmpty() }
}
```

Then handle partial binding:

```kotlin
override fun onBindViewHolder(holder: UserHolder, position: Int, payloads: MutableList<Any>) {
    if (payloads.isEmpty()) {
        onBindViewHolder(holder, position)
        return
    }
    holder.bindPartial(getItem(position), payloads)
}
```

This avoids unnecessary image reloads, text layout, and animation resets. For frequently changing rows, payloads are often the difference between stable and jittery UI.

## AsyncListDiffer: Moving Work Off the Main Thread

`AsyncListDiffer` computes diffs on a background thread and dispatches results back to the main thread. `ListAdapter` is a thin convenience wrapper around it.

```kotlin
class UserAdapter : ListAdapter<User, UserHolder>(UserDiffCallback()) {
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): UserHolder {
        return UserHolder.create(parent)
    }

    override fun onBindViewHolder(holder: UserHolder, position: Int) {
        holder.bind(getItem(position))
    }
}
```

When `submitList()` is called repeatedly, AsyncListDiffer uses generation numbers to avoid applying stale diff results. If list A is submitted, then list B, and A finishes diffing later, A's result is ignored.

This is essential for search results, paging, and live feeds where new lists can arrive before old diffs finish.

## Callback Timing Traps

`submitList(newList) { ... }` runs after the list has been committed, not immediately after the method call. If you read adapter state right after `submitList`, you may still see the old list.

Also avoid mutating a list after passing it to `submitList`. DiffUtil assumes the old and new lists are stable snapshots. Mutating them in place can produce incorrect diffs or hard-to-reproduce crashes.

Use immutable data and copy-on-write updates:

```kotlin
val next = currentList.map { item ->
    if (item.id == targetId) item.copy(selected = true) else item
}
submitList(next)
```

## Back to RecyclerView Caching

DiffUtil and RecyclerView caching complement each other. DiffUtil preserves item identity and emits minimal operations; RecyclerView can then reuse ViewHolders more effectively.

The working rules are:

- use stable identity in `areItemsTheSame`.
- use accurate content comparison in `areContentsTheSame`.
- implement payloads for partial row updates.
- avoid mutating submitted lists.
- disable move detection when the data never reorders.

With these rules, list updates become smaller, smoother, and more cache-friendly.
