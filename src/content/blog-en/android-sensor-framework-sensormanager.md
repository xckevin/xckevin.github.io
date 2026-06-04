---
title: "Inside the Android Sensor Framework: From SensorManager API to Sensor HAL"
lang: en
translationKey: android-sensor-framework-sensormanager
slug: android-sensor-framework-sensormanager
excerpt: "A full-stack look at Android sensors, covering SensorManager, SensorService scheduling, BitTube delivery, virtual sensor fusion, batching, and power tuning."
publishDate: '2025-09-12'
tags:
- "Android"
- "Sensor HAL"
- "System Framework"
- "Performance Optimization"
seo:
  title: "Android Sensor Framework: SensorManager, SensorService, and Sensor HAL"
  description: "Trace Android sensor data from SensorManager through SensorService and HAL, including BitTube, EKF fusion, batching, wake-up sensors, and power tuning."
  pageType: article
---

While building a step counter SDK, I ran into a tricky issue: the step sensor worked correctly in the foreground, but stopped reporting data five minutes after the app moved to the background. The root cause turned out to be two system services competing for the same physical sensor, while our understanding of the Android Sensor framework stopped at `registerListener`.

From an API call to a hardware interrupt, sensor data travels through a longer path than it first appears. This article follows that call stack from top to bottom.

## What SensorManager wraps

Most developers first meet Android sensors through code like this:

```kotlin
val sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
sensorManager.registerListener(listener, accelerometer, SensorManager.SENSOR_DELAY_GAME)
```

The object returned by `getSystemService` is actually `SystemSensorManager`. During construction it obtains the Binder proxy for the system `SensorManager` service. `registerListener` itself is not complicated: it packages the arguments and sends them across process boundaries to `SensorService`. Two details, however, cause a lot of production bugs.

The callback thread is chosen by the caller. `registerListener` has an overload that accepts a `Handler`; if you do not pass one, callbacks run on the main thread. Handling high-frequency data on the main thread, such as a 50 Hz gyroscope stream in a game, can directly cause frame drops. In real projects I usually create a dedicated `HandlerThread`:

```kotlin
val sensorThread = HandlerThread("SensorThread", Process.THREAD_PRIORITY_URGENT_DISPLAY)
sensorThread.start()
val handler = Handler(sensorThread.looper)
sensorManager.registerListener(listener, gyroscope, 10000, handler)
```

The sampling period is only a recommendation, not a strict contract. Constants such as `SENSOR_DELAY_GAME` (20000 us) and `SENSOR_DELAY_UI` (66667 us) are eventually converted into microsecond parameters and passed downward, but the hardware may not support that exact rate. The system chooses a supported rate that is no faster than requested. If your algorithm needs strict time alignment, you must interpolate with `SensorEvent.timestamp` inside the callback instead of assuming evenly spaced samples.

## SensorService as the central scheduler

`SensorService` is a C++ service running inside the `system_server` process. Its core responsibilities are managing client connections, scheduling sensor hardware, and dispatching data.

Each client that registers a listener corresponds to a `SensorEventConnection` object. Inside that object is a key IPC channel: **BitTube**. It is not a Binder call. It is a pair of Unix domain sockets, implemented with `socketpair`, designed for high-frequency sensor events. Binder is used only for control commands such as register, unregister, and parameter updates. Sensor data flows through BitTube, avoiding the overhead of the Binder thread pool.

Sensor activation is reference counted. When the first client registers, `SensorService` calls HAL `activate(handle, 1)` to enable the sensor. When the last client unregisters, it calls `activate(handle, 0)` to disable it. This was the root cause of the issue above: a third-party SDK held a sensor reference, and our registration effectively became secondary.

Data dispatch uses a broadcast model. In `SensorService::onSensorEvent`, every client connected to that sensor receives a copy of the event. There is no priority queue; clients receive events in registration order under fair scheduling.

## HAL: sensors.h as the vendor contract

The Sensor HAL interface is defined in `hardware/libhardware/include/hardware/sensors.h`. The core type is `sensors_poll_device_t`, which exposes five important methods:

| Method | Purpose |
|------|------|
| `activate(sensor_handle, enabled)` | Enable or disable a specific sensor |
| `setDelay(sensor_handle, sampling_period_ns)` | Set the sampling period |
| `poll(events, max_count)` | Block and read sensor events |
| `batch(sensor_handle, sampling_period_ns, max_report_latency_ns)` | Configure batching parameters |
| `flush(sensor_handle)` | Immediately flush all data in the FIFO |

Above the HAL, the `SensorDevice` class manages this interface. It starts a thread that repeatedly blocks on `poll()`, then writes received events back to `SensorService` through BitTube. The simplified logic looks like this:

```cpp
// Pseudocode for the SensorDevice read thread
while (!mStop) {
    sensors_event_t buffer[16];
    int n = mHalDevice->poll(mHalDevice, buffer, 16);
    for (int i = 0; i < n; i++) {
        // Write to the SensorEventConnection BitTube
        sendToConnections(buffer[i]);
    }
}
```

The return timing of `poll` is driven by hardware interrupts. An accelerometer may trigger an interrupt on every sample, while a temperature sensor may trigger only every few seconds. `poll` blocks while waiting, so the `SensorDevice` thread sleeps most of the time and does not burn CPU.

## Sensor fusion: how virtual sensors are computed

Android's `TYPE_ROTATION_VECTOR` has no matching physical sensor. It is a **virtual sensor** computed by fusing data from the accelerometer, gyroscope, and magnetometer.

Fusion logic lives inside `SensorService` and does not depend on the HAL. The implementation is in `Fusion.cpp`, built on an extended Kalman filter (EKF) with Android-specific engineering simplifications:

1. Gyroscope integration provides pose prediction.
2. The accelerometer provides a gravity reference to correct pitch and roll.
3. The magnetometer provides a horizontal reference to correct yaw.

The three physical sensors have their own sampling periods, but the fused output needs a unified frequency. `SensorService` handles this by running a fusion update whenever data arrives from any underlying sensor. The output rate is approximately the rate of the fastest sensor. This does not guarantee strict timestamp alignment across all three inputs. If one sensor drops data, such as a magnetometer that gets downsampled, rotation vector accuracy falls noticeably. In production I usually check `SensorEvent.values[4]`, the estimated accuracy, and fall back to a gyroscope-only path when it exceeds 0.1 radians.

## Batching and power: what batch() really controls

Starting with Android 4.4 KitKat, the HAL supports sensor batching. At the API level this is the `maxReportLatencyUs` parameter on `registerListener`, and it eventually maps to HAL `batch()`.

Batching means sensor hardware has a FIFO buffer. Samples accumulate in hardware first, then are reported together when enough data is available or the timeout expires. The benefit is not inside the sensor itself, but in the application processor (AP): the AP does not need to wake up on every sample interrupt, and context-switch overhead can be amortized across a batch.

```cpp
// Typical batch parameter meaning
batch(TYPE_ACCELEROMETER,
      20000,    // sampling_period_ns: 50 Hz sampling
      200000);  // max_report_latency_ns: report every 200 ms
// Result: sample at 50 Hz and report 10 events together every 200 ms
```

Setting `maxReportLatencyUs` to 0 does not necessarily disable batching. It only tells the HAL to report as soon as possible. Actual behavior depends on the hardware; some chipsets still have 5-10 ms of hardware buffering delay when latency is 0.

Another common source of confusion is **wake-up sensors versus non-wake-up sensors**. Events from wake-up sensors, such as `TYPE_SIGNIFICANT_MOTION`, can wake the AP, but they consume more power and require an extra interrupt path from the SoC to the AP in the HAL layer. Non-wake-up sensor data can only be read by the service while the AP is awake; data generated during sleep is simply lost.

Google's Activity Recognition API uses this kind of composite strategy underneath: a low-power significant motion sensor triggers wake-up, then a higher-precision accelerometer is enabled for concrete activity recognition.

## Debugging and optimization notes

A few lessons from production work:

**Sensor data not arriving? Check reference counts first.** `dumpsys sensorservice` shows each sensor's activation state and all registered package names. Sensor contention from other processes happens more often than most teams expect.

**Unstable latency? Inspect callback-thread blocking.** `SensorService` writes data through BitTube, but if your `HandlerThread` does expensive work, its message queue backs up and processing latency keeps growing. `SensorService` will not wait for you. When the FIFO fills up, old data is overwritten and lost.

**Accuracy too low? Use a fused sensor.** Computing tilt angle from the accelerometer alone can have an error around +/-5 degrees. `TYPE_GRAVITY`, also a virtual sensor, can stay within about +/-1 degree after fusion. Unless you are locked into a custom fusion algorithm, the system-provided result is usually the easier and safer choice.

**For power-sensitive flows, prefer hardware FIFO.** In the same step-counting pipeline, configuring `batch(100ms)` versus `batch(20ms)` can change phone power consumption by 2-3x. This parameter can be adjusted dynamically: increase latency while the user is still, and reduce it during motion to balance accuracy and battery life.
