---
title: 'Android gRPC End to End: Protobuf Code Generation to Bidirectional Streaming for Client-Cloud Collaboration'
lang: en
translationKey: android-grpc-protobuf-bidirectional-streaming
slug: android-grpc-protobuf-bidirectional-streaming
excerpt: 'Starting from a real client-cloud voice assistant, this post walks through gRPC on Android: Protobuf contract generation, bidirectional streaming, and practical concerns such as threading, backpressure, and reconnection.'
publishDate: '2026-09-18'
tags:
- Android
- gRPC
- Protobuf
- Kotlin
- Networking
seo:
  title: 'Android gRPC: Protobuf Codegen to Bidirectional Streaming'
  description: 'Explore Android gRPC end to end: Protobuf code generation, bidirectional streaming, and practical concerns like threading, backpressure, and reconnection.'
  pageType: article
---

While building a client-cloud voice assistant, I ran into an unavoidable problem: the client has to keep uploading an audio stream, and the server has to return recognition and generation results in real time. REST only supports one question, one answer; WebSocket is full-duplex, but messages have no strong typing; MQTT is publish/subscribe oriented toward IoT, with weak method semantics. gRPC fills exactly this gap — it combines "remote method calls" with "binary streams" and uses Protobuf to provide the contract.

## Why gRPC

When choosing the stack, I compared three paths. REST + JSON is fast to develop, but for continuous data like audio, polling or chunked upload is awkward, and you pay in both latency and bandwidth. WebSocket's full-duplex is fine, but the server and client have to agree on message formats, handle partial packets and message fragmentation, and maintain a state machine themselves — which becomes a burden as soon as the project gets complex. MQTT's pub/sub fits device telemetry, but not "calling a method with arguments and getting a structured response."

gRPC uses HTTP/2 as its transport layer, natively supporting multiplexing and bidirectional streams. The key is that Protobuf pins down the interface contract: client and server generate code from the same `.proto` file, so field types and method signatures align at compile time. This matters especially for client-cloud collaboration: when the cloud team changes an interface, the client fails to compile immediately, instead of discovering after release that JSON fields don't match.

## The Protobuf generation pipeline

A typical voice interaction proto is defined like this:

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

`stream` appearing on both the request and response sides declares a bidirectional streaming method. At build time, the protobuf plugin generates three kinds of code: message serialization/deserialization, the server base class skeleton, and the client Stub.

In Android projects, I prefer the official `protobuf-gradle-plugin` paired with `grpc-java`. Generated code lands in the build/generated directory; what you actually care about is the client Stub:

```kotlin
val channel = ManagedChannelBuilder.forAddress(host, port)
    .useTransportSecurity()
    .build()
val stub = VoiceAssistantGrpc.newStub(channel)
```

`newStub` returns an asynchronous Stub that supports the observer pattern; `newBlockingStub` is for simple one-question-one-answer calls. Bidirectional streaming must use the asynchronous Stub, because it has to read and write at the same time.

## Implementing bidirectional streaming

The core of bidirectional streaming is an observer object. The client calls `stub.chat(observer)`, passing in the observer that receives server messages, and gets back the `StreamObserver` used for sending:

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

First, a pitfall I've hit: the threading semantics of `onNext`. gRPC calls back the observer on different threads by default, so touching the View directly inside it will crash. I make a habit of posting callback results to the main thread, or specifying an executor when constructing the channel.

Another pitfall is backpressure. Audio capture produces one frame every 20 ms, and sends pile up when the network jitters. `onNext` itself is an asynchronous submission and does not block; the underlying HTTP/2 flow control can be observed through `ClientCallStreamObserver.isReady()` to watch the peer's window, but the application layer still has to handle it itself. My approach is to maintain a send window: when unacknowledged chunks exceed a threshold, drop non-critical frames. In voice scenarios, dropping a few frames is cheaper than letting latency keep accumulating.

## Server side and client-cloud collaboration

The server implementation is just as simple — inherit the generated base class and override the `chat` method:

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

This pattern is perfectly symmetrical with the Android side: the observer returned by the server receives client data, and `responseObserver` writes results back. Cloud AI engines are often asynchronous callbacks too, which maps directly onto this interface.

In real projects, I have mobile and cloud share a single proto repository. CI generates Android's Java/Kotlin code and the cloud's Go/Python code from the same proto, so any field change on either side surfaces at the generation stage. Compared with JSON over WebSocket's "convention-based interface", this is a genuine compile-time contract.

## A few practical judgments

Bidirectional streaming is not a silver bullet. For interfaces that are only "one question, one answer," a unary RPC is simpler, and the server is also easier to load-balance — long-lived connection streams stick to a single backend.

Mobile needs to handle network switching. When Wi-Fi switches to cellular, the HTTP/2 connection drops; do exponential backoff reconnection in `onError`, while giving the user a "reconnecting" state.

For debugging, `grpcurl` and `grpcui` are more useful than Postman: the former calls methods from the command line, and the latter has a web interface where you can see the timing of streamed messages directly.

I lean toward using gRPC instead of WebSocket for client-cloud AI real-time interaction: the three capabilities of contract, flow control, and bidirectional streaming are worth far more than the small integration cost they save.
