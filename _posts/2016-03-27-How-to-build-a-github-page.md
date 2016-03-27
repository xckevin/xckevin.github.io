---
layout: post
title: 建立属于你自己的GitHub Page
---

> Git Page既可以建立个人、组织的站点，也可以建立属于某一项目的站点。这篇文章只讨论个人站点和Jekyll搭建。

### 创建个人站点

1. 去Github上创建一个名称为**username.github.io**的repo。这个的*username*是你在github上的username。
	
	*注意这里的username一定要和你github上的username相一致，否则不会生效。*
2. 	将你的刚刚创建的repo 克隆到本地。这里强烈推荐大家使用[SourceTree](https://www.sourcetreeapp.com/)，SourceTree是一款可视化的Git客户端，还支持Mercurial，不需要了解记忆那么多的git命令，操作起来那是十分的带感。不过下载地址貌似国内被墙掉了，这里给小伙伴们分享一个 [某网盘地址](http://pan.baidu.com/s/1i50He89)。
3. 进入到你本地repo目录，创建一个index.html文件。这个index默认会作为你的website首页展示。下面我们对这个文件编辑：

```
<!DOCTYPE html>
<html>
<body>
    <h1>Hello World</h1>
    <p>I'm hosted with GitHub Pages.</p>
</body>
</html>
```
	
4. 提交index.html文件，并push到origin。
5. 现在是见证奇迹的时刻，赶紧打开浏览器访问username.github.io吧！

### 使用Jekyll

