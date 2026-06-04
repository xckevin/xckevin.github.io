---
title: "Android Perfetto End to End: ftrace, TrackEvent, and Production Monitoring"
lang: en
translationKey: android-perfetto-ftrace-trackevent
slug: android-perfetto-ftrace-trackevent
excerpt: "A deep dive into Android Perfetto, from the traced and traced_probes daemon architecture to kernel ftrace sources, shared ring buffers, SDK TrackEvent instrumentation, and production observability."
publishDate: '2026-05-09'
tags:
- "Android"
- "Performance Optimization"
- "Perfetto"
- "System Debugging"
- "Architecture"
seo:
  title: "Android Perfetto: ftrace, TrackEvent, and Production Monitoring"
  description: "Learn how Android Perfetto connects kernel ftrace, shared ring buffers, SDK TrackEvent instrumentation, and production performance monitoring."
  pageType: article
---

After Android Studio Meerkat made Perfetto the default Profiler backend, it stopped asking whether you wanted Systrace or the CPU Profiler. Android 16 also expanded several data sources, so kernel-side irq, binder, and workqueue events can now line up directly with app-level trace points on the same timeline. That means one decision has already taken shape: **Perfetto is no longer a replacement for Systrace. It is the unified foundation for Android performance observability.**

After migrating all of a project's custom instrumentation from Systrace's `Trace.beginSection` to the Perfetto SDK, I found that understanding Perfetto's service architecture and serialization model mattered far more than memorizing the API. The rest of this article looks at three dimensions of that system.

## traced + traced_probes: why Perfetto uses two daemons

Perfetto's server side is made of two daemons: `traced`, the central router, and `traced_probes`, the data-source driver. Their process boundary is not arbitrary. It comes from the sandboxing model.

`traced` runs in a process with `CAP_SYS_ADMIN` privileges and is responsible for:

- Managing the lifecycle of every trace session
- Receiving streams from data sources and serializing them into trace files
- Exposing Unix sockets to CLI and SDK clients

`traced_probes` runs in a sandbox with a minimal privilege set. It is dedicated to driving system-level data sources such as ftrace, `/proc` polling, and logcat injection. It pushes data to `traced` through shared memory, specifically the Shared Ring Buffer or SRB, and does not touch the file system itself.

```bash
# Inspect the current trace sessions
adb shell perfetto --query | head -20
# The traced_probes isolation is visible in init.rc
adb shell cat /system/etc/init/perfetto.rc
```

The engineering value of this two-process design is clear: **even if `traced_probes` crashes because of a kernel-interface failure, data already written into the `traced` buffer is not lost, and the trace file can still be flushed normally.** In one production stress test, this mechanism preserved the full 30 seconds of trace data before a crash. The older single-process Systrace architecture could not provide that.

New Android 16 data sources such as `android.surfaceflinger.layers` and `android.vsync` follow the same sandbox model. A data source only needs to register with the unified plugin interface in `traced_probes` to get process isolation and lifecycle management.

## protozero: why zero-copy serialization is fast

Perfetto encodes everything with protobuf: trace configurations, data packets, and the final file format. But the standard protobuf library's allocation strategy becomes a bottleneck when tens of thousands of trace events are written every second. Perfetto built its own tool for this: **protozero**.

The core idea behind protozero is to build protobuf binary data directly on top of contiguous SRB memory blocks. That removes the intermediate object allocation and copy:

```cpp
// protozero write flow, simplified from traced_probes
protozero::HeapBuffered<protozero::Message> msg;
// Append fields directly on SRB-mapped memory without allocating temporary objects
msg->AppendString(1, event_name);
msg->AppendVarInt(2, timestamp_ns);
// Finalize only aligns memory once; it does not copy
auto slice = msg.SerializeAsSlice();
```

The standard protobuf path is different: construct a C++ object, fill its fields, call `SerializeToString()` to copy into a string, and then write that string into the target buffer. That adds one allocation and one copy.

In high-frequency event scenarios, such as writing 20 custom TrackEvent points per frame at 60 fps, the difference compounds quickly. In my measurements on a Pixel 8, writing 5,000 events per second with protozero used about 40% less CPU time than libprotobuf. The advantage is even more visible on lower-end devices, where memory bandwidth is already a bottleneck.

protozero also has an easy-to-miss feature: chunked writes. Trace files can be flushed to disk in chunks. Even a long 10 GB trace does not need 10 GB of contiguous memory; each chunk is written and recycled once it fills, keeping memory usage stable at a near-constant level.

## SDK TrackEvent: from beginSection to structured instrumentation

In the Systrace era, `Trace.beginSection("loadData")` had only two capabilities: a name string and start/end timing. The Perfetto SDK's `TrackEvent` turns instrumentation into **time-series events with structured data**.

```kotlin
// Perfetto SDK instrumentation example
class DataRepository {
    fun loadUserProfile(userId: String) {
        val trackEvent = TrackEvent.newBuilder()
            .setName { it.addString("loadUserProfile") }
            .setCustomDimension { dims ->
                dims.addIntDimension("user_id", userId.hashCode())
            }
        
        PerfettoSdk.trace(trackEvent.build()) {
            // Code inside the trace block is timed
            val result = apiService.fetchProfile(userId)
            PerfettoSdk.addCounter("cache_hit_rate", cacheMonitor.hitRate)
            result
        }
    }
}
```

In Perfetto UI, this appears as an independent track that contains:

- Function execution duration, timed automatically
- The custom dimension `user_id`, which can be used for grouped aggregation
- The `cache_hit_rate` counter samples, shown as a time-varying line

One migration pitfall is the reflection overhead of the TrackEvent Builder in debug builds. In release builds, protozero code generation happens at compile time, but debug builds use dynamic reflection to construct fields. With 20 or more instrumentation points per frame, that can add about 3-5 ms of extra cost. The fix is to force-retain the generated proto code in `proguard-rules.pro`, or use the simpler `PerfettoSdk.trace("name")` path during debugging.

## Two production engineering challenges

Perfetto was originally designed as a system debugging tool. Using it directly as an observability layer inside a production app requires solving two issues.

**Permissions and sandboxing.** `traced` needs `CAP_SYS_ADMIN` to control ftrace. Even when a normal app integrates the SDK, it can only write its own data source; it cannot trigger a system-level trace. That means the in-app SDK is only partially capable by default. It can write custom instrumentation, but it cannot see kernel scheduling.

A practical compromise is to have the production SDK write asynchronously into a local ring buffer and avoid sending `traced` requests by default. When a user hits a problem, customer support can issue a collection command from the server. Only then does the app-side SDK start a full trace session, limited to 30 seconds, with bounded overhead. Google's recommended SDK integration practices in Q4 2025 point in this direction.

**Data volume and privacy.** A full Perfetto trace includes scheduling events for all threads, binder call parameters, and even access patterns for some memory pages. Uploading it directly to a server creates privacy risk, while local manual analysis is not realistic at scale.

My practice is to add a preprocessing layer on the device. After the SDK finishes collection, the app parses the trace file into structured metrics such as p99 render time, top 10 binder calls, and the distribution of thread scheduling delays. Only aggregated data is uploaded. The raw trace file is kept locally for seven days only with user authorization. Perfetto's official `trace_processor` command-line tool can do this:

```bash
trace_processor_shell trace.perfetto-trace \
  --run-metrics android_cpu \
  --run-metrics android_frame_timeline_metric
```

## Toolkit

Perfetto is not a drop-in replacement for Systrace. It is a full-domain time-series database spanning the kernel and the app. In day-to-day development, these three tools are worth keeping close:

1. **`trace_processor` SQL queries**: a Perfetto trace file is effectively a SQLite database. `SELECT` is an order of magnitude faster than dragging through the UI, and it is well suited to scripted batch analysis of production issues.
2. **The SDK debug-mode switch**: keep the smallest useful instrumentation set in production, but enable the full TrackEvent set in debug builds. Combined with Android Studio Meerkat's Compose tracing support, this can locate recomposition hot paths directly.
3. **On-device preprocessing and aggregate uploads**: do not let phones upload raw traces directly. The Python and C++ APIs in `trace_processor` can downsample and extract metrics on the device, keeping privacy under control and bandwidth usage reasonable.

Android 16 pushes Perfetto into the system-capability layer. Android Studio Meerkat pushes it into the developer-tooling layer. The app-integration layer between them is the engineering space left for developers.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android performance optimization](/en/android-performance/)
- [Android cold-start optimization: Perfetto practice from Zygote fork to first frame](/blog/android-cold-start-zygote-systrace/)
- [Android app startup optimization: metrics, pipeline, tools, and governance](/blog/app-startup-optimization/)
- [RecyclerView caching internals: four-level cache, reuse, and prefetch](/blog/android-recyclerview-four-level-cache/)
- [Android Bitmap memory model: Java heap, native heap, and Hardware Bitmap](/blog/android-bitmap-oom/)
<!-- /seo-internal-links -->
