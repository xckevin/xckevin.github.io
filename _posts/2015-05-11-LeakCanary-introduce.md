---
layout: post
title: LeanCanary——消除Android中的内存泄露
---

####简介
LeakCanary是Square公司最近公布的开源项目，旨在消除Android中的内存泄露（Memory Leak），项目地址[猛戳这里](https://github.com/square/leakcanary)。

####使用
LeakCanary的使用也非常之简单，仅需要在**Application**中添加一行代码

    public class ExampleApplication extends Application {

	  @Override public void onCreate() {
	    super.onCreate();
	    LeakCanary.install(this);
	  }
	}

当然依赖也是必须的

    dependencies {
	   debugCompile 'com.squareup.leakcanary:leakcanary-android:1.3'
	   releaseCompile 'com.squareup.leakcanary:leakcanary-android-no-op:1.3'
	 }

> 在这里分别使用了`debugCompile`和`releaseComile`是为了在开发测试和发布时，发现内存泄露执行不同Action。

当使用debug编译时，如果Activity发生了内存泄露，LeanCanary会自动发送Notification提醒你，点击之后会展现内存泄露的详细信息，列出相关的对象引用。
![内存泄露详细信息](https://github.com/square/leakcanary/raw/master/assets/screenshot.png)
并且还会在logcat中打印相关的信息：
> In com.example.leakcanary:1.0:1 com.example.leakcanary.MainActivity has leaked:
* GC ROOT thread java.lang.Thread.<Java Local> (named 'AsyncTask #1')
* references com.example.leakcanary.MainActivity\$3.this\$0 (anonymous class extends android.os.AsyncTask)
* leaks com.example.leakcanary.MainActivity instance
* Reference Key: e71f3bf5-d786-4145-8539-584afaecad1d
* Device: Genymotion generic Google Nexus 6 - 5.1.0 - API 22 - 1440x2560 vbox86p
* Android Version: 5.1 API: 22
* Durations: watch=5086ms, gc=110ms, heap dump=435ms, analysis=2086ms

如果你认为LeakCanary能做的只有这样，那你就大错特错了。只要你想，它还可以监视任何对象。

	RefWatcher refWatcher = LeakCanary.install(this);

然后在你觉得对象要被虚拟机回收的时机让`RefWatcher`观察这个对象：

	refWatcher.watch(obj)

####结果
在使用LeakCanary之后，Square声称减少了94%OOM产生的crash，甚至还发现了[Android SDK中的内存泄露](https://github.com/square/leakcanary/blob/master/library/leakcanary-android/src/main/java/com/squareup/leakcanary/AndroidExcludedRefs.java)。
![OOM产生的Crash](https://corner.squareup.com/images/leakcanary/oom_rate.png)

####原理

其实LeakCanary的原理也很简单，简单来说就是创建了一个*WeakReference*对象，如果触发了GC之后这个对象存在，则说明发生了内存泄露。接着dump内存，分析引用，发送通知。

1.  `RefWatcher.watch()`在观察对象中添加一个[KeyedWeakReference](https://github.com/square/leakcanary/blob/master/library/leakcanary-watcher/src/main/java/com/squareup/leakcanary/KeyedWeakReference.java)。
2. 接着过一段时间，后台线程会检查观察对象是否还存活着，如果是，则触发GC。
3. 如果观察对象仍然存在，则表示发生了内存泄露。LeakCanary会dump内存生成`.hprof`文件在应用文件目录下。
4. 在另一个进程中启动`HeapAnalyzerService` ，`HeapAnalyzer`借助[HAHA](https://github.com/square/haha)来分析内存。
5. `HeapAnalyzer`在dump文件中找到`KeyedWeakReference`，并且找到泄露的引用。
6. `HeapAnalyzer`计算到GG Root的最短路径，并判断是否是一个的内存泄露。如果是，生成引用的路径链。
7. 最终接口会发送到app进程中的`DisplayLeakService`，执行接下来的操作，debug环境默认是发送一个Notification。

#####参考地址
+ https://github.com/square/leakcanary
+ https://corner.squareup.com/2015/05/leak-canary.html