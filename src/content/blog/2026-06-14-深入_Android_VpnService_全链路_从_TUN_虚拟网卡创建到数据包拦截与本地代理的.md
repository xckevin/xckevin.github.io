---
title: 深入 Android VpnService 全链路：从 TUN 虚拟网卡创建到数据包拦截与本地代理
excerpt: 深入剖析 Android VpnService 实现本地 VPN 代理的全链路技术，涵盖 TUN 虚拟网卡创建、IP 包解析、TCP 状态机维护、SOCKS5 转发及 NAT 地址转换等核心环节。
publishDate: '2026-06-14'
tags:
- Android
- VpnService
- 网络编程
- TCP/IP
- SOCKS5
seo:
  title: 深入 Android VpnService 全链路：从 TUN 虚拟网卡创建到数据包拦截与本地代理
  description: 详解 Android VpnService 从 TUN 虚拟网卡创建到数据包拦截与本地 SOCKS5 代理的完整实现链路，涵盖 IP 包解析、TCP 状态机维护和 NAT 地址转换。
---

去年接了一个需求：在不修改 App 代码的前提下，对指定域名的 HTTPS 请求做证书校验增强。常规方案是搭一个中间人代理，但意味着要改网络配置、装 CA 证书、改 Wi-Fi 代理——对普通用户来说门槛太高。

最终选了 **VpnService 本地 VPN**。核心思路：利用 Android 的 VpnService API 创建一块 TUN 虚拟网卡，把设备所有流量引过来，解析 IP 包后按规则转发或放行。本机跑一个轻量 SOCKS5 代理，需要拦截的请求走代理，其余直连。

下面拆解整条链路的实现细节。

## TUN 设备：流量入口的前置条件

VpnService 底层做的第一件事，是创建一块 **TUN（Tunnel）虚拟网络接口**。和 TAP 不同，TUN 工作在 IP 层（网络层），不处理以太网帧。这恰好匹配我们的场景——只关心 IP 包里封装的 TCP/UDP 数据，对链路层帧头没兴趣。

调用链：

```java
VpnService.Builder builder = new VpnService.Builder();
builder.setSession("MyVPN")
       .addAddress("10.0.0.2", 32)      // 本机在 VPN 子网的地址
       .addRoute("0.0.0.0", 0)          // 捕获所有流量
       .addDnsServer("8.8.8.8")
       .setMtu(1500)
       .establish();                     // 返回 ParcelFileDescriptor
```

`establish()` 返回的 `ParcelFileDescriptor` 就是 TUN 设备的读写句柄。从这里读出来的是原始 IP 包，写回去的也是原始 IP 包。这一步完成后，Android 系统会修改路由表，所有网络流量经由这个虚拟接口发出。

三个容易踩坑的地方：

1. `addRoute("0.0.0.0", 0)` 会拦截所有流量，包括 VPN 自身发出的请求。如果不做保护，代理请求也会被自家 VPN 拦截，形成死循环。需要用 `builder.addDisallowedApplication(packageName)` 或 `protect()` 方法排除自己的流量。
2. MTU 设太大可能导致分包，设太小增加包数量。1500 是以太网标准值，通常够用。
3. `addAddress` 的第二个参数是前缀长度，`32` 表示 `/32` 子网，即单机地址。只有多设备互联时才需要更大的子网。

拿到 `ParcelFileDescriptor` 后开两个线程：一个读线程从 TUN 收包，一个写线程向 TUN 发包。

## IP 包解析：从字节流还原协议栈

从 TUN 设备读到的 `ByteBuffer` 是完整的 IP 包。IPv4 头部结构固定——前 20 字节是标准头：

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Version|  IHL  |Type of Service|          Total Length         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Identification        |Flags|      Fragment Offset    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Time to Live |    Protocol   |         Header Checksum       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Source Address                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Destination Address                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

解析逻辑封装为一个工具类：

```java
public class IPPacket {
    public final int protocol;      // 6=TCP, 17=UDP
    public final int sourceIP;
    public final int destIP;
    public final byte[] payload;    // TCP/UDP 段的完整数据

    public static IPPacket parse(ByteBuffer buffer) {
        byte versionAndIHL = buffer.get();
        int protocol = buffer.get(9) & 0xFF;     // 第 10 字节
        int sourceIP = buffer.getInt(12);
        int destIP = buffer.getInt(16);

        int headerLength = (versionAndIHL & 0x0F) * 4;
        int totalLength = buffer.getShort(2) & 0xFFFF;

        buffer.position(headerLength);
        byte[] payload = new byte[totalLength - headerLength];
        buffer.get(payload);

        return new IPPacket(protocol, sourceIP, destIP, payload);
    }
}
```

第 10 字节（偏移 9）的 protocol 字段决定上层协议：`6` 是 TCP，`17` 是 UDP。解析出 sourceIP 和 destIP 后，就能判断这个包的去向——是发往拦截列表里的域名，还是直接放行。

## TCP 状态机：劫持一条连接的全过程

UDP 处理相对简单——无连接、无状态，解析出目的端口转发即可。TCP 则麻烦得多：它是有状态协议，三次握手、序列号、确认号、窗口大小都要正确维护。

劫持一条 TCP 连接时，我们扮演的是**中间人**：客户端以为在和目标服务器通信，实际是在和 VPN 本地代理对话；代理再去连接真实服务器。

这个过程需要维护一个精简的 TCP 状态机：

```java
enum TcpState { SYN_SENT, SYN_RCVD, ESTABLISHED, CLOSING }

class TcpConnection {
    TcpState state = TcpState.SYN_SENT;
    long mySeq, myAck;          // 我们的序列号和确认号
    long theirSeq, theirAck;    // 客户端的序列号
    InetSocketAddress dest;
}
```

收到 SYN 包时的关键处理：

```java
void handleSyn(TcpPacket syn) {
    this.dest = new InetSocketAddress(syn.destIP, syn.destPort);
    this.theirSeq = syn.seqNumber;

    // 发送 SYN-ACK，声明我们的初始序列号
    this.mySeq = generateISN();
    TcpPacket synAck = TcpPacket.create(
        syn.destPort, syn.sourcePort,  // 注意源目端口互换
        mySeq, theirSeq + 1,
        TcpFlags.SYN | TcpFlags.ACK
    );
    writeToTUN(synAck);
    this.state = TcpState.SYN_RCVD;
}
```

客户端收到 SYN-ACK 后回复 ACK，三次握手完成，连接进入 ESTABLISHED 状态。此后所有数据交互都需要正确递增序列号——TCP 字节流里每个字节占一个序号，发送方和接收方各自维护一套递增逻辑。

**踩过的一个坑：** 早期实现时没正确处理 TCP 窗口缩放选项（Window Scale），大文件传输速度直接掉到几十 KB/s。客户端在 SYN 包里带了 `wscale=7`（窗口乘以 128），但我们回 SYN-ACK 时没带这个选项，浏览器按默认窗口 65535 发数据，而我们按客户端声明的缩放因子计算——两边不对称，吞吐量骤降。解决方法是在 SYN-ACK 里原样回传 window scale 选项。

## 本地代理：SOCKS5 转发与连接保护

解析出的 TCP 流需要转发给本地代理。选 SOCKS5 而非 HTTP 代理，因为 SOCKS5 工作在会话层，TCP/UDP 都支持，握手协议极简（3 步），不会引入额外的 HTTP 头部解析开销。

本地 SOCKS5 服务在独立线程里监听 `127.0.0.1`：

```java
ServerSocket server = new ServerSocket(0);  // 随机端口
int proxyPort = server.getLocalPort();

new Thread(() -> {
    while (!closed) {
        Socket client = server.accept();
        // 第一次握手：客户端告知支持的认证方式
        // 第二次握手：服务端确认（通常选 0x00 无认证）
        // 第三次握手：客户端告知目标地址和端口
        // 建立到真实目标服务器的连接，双向转发数据
        handleSocks5(client);
    }
}).start();
```

SOCKS5 握手后拿到目标地址，建立到真实服务器的 TCP 连接，然后在 client 和 remote 之间做双向 pipe：

```java
void pipe(Socket client, Socket remote) {
    // 两个线程分别负责两个方向的数据拷贝
    // 注意：任一方断开都要关闭另一方
    // 这里用 try-with-resources 或 finally 确保资源释放
}
```

**VpnService.protect() 是整条链路的关键守卫。** 代理发出的 Socket 必须调用这个方法，否则代理流量也会被 TUN 设备捕获，形成无限回环：

```java
VpnService service = ...; // VpnService 实例
if (!service.protect(proxySocket)) {
    throw new RuntimeException("protect failed");
}
```

`protect()` 在系统路由表中标记这个 Socket，让 Linux 内核绕过 VPN 路由规则，直接走物理网卡出口。这个调用必须在 `connect()` 之前完成。

## 数据包重写：NAT 地址转换的要点

整条链路中，NAT（网络地址转换）有两个方向：

**上行（客户端 → TUN → 代理 → 服务器）：** 从 TUN 读到的 IP 包，源地址是设备真实 IP，目的地址是被拦截的目标。解析出 TCP payload 后，通过 SOCKS5 代理转发到真实服务器。这个方向不需要改地址——SOCKS5 协议已经指定了目标。

**下行（服务器 → 代理 → TUN → 客户端）：** 代理从服务器收到响应数据后，构造成 IP 包写回 TUN 设备。源 IP 必须填原始目标服务器的地址（客户端以为自己在和那个地址通信），目的 IP 填客户端地址。端口同理。

构造回包的核心逻辑：

```java
ByteBuffer buildResponsePacket(int srcIP, int srcPort,
                                int dstIP, int dstPort,
                                byte[] tcpPayload, long seq, long ack) {
    ByteBuffer packet = ByteBuffer.allocate(1500);

    // IPv4 头：version=4, IHL=5, total_length, TTL=64, protocol=6(TCP)
    packet.put((byte) 0x45);
    // ... 省略其他固定字段 ...
    packet.putInt(2, 20 + tcpPayload.length); // total length
    packet.putInt(12, srcIP);                  // source = 伪装成目标服务器
    packet.putInt(16, dstIP);                  // dest = 客户端地址

    // TCP 头：源端口、目的端口、序列号、确认号、窗口大小
    // ... 写入 TCP 头各字段 ...
    packet.put(tcpPayload);
    packet.flip();
    return packet;
}
```

TCP 校验和计算必须包含**伪头部**（pseudo-header），即源 IP、目的 IP、协议号、TCP 段长度。不少人只算了 TCP 段本身的校验和，客户端收到包直接丢弃——Wireshark 抓包一看全是 checksum error。

## 实践建议

整条链路跑通后，核心复杂度集中在三个地方：

**TCP 状态机的健壮性。** 只实现 SYN、SYN-ACK、ACK、FIN、RST 五个状态转换，正常网络环境够用，但弱网、重传、乱序场景会暴露大量边界 case。可靠性要求高的话，参考 Linux 内核的 TCP 有限状态机（RFC 793），把 TIME_WAIT 和 CLOSE_WAIT 也纳进来。

**性能瓶颈在数据拷贝。** 每个包从 TUN 读到用户态 Buffer，解析完再写回 TUN 或转发给代理 Socket，路径上有 3-4 次内存拷贝。追求吞吐量的话，用 `FileChannel.transferTo()` 做零拷贝，或者把代理逻辑下沉到 native 层用 raw socket 处理。

**UDP 的 NAT 超时问题。** UDP 没状态，NAT 表容易因映射过期而断流。DNS 这类短连接场景影响不大，但要代理 QUIC（HTTP/3）流量——QUIC 基于 UDP，连接持续时间长——就需要维护一张 UDP 映射表，定时发 keepalive 包续期。
