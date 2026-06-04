---
title: "Android NFC Deep Dive: NfcAdapter, NDEF, and HCE Card Emulation"
lang: en
translationKey: android-nfc-nfcadapter-ndef
slug: android-nfc-nfcadapter-ndef
excerpt: "A deep dive into Android NFC across reader/writer mode, NDEF records, dispatch latency, HCE APDU handling, and AID routing-table debugging."
publishDate: '2025-08-06'
tags:
- "Android"
- "NFC"
- "HCE"
- "NDEF"
- "Card Emulation"
seo:
  title: "Android NFC: NfcAdapter, NDEF, and HCE Card Emulation"
  description: "Explore Android NFC from NfcAdapter and NDEF records to reader-mode latency, HCE APDU handling, AID routing conflicts, and production debugging."
  pageType: article
---

While building an access-card feature, I ran into an intermittent failure: NFC card reading sometimes worked and sometimes did nothing. The investigation showed that many Android developers understand NFC only up to `enableForegroundDispatch`: if the card can be read, it is considered done. What happens underneath is ignored. Once the requirement moves from "read a card" to "emulate an access card," those architectural gaps become impossible to hide.

NFC is different from Bluetooth. Its protocol stack sits much closer to hardware. Once you understand the hardware roles of the three modes and the NDEF data format, the API call sequence becomes much easier to reason about.

## Hardware roles of the three modes

Android divides NFC into three modes. This is not just a software classification; it reflects **hardware role switching inside the NFC controller (NFCC)**.

**Reader/Writer mode**: the phone acts as a reader/writer and actively generates an RF field to power a passive tag. Typical examples include reading transit-card balances or writing NFC stickers.

**P2P mode**: two devices exchange data through Android Beam and take turns generating the RF field. This mode has been deprecated since Android 10 because usage was low and the functionality overlapped with Bluetooth and Wi-Fi Direct. Skip it for new projects.

**Card Emulation mode**: the phone emulates a passive card and is powered by an external reader. Internally, this splits into two technical paths: Secure Element based emulation and Host Card Emulation (HCE). Their routing mechanisms differ fundamentally, which we will cover later.

The `NfcAdapter` API design maps directly to these three modes. P2P APIs such as `setNdefPushMessage` are deprecated historical baggage and can be ignored.

## NDEF: the underrated data container

NDEF (NFC Data Exchange Format) is the standard data format defined by the NFC Forum. Both card reading and card emulation transfer NDEF data at the RF layer.

An NDEF Message contains one or more NDEF Records. Each Record uses Type Name Format (TNF) to identify the data type. Constructing an `NdefRecord` is a common source of bugs:

```kotlin
// Option 1: use the helper method directly
val record = NdefRecord.createTextRecord("en", "payload")

// Option 2: build bytes manually, equivalent to the line above
val payload = byteArrayOf(0x02, 'e'.code.toByte(), 'n'.code.toByte()) +
              "payload".toByteArray(Charsets.UTF_8)
val header = (0x01.toByte() /* TNF_WELL_KNOWN */ or
              (0x01.toByte() shl 3) /* MB=1 */)
NdefRecord(header, NdefRecord.RTD_TEXT, byteArrayOf(), payload)
```

`createTextRecord` automatically inserts the language-code header (`0x02` means `en`, length 2). If you assume the payload is pure text and concatenate raw bytes yourself, different readers may parse the result differently. RTD_TEXT and RTD_URI also have different formats. URI records use a prefix-byte abbreviation table defined in the RFC, for example `0x01` means `http://www.`. You cannot omit it and expect the reader to reconstruct the full URI.

## Reader/Writer path: dispatch latency matters

The bottleneck in card reading is not RF transfer. It is dispatch latency after a Tag is discovered. The default Intent dispatch path goes through ActivityManager, and the time from physical tap to `onNewIntent` callback is usually 200-500 ms.

For fast consecutive reads, such as gate access, use `enableReaderMode` instead of `enableForegroundDispatch`:

```kotlin
nfcAdapter.enableReaderMode(
    activity,
    { tag -> handleTagDiscovered(tag) },  // Get the Tag directly on the callback thread
    NfcAdapter.FLAG_READER_NFC_A or
    NfcAdapter.FLAG_READER_NFC_B or
    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
    null
)
```

`FLAG_READER_SKIP_NDEF_CHECK` lets NFC-A and NFC-B tags enter the callback directly and avoids Intent serialization overhead. In testing, latency can be reduced below 50 ms.

The lifecycle of the Tag object is another common trap. Once the tag leaves the RF field, the underlying `nativeHandle` becomes invalid immediately. If you store a Tag and use it later in an asynchronous callback, you will get an `IOException`. Reads and writes must be completed immediately while the tag is still present.

Mifare Classic is a special case. It does not use the NDEF protocol, so `Ndef.get(tag)` returns null. You must use `MifareClassic.get(tag)` and read or write binary data by sector and block. The check is whether the tag's techList contains `MifareClassic`:

```kotlin
val isMifare = tag.techList.any { it == MifareClassic::class.java.name }
```

## HCE card emulation: APDU handling in your process

HCE (Host Card Emulation) lets app code handle ISO 7816-4 APDU commands directly, without a hardware Secure Element. It is useful for access-card emulation, payment testing, and similar scenarios.

The core entry point is `HostApduService`:

```kotlin
class MyHceService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        val ins = commandApdu[1].toInt() and 0xFF
        return when (ins) {
            0xA4 -> handleSelectAid(commandApdu)   // SELECT
            0xB0 -> handleReadBinary(commandApdu)  // READ BINARY
            0xD6 -> handleUpdateBinary(commandApdu)
            else -> byteArrayOf(0x6A.toByte(), 0x81.toByte()) // SW=6A81, function not supported
        }
    }

    override fun onDeactivated(reason: Int) {
        // DEACTIVATION_LINK_LOSS: RF field disconnected
        // DEACTIVATION_DESELECTED: reader released the card
    }
}
```

`processCommandApdu` must return within 1 second. If it times out, the NFC service forcibly disconnects. Complex logic needs a separate thread, but the APDU response still has to be returned synchronously from the method body. In practice, this often means using a `CountDownLatch` internally and blocking until the result is ready.

AIDs are registered in the manifest through the `host-apdu-service` tag:

```xml
<host-apdu-service
    android:requireDeviceUnlock="false">
    <aid-group android:category="other">
        <aid-filter android:name="F0010203040506" />
    </aid-group>
</host-apdu-service>
```

When `requireDeviceUnlock` is false, the service can respond on the lock screen and the system displays a prompt. Use `category="other"` instead of `payment`. Payment categories trigger additional security checks, which are unnecessary complexity for access-control scenarios.

## Full protocol flow and routing-table issues

The full path from a reader-side card tap to an HCE-side response looks like this:

```text
Reader side                         Card Emulation side
-------------                       -------------------
NfcAdapter                          HostApduService
enableReader                        processCommandApdu
     |                                    ^
     | API                                | APDU response
     v                                    |
NfcService                          NfcService
(framework)      13.56 MHz RF       (framework)
     |             <------------->        ^
     | HAL                                | APDU routing
     v                                    |
NFC controller  ISO 14443-4/7816    NFC controller
```

The biggest trap in the middle of this path is the APDU routing table. When the NFCC receives a SELECT AID command, it uses the routing table to decide whether to deliver it to the Secure Element or to a Host APDU Service. If the same AID is registered in both SE and Host, the SE has higher priority. This is defined by the GlobalPlatform spec and cannot be changed from the Android layer.

To debug an HCE service that does not respond, run `adb shell dumpsys nfc` and check whether the AID routing table is registered correctly. I once traced a case where another banking app had registered the same AID at the SE layer, so our HCE implementation never received the command. The application code looked fine; the routing table exposed the real issue.

## Engineering notes

The UI chooser for HCE AID conflicts appears only on the next card tap. The first tap may not respond, and the user needs to tap again. This is a race between the UI thread and the NFC service thread. There is no elegant fix; document the interaction clearly.

The effective NFC RF field range is about 4 cm, and it is strongly affected by antenna placement and metal backs. In testing, anything beyond 2 cm was already unstable. For access-control products, put this physical constraint into the interaction design document instead of shipping and telling users to "tap a few more times."

One more detail: TNF_EXTERNAL_TYPE supports AAR (Android Application Record). If a tag contains an AAR with a specific package name, a device without the app installed can open the Play Store directly after the tap. It is a niche way to promote a lightweight app. The impact varies, but the cost is essentially zero.
