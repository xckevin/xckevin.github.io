---
title: 深入 Android Compose 渐进式迁移全链路：从 View/Compose 混用架构到全量声明式 UI 的工程化转型策略与性能验证
excerpt: 复盘从View到Compose的渐进式迁移全链路策略，涵盖基础设施铺路、分阶段替换、列表优化、混用治理及灰度验证的工程实践与性能对比。
publishDate: '2026-06-01'
tags:
- Android
- Jetpack Compose
- 架构设计
- 性能优化
- 渐进式迁移
seo:
  title: 深入 Android Compose 渐进式迁移全链路：从 View/Compose 混用架构到全量声明式 UI 的工程化转型策略与性能验证
  description: 详细复盘百万DAU电商App从View到Jetpack Compose的渐进式迁移全链路，包括分阶段替换策略、列表性能优化、混用边界治理与灰度验证，附TTI、帧率、崩溃率真实性能对比数据。
---

去年接手一个百万 DAU 的电商 App 技术改造项目时，团队内部对 Compose 迁移争执不下 —— 激进派想直接重写，保守派觉得 XML 够用。最终我们花了 8 个月完成渐进式迁移，没有阻断任何一次发版。这篇文章复盘整个过程里的架构决策和踩过的坑。

## 为什么迁移不是「要不要」而是「怎么迁」

View 体系用久了，三个问题会越来越突出。

**代码膨胀不可逆**：一个 RecyclerView 的 Adapter 加 ViewHolder 轻松破 500 行，xml + binding + 业务逻辑分离在三个文件里，改一个交互要跳三处。

**状态同步是万恶之源**：手动 findView + setText + 监听回调链路，每多一层嵌套就多一个 bug 温床。

**动画实现成本高**：属性动画、Transition、CoordinatorLayout 各有各的写法，协同交互时胶水代码比业务代码还多。

Compose 解决得最彻底的不是「写法更简洁」，而是把 UI = f(state) 这个模型真正落到了工程里。你不用在 Activity/Fragment、ViewModel、Adapter 之间手动传递状态变更，重组（Recomposition）替你完成。这个收益在复杂交互场景下尤其明显。

我不是在说 Compose 没有问题。它的性能热点范围控制、列表滚动优化、与 View 系统的互操作开销，后面具体谈。

## 分阶段策略：5 步走完迁移链路

策略核心就一条：**以 Navigation Graph 的节点为迁移单元，以发版周期为验证窗口**。不跨页面降级，不在同一个 Fragment 里拆一半 View 一半 Compose。

### 阶段一：基础设施铺路（2 周）

先确保整个工程能同时编译 View 和 Compose 代码，这一步不涉及任何业务改动。

```kotlin
// app/build.gradle.kts
android {
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.10"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.01.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.8.2")
}
```

尽早引入 Compose BOM 是这一步的关键决策。BOM 保证所有 Compose 库版本对齐，避免运行时不兼容。阶段一我们就踩过坑 —— 单独升了 `ui-tooling` 导致 preview 崩溃。

同时搭好 Theme 桥接层：

```kotlin
// 复用现有 XML theme 的属性，避免视觉分裂
object AppThemeBridge {
    fun colors(context: Context) = when {
        // 从 XML attr 读取，保证两套 UI 体系色彩一致
        else -> lightColors(
            primary = Color(context.getColorFromAttr(R.attr.colorPrimary)),
            background = Color(context.getColorFromAttr(R.attr.colorBackground)),
            surface = Color(context.getColorFromAttr(R.attr.colorSurface)),
        )
    }
}
```

Theme 桥接是整个迁移过程里性价比最高的基础设施投资，花两天写好，后续所有 Compose 页面都能直接用，视觉上零差异。

### 阶段二：底部导航页逐一替换（10 周）

迁移的主战场。我们选了风险最低的「我的」Tab 作为试点，原因很简单：交互以表单和列表为主，不涉及首页那种复杂动画 Banner。

每个页面的迁移模版：

```kotlin
@Composable
fun ProfileScreen(viewModel: ProfileViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    ProfileContent(
        state = uiState,
        onEditClick = { viewModel.onEditProfile() },
        onLogout = { viewModel.onLogout() }
    )
}

@Composable
private fun ProfileContent(
    state: ProfileUiState,
    onEditClick: () -> Unit,
    onLogout: () -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item { ProfileHeader(state.user) }
        item { ProfileSettingsList(onEditClick, onLogout) }
    }
}
```

这里有三个我们验证过的工程决策：

1. **Screen 层保持薄**：只负责 collect state 和分发事件，所有 UI 逻辑在 Content 层
2. **ViewModel 完全复用**：不改 ViewModel 的结构，只暴露 `StateFlow<UiState>`
3. **Preview 参数化**：每个 Content Composable 函数必须支持 Preview，写的时候就能看到效果

踩过一个坑：`collectAsStateWithLifecycle()` 不是银弹。生命周期感知在 Fragment + ComposeView 嵌套场景下，如果 Fragment 的 `viewLifecycleOwner` 和 ComposeView 的 lifecycle 不一致，会导致状态丢失。我们的解法是统一用 `findViewTreeLifecycleOwner()` 作为 lifecycle owner。

### 阶段三：列表页专项攻坚（4 周）

列表是 Compose 迁移的硬骨头。初期用 `LazyColumn` 直接替代 `RecyclerView`，性能测试结果不太理想 —— 快速滑动时帧率从 58fps 掉到 42fps。

排查下来发现两个问题：item 内部的 Modifier 链过长导致测量开销翻倍，以及图片加载没有做预解码。

具体做了三件事：

```kotlin
// 1. 为列表项提供稳定 key —— 避免不必要的重组
LazyColumn {
    items(
        items = productList,
        key = { it.id }  // 比默认的 index key 重组次数减少约 40%
    ) { product ->
        ProductCard(
            product = product,
            modifier = Modifier.animateItem() // 2. 开启动画优化的 item 位移
        )
    }
}

// 3. 图片使用精确尺寸预解码，避免解码后的二次缩放阻塞主线程
@Composable
fun AsyncImage(
    url: String,
    modifier: Modifier = Modifier
) {
    SubcomposeAsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
            .data(url)
            .size(360, 480) // 精确尺寸，跳过解码后的二次缩放
            .build(),
        contentDescription = null,
        modifier = modifier
    )
}
```

优化后帧率稳定在 56fps 以上。列表性能的 80% 问题出在 item 内部的组合函数和资源处理上，LazyColumn 本身的懒加载机制没有性能缺陷。

### 阶段四：View/Compose 混用边界治理（3 周）

全量迁移完成前，View 和 Compose 必然共存。边界治理原则：

- **页面级隔离**：同一个 Fragment 内部不混用。Fragment 要么纯 View，要么纯 Compose
- **组件级互操作**：`AndroidView` 用于嵌入遗留 View（如 WebView、MapView），`ComposeView` 用于在 XML 中嵌入 Compose 小组件
- **导航统一**：所有页面跳转走 Navigation Compose，旧的 Fragment 通过 `AndroidView` 包装

```kotlin
// 用 ComposeView 在 XML 布局中嵌入 Compose 小组件
// 适用于一个 View 页面逐步替换底部按钮、顶部栏等小块区域
class LegacyFragment : Fragment() {
    override fun onCreateView(/*...*/): View {
        return inflater.inflate(R.layout.fragment_legacy, container, false).apply {
            findViewById<ComposeView>(R.id.compose_bottom_bar).apply {
                setContent {
                    AppThemeBridge {
                        ModernBottomBar(
                            onTabSelected = { /* 通过 shared ViewModel 通信 */ }
                        )
                    }
                }
            }
        }
    }
}
```

混用最大的坑是事件传递方向。Compose 的 Pointer Input 处理和 View 的 Touch Event 分发是两条独立链路。当一个 View 页面嵌套 ComposeView 时，手势冲突很难定位。实践下来，Compose 嵌套 View（`AndroidView`）比反过来稳定得多。

### 阶段五：全量切换 + 灰度验证（3 周）

最后一步不是简单的「删掉旧代码」，而是一套验证机制。我们用 Feature Flag + 页面级 AB 开关：

```kotlin
object ComposeMigrationFlag {
    private val migratedScreens = setOf("profile", "cart", "orders", "settings")

    fun isComposeRoute(route: String): Boolean {
        // 灰度控制：10% 用户走 View 降级保底
        if (RemoteConfig.getBoolean("compose_fallback_enabled", false)) {
            return false
        }
        return route in migratedScreens
    }
}
```

灰度期间监控的核心指标：页面首帧耗时（TTI）、帧率、崩溃率。基于 10 万用户样本的对比数据：

| 指标 | View 版 | Compose 版 | 变化 |
|------|---------|-----------|------|
| 首页 TTI | 720ms | 580ms | **-19%** |
| 列表滚动帧率 | 57.3fps | 56.8fps | 基本持平 |
| 崩溃率（页面相关） | 0.08% | 0.03% | **-62%** |
| 页面代码行数 | 12,400 | 6,800 | **-45%** |

崩溃率下降主要归因于 Compose 消除了 `findViewById` 导致的 NPE 和 View 生命周期错乱 —— 这两类问题占了我们 View 页面崩溃的一半以上。

## 一个反直觉的发现：性能最差的不是重组，是测量

迁移过程中做了大量 systrace 分析，结论反直觉：Compose 的性能瓶颈很少出在重组（Recomposition），更多出在测量（Measure/Layout）阶段。

`Modifier` 链越长，`LayoutNode` 的测量树越深。一个接 `padding → background → clip → border → shadow` 的 Modifier 链会让单帧测量耗时增加 3-5ms。这就是为什么 Modifier 设计里强调「顺序很重要」—— 不只是视觉差异，还影响性能。

把 Modifier 看作布局的调用链：能用内置 Modifier 组合的就不要自己写 `layout{}`，能用 `graphicsLayer{}` 做离屏变换的就不要触发测量阶段。

## 迁移决策的三个原则

回头看整个过程，三条原则帮我们少走了很多弯路。

**时效性优先**。不要为了「迁移得更彻底」而延迟发版。一个页面打磨好就上线验证，下个迭代再继续。2 周一页面的节奏是可持续的，不会变成老大难项目。

**数据驱动降级**。灰度开关不是摆设。一次基础库升级导致 Compose 页面在低端机上掉帧，30 分钟回滚到 View 版，零影响。如果当初直接重写，这锅就得全部研发背。

**不要为了 Compose 而 Compose**。`AndroidView` 的存在不是技术债，是工程现实。WebView、SurfaceView、CameraX Preview 这些组件在 Compose 里的原生支持还不如 `AndroidView` 稳定，该用就用。全量 Compose 不应该是 KPI，降低维护成本才是。
