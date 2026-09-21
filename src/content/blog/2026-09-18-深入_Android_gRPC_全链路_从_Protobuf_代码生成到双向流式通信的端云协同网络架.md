---
slug: android-grpc-protobuf-bidirectional-streaming
translationKey: android-grpc-protobuf-bidirectional-streaming
title: 深入 Android gRPC 全链路：从 Protobuf 代码生成到双向流式通信的端云协同网络架构
excerpt: 本文从端云协同语音助手的实际需求出发，剖析 gRPC 在 Android 端的使用：Protobuf 契约生成、双向流式通信实现，以及线程、背压、重连等实践要点。
publishDate: '2026-09-18'
tags:
- Android
- gRPC
- Protobuf
- Kotlin
- 网络架构
seo:
  title: 深入 Android gRPC 全链路：从 Protobuf 代码生成到双向流式通信的端云协同网络架构
  description: 从端云协同语音助手出发，详解 Android 端 gRPC 全链路：Protobuf 代码生成、双向流式通信实现，以及线程、背压、重连等实战要点。
---

做端云协同的语音助手时，我遇到一个绕不开的问题：客户端要持续上传音频流，服务端要实时返回识别和生成结果。REST 只能一问一答；WebSocket 全双工，但消息没有强类型约束；MQTT 偏 IoT 的发布订阅，方法语义很弱。gRPC 正好补上这块拼图——它把「远程方法调用」和「二进制流」结合起来，再用 Protobuf 提供契约。

## 为什么是 gRPC

选型时我对比过三条路。REST + JSON 开发快，可音频这类连续数据用轮询或 chunk 上传很别扭，延迟和带宽都吃亏。WebSocket 全双工没问题，但服务端和客户端得自己约定消息格式、处理半包粘包、维护状态机，项目一复杂就成了负担。MQTT 的 pub/sub 适合设备遥测，不适合「调用带参数的方法并拿到结构化响应」。

gRPC 用 HTTP/2 做传输层，天然支持多路复用和双向流。关键是 Protobuf 把接口契约固定下来，客户端和服务端从同一个 .proto 文件生成代码，字段类型、方法签名在编译期就对齐。这一点对端云协同尤其重要：云端团队改接口，客户端编译立刻报错，而不是上线后才发现 JSON 字段对不上。

## Protobuf 生成链路

一个典型的语音交互 proto 这样定义：

```proto
syntax = "proto3";

service VoiceAssistant {
  rpc Chat(stream AudioChunk) returns (stream AssistantReply);
}

message AudioChunk {
  bytes data = 1;
  int32 sample_rate = 2;
}

message AssistantReply {
  string text = 1;
  bool is_final = 2;
}
```

`stream` 出现在请求和响应两侧，声明的是双向流（Bidirectional Streaming）方法。构建时 protobuf 插件生成三类代码：消息的序列化/反序列化、服务端基类骨架、客户端 Stub。

Android 项目里我倾向用官方 `protobuf-gradle-plugin` 配 `grpc-java`。生成代码落在 build/generated 目录，真正要关心的是客户端 Stub：

```kotlin
val channel = ManagedChannelBuilder.forAddress(host, port)
    .useTransportSecurity()
    .build()
val stub = VoiceAssistantGrpc.newStub(channel)
```

`newStub` 返回异步 Stub，支持观察者模式；`newBlockingStub` 留给简单的一问一答。双向流必须用异步 Stub，因为它要同时读写。

## 双向流的实现

双向流的核心是一个观察者对象。客户端调用 `stub.chat(observer)`，传入接收服务端消息的 observer，拿到用于发送的 `StreamObserver`：

```kotlin
val requestObserver = stub.chat(object : StreamObserver<AssistantReply> {
    override fun onNext(reply: AssistantReply) {
        // 服务端推回结果
        renderText(reply.text)
    }
    override fun onError(t: Throwable) {
        // 断流处理，触发重连
        reconnect()
    }
    override fun onCompleted() {
        // 服务端关闭流
    }
})

// 采集音频后持续发送
audioSource.setOnChunk { pcm ->
    requestObserver.onNext(
        AudioChunk.newBuilder()
            .setData(ByteString.copyFrom(pcm))
            .setSampleRate(16000)
            .build()
    )
}
```

先说一个踩过的坑：`onNext` 的线程语义。gRPC 默认在不同线程回调 observer，直接在里面碰 View 会崩。我习惯把回调结果 post 到主线程，或者在构造 channel 时指定 executor。

另一个坑是背压（Backpressure）。音频采集 20 ms 一帧，网络抖动时发送会堆积。`onNext` 本身是异步提交，不会阻塞，底层 HTTP/2 的流控可以通过 `ClientCallStreamObserver.isReady()` 观察对端窗口，但应用层还是得自己兜底。我的做法是维护一个发送窗口：未确认的 chunk 超过阈值就丢非关键帧。语音场景丢几帧，比延迟不断累积划算。

## 服务端与端云协同

服务端实现同样简单——继承生成的基类，重写 `chat` 方法：

```kotlin
override fun chat(responseObserver: StreamObserver<AssistantReply>):
        StreamObserver<AudioChunk> {
    return object : StreamObserver<AudioChunk> {
        override fun onNext(chunk: AudioChunk) {
            // 送入 ASR/TTS 引擎，结果回写
            engine.feed(chunk.data.toByteArray()) { text, isFinal ->
                responseObserver.onNext(
                    AssistantReply.newBuilder()
                        .setText(text)
                        .setIsFinal(isFinal)
                        .build()
                )
            }
        }
        override fun onError(t: Throwable) {
            responseObserver.onError(t)
        }
        override fun onCompleted() {
            responseObserver.onCompleted()
        }
    }
}
```

这个模式和 Android 端完全对称：服务端返回的 observer 接收客户端数据，`responseObserver` 回写结果。云端 AI 引擎往往也是异步回调，正好映射到这个接口上。

实际项目里我让移动端和云端共用一份 proto 仓库。CI 从同一份 proto 生成 Android 的 Java/Kotlin 代码和云端的 Go/Python 代码，任何一方的字段变更都在生成阶段暴露。相比 JSON over WebSocket 的「约定式接口」，这是实打实的编译期契约。

## 几个实践判断

双向流不是银弹。只有「一问一答」的接口，用一元 RPC（Unary RPC）更简单，服务端也更好做负载均衡——长连接流会黏在单个后端上。

移动端要处理网络切换。Wi-Fi 切蜂窝时 HTTP/2 连接会断，在 `onError` 里做指数退避（Exponential Backoff）重连，同时给用户一个「正在重连」的状态。

调试时 `grpcurl` 和 `grpcui` 比 Postman 好用：前者命令行调方法，后者有 Web 界面，能直观看到流式消息的时序。

我更倾向在端云 AI 实时交互里用 gRPC 替代 WebSocket：契约、流控、双向流这三个能力，比省掉的那点接入成本值钱得多。
