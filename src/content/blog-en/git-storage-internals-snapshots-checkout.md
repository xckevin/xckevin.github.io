---
title: "Git Storage Internals: From Snapshots to Checkout"
lang: en
translationKey: git-storage-internals-snapshots-checkout
slug: git-storage-internals-snapshots-checkout
excerpt: "A practical look at Git's object database, how blob, tree, and commit objects relate, and what git log and git checkout actually do under the hood."
publishDate: '2026-03-03'
tags:
  - "Git"
  - "Version Control"
  - "Software Engineering"
  - "Architecture"
seo:
  title: "Git Storage Internals: Snapshots, Objects, and Checkout"
  description: "Understand Git's snapshot storage, object model, log traversal, and checkout restoration mechanism with a clear low-level mental model."
---



Many people think of Git as "a system that records an operation log for every step." That mental model creates confusion again and again when you learn `rebase`, `merge`, and `reset`.

Git's real model is closer to this sentence: it is an immutable object database based on content addressing.

## Git Stores Snapshots, Not Operations

Each commit is not "a record of what you did." It is "a record of what the project looked like at this moment."

That "look" is a snapshot.

If you did not change a file between two commits, Git does not store another copy of the same content. It keeps referencing the old object. That gives you two results:

1. Semantically, a commit is a complete snapshot.
2. At the storage layer, Git deduplicates by reusing objects.

This is where many first-time Git users get misled: conceptually it looks like "backing up the whole repository," but the implementation is really "object reuse."

## Git's Four Core Object Types

Git's internal structure can first be compressed into four keywords:

```text
blob    file content
tree    directory structure
commit  one commit
tag     tag
```

### blob: Content Only, Not Filenames

A `blob` stores the raw bytes of file content. Git calculates a hash over the content, commonly SHA-1, while modern versions also support the SHA-256 repository format. That hash is the object identifier.

The same content only needs one blob in the repository.

### tree: A Directory Index

A `tree` records directory entries. Each entry contains a mode, a name, and the hash of the object it points to.

It describes "which files or subdirectories are under this directory, and which objects they point to."

### commit: Connecting History

A `commit` contains at least the following information:

- A pointer to a root tree
- A pointer to the parent commit, or multiple parents for a merge commit
- Author, committer, and timestamp
- Commit message

That naturally makes commits form a directed acyclic graph, or DAG.

## A Minimal Example: What Actually Happens Across Two Commits

Assume the project only has `hello.txt`.

The first commit contains:

```text
hello world
```

Git creates a set of objects:

```text
blob A   (hello world)
tree A   (hello.txt -> blob A)
commit A (root tree = tree A)
```

You change the file to:

```text
hello world!!!
```

After the second commit:

```text
blob B   (hello world!!!)
tree B   (hello.txt -> blob B)
commit B (root tree = tree B, parent = commit A)
```

If another file in the repository did not change, `tree B` still points to its original blob instead of copying a new object.

## What `git log` Really Does: Traverse Parent Pointers

`git log` does not read some "operation log table."

Its core action is this: start from the commit pointed to by the current `HEAD`, then walk backward through `parent` pointers.

Simplified, it looks like this:

```text
A <- B <- C <- D (HEAD)
```

Running `git log` means walking from `D` to `C`, `B`, and `A`, then formatting and displaying the metadata of each commit.

## What `git checkout <commit>` Actually Does in Two Steps

Take `git checkout B` as an example. The core process can be split into two steps:

1. Update where `HEAD` points.
2. Rebuild the working directory files from the target commit's root tree.

In other words:

- Find `commit B`
- Read the `tree B` it points to
- Write the corresponding blob contents from the tree back to disk

What you see is "the project returned to the state it had at moment B."

Many people worry that "the later commits were lost." Usually they are not. The commit objects are still in the repository; the current reference simply no longer points to them.

## Git and diff: Separate the Logical Layer from the Storage Layer

A common question is: "Doesn't Git store diffs?"

The answer has two layers:

- Logical model: Git organizes history as snapshot objects.
- Transfer and compression: packfiles may use delta compression to reduce size.

So when you learn Git conceptually, start by holding onto the "snapshot model." Do not reverse the compression details of packfiles into Git's core abstraction.

## Connecting the Structure with an ASCII Diagram

```text
commit D
  |
  v
tree D
  |
  +-- src/ -> tree X
  |            |
  |            +-- main.ts -> blob M
  |
  +-- README.md -> blob R

commit C
  |
  v
tree C
  |
  +-- src/ -> tree X
  |            |
  |            +-- main.ts -> blob K
  |
  +-- README.md -> blob R   (reused)
```

Here `README.md` did not change, so `blob R` is reused across multiple commits.

## Why This Model Matters

Once you understand this model, many commands become predictable:

- Creating a branch is cheap because a branch is essentially a movable reference.
- `merge` creates a new commit with multiple parents.
- `rebase` replays commits on top of a new parent and creates new objects.
- `reflog` can save you because it records changes in reference positions.

You no longer rely on "memorizing commands." You reason about behavior through changes in the object graph.

## Summary

Git is not an operation log system. It is a snapshot-driven object database:

- `blob` stores content
- `tree` stores directory mappings
- `commit` connects history
- `log` traverses the commit graph
- `checkout` switches references and restores a tree

When you view Git through this model, most "mysterious" day-to-day development problems become engineering questions you can verify.
