---
title: Android 组件化模块间通信：从路由表到 SPI 服务发现
excerpt: 深入分析 Android 组件化模块间通信的两种方案：路由表与接口下沉（SPI 服务发现），涵盖实现原理、实战决策与选型指南。
publishDate: '2026-05-19'
tags:
- Android
- Kotlin
- 组件化
- SPI
- 架构设计
seo:
  title: Android 组件化模块间通信：从路由表到 SPI 服务发现
  description: Android 组件化模块间通信方案深度对比：从路由表到接口下沉（SPI 服务发现），剖析原理、实战决策与选型指南，助你构建可维护的组件化架构。
---

去年接手一个电商 App 的组件化改造，项目拆成了 12 个模块。第一个让人头疼的问题不是怎么拆，而是拆完之后模块之间怎么通信——壳工程不直接依赖子模块，但支付模块要调用户模块的登录态、商品模块要调搜索模块的接口。这几乎是所有组件化项目绕不过去的坎。

## 问题的本质

组件化通信的核心矛盾：**模块间需要协作，但编译期不能产生直接依赖**。

如果模块 A 直接 `implementation` 模块 B，那就不是组件化了——B 的改动会导致 A 重新编译，并行开发的优势荡然无存。你需要的是：A 在编译期不知道 B 的存在，运行时却能调用 B 的能力。

解决这个矛盾的路线分两派：**路由派**和**接口下沉派**。前者用 URL 字符串做中间层，后者用接口抽象解耦编译依赖。

## 路由方案：用 URL 做中间层

早期的组件化项目几乎都从路由起步，思路很直观——像 Web 一样用 URL 跳转，顺带处理通信。

```kotlin
// 模块A中调用
ARouter.getInstance()
    .build("/user/getUserInfo")
    .withString("userId", "12345")
    .navigation()

// 模块B中注册
@Route(path = "/user/getUserInfo")
class UserServiceImpl : UserService {
    override fun getUserInfo(userId: String): UserInfo {
        // 实际逻辑
    }
}
```

路由方案依赖**中心化路由表**：编译期通过 APT 扫描所有 `@Route` 标记的类，生成字符串路径到具体类的映射表，运行时查表分发。

我在两个项目里用过这种方式。接入成本低、前端同学也能理解，优点很实在。但坑也同样真实：

- **字符串强依赖**，路径拼错编译期零感知
- **参数类型擦除**，传参和取值全靠文档约定，没有编译期检查
- **路由表膨胀**后维护成本线性增长，多人协作时路径冲突时有发生

更深层的问题在于路由方案的**通信模型是单向的**。A 调 B 可以，B 回调 A 就得再走一遍路由，链式调用一多就成了字符串地狱。

## 接口下沉：让依赖反转

接口下沉的思路是 **把接口定义抽到公共层，实现留在各自模块，运行时通过 SPI 机制组装**。

```
common 模块
├── IUserService（接口）
└── IOrderService（接口）

user 模块
├── UserServiceImpl（实现 IUserService）
└── 不依赖 order 模块

order 模块
├── OrderServiceImpl（实现 IOrderService）
├── 不依赖 user 模块
└── 但可以调用 IUserService
```

编译期的依赖关系被反转了：user 和 order 都只依赖 common 层的接口，互不感知。运行时由 SPI 把接口和实现关联起来。

### SPI 服务发现的三种实现

**Google AutoService** 最轻量，基于注解加 ServiceLoader：

```java
@AutoService(IUserService::class)
class UserServiceImpl : IUserService {
    override fun getUserInfo(userId: String): UserInfo {
        // 实现
    }
}
```

编译期在 `META-INF/services/` 下生成接口全限定名文件，内容是实现类的全限定名，ServiceLoader 启动时读取完成加载。

**Gradle 插件 + 字节码注入**在 transform 阶段扫描接口实现，直接注入到注册类中。滴滴 VirtualAPK 早期版本用过类似方案。优势是不依赖反射，代价是得维护一套 Gradle 插件。

**APT 生成注册代码**是我最推荐的方式——编译期生成工厂类，运行时直接调用，性能最优：

```kotlin
// 编译期自动生成
object ServiceRegistry {
    private val services = mapOf(
        IUserService::class.java to UserServiceImpl(),
        IOrderService::class.java to OrderServiceImpl()
    )
    
    fun <T> get(cls: Class<T>): T = services[cls] as T
}
```

## 实战中三个绕不过去的决策

在项目里落地接口下沉方案时，有三个点必须想清楚。

### 一、服务注册中心的单例与生命周期

接口下沉后服务通常是单例的，但有些场景需要生命周期感知。比如用户在设置页退出登录，`IUserService` 缓存的用户数据必须失效。

我的做法是给服务接口增加 `onUserChanged()` 回调：

```kotlin
interface IUserService : LifecycleAware {
    fun getUserInfo(userId: String): UserInfo
    override fun onUserChanged() {
        // 清除缓存
    }
}
```

Application 层在登录态变化时遍历所有 `LifecycleAware` 服务触发回调，不侵入业务模块。

### 二、服务发现的初始化时序

SPI 注册必须在 Application 的 `onCreate` 最早阶段完成，否则其他模块初始化时调用服务直接 NPE。但 ServiceLoader 在冷启动时全量加载有几十毫秒的损耗，对启动速度敏感的项目是个痛点。

这个项目我最终选了 APT 方案：注册代码编译期硬编码到类中，运行时零扫描开销。代价是每新增一个服务实现需要 rebuild。实际项目中服务的增减频率远低于业务代码变更，这个 trade-off 完全可接受。

### 三、通信的降级与兜底

接口下沉后，如果 order 模块调用 `IUserService.getUserInfo()` 时 user 模块未安装（插件化或热修复场景），调用方必须兜住服务缺失的情况。

```kotlin
fun getUserName(userId: String): String {
    return try {
        ServiceRegistry.get(IUserService::class.java)
            .getUserInfo(userId).name
    } catch (e: ServiceNotFoundException) {
        "未知用户" // 降级策略
    }
}
```

我们在 ServiceRegistry 层统一做了容错，返回 NullObject 或抛出明确的 `ServiceNotFoundException`，避免隐式 NPE 在调用链里扩散后难以定位。

## 路由 vs 接口下沉：怎么选

踩了几个项目的坑后，我对选型有了明确的判断标准。

| 维度 | 路由方案 | 接口下沉 |
|------|---------|---------|
| 类型安全 | 弱，运行时校验 | 强，编译期校验 |
| 接入成本 | 低，注解+路径即可 | 中，需要公共接口层 |
| 代码可追踪性 | 差，找引用靠搜索字符串 | 好，IDE 能直接跳转 |
| 模块解耦程度 | 中等 | 强 |
| 性能 | 路径匹配有开销 | 接近直接调用 |

**我的立场很明确：优先选接口下沉。** 不是因为路由方案不好，而是路由解决的问题域本身有限——它就是为页面跳转设计的，硬拿来当服务通信用属于职责越界。路由做页面导航，接口下沉做服务通信，各司其职才是合理的分工。

如果你的项目模块不超过 5 个、团队规模小、对编译速度不敏感，路由方案也能跑。架构选型的核心从来不是追新，而是**匹配当前工程的复杂度和团队的维护能力**。

一个经验参数：当 common 层接口超过 20 个时，就该做接口分层了——按业务领域拆出 `common-user`、`common-order` 等子模块，否则公共层会膨胀成第二个壳工程。

组件化通信没有银弹。路由是字符串的中间层，接口下沉是抽象的中间层——区别在于这个中间层是动态解析还是静态编译，而这一点直接决定了你后续的维护成本和调试体验。
