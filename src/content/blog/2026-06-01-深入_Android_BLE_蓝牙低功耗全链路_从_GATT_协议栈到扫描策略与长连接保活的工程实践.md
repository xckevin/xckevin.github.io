---
title: 深入 Android BLE 蓝牙低功耗全链路：从 GATT 协议栈到扫描策略与长连接保活的工程实践
excerpt: 本文从实战踩坑出发，系统梳理 Android BLE 开发的 GATT 协议分层与数据交互模式、扫描策略在功耗与发现率之间的平衡技巧，以及对抗 Doze、断线重连、多设备管理等长连接保活的工程实践。
publishDate: '2026-06-01'
tags:
- Android
- BLE
- Kotlin
- 性能优化
- 长连接保活
seo:
  title: 深入 Android BLE 蓝牙低功耗全链路：从 GATT 协议栈到扫描策略与长连接保活的工程实践
  description: 系统讲解 Android BLE 开发全链路：GATT 协议分层、扫描功耗控制、断线重连与 Doze 对抗策略，附 Java/Kotlin 代码示例及多机型兼容性实践经验。
---

去年做智能穿戴设备时，遇到过一个问题：App 在后台跑了 20 分钟，BLE 连接就断了，设备端还在正常广播，但手机端怎么也重连不上。折腾了两天才定位到——扫描策略和保活机制各缺了一环。

下面把 BLE 开发里真正要命的东西拆开讲：GATT 协议分层、扫描功耗控制，以及 Android 碎片化生态下长连接怎么保活。

## GATT 协议栈：数据是怎么流动的

BLE 协议栈自上而下三层：**应用层（GATT）→ 逻辑链路层（ATT）→ 物理链路层（GAP）**。开发时直接打交道的是 GATT 层，但问题往往出在下面两层。

### Service 和 Characteristic 的关系

每个 BLE 设备以 **Service（服务）** 为容器，Service 内包含多个 **Characteristic（特征值）**。Characteristic 是数据交互的最小单元，携带一个 value 和一组 properties：

```java
// 扫描到设备后，发起 GATT 连接
BluetoothGatt gatt = device.connectGatt(context, false, gattCallback);
// 连接成功后回调
public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
    if (newState == BluetoothProfile.STATE_CONNECTED) {
        gatt.discoverServices(); // 这一步触发服务发现
    }
}
```

**`discoverServices()` 执行的是 ATT 层的服务发现协议**，遍历设备上所有 Service 和 Characteristic，耗时 500ms~2s 不等，取决于 Service 数量。我习惯在这一步之前加一个 1.5s 的超时保护，弱信号下不会被卡死。

### 读写与通知的三种模式

GATT 定义了三种数据交互方式：

- **Write / Read**：主设备主动发起，同步请求-响应模式
- **Notify**：从设备主动推送，主设备预先使能 CCCD（Client Characteristic Configuration Descriptor）
- **Indicate**：与 Notify 类似，但需要主设备确认（Acknowledge），速度慢一半但可靠

```java
public void onServicesDiscovered(BluetoothGatt gatt, int status) {
    BluetoothGattService service = gatt.getService(SERVICE_UUID);
    BluetoothGattCharacteristic characteristic = 
        service.getCharacteristic(CHAR_UUID);
    
    // 使能 Notify：写入 CCCD descriptor
    gatt.setCharacteristicNotification(characteristic, true);
    BluetoothGattDescriptor descriptor = 
        characteristic.getDescriptor(CCCD_UUID);
    descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
    gatt.writeDescriptor(descriptor);
}
```

一个踩过的坑：**CCCD 使能必须在 `onServicesDiscovered` 之后执行**。如果在 `onConnectionStateChange` 里立刻写 descriptor，大概率报 `GATT_WRITE_NOT_PERMITTED`——Service 还没发现完，Characteristic 句柄是无效的。

## 扫描策略：在高发现率与低功耗之间平衡

BLE 扫描是功耗大户。`BluetoothLeScanner` 的参数能控制扫描行为，但默认配置不是最优解。

### 三种扫描模式的取舍

Android 提供了三种扫描模式，本质是占空比不同：

| 模式 | 占空比 | 功耗 | 适用场景 |
|------|--------|------|----------|
| SCAN_MODE_LOW_POWER | ~0.5% | 低 | 后台持续监听 |
| SCAN_MODE_BALANCED | ~2% | 中 | 前台常规扫描 |
| SCAN_MODE_LOW_LATENCY | ~100% | 高 | 快速发现设备 |

**占空比**是扫描窗口占整个扫描周期的比例。LOW_LATENCY 模式下射频几乎全开，5 分钟能耗掉 3%~5% 的电量。

### 过滤与聚合策略

与其拉长扫描时间，不如提高扫描效率：

```java
ScanSettings settings = new ScanSettings.Builder()
    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
    .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
    .setNumOfMatches(ScanSettings.MATCH_NUM_ONE_ADVERTISEMENT)
    .setReportDelay(1000) // 聚合上报，1s 内的扫描结果合并
    .build();

// 按 Service UUID 过滤，减少无关设备干扰
List<ScanFilter> filters = new ArrayList<>();
filters.add(new ScanFilter.Builder()
    .setServiceUuid(ParcelUuid.fromString("0000xxxx-0000-..."))
    .build());
```

三个参数说一下：

- **`MATCH_MODE_AGGRESSIVE`**：信号微弱也报告，适合远距离场景；`STICKY` 要求信号强度达阈值，适合近距离
- **`MATCH_NUM_ONE_ADVERTISEMENT`**：每个设备只匹配一次广告包，减少重复回调
- **`setReportDelay(1000)`**：批量上报。不加这个参数，每个广告包都会触发回调用，1 秒内可能回调上百次

### 后台扫描限制与对策

Android 8.0+ 对后台扫描做了严格限制：后台 App 扫描间隔被强制拉长到约 30 分钟一次。我的做法是结合 **前台服务（Foreground Service）**：

```kotlin
// 启动前台服务以维持扫描权限
val intent = Intent(this, BleForegroundService::class.java)
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    startForegroundService(intent)
}
```

前台服务需要关联一个可见通知，写入"正在连接设备"即可——用户感知上不算打扰。

## 长连接保活：从断线重连到系统级守护

BLE 长连接的死敌有三个：**系统省电机制（Doze）**、**蓝牙固件异常**、**信号衰减**。

### 连接参数协商

BLE 连接建立后，连接间隔（Connection Interval）决定了通信频率。默认值通常是 30ms~50ms，但 Android 作为 Central 设备，**不能直接设置连接参数**，只能发送更新请求：

```java
// 向设备端请求更短的连接间隔
gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
// 对应连接间隔约 11.25~15ms，延迟更低但功耗更高
```

`CONNECTION_PRIORITY_HIGH` 适合实时性要求高的场景（如音频流），`BALANCED` 适合常规数据同步，`LOW_POWER` 适合低频传感器上报。

这里有个坑：**连接参数最终由 Peripheral 设备决定**，Android 的 `requestConnectionPriority` 只是一个建议请求。如果设备固件不响应，参数不会变化。做双端开发时，在设备端固件里直接设好目标参数，App 端再发一次请求兜底，这才是靠谱做法。

### 断线检测与自动重连

BLE 断开分两种情况：

1. **主动断开**：`gatt.disconnect()` 或设备端主动释放
2. **被动断开（Supervision Timeout）**：链路监控超时，默认值约 2s~20s

被动断开的判断依赖链接监督超时（Link Supervision Timeout）。设备端的 Supervision Timeout 配置为 6s 比较合理，App 端做心跳超时检测：

```java
private Handler timeoutHandler = new Handler();
private static final long HEARTBEAT_TIMEOUT = 10_000; // 10s 无数据判定断开

private Runnable timeoutRunnable = () -> {
    // 心跳超时，主动释放 gatt 并重连
    gatt.disconnect();
    gatt.close();
    scheduleReconnect();
};
```

**`gatt.close()` 这一行经常被漏掉**。不调用 close，BluetoothGatt 对象持有的系统资源不会释放，下次 `connectGatt` 可能返回已有实例，导致连接状态混乱。我见过不少 App 重连 3 次后就再也连不上了，根因就在这里。

### 对抗 Doze 模式

Android 6.0 Doze 模式会在息屏一段时间后切断网络和蓝牙扫描。实践下来有效的方案分两层：

**第一层：白名单豁免**

```kotlin
val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
if (powerManager.isIgnoringBatteryOptimizations(packageName).not()) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
    intent.data = Uri.parse("package:$packageName")
    startActivity(intent)
}
```

引导用户将 App 加入电池优化白名单——效果立竿见影，Doze 不会再冻结你的后台任务。但引导操作这步需要合理的 UI 设计，弹个对话框不够。

**第二层：AlarmManager + WakeLock 组合**

对于不能依赖用户授权的场景，用 `setExactAndAllowWhileIdle` 定时唤醒：

```kotlin
val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
val intent = Intent(this, BleReconnectReceiver::class.java)
val pendingIntent = PendingIntent.getBroadcast(this, 0, intent, 
    PendingIntent.FLAG_IMMUTABLE)

alarmManager.setExactAndAllowWhileIdle(
    AlarmManager.ELAPSED_REALTIME_WAKEUP,
    SystemClock.elapsedRealtime() + 60_000, // 60s 后唤醒
    pendingIntent
)
```

WakeLock 持有时间控制在 5s 以内，够做一次扫描加连接即可，长了反而触发系统的功耗告警。

### 多设备场景下的连接管理

同时维护多个 BLE 连接时（比如中心设备连多个传感器），不要用单个 BluetoothGatt 对象反复 `connectGatt`——为每个设备创建独立的 Gatt 实例。Android 底层 BLE 栈上限是 7 个并发连接，但这个数字在不同厂商的实现上差异很大，实测小米和三星的设备通常稳定在 3~4 个。

## 反复踩坑后的经验

**第一个：GATT 操作必须串行。** Android BLE 栈不支持并发 GATT 读写。如果在 `onCharacteristicWrite` 回调之前发起下一次写入，大概率返回 false。用一个单线程队列串行化所有 GATT 操作，可靠性提升明显。

**第二个：蓝牙地址不是稳定的设备标识。** Android 设备端随机地址（Random Address）会定期轮换，Mac Address 在 Android 10+ 已无法获取。用设备的 Service UUID 加特征组合做身份识别更可靠。

**第三个：断开后延迟 300ms~500ms 再重连。** 立即重连（`gatt.close()` → `connectGatt()` 间隔小于 100ms）在部分高通蓝牙芯片上会导致 HCI 层超时。这个延迟值是从日志里一点一点调出来的，500ms 在各机型上都比较稳。

BLE 协议本身不复杂，复杂的是 Android 碎片化生态里各厂商蓝牙协议栈实现的差异。在 5 台主流机型上跑过自动化连接测试，覆盖连接→读写→断线重连→后台保活四个环节，能拦住至少 80% 的兼容性问题。
