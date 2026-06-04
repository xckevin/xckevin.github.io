---
title: "A Complete Git Guide: From Basics to Mastery"
lang: en
translationKey: git-complete-guide-from-basics-to-mastery
slug: git-complete-guide-from-basics-to-mastery
excerpt: "A systematic Git guide from core concepts to advanced techniques, including commits, branches, merges, rebase, fixup, rerere, sparse checkout, range-diff, pickaxe, bisect, worktree, submodules, subtree, troubleshooting, and aliases."
publishDate: '2026-03-16'
tags:
  - "Git"
seo:
  title: "Complete Git Guide: Basics, Workflows, and Advanced Tools"
  description: "Master Git from fundamentals to advanced workflows: commits, branches, merge, rebase, bisect, worktree, submodules, subtree, troubleshooting, and aliases."
---



Git is the de facto standard version control system for modern software development. Whether you are an individual developer, a team engineer, or working in DevOps, your ability to understand commits and branches, then use rebase, cherry-pick, bisect, submodule, worktree, and hooks well, directly affects collaboration efficiency and delivery quality. This article follows the structure of a practical workflow, explains Git's core concepts and advanced usage, and uses hands-on examples and best practices to help you build a transferable mental model of Git.

## 1. Basic Git Operations

### 1.1 Core Objects and the Working Directory Model

Git is built around a content-addressed object database. Four areas make up the everyday workflow:

- Working Directory: the files you are editing.
- Index/Stage: the snapshot prepared for commit.
- Local Repository: stores commit history.
- Remote: used for pull, push, and collaboration.

Common inspection commands:

```bash
# Show current status
git status
# Show commit history: one line, graph, decoration, relative time
git log --oneline --graph --decorate --relative-date
# Show differences: working directory vs index, or index vs previous commit
git diff            # Working directory vs index
git diff --staged   # Index vs HEAD
```

### 1.2 Initialization and Configuration

```bash
# Initialize a repository
git init
# Set identity and common configuration
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
# Friendlier diffs and logs
git config --global core.editor "code --wait"
git config --global pull.rebase false   # Teams can agree on true or false
```

### 1.3 Commit Basics

```bash
# Selectively stage files, then commit
git add file1 file2
# Interactively stage hunks; strongly recommended
git add -p
# Commit with a message
git commit -m "feat: initialize project skeleton"
# Edit the latest commit message or add files; safe before pushing
git commit --amend
```

## 2. Branches and Merges

### 2.1 Branch Model

```bash
# Create and switch branches
git branch feature/login
git switch feature/login     # Or: git checkout -b feature/login
# Delete a branch
git branch -d feature/login  # Safe delete after it has been merged
git branch -D feature/login  # Force delete
```

Common collaboration models:

- Git Flow: `main` + `develop` + feature/release/hotfix. Clear, but somewhat heavy.
- Trunk-Based Development: `main` as the trunk, small steps, and short-lived branches. More modern.

### 2.2 Merge Strategies

```bash
# Normal merge; preserves divergent history
git merge feature/login
# Squash merge; compress a series of commits into one
git merge --squash feature/login
# Fast-forward only; does not create a merge commit
git merge --ff-only feature/login
```

### 2.3 Rebase

```bash
# Move the current branch's changes onto the latest main
git switch feature/login
git fetch origin
git rebase origin/main
# Continue after resolving conflicts
git rebase --continue
# Abort this rebase if needed
git rebase --abort
```

Note: avoid rebasing public history that has already been pushed and used by others, because it rewrites history.

## 3. Remote Collaboration

### 3.1 Remote Management

```bash
# Add, view, and remove remotes
git remote add origin git@github.com:org/repo.git
git remote -v
git remote remove origin
```

### 3.2 Pull and Push

```bash
# Push the current branch and set upstream
git push -u origin feature/login
# Pull remote updates: merge or rebase
git pull            # Equivalent to: fetch + merge
git pull --rebase   # Equivalent to: fetch + rebase
```

### 3.3 Tracking Branches and Upstream

```bash
git branch -vv           # Show local branches and upstream bindings
git push -u origin main  # Set upstream
git push --set-upstream origin feature/login
```

## 4. History Revision and Selective Migration

### 4.1 Interactive Rebase: Squash and Clean Up Commits

```bash
git rebase -i HEAD~5   # Reorder, squash, or fix up the latest five commits
# Common actions: pick(keep), reword(edit message), squash(merge), fixup(merge and discard message), drop(discard)
```

### 4.2 Cherry-pick

```bash
# Apply one commit to the current branch
git cherry-pick <commit>
# Pick a continuous range of commits
git cherry-pick A^..B
```

### 4.3 Revert: Create an Inverse Commit

```bash
# Undo one commit without rewriting history; suitable for public branches
git revert <commit>
```

## 5. Problem Location and Debugging

### 5.1 Bisect: Binary Search for Defects

```bash
git bisect start
git bisect bad            # Mark the current version as bad
git bisect good <tag|commit>  # Specify a known good version
# Git automatically checks out points in the range; combine with a test script for fast location
# After finishing:
git bisect reset
```

### 5.2 Blame and Log for Locating Changes

```bash
git blame path/to/file
# View the evolution of specific lines
git log -L <start>,<end>:path/to/file
```

## 6. Improving Work Efficiency

### 6.1 Stash and Worktree

```bash
# Temporarily shelve work changes
git stash push -m "WIP: refactoring in progress"
git stash list
git stash apply  # Or git stash pop

# Parallel development with multiple worktrees: one repository, multiple working directories
git worktree add ../repo-feature feature/login
```

### 6.2 Submodule and Subtree

```bash
# Submodule: embed a fixed commit from another repository
git submodule add https://github.com/org/lib.git libs/lib
git submodule update --init --recursive

# Subtree: merge another repository's history under a directory; no submodule needed
git subtree add --prefix=packages/lib https://github.com/org/lib.git main --squash
```

### 6.3 Hooks and Automation

```bash
# Enable hooks under .git/hooks/. Example: pre-commit validation
# .git/hooks/pre-commit
#!/bin/sh
npm run lint
```

You can combine Husky, lefthook, pre-commit, and similar tools for cross-language validation and formatting.

## 7. Reset and Recovery

### 7.1 The Three Reset Modes

```bash
# Move only the HEAD pointer; keep working directory and index
git reset --soft <commit>
# Move HEAD and reset the index; keep the working directory
git reset --mixed <commit>   # Default
# Move HEAD and restore the working directory; dangerous
git reset --hard <commit>
```

### 7.2 Restore Commands

```bash
git restore --staged path/to/file   # Unstage from the index
git restore path/to/file            # Restore to index or HEAD content
```

## 8. Tags and Version Releases

```bash
# Lightweight and annotated tags
git tag v1.0.0
git tag -a v1.0.0 -m "first release"
# Push and delete tags
git push origin v1.0.0
git push origin --delete v1.0.0
```

## 9. Security and Large File Management

- Use `.gitignore` to exclude sensitive files and generated artifacts. Use `.gitattributes` to standardize line endings and diff strategies.
- Enable `protected branches`, `required reviews`, and `status checks` in teams.
- Manage large files with Git LFS, or Large File Storage.

```bash
git lfs install
git lfs track "*.psd"
```

## 10. Best Practice Checklist

1. Make atomic commits: one commit does one thing, with a clear message and verb prefix such as feat, fix, docs, or chore.
2. Prefer small steps and early merges. The shorter a branch lives, the better.
3. Use `rebase -i` before a PR to clean up history, so commits serve review and later tracing.
4. Avoid rewriting public branch history. Use `revert` instead of `reset --hard` when needed.
5. Use templates and hooks to enforce standards, such as Commitlint, lint, and tests.
6. Use `bisect`, `blame`, and `-L` to locate problem lines and introducing commits precisely.
7. Use `worktree` and `stash` to improve context-switching efficiency.

## 11. Advanced Techniques: More Efficient and More Robust

### 11.1 `--fixup` + `--autosquash` for Fast History Cleanup

Automatically fold scattered fixes into target commits, producing history that is ready for review:

```bash
# Create a fixup commit for a historical commit; message gets a fixup! prefix automatically
git commit --fixup <commit>
# Automatically merge by fixup relationship during interactive rebase
git rebase -i --autosquash <base>
```

### 11.2 Reusing Conflict Resolutions with `rerere`

Record and reuse conflict resolutions you have already performed. Git can apply them automatically when the same conflict appears again:

```bash
git config --global rerere.enabled true
# When the same kind of conflict appears again, Git automatically applies your prior resolution
```

### 11.3 Advanced Merge Options: Understand Semantics Before Using

```bash
# Prefer the other side on conflicts; effective under the default recursive strategy
git merge -X theirs feature/login
# Prefer our side on conflicts
git merge -X ours feature/login
# Ignore conflicts caused by whitespace differences
git merge -X ignore-space-change feature/login
# Normalize line endings and similar differences to avoid cross-platform CRLF issues
git merge -X renormalize feature/login
```

### 11.4 Sparse Checkout and Partial Clone: Preferred for Monorepos

```bash
# Download only tree objects, fetch file content on demand
git clone --filter=blob:none --sparse <repo>
cd repo
# Cone mode: operate by path prefix
git sparse-checkout init --cone
# Check out only the directories you care about
git sparse-checkout set packages/app docs
```

### 11.5 Compare Two Commit Sequences with `range-diff`

Use this to review how a new version of a branch evolved relative to an old version. It compares "commit sequences," not just final trees:

```bash
git range-diff old-base..old-feature new-base..new-feature
```

### 11.6 Search Introductions and Removals by Content: Pickaxe

```bash
# Find commits that first introduced or removed specific text
git log -S "dangerous_flag"
# Match code patterns with a regular expression
git log -G 'foo\(.*\)'
```

### 11.7 Ignore Formatting Commits in `blame`

```bash
# 1. Create an ignore list, usually for large formatting or rename commits
cat >> .git-blame-ignore-revs <<EOF
<big-format-commit-sha>
EOF
# 2. Configure blame to ignore it by default
git config blame.ignoreRevsFile .git-blame-ignore-revs
# 3. Temporarily disable it when needed: git blame --no-ignore-revs path/to/file
```

### 11.8 Background Maintenance and Automatic Cleanup

```bash
# Register background maintenance tasks such as periodic gc, repack, and fetch
git maintenance start
# You can also run immediately: git maintenance run --task=gc
```

### 11.9 Restore a File from Any Version

```bash
# Restore a file to the content from a specific commit without affecting other files
git restore --source=<commit> -- path/to/file
```

### 11.10 More Precise `stash`

```bash
# Save only unstaged changes and keep the index
git stash push --keep-index -m "keep staged changes"
# Save only a specific path
git stash push -m "stash frontend only" -- packages/web
# Interactively stash selected changes
git stash -p
```

### 11.11 A Safer Way to Clean the Working Directory

```bash
# Dry-run cleanup: show untracked or ignored files that would be deleted
git clean -ndX
# Execute with care: git clean -fdX
```

### 11.12 Diff and Review Enhancements

```bash
# Show function-level context
git diff -W
# Ignore whitespace changes
git diff -w
# Self-check before a PR:
git log --oneline --decorate --graph
```

## 12. Common End-to-End Workflows

### 12.1 Slim Down the History of a Large PR

```bash
# Create fixup commits for historical commits one by one
for c in $(git rev-list --reverse HEAD~8..HEAD); do
  git commit --fixup $c  # Commit after each fix
done
# Clean up into a semantically clear sequence in one pass
git rebase -i --autosquash origin/main
```

Key points: make sure each commit builds and passes tests; keep the branch bisectable before merging.

### 12.2 Full Hotfix Flow: Starting from the Production Version

```bash
# Create a hotfix branch from the production tag
git switch -c hotfix/timeout v2.3.1
# Fix and publish a tag
git commit -m "fix: retry request timeout"
git tag -a v2.3.2 -m "Emergency hotfix"
# Backport into main and the long-term support branch
git switch main && git cherry-pick v2.3.2
git switch release/2.3 && git cherry-pick v2.3.2
```

### 12.3 Roll Back a Public Branch Without Rewriting History

```bash
# Revert a single commit
git revert <commit>
# Revert a merge commit; specify mainline parent as 1
git revert -m 1 <merge-commit>
```

### 12.4 Recover an Accidentally Deleted Branch or Commit

```bash
# View all HEAD movement history
git reflog
# Create a new branch from the commit before it was lost
git branch rescue <sha-from-reflog>
```

### 12.5 Bisect with an Automation Script

```bash
git bisect start
git bisect bad                # Current version is bad
git bisect good <good-tag>
# 0=good, 1=bad, 125=skip
git bisect run ./ci/check.sh
# Finish
git bisect reset
```

### 12.6 Parallel Tasks Without Interference: `worktree`

```bash
# Create another working directory for the same repository in a sibling directory
git worktree add ../repo-fix hotfix/pay-bug
# Continue development in the main directory; focus on the fix in the secondary directory
```

### 12.7 Split an Independent Sub-repository from a Monorepo

```bash
# Extract subdirectory history into a new branch
git subtree split --prefix=packages/sdk -b sdk-history
# Push to a new repository
git push git@github.com:org/sdk.git sdk-history:main
```

### 12.8 Quickly Pull Specific Packages from a Monorepo

```bash
git clone --filter=blob:none --sparse git@github.com:org/mono.git
cd mono
git sparse-checkout init --cone
git sparse-checkout set packages/api packages/web
```

---

These advanced techniques and workflows can be used directly in everyday collaboration. Combine them with team conventions, hooks, and CI checks, and make "clear history + automation" a required step before commits and merges.


## 13. Common Pitfalls and Troubleshooting Checklist

### 13.1 `.gitignore` Does Not Work

Cause: the file has already been tracked, or the ignore rule or path is written incorrectly.

```bash
# Untrack already tracked files and add them again
git rm -r --cached .
git add -A
git commit -m "chore: reapply .gitignore"
# Check which files an ignore rule matches
git check-ignore -v path/to/file
```

### 13.2 Line Ending Confusion: LF and CRLF

```bash
# Normalize in one pass
echo "* text=auto" >> .gitattributes
git add --renormalize .
# Recommended for macOS and Linux:
git config core.autocrlf input
# Common on Windows:
git config core.autocrlf true
```

### 13.3 Detached HEAD

```bash
# You are on a commit instead of a branch; create and switch to a new branch to preserve work
git switch -c rescue/work <current-commit>
```

### 13.4 Accidental Overwrite with `push --force`

```bash
# Recover lost history locally
git reflog
# Create a new branch from the commit before loss
git branch restore <sha>
# After confirming with teammates, overwrite in the safer way
git push --force-with-lease
```

### 13.5 Accidentally Rebasing a Public Branch

- Prefer `revert` to create an "inverse commit" that corrects public history.
- If you need to return to an old state, create a new branch and `cherry-pick` the required commits.

### 13.6 Merge Conflicts Are Hard to Handle

```bash
# More informative conflict markers
git config merge.conflictStyle diff3
# Abort this merge or rebase
git merge --abort || git rebase --abort
# Ignore whitespace-caused conflicts; use carefully
git merge -X ignore-space-change
```

### 13.7 Large Files Cause Push Failure

```bash
# Manage large files with Git LFS
git lfs install
git lfs track "*.psd"
# Rewrite history; back up first
git lfs migrate import --include="*.psd"
```

### 13.8 Cleaning Leaked Secrets or Private Data: History Rewrite

Strongly back up offline before running these commands.

```bash
# Recommended: git filter-repo, faster and more modern
# After installation:
# git filter-repo --path path/to/secret.file --invert-paths
# Or replace text:
# git filter-repo --replace-text replacements.txt
```

### 13.9 Lost `stash` Content

```bash
# View all stashes
git stash list
# Try recovery after accidental deletion; not guaranteed
git fsck --no-reflogs --lost-found
```

### 13.10 Leftover `index.lock` or `packed-refs.lock`

```bash
# Delete only after confirming no Git process is running
rm -f .git/index.lock .git/packed-refs.lock
```

### 13.11 Common submodule Problems

```bash
# Clone and initialize submodules
git clone --recursive <repo>
# Fill in submodules for an existing repository
git submodule update --init --recursive
```

### 13.12 Default Branch and Upstream Changes

```bash
# Rename the local branch
git branch -m master main
# Update the remote default branch after changing it on the hosting platform
git fetch origin
git branch -u origin/main main
```

### 13.13 Windows `Filename too long`

```bash
git config --system core.longpaths true
```

### 13.14 Shallow Clone Breaks `rebase` or `cherry-pick`

```bash
# Convert from a shallow clone
git fetch --unshallow   # Or: git fetch --depth=1000 --tags
```

### 13.15 Rename Detection and Large Moves

```bash
# Improve rename detection sensitivity
git config diff.renames true
# Enable rename detection when comparing
git diff -M -C
```

### 13.16 Binary File Conflicts

```bash
# Mark as binary and use the union strategy; customize as needed
# .gitattributes
*.bin binary merge=union
```

### 13.17 403 or Authentication Failure

```bash
# Update credential manager; example: macOS Keychain
git config --global credential.helper osxkeychain
# Or use a PAT, personal access token, instead of a password
```

### 13.18 Repository Health Check

```bash
git fsck
git gc --aggressive   # Use carefully; slow for large repositories
# More recommended:
git maintenance run
```

## 14. Appendix: Common Aliases and Better Logs

Add this to `~/.gitconfig`:

```ini
[alias]
  co = switch
  cob = switch -c
  br = branch
  st = status -sb
  ci = commit
  amend = commit --amend --no-edit
  lg = log --graph --pretty=format:'%C(auto)%h %Cgreen%ad%Creset %C(bold blue)%an%Creset %C(yellow)%d%Creset %s' --date=relative
  lga = log --all --graph --decorate --oneline
  rb = rebase
  rbi = rebase -i
  cp = cherry-pick
  fixup = commit --fixup
  aa = add -A
```

Common combinations:

```bash
git lg          # Quickly review branch history
git lga         # Bird's-eye view across all branches
```

> Tip: Combine these aliases with hooks and CI status checks to form a team convention where commits serve as documentation and history stays traceable.


## Conclusion

The key to mastering Git is understanding the essence of "snapshots and pointers" and using clear history to support collaboration and traceability. Build an executable commit convention and automated checks around your team's branch strategy, and upgrade Git from a "tool" into a "process." Practice often, and when you hit a problem, inspect first with `git status`, `git log`, and `git reflog` before taking action.
