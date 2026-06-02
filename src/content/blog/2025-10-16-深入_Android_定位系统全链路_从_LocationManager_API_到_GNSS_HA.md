---
title: 深入 Android 定位系统全链路：从 LocationManager API 到 GNSS HAL 的卫星定位与 Fused Location Provider 融合定位架构解析
excerpt: 本文从一次运动轨迹跳点问题出发，深入剖析 Android 定位系统全链路：涵盖 LocationManager API、Fused Provider 卡尔曼滤波融合算法、GNSS HAL 层 NMEA 协议解析及 AGPS 冷启动优化，提供跳点排查与功耗策略的实战经验。
publishDate: '2025-10-16'
tags:
- Android
- GNSS
- 定位系统
- HAL
- 系统架构
seo:
  title: 深入 Android 定位系统全链路：从 LocationManager API 到 GNSS HAL 的卫星定位与 Fused Location Provider 融合定位架构解析
  description: 从 LocationManager API 到 GNSS HAL，深入剖析 Android 定位系统全链路架构，详解 Fused Provider 卡尔曼滤波融合算法、AGPS 冷启动优化及定位跳点排查实战。
---

去年在做运动轨迹记录功能时，遇到一个奇怪的问题：同一段跑步路线，小米手机记录的轨迹平滑连续，某 ODM 设备却频繁跳点，配速直接从 5'30" 飘到 3'20"。排查后发现，问题出在 Fused Provider 的融合策略上——那台设备没有陀螺仪，融合引擎降级策略有 bug。这个经历让我把 Android 定位全链路重新捋了一遍。

## LocationManager：应用层的唯一入口

对应用开发者来说，获取定位的代码很简洁：

```kotlin
val locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
val request = LocationRequest.Builder(PRIORITY_HIGH_ACCURACY, 5000)
    .setMinUpdateDistanceMeters(10f)
    .build()

locationManager.requestLocationUpdates(
    PROVIDER_FUSED, request, executor, locationCallback
)
```

表面上只是调了个 API，但 `LocationManager` 的 `requestLocationUpdates` 实际走了一条很长的 IPC 链路。它通过 Binder 调用运行在 `system_server` 进程中的 `LocationManagerService`。

`LocationManagerService` 的核心职责只有三个：权限校验、Provider 路由、回调管理。它不做任何定位计算，真正的定位逻辑在 Provider 层。关键代码路径：

```java
// frameworks/base/services/core/java/com/android/server/LocationManagerService.java
private void requestLocationUpdatesLocked(LocationRequest request, 
        ILocationListener listener, String packageName) {
    // 1. 权限检查
    checkResolutionLevelIsSufficientForProviderUseLocked(..., providerName);
    // 2. 查找或创建 Receiver（每个 listener 对应一个 Receiver）
    Receiver receiver = checkListenerOrIntentLocked(listener, ...);
    // 3. 将请求转发给对应的 LocationProvider
    requestLocationUpdatesLocked(sanitizedRequest, receiver, packageName);
}
```

Provider 的选择才是真正的分叉点。Android 支持三类 Provider：**GPS Provider**（纯卫星）、**Network Provider**（基站+WiFi）和 **Fused Provider**（融合定位）。绝大多数应用使用 Fused Provider，它背后是一个复杂的融合引擎。

## Fused Location Provider：融合引擎的架构

Fused Provider 由 Google Play Services 实现，代码在 `gmscore` 的 `com.google.android.location` 包中。它不像 GPS Provider 直接读 HAL，而是同时订阅多个底层 Provider 的数据，通过算法融合输出最优位置。

融合引擎的输入源有四种：

- **GNSS 卫星定位**：精度 3-10 米，室外可用，功耗高
- **WiFi 扫描结果**：精度 20-50 米，室内可用，依赖 Google 的 WiFi 指纹库
- **蜂窝基站信息**：精度 100-1000 米，作为兜底
- **传感器数据**：加速度计、陀螺仪、磁力计，用于航位推算（Dead Reckoning）

融合算法的大致流程：

```
GNSS Fix ──┐
WiFi Scan ──┼──→ Kalman Filter ──→ 输出位置 + 精度半径
Cell Info ──┤
Sensors   ──┘
```

**卡尔曼滤波器（Kalman Filter）** 是融合引擎的核心。它维护一个状态向量（位置、速度、加速度），每次收到新观测值就执行两步：预测（predict）→ 更新（update）。GNSS 数据用来修正绝对位置，加速度计和陀螺仪填补 GNSS 信号盲区（隧道、高架桥下）。

一个踩过的坑：`PRIORITY_HIGH_ACCURACY` 模式下，Fused Provider 会持续开启 GNSS 芯片，功耗大约 200-300mW。如果应用不需要亚米级精度，`PRIORITY_BALANCED_POWER_ACCURACY`（100 米精度）会关闭 GNSS，仅用 WiFi + 基站，功耗降到 20-50mW。

## GNSS HAL：从 Framework 到芯片的最后一公里

当 Fused Provider 决定使用卫星定位时，调用链进入 HAL 层。Android 定义了 `IGnss.hal` 接口（AIDL 定义），芯片厂商（高通、博通、MTK）实现对应的 HAL 模块。

调用路径如下：

```
LocationManagerService
  → GnssLocationProvider (frameworks/base)
    → IGnss.hal (HIDL/AIDL 接口)
      → gnss.qcom.so / gnss.mtk.so (厂商实现)
        → /dev/ttyHS0 (串口通信)
          → GNSS 芯片固件
```

GNSS Provider 通过串口（UART）或 SPI 与芯片通信，传输的是标准 **NMEA-0183 语句**。以下是典型的 `$GPGGA` 语句（GPS 定位数据）：

```
$GPGGA,092750.000,3109.6452,N,12123.5264,E,1,12,1.0,48.5,M,,M,,*5E
```

解析后得到：UTC 时间 09:27:50，北纬 31°9.6452'，东经 121°23.5264'，定位质量 1（单点定位），使用 12 颗卫星，海拔 48.5 米。

HAL 层的关键接口定义：

```cpp
// hardware/interfaces/gnss/1.0/IGnss.hal
interface IGnss {
    // 注入 AGPS 辅助数据，加速首次定位（TTFF）
    injectLocation(Location location);
    // 删除所有 AGPS 数据
    deleteAidingData(GnssAidingData aidingDataFlags);
    // 启动导航，传入回调用于上报 NMEA 和位置
    start() generates (bool started);
    stop();
    // 设置定位模式和周期
    setCallback(IGnssCallback callback);
};
```

HAL 实现中，厂商代码主要做三件事：**AGPS 辅助定位**（从网络下载星历）、**NMEA 解析**（将 `$GPGGA`、`$GPRMC` 等语句转为 Location 对象）、**功耗策略**（根据运动状态调整芯片工作周期）。

TTFF（Time To First Fix，首次定位时间）是一个常见的性能瓶颈。冷启动时芯片没有星历数据，需要扫描 32 颗卫星的信号，耗时 30 秒到几分钟不等。AGPS 通过蜂窝网络下载星历，能把 TTFF 压缩到 3-10 秒。实现时注意：`injectLocation` 的参数必须传入基站对应的粗略位置，否则芯片无法正确计算多普勒频移。

## 全链路追踪：一次定位请求的完整耗时

用一个具体场景串联全链路。应用调用 `requestLocationUpdates` 后：

1. **Binder IPC** → LocationManagerService：约 2-5ms
2. **Fused Provider 决策**：如果已有缓存位置（age < 10s），直接返回，约 1ms
3. **GNSS 启动**：若需冷启动，HAL 层 `start()` 到首次 NMEA 输出，约 3-10 秒（AGPS 辅助）
4. **融合计算**：卡尔曼滤波迭代，每收到一次 GNSS fix 约耗时 0.5-1ms
5. **回调到应用**：Binder 回调 + 主线程切换，约 3-8ms

实际项目中，从应用发起请求到拿到第一个有效位置，冷启动耗时约 5-15 秒。热启动（芯片持续工作）只需 100-500ms。

我做过一次对比测试：同样的室外场景，Fused Provider 的轨迹平滑度明显优于纯 GNSS Provider——尤其是在穿越有遮挡的路段时，加速度计数据让融合结果没有出现"漂移-回拉"的跳变。代价是多消耗约 15% 的电量（传感器持续采集）。

如果你也遇到定位跳点问题，三个方向值得排查：

**检查 Provider 选择**：`PRIORITY_HIGH_ACCURACY` 并不保证 GNSS 可用，室内场景会退化为 WiFi 定位，精度骤降。在 `onLocationChanged` 中打印 `location.provider` 可以确认实际来源。

**理解 Fused Provider 的降级逻辑**：当传感器缺失（比如没有陀螺仪）时，融合引擎退化为纯位置加权平均，室内外切换时容易出现跳点。ODM 设备的传感器配置差异是高频踩坑点。

**留意 HAL 层功耗策略**：部分厂商在灭屏后会将 GNSS 芯片的 fix 频率从 1Hz 降到 0.1Hz，导致运动类应用轨迹变稀疏。通过 `GnssNavigationMessage.Callback`（Android 7.0+）可以直接监听卫星数据质量，判断是芯片降频还是信号真差。
