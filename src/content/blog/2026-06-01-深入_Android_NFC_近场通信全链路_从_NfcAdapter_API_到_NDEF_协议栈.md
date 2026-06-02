---
title: 深入 Android NFC 近场通信全链路：从 NfcAdapter API 到 NDEF 协议栈的卡片读写与 HCE 卡模拟架构
excerpt: 深入解析Android NFC三种工作模式的硬件分工、NDEF数据封装协议、Reader/Writer链路调度优化以及HCE卡模拟的APDU处理与路由表排查机制，覆盖从API调用到协议栈的完整数据流。
publishDate: '2026-06-01'
tags:
- Android
- NFC
- HCE
- NDEF
- 卡模拟
seo:
  title: 深入 Android NFC 近场通信全链路：从 NfcAdapter API 到 NDEF 协议栈的卡片读写与 HCE 卡模拟架构
  description: 深入Android NFC近场通信全链路，从NfcAdapter API到NDEF协议栈，详解Reader/Writer模式延迟优化、HCE卡模拟APDU处理及路由表冲突排查，附工程实践要点。
---

在做门禁刷卡功能时遇到一个偶发失效问题：NFC 读卡有时正常，有时完全没反应。排查后发现，大部分人对 Android NFC 的理解停留在 `enableForegroundDispatch` 上——能读卡就行，底层发生了什么，一概不知。当需求从"读卡"升级到"模拟一张门禁卡"，架构层面的问题就藏不住了。

NFC 和蓝牙不一样，它的协议栈更贴近硬件。三种模式的硬件角色和 NDEF 数据格式搞清楚了，API 调用顺序自然就清楚了。

## 三种模式的硬件分工

Android 将 NFC 划分为三种模式，这不是软件层面的分类，而是 **NFC 控制器（NFCC）的硬件角色切换**：

**Reader/Writer 模式**：手机作为读写器，主动产生 RF 场为被动标签供电。最典型的场景——读公交卡余额、写 NFC 贴纸。

**P2P 模式**：两台设备通过 Android Beam 交换数据，交替产生 RF 场。Android 10 起已废弃，使用率低且功能与蓝牙/Wi-Fi Direct 重叠。写新项目直接跳过。

**Card Emulation 模式**：手机模拟一张被动卡片，由外部读写器供电。内部又分两条技术路径：基于安全单元（SE）的和基于主机的（HCE）。两者在路由机制上有本质区别，后面具体讲。

NfcAdapter 的 API 设计直接映射这三种模式，`setNdefPushMessage` 等 P2P 接口全是 deprecated——历史包袱，不用管。

## NDEF：被低估的数据封装协议

NDEF（NFC Data Exchange Format）是 NFC Forum 定义的标准数据格式，读卡和卡模拟在 RF 层传输的都是它。

一条 NDEF Message 包含若干 NDEF Record，每个 Record 通过 Type Name Format（TNF）标识数据类型。构造 NdefRecord 是高发踩坑区：

```kotlin
// 方式一：直接走工具方法
val record = NdefRecord.createTextRecord("en", "payload")

// 方式二：手动拼字节，等价于上面一行
val payload = byteArrayOf(0x02, 'e'.code.toByte(), 'n'.code.toByte()) +
              "payload".toByteArray(Charsets.UTF_8)
val header = (0x01.toByte() /* TNF_WELL_KNOWN */ or
              (0x01.toByte() shl 3) /* MB=1 */)
NdefRecord(header, NdefRecord.RTD_TEXT, byteArrayOf(), payload)
```

`createTextRecord` 在头部自动插入了语言编码（`0x02` = en，length = 2）。如果你以为 payload 只有纯文本，直接拼接 bytes，读卡端解析结果会不一致。RTD_TEXT 和 RTD_URI 的格式差异也容易翻车——URI 的 prefix byte 在 RFC 中定义了一个缩写表（0x01 = "http://www."），不能省略，否则解析时补不出完整 URI。

## Reader/Writer 链路：dispatch 延迟是关键

读卡流程的瓶颈不在 RF 传输，而在 Tag 发现后的 dispatch 延迟。默认的 Intent 分发走 ActivityManager，从物理贴近到 `onNewIntent` 回调耗时 200~500ms。

快速连续读卡场景（如闸机），用 `enableReaderMode` 替代 `enableForegroundDispatch`：

```kotlin
nfcAdapter.enableReaderMode(
    activity,
    { tag -> handleTagDiscovered(tag) },  // 直接在回调线程拿 Tag
    NfcAdapter.FLAG_READER_NFC_A or
    NfcAdapter.FLAG_READER_NFC_B or
    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
    null
)
```

`FLAG_READER_SKIP_NDEF_CHECK` 让 NFC-A 和 NFC-B 标签都能进回调，省掉了 Intent 序列化的开销。实测延迟可压缩到 50ms 以内。

Tag 对象的生命周期也容易踩坑。离开 RF 场后，底层 `nativeHandle` 立即失效。如果在异步回调里把 Tag 存下来随后再用，直接抛 `IOException`——必须当场完成读写。

Mifare Classic 是个特例：不走 NDEF 协议，`Ndef.get(tag)` 返回 null。只能用 `MifareClassic.get(tag)` 按 sector/block 做二进制读写。判定的依据是 tag 的 techList 包含 `MifareClassic`：

```kotlin
val isMifare = tag.techList.any { it == MifareClassic::class.java.name }
```

## HCE 卡模拟：进程内的 APDU 处理

HCE（Host Card Emulation）让应用层直接处理 ISO 7816-4 的 APDU 指令，不需要硬件安全单元。门禁模拟、支付测试这些场景确实用得上。

核心入口是 `HostApduService`：

```kotlin
class MyHceService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        val ins = commandApdu[1].toInt() and 0xFF
        return when (ins) {
            0xA4 -> handleSelectAid(commandApdu)   // SELECT
            0xB0 -> handleReadBinary(commandApdu)  // READ BINARY
            0xD6 -> handleUpdateBinary(commandApdu)
            else -> byteArrayOf(0x6A.toByte(), 0x81.toByte()) // SW=6A81 功能不支持
        }
    }

    override fun onDeactivated(reason: Int) {
        // DEACTIVATION_LINK_LOSS: RF 场断开
        // DEACTIVATION_DESELECTED: 读写器主动释放
    }
}
```

`processCommandApdu` 必须在 1 秒内返回，超时 NFC 服务会强断连接。复杂逻辑需要另起线程，但 APDU 响应必须在方法体内同步返回——实际做法是内部用 `CountDownLatch` 阻塞等待结果。

AID 在 manifest 中通过 `host-apdu-service` 标签注册：

```xml
<host-apdu-service
    android:requireDeviceUnlock="false">
    <aid-group android:category="other">
        <aid-filter android:name="F0010203040506" />
    </aid-group>
</host-apdu-service>
```

`requireDeviceUnlock` 设为 false 时锁屏也能响应，系统会弹出提示。`category` 选 `other` 而非 `payment`——支付类会触发额外的安全校验，门禁场景没必要引入那层复杂度。

## 协议栈完整数据流与路由表问题

从 Reader 端读卡到 HCE 端响应的完整链路：

```
Reader 端                            Card Emulation 端
┌──────────────┐                    ┌──────────────┐
│ NfcAdapter   │                    │ HostApduSvc  │
│ enableReader │                    │ processCmd   │
└──────┬───────┘                    └──────▲───────┘
       │ API                               │ APDU response
┌──────▼───────┐   13.56MHz RF      ┌──────┴───────┐
│ NfcService   │<──────────────────>│ NfcService   │
│ (framework)  │                    │ (framework)  │
└──────┬───────┘                    └──────▲───────┘
       │ HAL                               │ APDU routing
┌──────▼───────┐ ISO 14443-4/7816  ┌──────┴───────┐
│ NFC 控制器   │<──────────────────>│ NFC 控制器   │
└──────────────┘                    └──────────────┘
```

中间链路最大的坑是 APDU 路由表。NFCC 收到 SELECT AID 指令后，根据路由表决定交给 SE 还是 Host APDU Service。同一 AID 在 SE 和 Host 同时注册时，SE 优先级更高——这是 GlobalPlatform 规范规定的，Android 层面改不了。

排查 HCE 不响应的命令：`adb shell dumpsys nfc`，检查 AID 路由表是否正确注册。我排到过一次，另一家银行的 app 在 SE 层注册了相同的 AID，导致我们的 HCE 实现完全收不到指令，反复查自己代码查不出问题，最后是路由表暴露的。

## 工程实践要点

HCE AID 冲突的 UI 选择框只在下次贴卡时才弹出。首次贴卡无响应，用户需要二次贴——这是 UI 线程与 NFC 服务线程的竞态问题，没什么优雅解法，交互文档里标注清楚即可。

NFC 的 RF 场有效距离约 4cm，受天线位置和金属后壳影响，实测 2cm 以外就不稳定。门禁类产品要把这个物理约束写进交互设计文档，而不是上线后让用户"多贴几次"碰运气。

TNF_EXTERNAL_TYPE 的 AAR（Android Application Record）可以顺手提一下：标签写入特定包名的 AAR 后，未安装 app 的设备刷卡会直接跳 Play 商店。拿来给轻量 app 做推广的偏门手段，效果有多大不好说，但成本为零，不用白不用。
