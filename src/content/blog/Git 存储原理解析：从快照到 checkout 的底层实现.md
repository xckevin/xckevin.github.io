---
title: Git 存储原理解析：从快照到 checkout 的底层实现
excerpt: 本文从 Git 的对象数据库模型出发，解释 blob、tree、commit 的关系，并拆解 git log 与 git checkout 的执行逻辑，帮助你建立可验证的 Git 底层心智模型。
publishDate: 2026-03-03
tags:
  - Git
  - 版本控制
  - 软件工程
  - 架构设计
seo:
  title: Git 存储原理解析：从快照到 checkout 的底层实现
  description: 深入理解 Git 的快照存储、对象模型、log 遍历与 checkout 还原机制，建立清晰的 Git 底层认知。
---



很多人把 Git 理解成“记录每一步操作日志的系统”。这个理解会在你学习 `rebase`、`merge`、`reset` 时反复制造困惑。

Git 的真实模型更接近一句话：它是一个基于内容寻址（Content Addressable）的不可变对象数据库。

## Git 存的不是操作，而是快照

每次提交（commit）不是“记录你做了什么动作”，而是“记录当前项目在这一刻长什么样”。

这个“样子”就是快照（snapshot）。

如果你在两次提交之间没有改某个文件，Git 不会重复存一份同样内容。它会继续引用旧对象。于是你得到两个结果：

1. 提交语义上是完整快照。
2. 存储层面通过复用对象实现去重。

这也是很多人第一次接触 Git 时的误区来源：语义看起来像“整仓备份”，实现上其实是“对象复用”。

## Git 的 4 类核心对象

Git 的内部结构可以先压缩成 4 个关键词：

```text
blob    文件内容
tree    目录结构
commit  一次提交
tag     标签
```

### blob：只管内容，不管文件名

`blob` 存的是文件字节内容本身。Git 对内容计算哈希（常见为 SHA-1，现代版本也支持 SHA-256 仓库格式），哈希就是对象标识。

同一份内容在仓库里只需要一份 blob。

### tree：目录的“索引表”

`tree` 记录目录项。每一项包含模式、名字、指向对象的哈希。

它描述的是“这个目录下有哪些文件或子目录，它们分别指向哪些对象”。

### commit：把历史串起来

`commit` 至少包含这些信息：

- 指向一个根 tree
- 指向父 commit（可有多个，merge 时就是多个 parent）
- 作者、提交者、时间戳
- 提交说明

这使得提交天然形成一张有向无环图（DAG）。

## 一个最小例子：两次提交到底发生了什么

假设项目里只有 `hello.txt`。

第一次提交内容是：

```text
hello world
```

Git 会创建一组对象：

```text
blob A   (hello world)
tree A   (hello.txt -> blob A)
commit A (root tree = tree A)
```

你把文件改成：

```text
hello world!!!
```

第二次提交后：

```text
blob B   (hello world!!!)
tree B   (hello.txt -> blob B)
commit B (root tree = tree B, parent = commit A)
```

如果仓库中另一个文件没改，`tree B` 仍会指向它原来的 blob，不会复制新对象。

## `git log` 的本质：遍历 parent 指针

`git log` 不是读取某个“动作日志表”。

它的核心动作是：从当前 `HEAD` 指向的 commit 出发，沿着 `parent` 指针向后遍历。

简化后可以画成：

```text
A <- B <- C <- D (HEAD)
```

执行 `git log`，就是从 `D` 走到 `C`、`B`、`A`，再把每个 commit 的元数据格式化展示。

## `git checkout <commit>` 到底做了哪两步

以 `git checkout B` 为例，核心过程可以拆成两步：

1. 更新 `HEAD` 的指向。
2. 用目标 commit 的 root tree 重建工作区文件。

也就是：

- 找到 `commit B`
- 读取它指向的 `tree B`
- 把 tree 里对应的 blob 内容写回磁盘

你看到的是“项目回到了 B 那一刻的状态”。

很多人担心“后面的提交是不是丢了”。通常不会丢。提交对象还在仓库里，只是当前引用不再指向它们。

## Git 和 diff 的关系：逻辑层与存储层要分开

一个常见问题是：“Git 不是按 diff 存的吗？”

答案分两层：

- 逻辑模型：Git 以快照对象组织历史。
- 传输和压缩：packfile 可能使用 delta 压缩减少体积。

所以你在概念层学习 Git，应该先坚持“快照模型”。不要把 packfile 的压缩细节反向当成 Git 的核心抽象。

## 用一张 ASCII 图把结构连起来

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
  +-- README.md -> blob R   (复用)
```

这里 `README.md` 没变，`blob R` 在多个提交里被复用。

## 为什么这个模型重要

理解这套模型后，很多命令会变得可预测：

- 创建分支很轻，因为分支本质是可移动引用。
- `merge` 是创建一个具有多个 parent 的新 commit。
- `rebase` 是基于新 parent 重放提交，生成新对象。
- `reflog` 能救场，因为它记录了引用位置变更。

你不再靠“背命令”，而是靠“对象图变化”来推理行为。

## 小结

Git 不是操作日志系统，而是快照驱动的对象数据库：

- `blob` 存内容
- `tree` 存目录映射
- `commit` 连接历史
- `log` 是遍历提交图
- `checkout` 是切换引用并还原树

当你用这个模型看 Git，日常开发中的大多数“玄学问题”都会变成可以验证的工程问题。
