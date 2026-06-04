---
title: "Android BLE End to End: GATT, Scanning, and Long-Lived Connections"
lang: en
translationKey: android-ble-gatt-scanning-long-connection
slug: android-ble-gatt-scanning-long-connection
excerpt: "A practical guide to Android BLE development, covering the GATT protocol stack, scan power tradeoffs, reconnection, Doze handling, and multi-device long-connection management."
publishDate: '2025-06-10'
tags:
- "Android"
- "BLE"
- "Kotlin"
- "Performance Optimization"
- "Long-Lived Connections"
seo:
  title: "Android BLE: GATT, Scanning, and Long-Lived Connections"
  description: "A practical Android BLE guide covering GATT layering, scan power control, reconnection, Doze handling, and multi-device compatibility."
  pageType: article
---

Last year, while working on a smart wearable device, I ran into a nasty issue: after the app had been running in the background for about 20 minutes, the BLE connection dropped. The device was still advertising normally, but the phone could not reconnect no matter what I tried. It took two days to narrow it down: both the scan strategy and the keepalive mechanism were missing one critical piece.

This article breaks down the parts of BLE development that actually hurt in production: GATT protocol layering, scan power control, and how to keep long-lived connections alive in Android's fragmented device ecosystem.

## The GATT stack: how data actually flows

The BLE stack has three layers from top to bottom: **application layer (GATT) -> logical link layer (ATT) -> physical/link layer (GAP)**. As an app developer you mostly work with GATT, but many problems originate in the lower two layers.

### Services and characteristics

Each BLE device uses **Service** objects as containers. Each Service contains multiple **Characteristic** objects. A Characteristic is the smallest unit of data exchange. It carries one value and a set of properties:

```java
// Start a GATT connection after discovering the device.
BluetoothGatt gatt = device.connectGatt(context, false, gattCallback);
// Callback after the connection succeeds.
public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
    if (newState == BluetoothProfile.STATE_CONNECTED) {
        gatt.discoverServices(); // This triggers service discovery.
    }
}
```

**`discoverServices()` runs the ATT-layer service discovery protocol.** It walks through every Service and Characteristic on the device. The call usually takes 500 ms to 2 seconds depending on the number of Services. I usually add a 1.5-second timeout guard before this step so a weak signal does not leave the connection stuck forever.

### Three modes for reads, writes, and notifications

GATT defines three data exchange modes:

- **Write / Read**: initiated by the central device, using a synchronous request-response model.
- **Notify**: pushed by the peripheral device after the central enables the CCCD (Client Characteristic Configuration Descriptor).
- **Indicate**: similar to Notify, but it requires an acknowledge from the central. It is roughly half as fast, but more reliable.

```java
public void onServicesDiscovered(BluetoothGatt gatt, int status) {
    BluetoothGattService service = gatt.getService(SERVICE_UUID);
    BluetoothGattCharacteristic characteristic = 
        service.getCharacteristic(CHAR_UUID);
    
    // Enable Notify by writing the CCCD descriptor.
    gatt.setCharacteristicNotification(characteristic, true);
    BluetoothGattDescriptor descriptor = 
        characteristic.getDescriptor(CCCD_UUID);
    descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
    gatt.writeDescriptor(descriptor);
}
```

One pitfall I have hit: **CCCD enablement must happen after `onServicesDiscovered`.** If you write the descriptor immediately inside `onConnectionStateChange`, you are very likely to get `GATT_WRITE_NOT_PERMITTED`. Service discovery has not finished yet, so the Characteristic handle is still invalid.

## Scan strategy: balancing discovery rate and power use

BLE scanning is power hungry. `BluetoothLeScanner` exposes parameters that control scan behavior, but the defaults are rarely the best production choice.

### Tradeoffs among the three scan modes

Android provides three scan modes. In practice, they differ by duty cycle:

| Mode | Duty cycle | Power use | Best fit |
|------|------------|-----------|----------|
| SCAN_MODE_LOW_POWER | ~0.5% | Low | Continuous background listening |
| SCAN_MODE_BALANCED | ~2% | Medium | Normal foreground scanning |
| SCAN_MODE_LOW_LATENCY | ~100% | High | Fast device discovery |

The **duty cycle** is the ratio of the scan window to the full scan period. In LOW_LATENCY mode the radio is almost always on. Five minutes of scanning can drain 3% to 5% of the battery.

### Filtering and batching

Instead of scanning longer, improve scan efficiency:

```java
ScanSettings settings = new ScanSettings.Builder()
    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
    .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
    .setNumOfMatches(ScanSettings.MATCH_NUM_ONE_ADVERTISEMENT)
    .setReportDelay(1000) // Batch reports: merge scan results within 1 second.
    .build();

// Filter by Service UUID to reduce noise from irrelevant devices.
List<ScanFilter> filters = new ArrayList<>();
filters.add(new ScanFilter.Builder()
    .setServiceUuid(ParcelUuid.fromString("0000xxxx-0000-..."))
    .build());
```

The three important parameters are:

- **`MATCH_MODE_AGGRESSIVE`**: reports even weak signals, which works well for longer-range discovery. `STICKY` requires the signal to cross a stronger threshold and is better for nearby devices.
- **`MATCH_NUM_ONE_ADVERTISEMENT`**: matches only one advertisement packet per device, reducing duplicate callbacks.
- **`setReportDelay(1000)`**: batches scan results. Without it, every advertisement packet can trigger a callback, sometimes hundreds of callbacks per second.

### Background scan limits and workarounds

Android 8.0 and later heavily restrict background scanning. When an app is in the background, scan intervals can be forced to roughly once every 30 minutes. My usual approach is to pair scanning with a **Foreground Service**:

```kotlin
// Start a foreground service to maintain scan permissions.
val intent = Intent(this, BleForegroundService::class.java)
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    startForegroundService(intent)
}
```

The foreground service needs a visible notification. A simple message such as "Connecting to device" is enough and usually does not feel intrusive to users.

## Long-lived connections: from reconnection to system-level protection

BLE long connections have three main enemies: **system power saving (Doze)**, **Bluetooth firmware issues**, and **signal degradation**.

### Connection parameter negotiation

After a BLE connection is established, the connection interval determines communication frequency. The default is usually 30 ms to 50 ms. However, Android as the Central device **cannot directly set connection parameters**. It can only send an update request:

```java
// Request a shorter connection interval from the peripheral.
gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
// Corresponds to roughly 11.25-15 ms: lower latency, higher power use.
```

`CONNECTION_PRIORITY_HIGH` is suitable for latency-sensitive scenarios such as audio streaming. `BALANCED` works for normal data sync. `LOW_POWER` fits low-frequency sensor reporting.

The catch is that **the final connection parameters are decided by the Peripheral**. Android's `requestConnectionPriority` is only a suggestion. If the device firmware does not respond, the parameters will not change. When you control both app and firmware, configure the target parameters directly on the device side, then send the Android request as a fallback. That is the more reliable setup.

### Disconnect detection and automatic reconnection

BLE disconnections fall into two categories:

1. **Active disconnect**: `gatt.disconnect()` or the peripheral releases the connection.
2. **Passive disconnect (Supervision Timeout)**: link supervision times out, usually after about 2 to 20 seconds.

Passive disconnect detection depends on the Link Supervision Timeout. A 6-second Supervision Timeout on the device side is usually reasonable. On the app side, add heartbeat timeout detection:

```java
private Handler timeoutHandler = new Handler();
private static final long HEARTBEAT_TIMEOUT = 10_000; // Treat 10s without data as disconnected.

private Runnable timeoutRunnable = () -> {
    // Heartbeat timed out. Release the GATT object and reconnect.
    gatt.disconnect();
    gatt.close();
    scheduleReconnect();
};
```

**The `gatt.close()` line is often forgotten.** Without `close`, the system resources held by the `BluetoothGatt` object are not released. The next `connectGatt` may return an existing instance and put the connection state into a confused state. I have seen apps fail permanently after three reconnect attempts for exactly this reason.

### Handling Doze mode

Android 6.0 Doze can suspend networking and Bluetooth scanning after the screen has been off for a while. In practice, the effective solution has two layers.

**Layer 1: battery optimization exemption**

```kotlin
val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
if (powerManager.isIgnoringBatteryOptimizations(packageName).not()) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
    intent.data = Uri.parse("package:$packageName")
    startActivity(intent)
}
```

Guide the user to add the app to the battery optimization allowlist. The effect is immediate: Doze no longer freezes your background tasks. But this flow needs thoughtful UI design. A single pop-up dialog is not enough.

**Layer 2: AlarmManager plus WakeLock**

For scenarios where you cannot rely on user authorization, use `setExactAndAllowWhileIdle` to wake the app periodically:

```kotlin
val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
val intent = Intent(this, BleReconnectReceiver::class.java)
val pendingIntent = PendingIntent.getBroadcast(this, 0, intent, 
    PendingIntent.FLAG_IMMUTABLE)

alarmManager.setExactAndAllowWhileIdle(
    AlarmManager.ELAPSED_REALTIME_WAKEUP,
    SystemClock.elapsedRealtime() + 60_000, // Wake up after 60 seconds.
    pendingIntent
)
```

Keep the WakeLock under 5 seconds. That is enough for one scan and connection attempt. Holding it longer is more likely to trigger system power warnings.

### Connection management with multiple devices

When maintaining multiple BLE connections at once, such as one central device connected to several sensors, do not reuse a single `BluetoothGatt` object for repeated `connectGatt` calls. Create a dedicated GATT instance for each device. The Android BLE stack has a theoretical limit of 7 concurrent connections, but vendor implementations vary a lot. In real tests, Xiaomi and Samsung devices usually stayed stable around 3 to 4 connections.

## Lessons from repeated production failures

**First: GATT operations must be serialized.** The Android BLE stack does not support concurrent GATT reads and writes. If you start the next write before `onCharacteristicWrite` returns, the write is very likely to return false. A single-thread queue for all GATT operations makes reliability much better.

**Second: the Bluetooth address is not a stable device identifier.** Random addresses on Android peripherals rotate periodically, and MAC addresses are no longer accessible on Android 10 and later. Identifying devices by a combination of Service UUIDs and characteristics is more reliable.

**Third: wait 300 ms to 500 ms before reconnecting after a disconnect.** Immediate reconnects, such as calling `connectGatt()` less than 100 ms after `gatt.close()`, can cause HCI-layer timeouts on some Qualcomm Bluetooth chips. This delay was tuned from logs over time. Around 500 ms has been stable across device models.

The BLE protocol itself is not that complicated. The hard part is the difference among vendor Bluetooth stack implementations in Android's fragmented ecosystem. If you can run automated connection tests on five mainstream device models covering connect -> read/write -> disconnect/reconnect -> background keepalive, you can catch at least 80% of compatibility issues before release.
