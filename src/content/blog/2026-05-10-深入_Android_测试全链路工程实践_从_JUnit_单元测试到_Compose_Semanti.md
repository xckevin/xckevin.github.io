---
title: 深入 Android 测试全链路工程实践：从 JUnit 单元测试到 Compose Semantics UI 测试的生产级质量保障体系
excerpt: 系统梳理 Android 测试全链路体系：从 ViewModel 单元测试、Repository 集成测试到 Compose UI 语义树测试，再到 CI 质量门禁的 flaky test 治理，构建可落地的生产级质量保障方案。
publishDate: '2026-05-10'
tags:
- Android
- 测试
- Compose
- JUnit
- CI/CD
seo:
  title: "Android 测试工程实践：JUnit、集成测试、Compose 语义与 CI"
  description: "覆盖 Android 测试全链路，从 JUnit 单元测试、Repository 集成测试到 Compose 语义测试和 CI 自动化质量门禁。"
---

上周五晚上 11 点，CI 流水线在第 4 次重试后终于变绿。罪魁祸首是一个 `MutableStateFlow` 的时序问题——单元测试全过，但一跑 Compose UI 测试就随机挂。那次之后，我把团队的测试体系重新梳理了一遍，核心思路就一条：**不同层级的测试解决不同的问题，但必须能在 CI 上一致地跑出结果**。

## 单元测试：让 Mock 服务于行为验证

单元测试的命题不是"覆盖代码"，而是验证**一个类在隔离环境下的行为合约**。View 层和 Repository 层都有各自的测试重点。

ViewModel 是单元测试回报率最高的组件。它接收用户意图、调度数据流、产出 UI 状态，全链路纯逻辑，Mock 成本极低：

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class ArticleListViewModelTest {
    private val repository = mockk<ArticleRepository>()
    private val viewModel by lazy { ArticleListViewModel(repository) }

    @Test
    fun `loadArticles success emits Content state`() = runTest {
        coEvery { repository.fetchArticles() } returns Result.success(fakeArticles)
        val states = viewModel.uiState.take(3).toList()

        viewModel.loadArticles()

        assertThat(states[0]).isEqualTo(UiState.Loading)
        assertThat(states[1]).isEqualTo(UiState.Content(fakeArticles))
    }
}
```

这里用了 Turbine 的 `take(3).toList()`，直观地捕获 `StateFlow` 的发射序列。MockK 的 `coEvery` 处理 suspend 函数比 Mockito 简洁太多，省去了在 `runBlocking` 和 `UnconfinedTestDispatcher` 之间来回切换的麻烦。

Repository 层主要测两个东西：数据转换逻辑和异常处理路径。一个实用的技巧是用 Room 的 **in-memory 数据库**替代 Mock DAO：

```kotlin
@RunWith(AndroidJUnit4::class)
class ArticleRepositoryTest {
    private lateinit var db: AppDatabase
    private lateinit var repo: ArticleRepository

    @Before
    fun setup() {
        db = Room.inMemoryDatabaseBuilder(getContext(), AppDatabase::class.java).build()
        repo = ArticleRepository(db.articleDao(), mockApi)
    }

    @Test
    fun fetchArticles_networkError_returnsCached() = runTest {
        coEvery { mockApi.getArticles() } throws IOException()
        db.articleDao().insertAll(fakeCachedArticles)

        val result = repo.fetchArticles()

        assertThat(result.getOrNull()).containsExactlyElementsIn(fakeCachedArticles)
    }
}
```

这种方式比 Mock DAO 可靠——你的 DAO SQL 如果有问题，Mock 测不出来，但 in-memory Room 会直接暴露。

## 集成测试：把组件协作纳入验证范围

单元测试能验证 Repository 的异常处理逻辑，但不会告诉你 `Retrofit` 的拦截器配置是否正确、`Gson` 的反序列化是否和接口契约一致。集成测试的场景是：**一个真实网络请求，从 API 层到数据库的完整链路**。

OkHttp 的 `MockWebServer` 是这层测试的核心工具：

```kotlin
class ArticleApiIntegrationTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ArticleApi

    @Before
    fun setup() {
        server = MockWebServer()
        api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ArticleApi::class.java)
    }

    @Test
    fun getArticles_validResponse_parsedCorrectly() = runTest {
        server.enqueue(MockResponse()
            .setBody("""{"articles": [{"id": 1, "title": "Test"}]}""")
            .setResponseCode(200))

        val articles = api.getArticles()

        assertThat(articles.first().title).isEqualTo("Test")
        assertThat(server.requestCount).isEqualTo(1)
    }
}
```

Hilt 测试场景下，用 `@UninstallModules` 替换真实依赖模块，再把 MockWebServer 的 URL 注入进去。一个容易踩的坑：`MockWebServer` 默认的 `dispatcher` 是 FIFO 队列，并发测试场景下请求和 Mock 响应可能对不上号，改用自定义 `Dispatcher` 按 path 匹配更稳妥。

## Compose UI 测试：用语义树替代坐标定位

Compose 测试最大的思维转变：**忘了 View 体系的 `findViewById` 和坐标点击，一切都是语义树（Semantics Tree）**。

`ComposeTestRule` 提供了一套基于语义属性的查找和断言 API。写 Compose UI 测试的第一步不是写测试用例，而是在 Composable 上打好语义标记：

```kotlin
@Composable
fun ArticleCard(article: Article, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .semantics { contentDescription = "Article: ${article.title}" }
            .testTag("article_card_${article.id}")
            .clickable(onClick = onClick)
    ) {
        Text(article.title, modifier = Modifier.semantics { heading() })
        Text(article.summary)
    }
}
```

有了语义标记，测试代码就很干净：

```kotlin
class ArticleListScreenTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun articleList_displaysItems_onSuccess() {
        composeTestRule.setContent {
            ArticleListScreen(viewModel = FakeViewModel.success())
        }

        composeTestRule
            .onAllNodesWithTag(testTag = "article_card", substring = true)
            .assertCountEquals(3)

        composeTestRule
            .onNodeWithText("第一篇测试文章")
            .assertIsDisplayed()
            .performClick()
    }
}
```

几个实战经验：

- **`testTag` 是查找节点的首选**，比 `onNodeWithText` 稳定，不受多语言和文案变更影响。
- **`assertDoesNotExist()` 的等待策略**默认是 1 秒，网络异步场景下容易误报。用 `waitUntil(timeoutMillis = 5000)` 包裹自定义断言来规避。
- Animations 是 CI 上 Compose 测试挂掉的常见原因——本地跑动画耗时 OK，CI 机器性能差就超时。`composeTestRule.mainClock.autoAdvance = false` 可以手动控制虚拟时钟。

## CI 质量门禁：用数据驱动测试决策

写测试不难，难的是让团队**持续相信测试**。如果 CI 上的测试经常随机挂，开发者的第一反应是绕过它而不是修它。我建质量门禁时定了三条硬规则：

**1. 覆盖率红线不搞虚的**

JaCoCo 的指令覆盖率设为 70%，但只统计核心模块（`domain`、`data`），排除 `di` 和纯 UI Composable。用 GitHub Actions 的 step summary 输出覆盖率变化趋势：

```yaml
- name: Run tests with coverage
  run: ./gradlew testDebugUnitTest jacocoTestReport

- name: Check coverage threshold
  run: |
    COVERAGE=$(cat build/reports/jacoco/jacocoTestReport/html/index.html | grep -oP 'Total.*?(\d+)%' | tail -1)
    echo "Coverage: $COVERAGE"
    # 低于阈值直接 block merge
```

**2. 区分阻塞性和信息性检查**

- **阻塞（block merge）**：单元测试 + 集成测试全部通过。
- **信息（report only）**：Compose UI 测试结果、覆盖率变化趋势。

Compose 测试在 CI 上偶尔会因为动画时序问题 flaky，直接 block merge 会拖慢节奏。信息性检查让团队看见问题但不阻断流程，每周集中清理 flaky tests。

**3. Flaky test 自动追溯**

用 Gradle 的 `testRetry` 插件，重试失败的测试最多 2 次。每次失败记录到 `TEST-failed.xml`，写个脚本统计连续 3 次 CI 都重试成功的测试用例，自动开 Issue 标记 flaky。

这套体系跑了大半年，最直观的收益不是 bug 少了——而是代码评审时少了很多"这样改会不会出问题"的担忧。测试本身就是可执行的行为文档，写得好的测试用例比注释更能说明一段代码的真实意图。

把测试当文档写，比把测试当质量检查工具写，团队接受度高得多。

<!-- seo-internal-links -->

## 延伸阅读

- [返回对应专题：移动端工程化](/android-engineering/)
- [Android Gradle 构建提速：Configuration Cache、KSP 与任务治理](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android CI/CD 实践：Jenkins、GitLab CI、构建发布与质量门禁](/blog/jenkins与gitlab-ci实现android持续集成与交付从构建到发布的完整指南/)
<!-- /seo-internal-links -->
