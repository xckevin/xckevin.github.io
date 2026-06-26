---
title: "Android VpnService End-to-End: TUN Virtual Interface to Packet Interception and Local Proxy"
lang: en
translationKey: android-vpnservice-tun-packet-interception
slug: android-vpnservice-tun-packet-interception
excerpt: "A practical walkthrough of building a local VPN proxy on Android with VpnService, covering TUN interface creation, IP packet parsing, TCP state machine maintenance, SOCKS5 forwarding, and NAT."
publishDate: '2026-06-14'
tags:
- "Android"
- "VpnService"
- "Networking"
- "TCP/IP"
- "SOCKS5"
seo:
  title: "Android VpnService Internals: TUN Interface to Local SOCKS5 Proxy"
  description: "End-to-end guide to Android VpnService: TUN virtual interface creation, IP packet parsing, TCP state machine, SOCKS5 forwarding, and NAT address translation."
  pageType: article
---

Last year I took on a requirement: enhance certificate validation for HTTPS requests to specific domains, without modifying the app's code. The conventional approach is a man-in-the-middle proxy, but that means changing network settings, installing a CA certificate, and configuring a Wi-Fi proxy — too high a barrier for ordinary users.

We went with a **VpnService local VPN**. The core idea: use Android's VpnService API to create a TUN virtual network interface, pull all device traffic through it, parse IP packets, then forward or bypass traffic based on rules. A lightweight SOCKS5 proxy runs locally — requests that need interception go through the proxy, everything else goes direct.

Here is the breakdown of the end-to-end flow.

## TUN Interface: The Traffic Entry Precondition

The first thing VpnService does at the lower level is create a **TUN (Tunnel) virtual network interface**. Unlike TAP, TUN operates at the IP layer (network layer) and does not handle Ethernet frames. That matches our scenario exactly — we only care about the TCP/UDP data encapsulated in IP packets, not link-layer frame headers.

The call chain:

```java
VpnService.Builder builder = new VpnService.Builder();
builder.setSession("MyVPN")
       .addAddress("10.0.0.2", 32)      // our address in the VPN subnet
       .addRoute("0.0.0.0", 0)          // capture all traffic
       .addDnsServer("8.8.8.8")
       .setMtu(1500)
       .establish();                     // returns ParcelFileDescriptor
```

The `ParcelFileDescriptor` returned by `establish()` is the read/write handle to the TUN device. Reading from it yields raw IP packets; writing to it injects raw IP packets. Once this completes, Android modifies the routing table so all network traffic flows out through this virtual interface.

Three common pitfalls:

1. `addRoute("0.0.0.0", 0)` captures all traffic, including the VPN's own outgoing requests. Without protection, proxy traffic gets intercepted by its own VPN, creating a loop. Use `builder.addDisallowedApplication(packageName)` or the `protect()` method to exclude your own traffic.
2. An MTU that is too large causes fragmentation; too small increases packet count. 1500 is the Ethernet standard and usually sufficient.
3. The second argument to `addAddress` is the prefix length. `32` means a `/32` subnet — a single-host address. You only need a larger subnet when multiple devices must communicate.

After obtaining the `ParcelFileDescriptor`, spawn two threads: a read thread to receive packets from TUN, and a write thread to send packets to TUN.

## IP Packet Parsing: Rebuilding the Protocol Stack from a Byte Stream

The `ByteBuffer` read from the TUN device is a complete IP packet. The IPv4 header structure is fixed — the first 20 bytes are the standard header:

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

The parsing logic, wrapped in a utility class:

```java
public class IPPacket {
    public final int protocol;      // 6=TCP, 17=UDP
    public final int sourceIP;
    public final int destIP;
    public final byte[] payload;    // full TCP/UDP segment data

    public static IPPacket parse(ByteBuffer buffer) {
        byte versionAndIHL = buffer.get();
        int protocol = buffer.get(9) & 0xFF;     // 10th byte
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

The protocol field at byte 10 (offset 9) determines the upper-layer protocol: `6` is TCP, `17` is UDP. Once you have the source and destination IPs, you can decide where this packet is headed — a domain on the interception list, or straight through.

## TCP State Machine: Hijacking a Connection

UDP handling is relatively simple — connectionless and stateless, just parse the destination port and forward. TCP is far more involved: it is a stateful protocol. Three-way handshake, sequence numbers, acknowledgment numbers, and window sizes all need correct maintenance.

When hijacking a TCP connection, we play **man-in-the-middle**: the client thinks it is talking to the target server, but is actually talking to the VPN's local proxy; the proxy then connects to the real server.

This requires maintaining a minimal TCP state machine:

```java
enum TcpState { SYN_SENT, SYN_RCVD, ESTABLISHED, CLOSING }

class TcpConnection {
    TcpState state = TcpState.SYN_SENT;
    long mySeq, myAck;          // our sequence and acknowledgment numbers
    long theirSeq, theirAck;    // the client's sequence number
    InetSocketAddress dest;
}
```

Key handling when a SYN packet arrives:

```java
void handleSyn(TcpPacket syn) {
    this.dest = new InetSocketAddress(syn.destIP, syn.destPort);
    this.theirSeq = syn.seqNumber;

    // Send SYN-ACK, declaring our initial sequence number
    this.mySeq = generateISN();
    TcpPacket synAck = TcpPacket.create(
        syn.destPort, syn.sourcePort,  // note: source/dest ports swapped
        mySeq, theirSeq + 1,
        TcpFlags.SYN | TcpFlags.ACK
    );
    writeToTUN(synAck);
    this.state = TcpState.SYN_RCVD;
}
```

The client receives the SYN-ACK and replies with ACK. The three-way handshake completes, and the connection enters ESTABLISHED. From here, every data exchange must correctly increment sequence numbers — in a TCP byte stream, every byte occupies one sequence number, and sender and receiver each maintain their own incrementing logic.

**A bug I hit:** an early implementation did not handle the TCP Window Scale option correctly, and large-file transfer speed dropped to tens of KB/s. The client carried `wscale=7` (multiply window by 128) in its SYN packet, but our SYN-ACK did not include the option. The browser sent data based on the default 65535 window, while we calculated using the client's declared scale factor — the two sides were asymmetric, and throughput collapsed. The fix was to echo the window scale option back in the SYN-ACK.

## Local Proxy: SOCKS5 Forwarding and Connection Protection

The parsed TCP stream needs to be forwarded to a local proxy. We chose SOCKS5 over HTTP proxy because SOCKS5 operates at the session layer, supports both TCP and UDP, has a minimal three-step handshake, and introduces no extra HTTP header parsing overhead.

The local SOCKS5 server listens on `127.0.0.1` in a dedicated thread:

```java
ServerSocket server = new ServerSocket(0);  // random port
int proxyPort = server.getLocalPort();

new Thread(() -> {
    while (!closed) {
        Socket client = server.accept();
        // Handshake 1: client announces supported auth methods
        // Handshake 2: server selects (usually 0x00 no-auth)
        // Handshake 3: client sends target address and port
        // Connect to the real target server, bidirectionally pipe data
        handleSocks5(client);
    }
}).start();
```

After the SOCKS5 handshake yields the target address, open a TCP connection to the real server, then pipe data bidirectionally between client and remote:

```java
void pipe(Socket client, Socket remote) {
    // Two threads, each copying data in one direction
    // Important: when one side disconnects, close the other
    // Use try-with-resources or finally to ensure cleanup
}
```

**`VpnService.protect()` is the critical guard of the entire chain.** Sockets created by the proxy must call this method, otherwise proxy traffic is captured by the TUN device, creating an infinite loop:

```java
VpnService service = ...; // the VpnService instance
if (!service.protect(proxySocket)) {
    throw new RuntimeException("protect failed");
}
```

`protect()` marks the socket in the system routing table so the Linux kernel bypasses VPN routing rules and sends it straight out the physical interface. This call must happen before `connect()`.

## Packet Rewriting: NAT Essentials

NAT (Network Address Translation) runs in two directions along this chain.

**Uplink (client → TUN → proxy → server):** The IP packet read from TUN has the device's real IP as source and the intercepted target as destination. After parsing out the TCP payload, it is forwarded to the real server via the SOCKS5 proxy. No address rewrite is needed in this direction — SOCKS5 already specifies the target.

**Downlink (server → proxy → TUN → client):** After the proxy receives response data from the server, it constructs an IP packet and writes it back to the TUN device. The source IP must be the original target server's address (the client thinks it is talking to that address), and the destination IP is the client's address. Ports likewise.

Core logic for building a response packet:

```java
ByteBuffer buildResponsePacket(int srcIP, int srcPort,
                                int dstIP, int dstPort,
                                byte[] tcpPayload, long seq, long ack) {
    ByteBuffer packet = ByteBuffer.allocate(1500);

    // IPv4 header: version=4, IHL=5, total_length, TTL=64, protocol=6(TCP)
    packet.put((byte) 0x45);
    // ... other fixed fields omitted ...
    packet.putInt(2, 20 + tcpPayload.length); // total length
    packet.putInt(12, srcIP);                  // source = spoofed as target server
    packet.putInt(16, dstIP);                  // dest = client address

    // TCP header: source port, dest port, seq, ack, window size
    // ... write TCP header fields ...
    packet.put(tcpPayload);
    packet.flip();
    return packet;
}
```

The TCP checksum must include a **pseudo-header** (source IP, destination IP, protocol number, TCP segment length). Many implementations only compute the checksum over the TCP segment itself — the client receives the packet and immediately drops it. A Wireshark capture shows nothing but checksum errors.

## Practical Recommendations

Once the end-to-end flow is running, the core complexity concentrates in three areas.

**TCP state machine robustness.** Implementing only the five transitions — SYN, SYN-ACK, ACK, FIN, RST — is sufficient for normal network conditions, but weak networks, retransmissions, and out-of-order delivery expose many edge cases. For high reliability, refer to the Linux kernel's TCP finite state machine (RFC 793) and bring TIME_WAIT and CLOSE_WAIT into scope.

**Performance bottleneck is data copying.** Every packet travels from TUN to a userspace buffer, gets parsed, then is written back to TUN or forwarded to a proxy socket — 3 to 4 memory copies along the path. For throughput, use `FileChannel.transferTo()` for zero-copy, or push the proxy logic down to the native layer with raw sockets.

**UDP NAT timeout.** UDP is stateless, and NAT table entries expire easily. Short-lived connections like DNS are not significantly affected, but proxying QUIC (HTTP/3) traffic — QUIC runs over UDP with long-lived connections — requires maintaining a UDP mapping table with periodic keepalive packets to renew entries.
