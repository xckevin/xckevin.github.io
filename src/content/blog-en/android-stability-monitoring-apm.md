---
title: "Android Stability Monitoring: From Crash SDKs to APM Dashboards"
lang: en
translationKey: android-stability-monitoring-apm
slug: android-stability-monitoring-apm
excerpt: "A deep dive into Android production stability monitoring, including Java and native crash collection, ANR detection, reporting pipelines, stack clustering, and APM dashboards."
publishDate: '2025-12-23'
tags:
- "Android"
- "Crash Monitoring"
- "APM"
- "Performance Optimization"
- "Architecture"
seo:
  title: "Android Stability Monitoring from Crash SDKs to APM Dashboards"
  description: "Design an Android stability monitoring system with Java and native crash capture, ANR detection, buffered reporting, stack fingerprints, and APM dashboards."
  pageType: article
---

At the end of last year, our app's Google Play ANR rate suddenly jumped from 0.3% to 1.2%. It took the team three days to trace the issue to a third-party SDK doing main-thread file I/O on specific devices. After that incident, I decided to build a complete internal exception collection and monitoring system instead of relying entirely on delayed platform data.

## Core design of the exception collection SDK

Production exceptions fall into two categories: **Java-layer crashes** and **native-layer crashes**. They are captured through completely different mechanisms, but the SDK should manage both through one unified pipeline.

### Java crash interception

Java-layer interception is relatively straightforward. `UncaughtExceptionHandler` can catch all uncaught exceptions:

```java
public class CrashCollector implements UncaughtExceptionHandler {
    private final UncaughtExceptionHandler originalHandler;

    public CrashCollector() {
        this.originalHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    @Override
    public void uncaughtException(Thread t, Throwable e) {
        // Collect the current thread stack plus main-thread state
        String crashData = collectStackTrace(e) 
            + collectMainThreadState();
        // Write to file instead of memory to avoid losing data after a secondary crash
        persistToFile(crashData);
        // Hand control back to the system default handler
        originalHandler.uncaughtException(t, e);
    }
}
```

The SDK's own `UncaughtExceptionHandler` must save the original handler and call it at the end. If this detail is missed, the SDK swallows the exception. From the user's perspective, the app simply exits without anything visible happening, and the system ANR or crash statistics never record it. Monitoring coverage is broken.

### Native crash capture

For native crashes, I use Google's **Breakpad**. It generates minidump files on the client. The file size is controlled, and cross-platform compatibility is good. Registration goes through a `signal handler`:

```cpp
#include <client/linux/handler/exception_handler.h>

static bool dumpCallback(const MinidumpDescriptor& descriptor,
                         void* context, bool succeeded) {
    if (succeeded) {
        // Write the minidump path into a queue for the Java layer to read and upload later
        enqueuePendingDump(descriptor.path());
    }
    return succeeded;
}

MinidumpDescriptor descriptor("/data/data/com.yourapp/files/dumps");
ExceptionHandler eh(descriptor, nullptr, dumpCallback, nullptr, true, -1);
```

The core rule is simple: after capturing a native crash, do not do any time-consuming work inside the signal handler. The signal handler runs in the crashing thread's context. Any `malloc` or file I/O may trigger a secondary crash if the heap is already corrupted. Enqueue the file path and return immediately; leave the rest to a background thread.

### Dual-channel ANR detection

There is no standard API for ANR monitoring. The most common approach is **main-thread Looper instrumentation**: record timestamps before and after each message dispatch.

```java
Looper.getMainLooper().setMessageLogging(new Printer() {
    private long startTime = 0;
    
    @Override
    public void println(String x) {
        if (x.startsWith(">>>>> Dispatching")) {
            startTime = SystemClock.uptimeMillis();
        } else if (x.startsWith("<<<<< Finished")) {
            long duration = SystemClock.uptimeMillis() - startTime;
            if (duration > THRESHOLD_MS) {
                reportAnr(duration, collectMainThreadStack());
            }
        }
    }
});
```

This only detects cases where the main thread is blocked beyond the threshold, while system ANR conditions also include broadcast timeouts, service timeouts, and other cases. In production, I use a **dual-channel strategy**: main-thread Looper instrumentation as the real-time detection layer, plus periodic collection of `/data/anr/traces.txt` as a fallback confirmation layer. On Android 5.0 and later, `ActivityManager.getProcessesInErrorState()` can also be used. Cross-validating both channels lowers false positives by an order of magnitude.

## Reporting architecture

Collection is only the first step. The reliability of the reporting path determines monitoring quality.

I designed a **three-level buffered reporting model**:

```java
// Memory buffer -> disk file -> network upload
class ReportPipeline {
    private final BlockingQueue<ReportData> memoryQueue;
    private final File diskCache;
    
    public void schedule() {
        // 1. Write high-frequency events to the memory queue to avoid blocking on disk I/O
        // 2. Flush batches to disk every 30 seconds
        // 3. Read from disk and upload when the network is available
    }
}
```

**Data compression is mandatory**. A complete ANR trace can exceed 200 KB. Uploading it directly wastes user traffic and increases timeout risk. GZIP compression before upload usually reaches a compression ratio above 85%.

For the reporting protocol, I chose HTTPS plus Protobuf instead of a custom TCP long connection. The reasoning:

- Most apps already have an HTTPS path, so the SDK can reuse the existing OkHttp instance with no additional connection cost
- Protobuf payloads are usually about 60% smaller than JSON, which matters for exception data with large amounts of stack text
- Long connections have high maintenance cost; reconnect and retry logic becomes complex during mobile network switches, and the ROI is poor

## Exception clustering in the APM dashboard

If the server only counts events, the system is not very useful. The real value comes from **exception clustering and version attribution**.

My clustering strategy is based on a **stack fingerprint**. I concatenate the top three method signatures in the crash stack and hash them with SHA-256. Exceptions with the same fingerprint are grouped together:

```python
def calc_fingerprint(stacktrace):
    lines = stacktrace.strip().split('\n')
    # Take the top three stack frames, which usually contain the crash point
    top_frames = [l.strip() for l in lines[:3] 
                  if l.strip() and 'at ' in l]
    signature = '|'.join(top_frames)
    return hashlib.sha256(signature.encode()).hexdigest()[:16]
```

This looks blunt, but its accuracy in production is quite high. The main blind spot is that similar obfuscated exceptions can be mapped to different fingerprints. The server needs to deobfuscate stacks with mapping files and run clustering again.

For dashboard design, the most important feature is not visual polish. It is **comparison**: filtering by app version, device model, and OS version. A typical investigation path is: notice an ANR rate spike, switch to the new-exceptions tab, compare against the previous version, identify a fingerprint that first appeared in the new release, drill into specific device models, and then investigate compatibility issues.

## Pitfalls from production

This system has been running for more than six months, and both stability and coverage are in line with expectations. Three pitfalls are worth recording.

**First: file permissions and SELinux**. After Android 10, reading `/data/anr/traces.txt` requires root or a system signature. A normal app cannot read it. You can use `ACCESSIBILITY_SERVICE` or request the `READ_LOGS` permission, which must be granted through ADB, but neither option is ideal. I eventually used the `DropBoxManager` API to collect system-level exception records when the user actively triggers feedback, and treat that as an auxiliary data source.

**Second: reporting conflicts in multi-process apps**. If the app has multiple processes and each process starts the SDK, crash data files must be named with process isolation. Otherwise, file-lock contention can directly cause data loss.

**Third: exception collection can cause exceptions itself**. If a native crash handler touches a corrupted data structure, the process can immediately receive `SIGABRT`. During SDK initialization, I preallocate buffers and make the exception-handling path read-only to avoid risks from failed `malloc` calls.

## Three metrics for judging the system

For production monitoring, do not try to measure everything at once. I focus on three core metrics:

- **Capture coverage**: SDK-intercepted exceptions divided by SDK-intercepted exceptions plus missed exceptions reported by users across channels. Target: above 95%.
- **Upload success rate**: due to network conditions and timing, such as the app about to exit, first-attempt upload rarely reaches 100%. My baseline is at least one successful upload within 72 hours.
- **Clustering convergence**: the share of total events covered by the top three exception fingerprints. The higher this value is, the more concentrated production issues are, and the better the fix ROI.

Once these three metrics are working, the online stability monitoring system is genuinely in place. All other improvements require continuous refinement as the product evolves. There is no silver bullet.
