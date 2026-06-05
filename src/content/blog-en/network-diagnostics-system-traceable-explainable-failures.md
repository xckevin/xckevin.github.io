---
title: "Designing a Mobile Network Diagnostics System"
lang: en
translationKey: network-diagnostics-system-traceable-explainable-failures
slug: network-diagnostics-system-traceable-explainable-failures
excerpt: "The hardest part of mobile network failures is reconstructing what happened afterward. This article breaks down a practical diagnostics system: layered attribution, request-context capture, task orchestration, readable reports, privacy, and performance control."
publishDate: '2026-06-04'
tags:
- "Android"
- "Network Diagnostics"
- "Stability"
- "Architecture"
- "Observability"
seo:
  title: "Mobile Network Diagnostics System Design"
  description: "Design a mobile network diagnostics system with layered checks, request context, task orchestration, readable reports, privacy, and cost control."
  pageType: article
---

When troubleshooting client-side network issues, the hardest part is often reconstructing what happened. Users report "failed to load" or "images aren't showing," but logs may contain only an exception type and an error code. The real cause might sit in DNS resolution, TCP connection setup, TLS handshake, HTTP response handling, business status-code interpretation, or caching strategy. Client logs, server logs, and manual reproduction all help, but each has limits: log fields are inconsistent, user environments are hard to reproduce, servers cannot see requests that never arrived, and packet capture is costly and privacy-sensitive.

In our project, network diagnostics are infrastructure, not a standalone page. They are embedded across error pages, routing, debugging tools, and the network layer. The error page does more than show a retry button; it can trigger diagnostics through a hidden multi-tap entry point. Combined with multi-domain configuration and interceptors for tokens, error codes, and logs, diagnostics can cover DNS, connection setup, TLS, API responses, business error codes, and the active site environment. The result is not just "ping this domain"; it tells us which API or image domain was selected, whether the request was rewritten by a dynamic `BaseUrl`, and whether the error came from TLS, caching, rate limiting, or another layer.

## Unified Event Model: Normalizing Network Behavior Across Entry Points

The foundation of network diagnostics is not a probing tool, but an event model. An image library has its own loading mechanism, a WebView has its own resource fetching, and a download module might maintain an entirely separate connection logic. If every component records failures using its own method, the diagnostic information becomes fragmented.

A unified `NetworkEvent` can record `traceId`, `scene`, `resourceType`, `sanitizedHost`, `method`, `startTime`, `duration`, `networkType`, `cacheState`, `retryCount`, `phase`, `errorCategory`, and `httpStatus`. Note the use of `sanitizedHost` instead of the full URL; query parameters and paths might contain business identifiers, which are default-trimmed or hashed:

```kotlin
data class NetworkEvent(
    val traceId: String,
    val scene: String,
    val resourceType: String,
    val hostAlias: String,
    val method: String,
    val startAt: Long,
    val durationMs: Long,
    val networkType: String,
    val cacheState: String,
    val phase: String,
    val errorCategory: String?,
    val httpStatus: Int?
)
```

The purpose of this event model is to place "API request failure," "image loading failure," and "file download failure" on the same observable graph. For instance, when an image fails to load, we can also record the DNS, connection, and response status. When an API fails, we can record whether it hit the cache or if it used stale data.

## Decomposing Failure Causes by Stage

The diagnostic system should break down failure causes into multiple stages, rather than relying solely on exception class names:

- **Network Availability Stage**: Check if the system has available network connectivity or if it's in airplane or restricted mode.
- **Resolution Stage**: Check for successful DNS resolution, abnormal resolution time, or the presence of local resolution cache.
- **Connection Stage**: Check if the TCP connection was established, connection duration, or if failures were frequent.
- **Security Stage**: Check TLS handshake, certificate chain, system time anomalies, or protocol version compatibility.
- **Response Stage**: Check HTTP status codes, time to first byte, content length, or read interruptions.
- **Business Interpretation Stage**: Check if the response can be parsed, if the business status code indicates failure, or if a login state refresh was triggered.
- **Caching Stage**: Check if the cache was hit, if the cache expired, or if the cache strategy caused the user to see old data.

This layered approach makes the diagnostic report resemble a comprehensive checklist. Even if the root cause cannot be pinpointed with 100% certainty, the scope can be significantly narrowed down.

## Diagnosis Orchestrator: Selecting Probing Strategies by Scenario

Diagnostic tasks should not be called directly by a page using a collection of utility functions. Instead, an orchestrator should determine which tasks to execute based on the scenario and failure type. For example, a "no network error" only requires checking the system network and local proxy; a "DNS failure" can add resolution probing; and a "5xx error" should prioritize outputting the `traceId` for server-side lookup, rather than having the client repeat connection probing.

```kotlin
class DiagnosisOrchestrator(
    private val tasks: List<DiagnosisTask>
) {
    fun diagnose(event: NetworkEvent): DiagnosisReport {
        val context = DiagnosisContext.from(event)
        val selectedTasks = chooseTasks(event)
        val findings = selectedTasks.map { task ->
            runWithTimeout(task.timeoutMs) { task.run(context) }
        }
        return DiagnosisReportBuilder.build(event, findings)
    }

    private fun chooseTasks(event: NetworkEvent): List<DiagnosisTask> {
        return when (event.errorCategory) {
            "NO_NETWORK" -> tasks.filterByName("NetworkState")
            "DNS_ERROR" -> tasks.filterByName("NetworkState", "DnsProbe")
            "TIMEOUT" -> tasks.filterByName("NetworkState", "RouteProbe", "RecentEvents")
            else -> tasks.filterByName("RecentEvents")
        }
    }
}
```

## Report Output Tailored to Different Roles

The same diagnostic data can be presented in different ways. For the end-user, only clear recommendations are needed, such as "Network unavailable; please switch networks and retry." For support staff, the device environment, App version, diagnostic time, error category, and a brief suggestion are required. For developers, the `traceId`, stage timings, request context, cache state, sampled logs, and sanitized stack trace are necessary.

The report structure should ideally be fixed: Conclusion, Scope of Impact, Key Evidence, Suggested Actions, and Raw Diagnostic Summary. A fixed structure helps build a knowledge base and facilitates later integration with automated root cause analysis.

## Privacy Protection First

Do not perform data masking only before upload. It is best to only retain safe fields when the event is generated. Request headers, request bodies, and response bodies should not enter the diagnostic event by default. The diagnostic report must not contain sensitive information such as full tokens, cookies, user phone numbers, internal domains, or business record numbers. Even technical logs must be masked by default, and only the minimum set of data required for problem localization should be collected.

Another critical point: diagnostics must not retry indefinitely. If the network is already abnormal, initiating excessive probing can degrade the user experience further. Every diagnostic task must have an independent timeout, the overall orchestration must have a total timeout, and cancellation must be supported. It is also crucial to distinguish between failure and cancellation—cancellation due to the user leaving the page, the request being overwritten by a new one, or the lifecycle ending should not be treated as a network failure.

---

The core of a network diagnostics system is not running more probes; it is making failures describable, linkable, and explainable. The three most important pieces are a unified event model, layered attribution, and low-intrusion integration. The event model solves inconsistent data definitions, layered attribution answers "where did it fail?", and low-intrusion integration allows the system to cover more request paths. For large client applications, building this infrastructure early makes complex network environments and multi-module collaboration much easier to handle.
