---
title: 'Android Geofence End to End: Registration, Triggering, and Doze Failures'
lang: en
translationKey: android-geofence-doze-troubleshooting
slug: android-geofence-doze-troubleshooting
excerpt: 'A full walkthrough of Android geofences from registration to triggering: PendingIntent callbacks, fused location, and how Doze power-saving causes trigger failures—with power optimization practices.'
publishDate: '2026-08-31'
tags:
- Android
- Geofence
- FusedLocation
- Doze
- Performance
seo:
  title: 'Android Geofence: From Registration to Doze Trigger Failures'
  description: 'Android geofences end to end: PendingIntent callbacks, fused location, hardware vs software fences, why Doze delays triggers, and power-saving practices.'
  pageType: article
---

I hit a pitfall while building a location reminder feature: with the test device sitting on the desk and simulating an exit from the geofence, the app wouldn't receive a callback for a long time—sometimes minutes. After troubleshooting, the problem wasn't in the code but in how the geofence trigger pipeline and Doze power-saving interact. This article walks through the entire geofence path from registration to triggering.

## What a Geofence Really Is: Subscribing to Events, Not Polling

A geofence solves the problem of "notify the app when the device enters, exits, or dwells within a circular area." It is fundamentally different from continuous location updates: with location updates the app actively asks the system for location, while with a geofence the app subscribes to events and the system reports back at the right time. This is exactly why geofences save power—most of the time no positioning happens; you're notified only at the moment the boundary is crossed.

On Android you use it through `GeofencingClient`, a high-level wrapper provided by Google Play Services:

```kotlin
val geofencingClient = LocationServices.getGeofencingClient(context)
val geofence = Geofence.Builder()
    .setRequestId("office")
    .setCircularRegion(31.23, 121.47, 200f)
    .setExpirationDuration(Geofence.NEVER_EXPIRE)
    .setTransitionTypes(
        Geofence.GEOFENCE_TRANSITION_ENTER or
        Geofence.GEOFENCE_TRANSITION_EXIT
    )
    .setNotificationResponsiveness(5 * 60 * 1000)
    .build()
```

After a geofence is registered, the system can kill the app process; the Play Services process is responsible for monitoring. This is the biggest advantage geofences have over rolling your own polling: power efficiency and reliability.

## The Registration Path: PendingIntent Is the Callback Channel

There is only one channel for geofence callbacks: `PendingIntent`. The difference is where you point that Intent—a BroadcastReceiver, an Activity, or a Service. I usually use `getBroadcast` with a Receiver: a Receiver has no UI and a short lifecycle, making it a good event entry point, and the system can start it even after the app process is killed. Activity and Service, on the other hand, are subject to background-start restrictions, so they're not worth it.

```kotlin
val intent = Intent(context, GeofenceReceiver::class.java)
val pendingIntent = PendingIntent.getBroadcast(
    context, 0, intent,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
)

geofencingClient.addGeofences(
    GeofencingRequest.Builder()
        .addGeofence(geofence)
        .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
        .build(),
    pendingIntent
).addOnSuccessListener { /* 注册成功 */ }
```

`setInitialTrigger` determines whether ENTER fires immediately at registration if the device is already inside the geofence; by default it does not. `setNotificationResponsiveness` sets the notification responsiveness threshold (in milliseconds) for geofence events: it tells the system "this is how much notification delay I can accept after an event." The larger the value, the more the system tends to batch location updates and delay reporting, saving power. A value of 0 means report as soon as possible, but that only shortens the delay between "the crossing has been detected" and "notifying the app"—it does not keep GPS always on or force the system into continuous location mode. Which positioning source the system samples from is still determined by the system based on factors such as geofence radius and device capabilities.

## The Trigger Mechanism: Fused Location Does the Work Behind the Scenes

Under the hood, geofences are implemented with the Fused Location Provider. Play Services fuses GPS, Wi-Fi, cell towers, and sensors, switching dynamically by scenario.

Geofence evaluation has two paths:

- **Hardware Geofence**: supported by some chips (Qualcomm, Samsung, etc.), where location computation is done in the baseband or a coprocessor, allowing the AP to sleep—lowest power consumption.
- **Software Geofence**: Play Services periodically gets location fixes and computes boundary crossings in-process—higher power consumption.

Developers can't specify which path is used; the system chooses automatically, and this choice isn't locked in once, nor is it a static mapping of "fixed radius to fixed positioning source." Fused location dynamically adjusts the positioning source based on the geofence radius, desired latency, and the device's current state—the same geofence may be evaluated using different positioning methods at different times. In general, the smaller the radius (meaning higher accuracy requirements), the more likely the system is to lean on GPS; the looser the responsiveness threshold set by `setNotificationResponsiveness`, the more room the system has to use low-power positioning sources; and whether the device supports hardware geofences also affects the final path.

A common misconception: registering a geofence does not mean GPS is always on. The system dynamically balances geofence size against desired latency, preferring low-power Wi-Fi/cell positioning first, and only waking GPS when the accuracy isn't enough for evaluation.

## Doze Mode: Why Geofences "Stop Working"

Android 6.0 introduced Doze mode: after the device is stationary with the screen off for a while, the system defers network access, JobScheduler, Alarms, and so on. This directly affects geofence triggering.

**Geofence event delivery (the PendingIntent starting the app) has some exemption under Doze, but what's exempted is the "notification," not the "computation."** What is really affected is the positioning stage before the trigger—this needs to be stated carefully. The following is a reasonable inference based on Doze's overall throttling of network access and location updates, not an official clause-by-clause explanation specific to geofences:

- Under Doze the system throttles background location updates such as Wi-Fi scans and network positioning, so the observable location update frequency from fused location may drop.
- When the device is stationary for a long time, the system has less evidence to judge whether movement has occurred, so geofence evaluation may rely on relatively stale location data.
- Once the app enters App Standby, its background capabilities are further restricted, which may also indirectly affect geofence callback latency.

So a common cause of "exiting the geofence but not triggering for a long time" is: Doze reduces location update frequency, and the system can't quickly get a new location that clearly determines an EXIT. My verification at the time was straightforward: plug the charger into the test device (exiting Doze), and callbacks returned to normal. That can serve as evidence that the power-saving policy affects trigger latency, but it doesn't mean Doze is the only root cause of all geofence delay problems.

## Practices for Balancing Power and Reliability

Geofences are the background fallback in the location services loop, but over-relying on them causes power problems. A few practical suggestions:

**1. Make the radius as large as possible.** The geofence radius is the basis for the system's choice of positioning source. Above 200 meters, Wi-Fi/cell is enough; under 50 meters you basically need GPS. If the business can use 300 meters, don't use 50.

**2. Set `setNotificationResponsiveness` to the maximum you can accept.** If the business tolerates a 10-minute delay, pass `10 * 60 * 1000`; as long as that threshold is met, the system has more room to lower sampling frequency and batch processing. Setting it to 0 means demanding prompt notification, which squeezes the system's scheduling headroom and indirectly raises power consumption—but the exact magnitude varies by device and scenario, with no fixed multiplier.

**3. Avoid DWELL.** DWELL requires continuously determining whether the device remains stationary inside the area, which puts far more sampling pressure on the system than ENTER/EXIT. If ENTER+EXIT can solve the scenario, don't add DWELL.

**4. Give geofences an expiration.** For one-shot reminders, use `setExpirationDuration` so they're removed automatically and don't leave behind orphan geofences that drain power forever.

**5. Downgrade based on foreground state.** When the app is in the foreground, use `requestLocationUpdates` yourself for precise evaluation, and let geofences only serve as the background fallback—this takes care of both foreground experience and background power.

A typical self-defeating configuration I've seen in real projects: a 30-meter reminder radius combined with `setNotificationResponsiveness` set to 0—the two together clearly squeeze the system's scheduling and power-saving headroom. The actual power impact varies widely by device, system version, and usage scenario, and there's no uniform quantitative data, so I won't give specific battery-drain numbers here. The premise of geofence power savings is leaving the system enough room to make trade-offs.

The value of geofences is that "the system watches your location for you and wakes you when necessary"—it is not a replacement for real-time location. Understanding Doze's impact on location sampling solves more problems than memorizing API parameters.
