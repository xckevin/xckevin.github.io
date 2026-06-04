---
title: "Git Worktree in Practice: Parallel Branch Development"
lang: en
translationKey: git-worktree-parallel-branch-development
slug: git-worktree-parallel-branch-development
excerpt: "A practical guide to git worktree, covering concepts, common commands, real-world workflows, internals, limitations, and multi-branch development patterns."
publishDate: '2026-03-26'
tags:
  - "Git"
  - "DevOps"
  - "Engineering Productivity"
seo:
  title: "Git Worktree in Practice: Parallel Branch Development"
  description: "Learn git worktree concepts, commands, use cases, internals, limitations, and workflows for efficient multi-branch development."
---



In everyday development, you have probably hit this scenario: you are coding on a feature branch when an urgent production bug appears and you need to switch to a hotfix branch. So you run `git stash`, switch branches, fix the bug, switch back, and run `git stash pop`. If you are unlucky, the stash conflicts.

That loop of "switch branch -> stash -> switch back -> pop" becomes especially painful when multiple tasks run in parallel. `git worktree` exists to solve exactly this kind of problem: it lets one Git repository have multiple working directories at the same time, with each directory independently checked out to a different branch. That removes the mental overhead of branch switching almost entirely.

## Three Pain Points in the Traditional Workflow

### Frequent Branch Switching Loses Context

By default, a repository has only one working directory and can check out only one branch at a time. Switching branches means:

- Uncommitted code must first be stashed or temporarily committed
- Once stashes pile up, it becomes hard to tell which stash belongs to which task
- Restoring the work state after switching back has real mental cost

### Parallel Task Work Is Inefficient

Consider a typical case: you are building feature A, need to fix an online bug, and also need to review a teammate's code. The traditional flow is stash current work -> switch branch -> fix bug -> switch back and restore. Every extra switch increases the chance of an accident, especially in a collaborative repository.

### Build Artifacts Pollute Each Other

In frontend projects, `node_modules` and build caches often differ across branches. If you want to run a dev server and a production build at the same time, or debug two branches separately, the traditional answer is to clone the whole repository again. That wastes disk space and adds management complexity.

## The Core Idea of Git Worktree

The essence of `git worktree` can be summarized in one sentence: it lets one `.git` database mount multiple working directories.

Each worktree has:

- Its own file directory
- Its own current branch, or HEAD
- Its own staging area, or index
- Its own uncommitted changes

All worktrees share:

- Commit history
- The object database, or objects
- References, or refs

That means a commit made in any worktree is immediately visible to the others through `git log` or `git fetch`. At the disk layer, only working directory files are additional; the `.git` database remains a single copy.

## Common Commands

### Create a worktree

```bash
git worktree add ../feature-a feature-a
```

This command creates a `feature-a` folder in the parent directory and checks out the `feature-a` branch there. The path can be anywhere; it does not have to sit next to the repository.

### Create a worktree and a new branch at the same time

```bash
git worktree add -b hotfix-123 ../hotfix-123 main
```

This creates a new branch, `hotfix-123`, based on `main` and checks it out under `../hotfix-123`.

### List all worktrees

```bash
git worktree list
```

The output looks like this:

```text
/home/user/project        abc1234 [main]
/home/user/feature-a      def5678 [feature-a]
/home/user/hotfix-123     ghi9012 [hotfix-123]
```

### Remove a worktree

```bash
git worktree remove ../feature-a
```

This deletes the directory and unregisters the worktree. If the directory contains uncommitted changes, add `--force`.

### Clean up leftovers

```bash
git worktree prune
```

If you manually deleted a worktree directory, for example with `rm -rf`, Git does not know that. The `prune` command cleans up worktree records whose directories no longer exist.

## Typical Use Cases

### Emergency Bug Fix

You are writing feature code when a P0 production bug appears:

```bash
git worktree add -b hotfix-p0 ../hotfix-p0 main
cd ../hotfix-p0
# Fix the bug, commit, and push
```

After the fix, return to the original directory and continue development. No stash is needed, and no work progress is lost.

### Parallel Development Across Branches

Multi-platform teams often need to maintain several branches at once. You can create one worktree per task:

```text
~/project/           -> main (primary repository)
~/project-feature-a/ -> feature-a
~/project-feature-b/ -> feature-b
~/project-hotfix/    -> hotfix-xxx
```

Open each directory in a separate IDE window. The mental model becomes "one task = one directory," so you no longer need to remember which branch the current window is on.

### Build Isolation

In frontend projects, dependencies and build artifacts from different branches may conflict:

```text
~/project/      -> dev branch, running dev server
~/project-prod/ -> main branch, running production build
```

The two directories have independent `node_modules` directories and build caches, so they do not interfere with each other.

### Code Comparison and Review

When reviewing a teammate's code, create a worktree checked out to their branch:

```bash
git worktree add ../review-pr-42 origin/feature-xxx
```

Open both directories directly in the IDE and compare files side by side. That is much more efficient than switching branches back and forth inside one repository.

## How It Works Internally

Git does two things when it creates a worktree.

**First, it allocates independent state files for each worktree.** Under the main repository's `.git/worktrees/` directory, Git creates a subdirectory for each additional worktree. It stores:

- `HEAD`: points to the current branch
- `index`: the staging area
- `config`: worktree-level configuration

```text
.git/
  worktrees/
    feature-a/
      HEAD
      index
      commondir
```

**Second, all worktrees share the same object database.** The extra worktree directory contains a `.git` file, not a directory. Its content points to the main repository's `.git` path:

```text
gitdir: /home/user/project/.git/worktrees/feature-a
```

That is why worktrees consume very little extra disk space: code objects are stored once, and the additional storage is mainly the working directory files.

In one sentence, the low-level model is: worktree = multiple checkout views + one repository core.

## Limitations and Practical Responses

### The Same Branch Cannot Be Used by Multiple Worktrees at Once

Git does not allow two worktrees to check out the same branch. This prevents two working directories from modifying the same branch reference at the same time and creating confusion.

Response: create a temporary branch, or use `--detach` to open it with a detached HEAD.

### Mental Complexity Can Increase

When you have many worktrees, especially more than five, it is easy to forget which directory contains which change or even commit to the wrong branch.

Response: establish a consistent directory naming convention, such as `{project}-{branch}`, and periodically check with `git worktree list`.

### Some Toolchains Have Compatibility Issues

Some older IDEs, build systems, and scripts assume `.git` is a directory rather than a file. In an additional worktree, `.git` is a file whose content is `gitdir: ...`, which can cause compatibility problems.

Modern versions of VS Code, the IntelliJ family, and Android Studio already support worktrees. If you run into issues, check the tool version first.

### You Need `prune` After Manually Deleting a Directory

If you delete a worktree directory directly with `rm -rf`, Git will not detect it automatically. The leftover worktree record can keep a branch locked. Build the habit of using `git worktree remove` instead of manual deletion, or run `git worktree prune` regularly.

### Complexity Doubles with submodule

The combination of worktree and submodule can make path management messy. If your project uses many submodules, test thoroughly before introducing worktrees.

### It Is Not Useful for Lightweight Switching

If you only occasionally switch branches to glance at some code, worktree may add management overhead. Plain `git checkout` or `git switch` is simpler. Worktree is valuable for "running multiple tasks in parallel for a long time," not for "taking a quick look."

## Advanced Practices

### Combine It with Automation Scripts

You can write a shell function that completes "create worktree -> open IDE -> start development service" in one step:

```bash
workon() {
  local branch=$1
  local dir="../$(basename $(pwd))-${branch}"
  git worktree add -b "$branch" "$dir" main
  code "$dir"
  echo "Worktree created at $dir"
}
```

When you run `workon feature-login`, the entire environment is ready automatically.

### Parallel Debugging Across Environments

In backend or full-stack projects, different worktrees can connect to different backend environments:

```text
~/app-dev/     -> dev branch, connected to development API
~/app-staging/ -> staging branch, connected to staging API
~/app-prod/    -> main branch, connected to production API (read-only debugging)
```

Open all three windows at once to compare behavior across environments.

### AI Agent Collaboration

One promising direction is to assign one AI coding agent to each worktree for true parallel task development. Agent A implements a feature in the `feature-a` worktree, Agent B fixes a bug in the `bugfix` worktree, and Agent C refactors in the `refactor` worktree. They share repository data without interfering with each other.

## Summary

The core problem `git worktree` solves is this: it upgrades "only one branch can be checked out at a time" into "multiple working directories can operate on multiple branches in parallel."

It fits scenarios such as frequent switching among tasks, isolated build environments, parallel development across platforms, and code comparison for review. It is not a good fit for lightweight temporary branch switching.

For multi-platform teams with high iteration frequency, a practice worth adopting is "one task = one worktree." Combined with consistent directory naming and automation scripts, it can greatly reduce the mental cost of branch management.
