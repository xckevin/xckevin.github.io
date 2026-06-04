---
title: "What Is Android Binder? A Practical Guide to the Binder IPC Model"
lang: en
translationKey: android-binder
slug: android-binder
excerpt: "A question-driven explanation of Android Binder, why system services depend on it, and which roles participate in a cross-process call."
publishDate: '2026-06-01'
tags:
- "Android"
- "Binder"
- "Framework"
- "IPC"
seo:
  title: "What Is Android Binder? An Introduction to the Binder IPC Model"
  description: "A practical introduction to Android Binder for developers, covering Client, Server, ServiceManager, Binder Driver, AIDL, and system service calls."
  pageType: article
---

Android Binder is the core inter-process communication mechanism in Android. When an app calls a system service, when system services coordinate with each other, or when an AIDL interface is invoked, Binder is usually somewhere underneath.

In one sentence: Binder lets one process call an object in another process almost as if it were a local object, while the kernel handles forwarding, caller identity, reference management, and death notifications.

## What problem does Binder solve?

Android apps run in isolated processes. That isolation is good for security, but it creates an immediate problem: when an app wants ActivityManagerService to start an Activity, WindowManagerService to create a window, or PackageManagerService to query package metadata, it cannot directly access objects inside the system service process.

Binder turns a method call into three parts:

1. The Client writes the method code and arguments into a `Parcel`.
2. The Binder Driver transfers the transaction through the kernel to the target process.
3. The Server reads the `Parcel`, runs the real method, and writes the result back.

To the caller, it looks like a normal interface call. To the system, it is an IPC protocol with permission checks and lifecycle management.

## Which roles participate in a Binder call?

The typical path includes four roles: Client, Proxy, Binder Driver, and Stub.

The Client holds a remote object proxy. The Proxy serializes the method call into a `Parcel` and calls `transact()`. The Binder Driver receives the transaction, finds the target process from the Binder reference, and places the transaction into the target thread's queue. On the Server side, the Stub receives the request, calls the local implementation, and writes the result back.

ServiceManager is another key role. After a system service starts, it registers its Binder object with ServiceManager. When an app needs that service, it first looks up the Binder reference by name, then uses that reference for later calls. Many paths behind `Context.getSystemService()` eventually land in this model.

## How AIDL relates to Binder

AIDL is not Binder itself. It is a tool that generates Binder boilerplate for you. You write a `.aidl` interface, and the compiler generates `Stub` and `Proxy` code. The Client calls the Proxy, the Proxy writes the Parcel, the Server extends the Stub, and the Stub unpacks the Parcel and dispatches to the real implementation.

You can write Binder code by hand, but it is easy to get wrong: method codes, parameter order, exception handling, and interface versions all have to be maintained manually. AIDL's value is that it consolidates this boilerplate so developers can focus on the interface contract.

Keep two things in mind when working with AIDL. First, AIDL calls are synchronous and blocking by default, so the Client thread waits for the Server to return. If the Server is slow, the caller is slow too. Second, cross-process transfer does not "send objects" in the local-object sense. It serializes data. Complex objects need `Parcelable`, and large payloads increase copying and memory pressure.

## Why system services are a natural fit for Binder

Sockets can also communicate across processes, but Binder is much closer to what Android system services need.

Binder carries caller identity, so the Server can check permissions using the caller's UID and PID. It supports death notifications, so a process can receive `binderDied` when a remote process exits. It supports object references, so remote objects can be passed as parameters. It also plugs directly into Android's system service registration and lookup mechanism.

These capabilities make Binder more than a communication channel. It is the object model of the Android Framework. AMS, WMS, PMS, InputManager, and the media services can all organize their interface boundaries around Binder.

## How to inspect Binder during performance work

Binder calls are not inherently slow. The risky pattern is making synchronous Binder calls on the main thread, or calling into a system service that is itself backed up. In Perfetto, look at `binder transaction` slices, main-thread blocking spans, and the target service thread state. If the main thread is stopped inside Binder, do not stop at app-side code. Keep following the Server side to see whether it is waiting on a lock, waiting on I/O, or saturated by other requests.

A few practical rules help in day-to-day development: avoid dense system service queries before first frame, do not split batch work into many tiny Binder calls, handle death notifications for cross-process callbacks, keep large AIDL payloads under control, and check whether a system service call can block before making it on the main thread.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Android Framework](/en/android-framework/)
- [Android Binder internals: from driver communication to the AIDL call chain](/blog/binder-ipc机制深度解析-beyond-aidl/)
- [Android Framework system services: how AMS, WMS, and app processes interact](/blog/android系统服务与framework层交互模型/)
- [Getting started with Android Perfetto: capture traces, read tracks, and diagnose performance](/blog/android-perfetto/)
<!-- /seo-internal-links -->
