---
title: "Android Location Internals: LocationManager, Fused Provider, and GNSS HAL"
lang: en
translationKey: android-locationmanager-gnss-hal
slug: android-locationmanager-gnss-hal
excerpt: "A full-stack look at Android location, from LocationManager and the Fused Provider's Kalman filtering to GNSS HAL, NMEA parsing, AGPS, jump debugging, and power strategy."
publishDate: '2025-10-16'
tags:
- "Android"
- "GNSS"
- "Location System"
- "HAL"
- "System Architecture"
seo:
  title: "Android Location Internals: LocationManager, Fused Provider, and GNSS HAL"
  description: "Trace Android location from LocationManager calls to Fused Provider sensor fusion, GNSS HAL, NMEA parsing, AGPS, jump debugging, and power tradeoffs."
  pageType: article
---

Last year, while building a workout route recorder, I ran into a strange issue: the same running route looked smooth and continuous on a Xiaomi phone, while an ODM device produced frequent jumps and moved the pace from 5'30" to 3'20". The problem turned out to be the Fused Provider's fusion strategy. That device had no gyroscope, and the fusion engine's fallback path had a bug. That experience pushed me to revisit the full Android location stack.

## LocationManager: The Application-Layer Entry Point

For app developers, requesting location looks simple:

```kotlin
val locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
val request = LocationRequest.Builder(PRIORITY_HIGH_ACCURACY, 5000)
    .setMinUpdateDistanceMeters(10f)
    .build()

locationManager.requestLocationUpdates(
    PROVIDER_FUSED, request, executor, locationCallback
)
```

On the surface this is just one API call, but `LocationManager.requestLocationUpdates` travels through a long IPC path. It calls `LocationManagerService`, which runs inside the `system_server` process, through Binder.

`LocationManagerService` has three core responsibilities: permission checks, Provider routing, and callback management. It does not perform location calculation. The real location logic lives in the Provider layer. The key code path looks like this:

```java
// frameworks/base/services/core/java/com/android/server/LocationManagerService.java
private void requestLocationUpdatesLocked(LocationRequest request, 
        ILocationListener listener, String packageName) {
    // 1. Permission check.
    checkResolutionLevelIsSufficientForProviderUseLocked(..., providerName);
    // 2. Find or create a Receiver. Each listener maps to one Receiver.
    Receiver receiver = checkListenerOrIntentLocked(listener, ...);
    // 3. Forward the request to the matching LocationProvider.
    requestLocationUpdatesLocked(sanitizedRequest, receiver, packageName);
}
```

Provider selection is where the path really branches. Android supports three broad Provider types: **GPS Provider** for satellite-only positioning, **Network Provider** for cellular and Wi-Fi positioning, and **Fused Provider** for fused positioning. Most apps use the Fused Provider, which hides a complex fusion engine.

## Fused Location Provider: Fusion Engine Architecture

The Fused Provider is implemented by Google Play Services, with code under the `com.google.android.location` package in `gmscore`. Unlike GPS Provider, it does not read the HAL directly. Instead, it subscribes to multiple underlying Providers and fuses their outputs algorithmically to produce the best location.

The fusion engine has four input sources:

- **GNSS satellite positioning**: 3 to 10 meter accuracy, useful outdoors, high power consumption
- **Wi-Fi scan results**: 20 to 50 meter accuracy, useful indoors, dependent on Google's Wi-Fi fingerprint database
- **Cellular base station information**: 100 to 1000 meter accuracy, mostly a fallback
- **Sensor data**: accelerometer, gyroscope, and magnetometer for dead reckoning

The fusion flow is roughly:

```text
GNSS Fix  --+
WiFi Scan --+--> Kalman Filter --> output location + accuracy radius
Cell Info --+
Sensors   --+
```

The **Kalman Filter** is the core of the fusion engine. It maintains a state vector for position, velocity, and acceleration. Each new observation triggers two steps: predict, then update. GNSS data corrects absolute position, while accelerometer and gyroscope data fill gaps when GNSS signal is weak or blocked, such as in tunnels or under overpasses.

One trap I have hit: in `PRIORITY_HIGH_ACCURACY` mode, the Fused Provider keeps the GNSS chip active, consuming roughly 200 to 300 mW. If the app does not need sub-meter accuracy, `PRIORITY_BALANCED_POWER_ACCURACY`, with roughly 100 meter accuracy, disables GNSS and uses only Wi-Fi plus cellular data. Power consumption drops to roughly 20 to 50 mW.

## GNSS HAL: The Last Mile from Framework to Chip

When the Fused Provider decides to use satellite positioning, the call chain enters the HAL layer. Android defines the `IGnss.hal` interface, now represented through AIDL definitions in modern releases. Chip vendors such as Qualcomm, Broadcom, and MTK implement the corresponding HAL modules.

The path looks like this:

```text
LocationManagerService
  -> GnssLocationProvider (frameworks/base)
    -> IGnss.hal (HIDL/AIDL interface)
      -> gnss.qcom.so / gnss.mtk.so (vendor implementation)
        -> /dev/ttyHS0 (serial communication)
          -> GNSS chip firmware
```

GNSS Provider talks to the chip through UART or SPI. The transferred data is standard **NMEA-0183 sentences**. Here is a typical `$GPGGA` sentence for GPS fix data:

```text
$GPGGA,092750.000,3109.6452,N,12123.5264,E,1,12,1.0,48.5,M,,M,,*5E
```

After parsing, it represents UTC time 09:27:50, latitude 31 degrees 9.6452 minutes north, longitude 121 degrees 23.5264 minutes east, fix quality 1 for standalone positioning, 12 satellites in use, and altitude 48.5 meters.

The key HAL interface is:

```cpp
// hardware/interfaces/gnss/1.0/IGnss.hal
interface IGnss {
    // Inject AGPS assistance data to reduce time to first fix.
    injectLocation(Location location);
    // Delete all AGPS data.
    deleteAidingData(GnssAidingData aidingDataFlags);
    // Start navigation and provide callbacks for NMEA and location reports.
    start() generates (bool started);
    stop();
    // Set positioning mode and interval.
    setCallback(IGnssCallback callback);
};
```

In vendor HAL implementations, most code handles three things: **AGPS assistance** by downloading ephemeris data from the network, **NMEA parsing** by turning `$GPGGA`, `$GPRMC`, and similar sentences into Location objects, and **power strategy** by adjusting chip work cycles based on motion state.

TTFF, or Time To First Fix, is a common performance bottleneck. During a cold start, the chip has no ephemeris data and must scan signals from up to 32 satellites, which can take from 30 seconds to several minutes. AGPS downloads ephemeris data through the cellular network and can reduce TTFF to 3 to 10 seconds. One implementation detail matters: the `injectLocation` parameter must include the rough cell-tower location, otherwise the chip cannot calculate Doppler shift correctly.

## Full-Path Trace: Timing a Location Request

Use a concrete request to connect the full chain. After an app calls `requestLocationUpdates`:

1. **Binder IPC** to LocationManagerService: about 2 to 5 ms
2. **Fused Provider decision**: if a cached location exists and its age is under 10 seconds, return directly in about 1 ms
3. **GNSS startup**: if a cold start is needed, `start()` in the HAL to first NMEA output takes about 3 to 10 seconds with AGPS assistance
4. **Fusion computation**: each Kalman filter iteration after a GNSS fix takes about 0.5 to 1 ms
5. **Callback to app**: Binder callback plus main-thread hop takes about 3 to 8 ms

In real projects, the time from request to first valid location is usually about 5 to 15 seconds for a cold start. A hot start, with the chip already running, can take only 100 to 500 ms.

I once ran an A/B test in the same outdoor scene. Fused Provider produced much smoother tracks than pure GNSS Provider, especially when passing through partially blocked segments. Accelerometer data prevented the "drift then snap back" jump pattern. The cost was roughly 15% more battery consumption because sensors kept collecting data.

If you also run into location jumps, three areas are worth checking.

**Check Provider selection**: `PRIORITY_HIGH_ACCURACY` does not guarantee GNSS is available. Indoors, it may degrade to Wi-Fi positioning and accuracy can drop sharply. Print `location.provider` in `onLocationChanged` to confirm the actual source.

**Understand Fused Provider fallback logic**: when sensors are missing, such as a missing gyroscope, the fusion engine can degrade into pure weighted averaging of positions. Jumps are common during indoor-outdoor transitions. ODM sensor configuration differences are a frequent source of these bugs.

**Watch HAL-layer power strategy**: some vendors lower the GNSS chip fix frequency from 1 Hz to 0.1 Hz after the screen turns off, making workout tracks sparse. With `GnssNavigationMessage.Callback` on Android 7.0+, you can listen to satellite data quality directly and decide whether the issue is chip throttling or genuinely poor signal.
