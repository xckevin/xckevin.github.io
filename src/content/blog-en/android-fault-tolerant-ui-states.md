---
title: "Systematic Fault-Tolerant UI States in Android"
lang: en
translationKey: android-fault-tolerant-ui-states
slug: android-fault-tolerant-ui-states
excerpt: "A systematic approach to modeling loading, content, empty, and error states in Android apps."
publishDate: '2026-08-07'
tags:
- "Android"
- "Kotlin"
- "UI Architecture"
- "State Management"
seo:
  title: "Systematic Fault-Tolerant UI States for Android"
  description: "A practical guide to modeling page states as a state machine, using skeleton screens, degraded error handling, and team standards."
  pageType: article
---

Last month I worked on a promotional campaign page. After product and UI finished reviewing the interaction draft, I estimated one week of work.

It actually took almost two weeks. The extra time went entirely into handling various states: how to avoid a flash during loading, where to put the retry button after a network error, how to word empty states, and how to refresh an expired token without the user noticing. These "exception paths" made up 30-40% of the page's code, but they were also the most casually written part of our team's work — everyone had their own ad-hoc approach, and code review would take forever to figure out.

After several medium-to-large projects, I have become more and more certain of one thing: fault-tolerant UI is not a feature patch; it needs systematic design.

## Four States, One State Machine

Every data-driven page is essentially a flow among four states:

```
Loading ──→ Content ──→ Empty
   │           │
   ▼           ▼
 Error       Error
```

These four states cover 90% of page scenarios. Explicitly defining them with an enum or sealed class is the first step toward systematic handling:

```kotlin
sealed class PageState<out T> {
    object Loading : PageState<Nothing>()
    data class Content<T>(val data: T) : PageState<T>()
    data class Empty(val message: String = "暂无数据") : PageState<Nothing>()
    data class Error(val throwable: Throwable, val canRetry: Boolean = true) : PageState<Nothing>()
}
```

Binding state and data together means the ViewModel only needs to expose a single `StateFlow<PageState<T>>`, and the UI layer renders the corresponding view based on the state. Using a sealed class has a concrete benefit as well: the compiler checks exhaustiveness for you. If you forget to handle Empty, the `when` lights up red immediately, instead of relying on manual code-review inspection.

## Composing State Containers

Handling four states for a single page is the basic operation. The real challenge is that a page is often composed of multiple independent data sources, each with its own state.

I hit this pitfall in a home page redesign: when the top banner failed to load, the entire page was taken over by an Error state, and the recommendation list below — which had loaded successfully — was invisible. The root cause was that the team used a global state override: a single `isError` field controlled the whole page.

The fix is to use a composite state container for partial degradation:

```kotlin
data class HomePageState(
    val banner: PageState<List<Banner>> = PageState.Loading,
    val feedList: PageState<List<FeedItem>> = PageState.Loading,
    val quickEntry: PageState<List<Entry>> = PageState.Loading
)
```

When rendering, each module consumes its own state independently. A banner error only affects the banner area, while the feed list displays normally. In the ViewModel, each request is launched and updated independently:

```kotlin
viewModelScope.launch {
    bannerRepo.fetch().collect { result ->
        _state.update { it.copy(banner = result.toPageState()) }
    }
}
viewModelScope.launch {
    feedRepo.fetch().collect { result ->
        _state.update { it.copy(feedList = result.toPageState()) }
    }
}
```

## Skeleton Screens: Loading Is Not Just a Spinner

Putting a `CircularProgressIndicator` in the center is the laziest approach and also the source of a rough-looking page. The user sees a blank space plus a spinner, with no idea of the page structure or how long they will wait.

The essence of a skeleton screen is to preview the page layout with placeholder shapes, reducing the user's perceived waiting time. For implementation, I prefer a shimmer animation over static gray blocks — a subtle shimmering effect looks more like something is happening than a flat color block.

The real pitfall with skeleton screens is adaptation. Real UI elements have different widths, heights, and corner radii, and writing a separate skeleton layout for every card is tedious. My approach is to extract a reusable component:

```kotlin
@Composable
fun ShimmerCard(lines: Int = 3, showAvatar: Boolean = true) {
    Column(modifier = Modifier.shimmerEffect()) {
        if (showAvatar) {
            Box(modifier = Modifier.size(40.dp).clip(CircleShape).shimmerPlaceholder())
            Spacer(modifier = Modifier.height(8.dp))
        }
        repeat(lines) { index ->
            Box(
                modifier = Modifier
                    .fillMaxWidth(if (index == lines - 1) 0.6f else 1f)
                    .height(14.dp)
                    .shimmerPlaceholder()
            )
            Spacer(modifier = Modifier.height(6.dp))
        }
    }
}
```

One `ShimmerCard` covers 80% of the skeleton-screen needs on list pages. The remaining special layouts can still be handwritten. The return on investment is reasonable.

## Tiered Error Handling

Not every error should show a Toast and a retry button. Different errors affect users differently, so handling strategies should also be layered.

**Recoverable errors**: network timeout, server 5xx. Provide a retry button and a brief note. "The network is a little unstable. Tap to retry" has more warmth than a cold "Request failed."

**Business errors**: insufficient stock, expired coupon. These are "normal exceptions"; show business copy directly, no retry button needed.

**Unrecoverable errors**: expired token, HTTP 403. Silent handling is better than a dialog. After token expires, the interceptor refreshes it automatically, and upper UI layers are unaware. Use OkHttp `Authenticator` to handle it uniformly:

```kotlin
class TokenAuthenticator(
    private val tokenProvider: TokenProvider
) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        synchronized(this) {
            val newToken = runBlocking { tokenProvider.refresh() }
            return if (newToken != null) {
                response.request.newBuilder()
                    .header("Authorization", "Bearer $newToken")
                    .build()
            } else {
                // 刷新失败，跳到登录页
                null
            }
        }
    }
}
```

**Development-stage errors**: wrong parameters, inconsistent data formats. These should surface as crashes during development and testing, not be swallowed by try-catch. In production, report them to a crash platform and go through the normal fix process.

## Differentiated Empty States

Empty state is the easiest of the four to handle with a one-size-fits-all approach — every empty page shows the same "no data" icon. But the empty list a user sees when first opening the app has a completely different psychological expectation from the empty list an existing user sees after clearing data.

I usually split them into three types:

- **Initial empty**: user has no data yet; suitable for guidance copy and an action entry. "You haven't saved anything yet. Go explore" + a navigation button.
- **Filter empty**: search returned no results. Prompt: "No matching results, try a different keyword" and keep the search box so users can modify it directly.
- **Cleared empty**: user cleared their data. Provide a lightweight recovery entry, such as "All history has been cleared."

The three empty states share the same component and are distinguished by parameters:

```kotlin
@Composable
fun EmptyView(
    type: EmptyType,
    onAction: (() -> Unit)? = null
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Image(painter = painterResource(type.icon), ...)
        Text(text = type.message)
        if (onAction != null && type.actionText != null) {
            Button(onClick = onAction) {
                Text(type.actionText)
            }
        }
    }
}
```

## Putting Team Standards into Practice

However well the architecture is designed, it means little if the team doesn't follow it. I standardized the state handling as template code and put it in the project wiki.

Three mandatory rules:

1. For every data-driven page, the type of the `StateFlow` exposed by the ViewModel must be `PageState` or a composite type of it.
2. UI layers (Activity/Fragment/Composable) are not allowed to access repositories directly or initiate network requests.
3. Every module must cover Loading, Empty, and Error UI states. Missing any state fails code review.

Code review checklist, no need to check from memory:

- [ ] Does the Loading state use a skeleton screen instead of an empty spinner?
- [ ] Does the Error state have a retry button (recoverable errors) or business copy (business errors)?
- [ ] Does the Empty copy fit the business scenario instead of being a generic placeholder?
- [ ] Do module errors degrade independently without affecting each other?

The resistance to rolling this out was surprisingly small. Everyone had already stumbled through state handling pitfalls on their own pages, and when they saw the standardized solution they thought it should have been done long ago.

---

The biggest change this architecture brought was not that the code became more "elegant", but that locating production issues got faster. Previously, when a user reported "the page won't open", we had to check APIs one by one. Now each module's state is reported independently. Searching the log platform for `module=banner state=error` pinpoints the exact problem.

I recommend a three-step approach: first, enforce `PageState` in new pages and verify whether the template is sufficient over two iterations; then migrate old pages one by one during refactoring; finally, formalize the team standards in the wiki. Pushing a full global standard in one shot meets too much resistance — people are always attached to what they have written. Let the results speak first.
