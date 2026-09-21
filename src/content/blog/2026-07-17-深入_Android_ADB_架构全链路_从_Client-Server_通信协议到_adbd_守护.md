---
title: 深入 Android ADB 架构全链路：从 Client-Server 通信协议到 adbd 守护进程的调试通道架构解析
excerpt: 深入解析 ADB 的 Client-Server-Daemon 三层架构，从文本通信协议、端口转发机制到 adbd 守护进程内部实现，完整还原调试通道的数据流全链路。
publishDate: '2026-07-17'
tags:
- Android
- ADB
- 架构设计
- 调试
- 通信协议
seo:
  title: 深入 Android ADB 架构全链路：从 Client-Server 通信协议到 adbd 守护进程的调试通道架构解析
  description: ADB 采用 Client-Server-Daemon 三层架构，本文深入解析其文本通信协议、端口转发机制、adbd 守护进程内部实现及调试通道完整数据流，附实战排查思路。
---

某次调试时 `adb devices` 始终显示 `offline`，排查了 USB 线、驱动、开发者选项，折腾半小时后才发现是 adb server 端口被另一个进程悄悄占用了。这次经历让我意识到：ADB 这个每天用的工具，多数人只停留在命令层面，对它的架构设计知之甚少。

## ADB 的三层架构

ADB 采用经典的 **C/S/D 三层架构**，每一层职责清晰：

```
┌──────────┐     localhost:5037     ┌──────────┐     USB/TCP      ┌──────────┐
│  Client  │ ◄──────────────────► │  Server  │ ◄──────────────► │  Daemon  │
│  (adb)   │                       │ (host)   │                  │ (adbd)   │
└──────────┘                       └──────────┘                  └──────────┘
   PC 终端                           PC 后台进程                    Android 设备
```

**Client** 是你敲下的 `adb shell`、`adb install` 等命令。它本身不做任何实际工作，只是把请求打包发给 Server。

**Server** 是 PC 上运行的后台进程，负责管理所有设备连接和请求调度。首次执行 adb 命令时自动启动，监听 `localhost:5037` 端口。它是整个架构的中枢——Client 只和 Server 通信，Server 再和 Daemon 通信。

**Daemon（adbd）** 是设备端守护进程，由 init 进程拉起的 native 服务，真正执行 shell 命令、安装 APK、推送文件。

这三层通过两段通信链路串联：Client ↔ Server 走本地 TCP，Server ↔ Daemon 走 USB 或无线 TCP。

## Client-Server 通信协议

Client 与 Server 之间的协议比很多人想的更简单直接，是基于 TCP 的文本协议。请求格式固定为：**4 字节十六进制 ASCII 字符串表示后续负载的字节长度 + 负载本身**。注意这个长度是负载字节数的十六进制值，而不是把十进制字节数直接拼接成字符串——比如负载是 12 字节，前缀应该是 `000c`（12 的十六进制是 0xc），不是 `0012`。

直接用 `nc` 手动发请求就能看到效果：

```bash
# host:devices 共 12 字节，十六进制 0xc，前缀补齐为 4 位 -> 000c
echo -n "000chost:devices" | nc localhost 5037
```

Server 收到后返回 `OKAY`（成功）或 `FAIL`（失败）；对于像 `host:devices` 这样需要回数据的请求，`OKAY` 后面还会跟一个 4 字节十六进制长度 + 实际数据。返回值长这样：

```
OKAY0024emulator-5554	device
a1b2c3d4	device
```

`OKAY` 是 4 字节固定头，`0024` 表示后续数据长度 0x24 = 36 字节，后面就是设备列表。

长度前缀让接收方能精确知道要读多少字节，不需要依赖换行符或超时判断边界——这是很多自定义网络协议的通用实践。

再看 `host:transport`。这个命令不直接返回数据，而是告诉 Server："后续和这个设备的所有操作都走同一个连接"。Server 返回 `OKAY` 后，连接状态切换到设备透传模式，你接着发的任何数据都会被原样转发到 adbd。

一条 `adb shell ls` 命令的完整协议交互链条：

1. Client 发 `host:transport:<serial>` 选中设备
2. Client 发 `shell:ls` 请求执行命令
3. Server 把 `shell:ls` 透传给 adbd
4. adbd 执行命令，通过 Server 回传 stdout/stderr
5. Client 接收并打印结果

连接复用和状态切换的设计，让单连接承载多设备、多命令成为可能。

## 端口转发的实现机制

`adb forward` 和 `adb reverse` 是最常用但也最容易混淆的两个转发命令。

**正向转发 `adb forward tcp:8080 tcp:8080`**：

Server 在 PC 端监听 `localhost:8080`。有连接进来时，Server 通过设备传输通道向 adbd 发起 `tcp:8080` 连接请求，adbd 在设备端连接 `localhost:8080`，然后 Server 把两端的数据流对接起来。

```bash
# PC 端访问 localhost:8080 实际转发到设备的 8080 端口
adb forward tcp:8080 tcp:8080
```

**反向转发 `adb reverse tcp:8080 tcp:8080`**：

方向反过来——adbd 在设备端监听 8080 端口，设备上的流量通过 adbd → Server → PC 端 localhost。调试 WebView 或需要设备访问 PC 服务时很实用。

```bash
# 设备访问 localhost:8080 实际转发到 PC 的 8080 端口
adb reverse tcp:8080 tcp:8080
```

搞清"谁监听、谁连接"就抓住了本质：正向是 Server 监听、adbd 连接目标（PC 端主动）；反向是 adbd 监听、Server 连接目标（设备端主动）。理解这点后，Chrome DevTools 的 USB 调试、scrcpy 投屏等工具链的端口映射逻辑就一目了然了。

## adbd 守护进程的内部

adbd 的源码在 AOSP 的 `system/core/adb/` 下，核心逻辑集中在 `daemon/main.cpp` 和 `services.cpp`。从设备开机到可以接收命令，adbd 经历三个阶段：

**第一阶段：属性检查**。init 进程根据 `ro.debuggable` 和 `persist.sys.usb.config` 等系统属性决定是否启动 adbd。`ro.adb.secure=1` 时开启 RSA 认证，这是 Android 4.2.2 之后的安全基线。

**第二阶段：传输层初始化**。USB 模式走 `ffs`（Function File System），通过 gadget 驱动将设备模拟为 USB 外设；TCP 模式直接监听 `5555` 端口。两者可以同时启用。

**第三阶段：认证握手**。配对密钥存储在 `/data/misc/adb/adb_keys`，每行一个 Base64 编码的公钥。手机会弹出"允许 USB 调试"对话框，用户在 Settings 里的勾选本质上就是往这个文件追加一条公钥记录。

adbd 支持的服务类型在 `SERVICES` 表中注册，核心服务有：

| 服务名 | 功能 |
|--------|------|
| `shell:cmd` | 执行 shell 命令，返回 pty 或 raw 模式 |
| `sync:` | 文件传输协议，`adb push/pull` 的底层实现 |
| `framebuffer:` | 截屏服务，scrcpy 等投屏工具依赖此接口 |
| `jdwp:` | Java Debug Wire Protocol，IDE 调试的桥梁 |
| `abb_exec:` | Android Backup 服务入口 |

每种服务对应一个处理函数，adbd fork 子进程处理连接后 exec 到具体服务逻辑。

## 调试通道的完整数据流

把以上各层串起来，一条 `adb shell dumpsys activity` 命令的完整数据路径：

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

Step ③ 的传输通道取决于当前连接方式：USB 模式下通过 bulk endpoint 传输，TCP 模式走 socket。USB 模式其实也是在逻辑上封装为 socket 接口——adbd 内部有一个 `UsbFfsConnection` 类把 USB endpoint 封装成类似 socket 的读写语义，上层的传输逻辑不感知物理层差异。无论 USB 还是 Wi-Fi 连接，从 shell service 的视角看都一样。

## 实战：ADB 问题排查思路

踩过的坑多了，总结出一套快速定位 ADB 问题的方法：

**第一步：检查 Server 状态**。`adb kill-server && adb start-server` 是最直接的暴力恢复手段。如果 start-server 失败，用 `lsof -i :5037` 检查端口是否被占用。Chrome 的开发者工具、Genymotion、某些 VPN 软件都可能占 5037。

**第二步：判断问题出在哪一层**。`adb devices` 无输出说明 Server 到 Daemon 的链路断了，重点查 USB 连接和开发者选项；显示 `unauthorized` 是认证问题，检查设备端是否需要确认弹窗；显示 `offline` 说明 daemon 启动了但连接异常，大概率是 adbd 版本不匹配。

**第三步：无线调试的特殊坑**。`adb tcpip 5555` 切换后记得确认设备 IP，Wi-Fi 切网后 IP 会变。我在工位和会议室之间来回切换时经常因此断连，后来干脆写了个脚本自动检测当前 IP 重连。

遇到多设备并行调试的场景，善用 `adb -s <serial>` 指定目标设备，避免 `adb -d`（仅 USB 设备）和 `adb -e`（仅模拟器）的隐式选择带来的困惑。

整个 ADB 架构的设计精髓不在于协议有多复杂，而在于分层解耦后的组合能力——你能用原始协议手动发包调试，也能基于服务接口扩展自定义功能，每一层都可以独立理解和操作。
