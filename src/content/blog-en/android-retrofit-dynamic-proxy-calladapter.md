---
title: 'Inside Retrofit: Dynamic Proxies and Coroutine Call Adapters'
lang: en
translationKey: android-retrofit-dynamic-proxy-calladapter
slug: android-retrofit-dynamic-proxy-calladapter
excerpt: 'Break down Retrofit network layer end to end: from JDK dynamic proxy intercepting interface methods, to annotation parsing generating request templates, to OkHttp lazy-execution bridging and CallAdapter coroutine adaptation, revealing the plugin-based design behind declarative HTTP architecture.'
publishDate: '2026-08-29'
tags:
- Android
- Retrofit
- Kotlin
- OkHttp
- Coroutines
seo:
  title: 'Android Retrofit Network Layer: Dynamic Proxy to CallAdapter'
  description: See how Retrofit turns annotated interfaces into requests through JDK proxies, annotation parsing, OkHttp calls, and coroutine CallAdapters.
  pageType: article
---

While troubleshooting an online memory leak, I stared at an `ApiService` interface for a long time—it only declared `@GET` annotations and abstract methods, yet at runtime it returned real user objects. The interface has no implementation class, so what exactly is Retrofit doing behind the scenes?

The answer lies in a single line: `Proxy.newProxyInstance`. The core of Retrofit is not the annotations, but a pipeline that translates "declarations" into "executable requests." This pipeline has four stages: dynamic proxy interception, annotation parsing, OkHttp bridging, and coroutine adaptation. Taken apart, the so-called "network framework" is nothing more than JDK reflection, OkHttp, and Kotlin coroutines stitched together.

## Dynamic Proxy: The Interface's Invisible Implementation

Retrofit's entry point is `Retrofit.create(Class)`. It does not generate an implementation class for `ApiService`; instead it borrows the JDK Dynamic Proxy to create a proxy object at runtime. The core logic is as follows:

```java
public <T> T create(final Class<T> service) {
  return (T) Proxy.newProxyInstance(service.getClassLoader(),
      new Class<?>[] { service },
      new InvocationHandler() {
        @Override public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
          // 方法来自 Object（equals/hashCode/toString）时，直接调用 method.invoke(this, args)，
          // 让它在 InvocationHandler 实例自己上执行，而不是转发到代理对象
          if (method.getDeclaringClass() == Object.class) {
            return method.invoke(this, args);
          }
          return loadServiceMethod(service, method).invoke(proxy, args);
        }
      });
}
```

One easily misunderstood detail here: the first argument to `method.invoke(this, args)` is `this` (the current `InvocationHandler` instance), not `proxy`. The reason is that `equals`/`hashCode`/`toString` already have default implementations on `InvocationHandler`'s own class (inherited from `Object` via the anonymous class), so executing them directly on `this` gives a sensible result. There is no need to route them back to the proxy object itself—doing so would actually fail because the method is not declared on the interface. Only real interface method calls go through `loadServiceMethod(service, method).invoke(proxy, args)`.

Whenever the proxy object receives any method call, it is intercepted by `InvocationHandler`, which distinguishes two cases: `Object` methods such as `equals`, `hashCode`, and `toString` execute on the handler instance itself, while real interface methods are handed to `loadServiceMethod`.

Inside `loadServiceMethod`, a `ConcurrentHashMap` caches the result. Each interface method is parsed only once, and later calls hit the cache directly. This step cannot be skipped: annotation parsing must traverse every annotation on the method, which is expensive, and caching avoids re-parsing on every request.

## Annotation Parsing: Translating Methods into Request Templates

`loadServiceMethod` returns a `ServiceMethod`, and the one doing the real work is `HttpServiceMethod`. It holds a `RequestFactory`, a `CallAdapter`, and a response converter; `RequestFactory` is responsible for translating annotations into HTTP request metadata.

```java
for (Annotation annotation : method.getAnnotations()) {
  parseMethodAnnotation(annotation); // 解析 @GET、@POST、@Headers
}
int parameterCount = parameterAnnotationsArray.length;
// 再逐个解析 @Path、@Query、@Body 等参数注解
```

What `RequestFactory` produces is not a real request, but a "template": the relative path `users/{id}`, the HTTP method, request headers, and how each parameter is handled. For example, `@Path("id")` records "take a value from here at runtime and replace the URL placeholder."

There is one detail that is easy to trip over: `@Query` supports `Map` and `Iterable`, while `@Body` supports arbitrary objects. The parser decides, based on the parameter type, whether to concatenate a query string or go through serialization. This "dispatch by type" logic is hard-coded in `RequestFactory`, which is why the stack trace usually points to this layer when a parameter type is wrong.

After template parsing completes, `HttpServiceMethod.invoke` starts constructing the request:

```java
@Override
final ReturnT invoke(Object[] args) {
  Call<ResponseT> call = new OkHttpCall<>(requestFactory, args, callFactory, responseConverter);
  return adapt(call, args);
}
```

`OkHttpCall` packages the template, the actual arguments, OkHttp's `Call.Factory`, and the response converter together, but no network request has been issued yet. What determines the final return type is the `adapt` step that follows.

## OkHttp Bridging: The Lazy-Execution Semantics of Call

`OkHttpCall` is the bridge between Retrofit and OkHttp. It implements Retrofit's own `Call<T>` interface and internally holds a lazily created `okhttp3.Call`.

```java
@Override
public void enqueue(Callback<T> callback) {
  okhttp3.Call call;
  synchronized (this) {
    if (executed) throw new IllegalStateException("Already executed.");
    executed = true;
    call = getRawCall();
  }
  call.enqueue(new okhttp3.Callback() {
    @Override public void onResponse(okhttp3.Call call, okhttp3.Response raw) {
      callback.onResponse(OkHttpCall.this, parseResponse(raw));
    }
    @Override public void onFailure(okhttp3.Call call, IOException e) {
      callback.onFailure(OkHttpCall.this, e);
    }
  });
}
```

The key is `getRawCall`: it calls `RequestFactory.create(args)` to combine the template and real parameters into an `okhttp3.Request`, then hands that to `Call.Factory.newCall`. That is why OkHttp's `Call` is only created at the moment the request is actually fired—this is "lazy execution."

The `executed` flag guarantees that a `Call` can be executed only once. I have stepped on this exact pitfall: the same `Call` object was awaited once in each of two coroutines, and the second await threw `IllegalStateException` immediately. Retrofit's `Call` is single-use; to reuse it you have to call the interface method again and get a new `Call`.

## CallAdapter: The Bridge from Call to Coroutines

`adapt` is Retrofit's most extensible design. `CallAdapter<ResponseT, ReturnT>` does exactly one thing: convert `Call<ResponseT>` into an arbitrary return type `ReturnT`. It is a user-extensible interface—RxJava and Guava integration both come from implementing `CallAdapter.Factory`. By default (with no extra adapter), the method returns the `Call<T>` itself directly.

Support for Kotlin `suspend` functions takes a different path. It is **not** done through the user-extensible `CallAdapter`, but through a special handling path built into Retrofit's `HttpServiceMethod`. During annotation parsing, `RequestFactory` detects whether the method's last parameter type is `kotlin.coroutines.Continuation` (this is where the `isKotlinSuspendFunction` flag comes from). Once it matches, `HttpServiceMethod.parseAnnotations` no longer goes through the regular `CallAdapted` branch, but instead constructs one of two inner classes—`SuspendForBody` or `SuspendForResponse`, distinguished by whether the return value is `Response<T>`. These inner classes still ask `Retrofit.callAdapter` for a `CallAdapter<ResponseT, Call<ResponseT>>`—by default that adapter simply passes the `Call` through unchanged—but the actual suspending semantics happen after obtaining that `Call`, via `KotlinExtensions.await`/`awaitResponse`. These are two different paths from the extension mechanism of user-defined `CallAdapter.Factory`: `CallAdapter` targets the general extension point of "converting Call to other return types," whereas `suspend` support is special-case logic that can be recognized at compile time and is hard-coded inside the library.

The core logic of `KotlinExtensions.await` is equivalent to:

```kotlin
suspend fun <T : Any> Call<T>.await(): T = suspendCancellableCoroutine { continuation ->
  continuation.invokeOnCancellation { cancel() }
  enqueue(object : Callback<T> {
    override fun onResponse(call: Call<T>, response: Response<T>) {
      if (response.isSuccessful) {
        continuation.resume(response.body()!!)
      } else {
        continuation.resumeWithException(HttpException(response))
      }
    }
    override fun onFailure(call: Call<T>, t: Throwable) {
      continuation.resumeWithException(t)
    }
  })
}
```

This snippet explains two behaviors. Canceling the coroutine also cancels the underlying OkHttp request, thanks to `invokeOnCancellation { cancel() }`. Non-2xx responses throw `HttpException` instead of returning `null`—a detail beginners often miss in error handling.

`CallAdapter` lets Retrofit integrate RxJava, Guava, and Kotlin coroutines without changing the core pipeline. I prefer the coroutine version: cancellation semantics are clear, and there is no need to hand-write `disposable` management for every interface.

## Converter: The Boundary Between Serialization and Deserialization

The final stage of the pipeline is `Converter`, which works in two directions: on the request side it serializes a `@Body` object into a `RequestBody`, and on the response side it deserializes a `ResponseBody` into an object.

```java
public interface Converter<F, T> {
  T convert(F value) throws IOException;
}
```

Gson's response converter is straightforward: it takes the `ResponseBody` character stream and passes it to `Gson.fromJson`. The request direction works the same way, using `toJson` to produce a `RequestBody`.

Retrofit binds a `responseConverter` to each `Call` in advance, and conversion happens inside `OkHttpCall.parseResponse`, not at the coroutine layer. Therefore, when the backend returns JSON that does not match the expected structure, the exception is thrown on the IO thread and can be caught normally with `try/catch` in the coroutine.

When the return type is written as `Call<ResponseBody>`, Retrofit skips deserialization and hands you the raw stream directly. This style suits file downloads or streaming responses; forgetting to call `close()` will leak the connection.

## Practical Advice

To troubleshoot Retrofit issues, the fastest way to locate the problem is to follow this pipeline:

1. **Wrong parameters or URL**, look at `RequestFactory`'s parsing result; set a breakpoint on the `create` method.
2. **Wrong return type or an odd exception type**, look at the `CallAdapter` branch and confirm whether it goes through coroutine `await` or a custom adapter.
3. **Deserialization crash**, look at the `Converter`, confirm whether the return type matches the actual JSON structure, and don't confuse the `@Body` object with the response object.

Once you understand this pipeline, Retrofit is no longer a black box. The essence of declarative HTTP is using a dynamic proxy to turn interface declarations into request templates, then using CallAdapter and Converter to decouple the cross-cutting "request–response" flow into replaceable plugins.
