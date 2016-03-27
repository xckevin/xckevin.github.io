---
layout: post
title: 建立属于你自己的GitHub Page
---

> Git Page既可以建立个人、组织的站点，也可以建立属于某一项目的站点。这篇文章只讨论个人站点和Jekyll搭建。

### 生成你的站点

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

### Jekyll

Jekyll的一个静态博客网站生成器，使用Ruby构建。并且它还是开源的，项目地址是[https://github.com/jekyll/jekyll](https://github.com/jekyll/jekyll)。

1. 安装Jekyll可以通过gem的方式。`gem install Jekyll`。安装完成之后可以通过`jekyll --version`来验证是否安装成功。

	> 大天朝的网络你懂的，如果直接安装速度那是相当的醉人。在安装之前可以先替换成国内的镜像。`gem sources --add https://ruby.taobao.org/ --remove https://rubygems.org/`，使用`gem sources -l`来验证是否切换成功。不过听说最近淘宝源已经不再维护了，也可以试着切换到https://gems.ruby-china.org/这个地址。

2. 使用`jekyll new my-awesome-site`命令来生成一个website。Jekyll会自动帮你创建好项目配置。进入my-awesome-site目录并使用`jekyll serve`本地开启服务。你可以使用浏览器访问*http://localhost:4000*来预览页面。	
3. 基本的Jekyll结构如下：

```
|-- _config.yml
|-- _includes
|-- _layouts
|   |-- default.html
|   |-- page.html
|   |-- post.html
|-- _posts
|   |-- 2016-03-27-welcome-to-jekyll.markdown
|-- _site
|-- index.html
```
简单说下他们的作用

 + _config.yml：配置文件，保存Jekyll基本配置。每次修改需要重启Jekyll才能起作用。
 + _includes：可以用来存放一些小的可复用的模块，方便通过\{\%include file.ext\%\}灵活的调用。这条命令会调用_includes/file.ext。
 + _layouts：这里是模板文件存放的位置。
 + _posts：这里是你存放博客文字的地方。博客的命名有强制的规范，必须是*2016-03-27-How-to-build-a-github-page.md*。
 + _site：这个是Jekyll生成的最终的文档，不用去关心。最好把在你的.gitignore文件中忽略它。

> 通常我是使用Markdown来写文字，就需要安装Rdiscount来解析Markdown标记。使用命令`gem install rdiscount`安装。

### Go Forward

现在你可以使用Jekyll来装饰你的repo了，然后快乐地写博客吧！

### Tips

#### Jekyll模板

配置website时可以直接套用网上现有的模板，配色、文字都精心调整过，十分优美。

+  [http://jekyllthemes.org/](http://jekyllthemes.org/)
+  [http://jekyllthemes.io/](http://jekyllthemes.io/)

#### 代码高亮

Jekyll默认是没有代码高亮的功能，官方文档指导用户使用Liquid,再配合Pygments实现高亮。

Liquid写法：

```
/{ % highlight java %}
public static void main(String...args) {
    System.out.println("Hello world");
}
{ % endhighlight %}
```

markdown写法：

```
```java
public static void main(String...args) {
    System.out.println("Hello world");
}
、```
```

使用markdown高亮可以借助Pygments，也可以使用JS来展示代码高亮。使用JS高亮方法如下：
在`_config.yml`追加以下配置：

```
redcarpet:
  extensions: [fenced_code_blocks]
  render_options:
```

然后在页面中引入*highlight.js*：

```
<link rel="stylesheet" href="http://yandex.st/highlightjs/7.1/styles/default.min.css">
<script src="http://yandex.st/highlightjs/7.1/highlight.min.js"/>
<script>hljs.initHighlightingOnLoad();</script>
```

### THE END

Thanks for reading!