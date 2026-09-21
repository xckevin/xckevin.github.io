---
title: "ADB Under the Hood: Client, Server, and adbd"
lang: en
translationKey: android-adb-client-server-adbd-architecture
slug: android-adb-client-server-adbd-architecture
excerpt: "How Android Debug Bridge's client, server, and daemon layers work together, from protocol packets to troubleshooting."
publishDate: '2026-07-17'
tags:
- "Android"
- "ADB"
- "Debugging"
seo:
  title: "ADB Architecture: Client, Server, and adbd"
  description: "A technical walkthrough of Android Debug Bridge's three-layer architecture, client-server protocol, port forwarding, adbd internals, and debugging."
  pageType: article
---

During a debugging session, `adb devices` kept reporting `offline`. I checked the USB cable, drivers, and developer options; only after struggling for half an hour did I discover that the adb server port had been silently occupied by another process. That experience made me realize how little most of us know about the architecture behind ADB, a tool we use every day—our understanding often stops at the command level.

## ADB's Three-Layer Architecture

ADB uses the classic **three-layer client/server/daemon (C/S/D) architecture**, with clearly separated responsibilities at each layer:

```
┌──────────┐     localhost:5037     ┌──────────┐     USB/TCP      ┌──────────┐
│  Client  │ ◄──────────────────► │  Server  │ ◄──────────────► │  Daemon  │
│  (adb)   │                       │ (host)   │                  │ (adbd)   │
└──────────┘                       └──────────┘                  └──────────┘
   PC 终端                           PC 后台进程                    Android 设备
```

**Client** is the `adb shell`, `adb install`, and other commands you type. It does no real work itself; it only packages the request and sends it to the server.

**Server** is the background process running on your PC. It manages all device connections and request dispatch. It starts automatically the first time you run an adb command and listens on `localhost:5037`. The server is the hub of the whole architecture—clients only talk to the server, and the server talks to the daemon.

**Daemon (adbd)** is the on-device daemon, a native service started by init, that actually executes shell commands, installs APKs, and pushes files.

These three layers are connected by two communication links: Client ↔ Server uses local TCP, and Server ↔ Daemon uses USB or wireless TCP.

## Client-Server Communication Protocol

The protocol between the client and server is simpler and more direct than many people imagine: a text-based protocol over TCP. The request format is fixed: **a 4-byte hexadecimal ASCII string representing the byte length of the following payload + the payload itself**. Note that this length is the hexadecimal value of the payload byte count, not the decimal byte count spliced directly into string form—for example, a 12-byte payload should have the prefix `000c` (12 in hex is 0xc), not `0012`.

You can use `nc` to send a request manually and see it:

```bash
# host:devices 共 12 字节，十六进制 0xc，前缀补齐为 4 位 -> 000c
echo -n "000chost:devices" | nc localhost 5037
```

After receiving a request, the server returns `OKAY` (success) or `FAIL` (failure). For requests like `host:devices` that need to return data, `OKAY` is followed by another 4-byte hexadecimal length plus the actual data. The return value looks like this:

```
OKAY0024emulator-5554	device
a1b2c3d4	device
```

`OKAY` is a fixed 4-byte header, `0024` means the following data is 0x24 = 36 bytes, followed by the device list.

The length prefix lets the receiver know exactly how many bytes to read, without relying on newlines or timeouts to determine boundaries—a common practice in many custom network protocols.

Now look at `host:transport`. This command does not return data directly; instead it tells the server: "all subsequent operations for this device go over the same connection." After the server returns `OKAY`, the connection state switches to device passthrough mode, and any data you send next is forwarded to adbd as-is.

The complete protocol interaction chain for a single `adb shell ls` command:

1. The client sends `host:transport:<serial>` to select the device
2. The client sends `shell:ls` to request command execution
3. The server passes `shell:ls` through to adbd
4. adbd executes the command and returns stdout/stderr back through the server
5. The client receives and prints the result

Connection reuse and state switching make it possible for a single connection to carry multiple devices and multiple commands.

## How Port Forwarding Works

`adb forward` and `adb reverse` are the two most commonly used but also most easily confused forwarding commands.

**Forward forwarding `adb forward tcp:8080 tcp:8080`**:

The server listens on `localhost:8080` on the PC side. When a connection arrives, the server initiates a `tcp:8080` connection request to adbd through the device transport channel; adbd connects to `localhost:8080` on the device, and then the server splices the two data streams together.

```bash
# PC 端访问 localhost:8080 实际转发到设备的 8080 端口
adb forward tcp:8080 tcp:8080
```

**Reverse forwarding `adb reverse tcp:8080 tcp:8080`**:

The direction is reversed—adbd listens on port 8080 on the device, and traffic from the device travels through adbd → server → PC-side localhost. This is very useful for debugging WebView or when the device needs to access a service on the PC.

```bash
# 设备访问 localhost:8080 实际转发到 PC 的 8080 端口
adb reverse tcp:8080 tcp:8080
```

Understanding "who listens and who connects" captures the essence: with forward mode, the server listens and adbd connects to the target (the PC side initiates); with reverse mode, adbd listens and the server connects to the target (the device side initiates). Once you understand this, the port mapping logic of tools such as Chrome DevTools USB debugging and scrcpy screen mirroring becomes clear.

## Inside the adbd Daemon

The source code for adbd is in AOSP under `system/core/adb/`, with the core logic concentrated in `daemon/main.cpp` and `services.cpp`. From device boot to being able to receive commands, adbd goes through three phases:

**Phase 1: property check**. The init process decides whether to start adbd based on system properties such as `ro.debuggable` and `persist.sys.usb.config`. When `ro.adb.secure=1`, RSA authentication is enabled—this has been the security baseline since Android 4.2.2.

**Phase 2: transport initialization**. USB mode uses `ffs` (Function File System), presenting the device as a USB peripheral through the gadget driver. TCP mode directly listens on port `5555`. Both can be enabled at the same time.

**Phase 3: authentication handshake**. Paired keys are stored in `/data/misc/adb/adb_keys`, with one Base64-encoded public key per line. The phone shows the "Allow USB debugging" dialog; checking the box in Settings essentially appends a public key record to this file.

The service types supported by adbd are registered in the `SERVICES` table. The core services are:

| Service name | Function |
|--------|------|
| `shell:cmd` | Executes shell commands, returns pty or raw mode |
| `sync:` | File transfer protocol; the underlying implementation of `adb push/pull` |
| `framebuffer:` | Screenshot service; screen mirroring tools such as scrcpy rely on this interface |
| `jdwp:` | Java Debug Wire Protocol; the bridge for IDE debugging |
| `abb_exec:` | Android Backup service entry |

Each service maps to a handler function. adbd forks a child process to handle the connection and then execs into the specific service logic.

## Complete Data Flow of the Debugging Channel

Putting the layers together, the complete data path for an `adb shell dumpsys activity` command is:

```
adb client                    adb server                   adbd                   system_server
    │                             │                          │                         │
    │ ① host:transport             │                          │                         │
    │────────────────────────────► │                          │                         │
    │                             │                          │                         │
    │ ② shell:dumpsys activity     │                          │                         │
    │────────────────────────────► │                          │                         │
    │                             │ ③ shell:dumpsys activity │                         │
    │                             │────────────────────────► │                         │
    │                             │                          │ ④ dumpsys activity      │
    │                             │                          │────────────────────────►│
    │                             │                          │                         │
    │                             │                          │ ⑤ 返回结果               │
    │                             │                          │◄────────────────────────│
    │                             │ ⑥ 结果回传                │                         │
    │                             │◄──────────────────────── │                         │
    │ ⑦ 打印输出                    │                          │                         │
    │◄──────────────────────────── │                          │                         │
```

The transport channel in step ③ depends on the current connection mode: USB mode transfers through bulk endpoints, and TCP mode uses sockets. In fact, USB mode is also logically wrapped as a socket interface—inside adbd, a `UsbFfsConnection` class wraps USB endpoints into socket-like read/write semantics, so the upper transport logic does not perceive the physical layer difference. From the shell service's perspective, USB and Wi-Fi connections look exactly the same.

## In Practice: Troubleshooting ADB

After stepping into enough pitfalls, I have summarized a method for quickly locating ADB problems:

**Step 1: check the server status**. `adb kill-server && adb start-server` is the most direct brute-force recovery method. If start-server fails, use `lsof -i :5037` to check whether the port is occupied. Chrome DevTools, Genymotion, and some VPN software can all occupy port 5037.

**Step 2: determine which layer has the problem**. If `adb devices` produces no output, the server-to-daemon link is broken; focus on the USB connection and developer options. If it shows `unauthorized`, this is an authentication issue; check whether the device needs the confirmation dialog. If it shows `offline`, the daemon has started but the connection is abnormal, most likely due to an adbd version mismatch.

**Step 3: wireless debugging pitfalls**. After switching with `adb tcpip 5555`, remember to confirm the device IP, because the IP changes when the Wi-Fi network changes. I often suffered disconnections when moving between my desk and meeting rooms for this reason, so eventually I wrote a script that automatically detects the current IP and reconnects.

When debugging multiple devices in parallel, make good use of `adb -s <serial>` to specify the target device, to avoid confusion from the implicit selection of `adb -d` (USB devices only) and `adb -e` (emulators only).

The essence of ADB's architecture is not the complexity of the protocol, but the composability that comes from layered decoupling—you can use the raw protocol to manually send packets for debugging, and you can extend custom functionality through service interfaces; each layer can be understood and operated independently.
