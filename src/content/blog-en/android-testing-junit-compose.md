---
title: "Android Testing in Practice: JUnit, Integration Tests, Compose Semantics, and CI"
lang: en
translationKey: android-testing-junit-compose
slug: android-testing-junit-compose
excerpt: "A practical Android testing strategy from ViewModel unit tests and Repository integration tests to Compose semantics UI tests and CI flaky-test governance."
publishDate: '2026-05-10'
tags:
- "Android"
- "Testing"
- "Compose"
- "JUnit"
- "CI/CD"
seo:
  title: "Android Testing: JUnit, Integration Tests, Compose Semantics, and CI"
  description: "Build an Android testing strategy across JUnit, Repository integration tests, Compose semantics UI tests, CI gates, and flaky-test governance."
---

At 11 p.m. last Friday, the CI pipeline finally turned green after its fourth retry. The culprit was a timing issue around `MutableStateFlow`: all unit tests passed, but Compose UI tests failed randomly. After that incident, I reworked our team's testing strategy around one principle: **different test layers solve different problems, but they must produce consistent results in CI**.

## Unit tests: make mocks serve behavior verification

The goal of a unit test is not "covering code." It is verifying **a class's behavioral contract in isolation**. The View layer and Repository layer each have different testing priorities.

ViewModels usually provide the highest return on unit tests. They receive user intents, orchestrate data flows, and emit UI state. The whole path is pure logic, so mocking cost is low:

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

Here, Turbine's `take(3).toList()` captures the `StateFlow` emission sequence directly. MockK's `coEvery` handles suspend functions much more cleanly than Mockito and avoids the back-and-forth between `runBlocking` and `UnconfinedTestDispatcher`.

At the Repository layer, test two things first: data transformation and exception handling paths. One practical technique is to use Room's **in-memory database** instead of a mocked DAO:

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

This is more reliable than mocking the DAO. If your DAO SQL is wrong, a mock will not catch it; in-memory Room will.

## Integration tests: verify component collaboration

Unit tests can verify a Repository's exception handling, but they will not tell you whether a `Retrofit` interceptor is configured correctly or whether `Gson` deserialization matches the API contract. Integration tests cover scenarios like **one real network request flowing from the API layer into the database**.

OkHttp's `MockWebServer` is the core tool for this layer:

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

In Hilt test scenarios, use `@UninstallModules` to replace real dependency modules, then inject the `MockWebServer` URL. One common pitfall: `MockWebServer` uses a FIFO `dispatcher` by default. In concurrent tests, requests and mocked responses may no longer line up. A custom `Dispatcher` that matches by path is more stable.

## Compose UI tests: use the semantics tree instead of coordinates

The biggest mental shift in Compose testing is this: **forget `findViewById` and coordinate clicks from the View system; everything is the semantics tree**.

`ComposeTestRule` provides lookup and assertion APIs based on semantic properties. The first step in writing Compose UI tests is not writing test cases. It is adding useful semantic markers to Composables:

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

With semantic markers in place, the test stays clean:

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
            .onNodeWithText("First test article")
            .assertIsDisplayed()
            .performClick()
    }
}
```

A few lessons from production use:

- **`testTag` should be the default lookup strategy.** It is more stable than `onNodeWithText` and is not affected by localization or copy changes.
- **`assertDoesNotExist()` waits for only 1 second by default**, which can produce false failures in async network scenarios. Wrap custom assertions in `waitUntil(timeoutMillis = 5000)`.
- Animations are a common cause of Compose test failures in CI. Local animation timing may be fine, while slower CI machines time out. `composeTestRule.mainClock.autoAdvance = false` lets you control the virtual clock manually.

## CI quality gates: use data to drive testing decisions

Writing tests is not the hard part. The hard part is keeping the team **confident in the tests**. If tests fail randomly in CI, developers will work around them instead of fixing them. When I set up quality gates, I used three strict rules.

**1. Keep the coverage threshold honest**

Set JaCoCo instruction coverage to 70%, but count only core modules such as `domain` and `data`. Exclude `di` and pure UI Composables. Use a GitHub Actions step summary to show coverage trends:

```yaml
- name: Run tests with coverage
  run: ./gradlew testDebugUnitTest jacocoTestReport

- name: Check coverage threshold
  run: |
    COVERAGE=$(cat build/reports/jacoco/jacocoTestReport/html/index.html | grep -oP 'Total.*?(\d+)%' | tail -1)
    echo "Coverage: $COVERAGE"
    # Block the merge directly when coverage is below the threshold.
```

**2. Separate blocking checks from informational checks**

- **Blocking checks:** all unit tests and integration tests pass.
- **Informational checks:** Compose UI test results and coverage trend changes.

Compose tests can occasionally become flaky in CI because of animation timing. Blocking every merge on them can slow the team down. Informational checks keep the issue visible without stopping the workflow, and flaky tests can be cleaned up in a weekly pass.

**3. Trace flaky tests automatically**

Use Gradle's `testRetry` plugin and retry failed tests up to 2 times. Record each failure into `TEST-failed.xml`, then run a script that finds test cases that failed first but passed on retry for 3 consecutive CI runs. Open an issue automatically and mark them as flaky.

After running this system for more than half a year, the most visible benefit was not simply fewer bugs. Code review had far fewer "will this change break something" discussions. Tests are executable behavior documentation, and well-written tests explain the real intent of code better than comments.

Treating tests as documentation earns much more team buy-in than treating them only as a quality inspection tool.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Mobile Engineering](/en/android-engineering/)
- [Android Gradle build acceleration: Configuration Cache, KSP, and task governance](/blog/2026-05-06-android_gradle_构建提速全链路_从_configuration_cache_到_ksp/)
- [Android CI/CD quality gates: build, test, lint, performance, and release checks](/en/blog/android-ci-cd-quality-gates/)
<!-- /seo-internal-links -->
