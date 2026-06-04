---
title: "Android Hidden APIs: From @hide to Greylist and Blacklist"
lang: en
translationKey: android-hidden-api-greylist-blacklist
slug: android-hidden-api-greylist-blacklist
excerpt: "Android exposes a rich public SDK, but many framework methods and fields are hidden with @hide. This article explains hidden API categories, runtime enforcement, greylists, blacklists, source generation, and safer compatibility strategies."
publishDate: 2024-06-18
tags:
- "Android"
- "Hidden APIs"
- "Framework"
- "Compatibility"
seo:
  title: "Android Hidden APIs: @hide, Greylist, Blacklist, and Compatibility"
  description: "Understand Android hidden APIs, @hide annotations, greylist and blacklist enforcement, source-level generation, runtime risks, and safer migration choices."
  pageType: article
---
Android is a complex open-source operating system that gives developers a broad set of APIs. To preserve system stability, security, and backward compatibility, however, Android intentionally hides some interfaces. These hidden APIs, usually marked with `@hide` in source code, exist in the platform source but are excluded from the public Android SDK. Developers can sometimes call them through technical workarounds, but doing so may introduce compatibility problems or trigger system access restrictions.

This article explains what hidden APIs are, how they are categorized, how access restrictions work, how they are generated and detected from source, how they may be called, and how the `greylist` and `blacklist` policies affect Android developers.

---

## 1. Definition and Background

### 1.1 What Is a Hidden API?

A hidden API is a method or field in the Android system that is not exposed to third-party developers. It is usually marked with the `@hide` annotation in source code. These APIs encapsulate implementation details, low-level hardware access, or sensitive system operations, and Android limits direct dependencies on them.

### 1.2 Why Hidden APIs Exist

Hidden APIs exist mainly for these reasons:

1. **System stability**: interfaces that may change across system releases are hidden so app developers do not depend on unstable implementation details.
2. **Security**: sensitive capabilities, such as direct hardware control or low-level resource access, are protected from misuse.
3. **Compatibility**: limiting non-public interfaces reduces fragmentation and prevents vendors or developers from breaking platform consistency through internal methods.
4. **Development flexibility**: Android platform teams can evolve internal functionality without being constrained by external dependencies.

### 1.3 Current State

Starting with Android 9 Pie, Google introduced the **Hidden API Enforcement Policy**, which applies stricter limits to hidden API access. Regular apps can access only certain greylisted APIs, while blacklisted APIs are completely blocked.

---

## 2. Hidden API Categories and Access Policies

### 2.1 Categories

Google categorizes hidden APIs by purpose and sensitivity:

| **Category** | **Access** | **Scope** |
| --- | --- | --- |
| **Public** | Public API with no restriction | Available to regular developers and included in the Android SDK |
| **Whitelist** | Whitelisted API, usually unrestricted | Basic platform interfaces that are publicly supported |
| **Light Greylist** | Greylisted API that logs warnings when regular apps access it | Legacy API temporarily preserved for compatibility and potentially removed in future releases |
| **Dark Greylist** | Dark greylisted API, limited to system apps | Hidden from regular apps but still usable by system-level apps such as preinstalled vendor apps |
| **Blacklist** | Fully blocked API | Sensitive or low-level API that throws `NoSuchMethodError` or `IllegalAccessError` when called |
| **Core platform** | Core platform API limited to apps with platform signing | APIs closely tied to system internals, such as core services or hardware operations |

### 2.2 Access Restrictions

Android mainly restricts hidden API access through two mechanisms.

#### 1. Hidden API Enforcement

Since Android 9, the system enforces hidden API access rules by default. If an app tries to access a hidden API, Android behaves differently depending on the API category:

- **Greylisted APIs**: the runtime logs a warning but allows access.
- **Blacklisted APIs**: the runtime throws an exception and the app may fail.

#### 2. Signature-Based Restrictions

Access to hidden APIs is closely related to app signing. At a high level, signatures map to access levels like this:

1. **Platform signature**:
   - Has the highest privilege and can access all hidden APIs.
   - Uses the system `Platform Key`, such as the key used for `framework.jar`.
2. **System signature**:
   - Can access greylisted APIs, while some blacklisted APIs remain restricted.
   - Uses a system key that is not necessarily the platform key.
3. **Regular signature**:
   - Can access public APIs, whitelisted APIs, and a small number of greylisted APIs.
   - Most blacklisted and dark greylisted APIs are restricted.

---

## 3. Generation and Source-Level Analysis

### 3.1 Role of the `@hide` Annotation

In Android source code, a method or field can be marked as hidden with `@hide`. Once marked, the API is removed during SDK compilation, so developers cannot call it directly through the public SDK.

Example:

```java
/**
 * @hide
 */
public static String get(String key) {
    return native_get(key);
}
```

### 3.2 Hidden API Configuration Files

Hidden API categories are controlled by configuration files during the build. These files are located in the Android source tree and commonly include:

- `hiddenapi-light-greylist.txt`: light greylist
- `hiddenapi-dark-greylist.txt`: dark greylist
- `hiddenapi-blacklist.txt`: blacklist

Each line records the full descriptor of a method or field. For example:

```plain
Landroid/os/SystemProperties;->get(Ljava/lang/String;)Ljava/lang/String;,light-greylist
```

### 3.3 Runtime Behavior

At runtime, Android uses these category files to decide whether an app can access a hidden API. If access goes beyond the app's allowed range, one of the following behaviors occurs.

**Warning log**:

```plain
Accessing hidden method Landroid/os/SystemProperties;->get(Ljava/lang/String;)Ljava/lang/String; (greylist, linking, allowed)
```

**Exception**:

```plain
java.lang.NoSuchMethodError: No direct method ...
```

---

## 4. Detecting and Calling Hidden APIs

### 4.1 Detection Tools and Methods

1. **Hidden API logs**:
   - Check hidden API access records in `logcat`.
   - Example:

```plain
Accessing hidden method Landroid/os/SystemProperties;->get(Ljava/lang/String;) (blacklist, blocked)
```

2. **Hidden API flags files**:
   - Analyze `hiddenapi-flags.csv` to confirm the category of a method.
   - Example:

```plain
Landroid/app/ActivityManager;->getService()Landroid/app/IActivityManager;,blacklist
```

### 4.2 Calling Hidden APIs

Although hidden API access is restricted, developers may still try to call hidden APIs through the following approaches. More techniques are discussed in [bypassing Android restricted APIs](https://github.com/jakkypan/trivia/blob/master/%E7%AA%81%E7%A0%B4%E5%AE%89%E5%8D%93%E9%99%90%E5%88%B6API%E7%9A%84%E7%A0%B4%E8%A7%A3%E6%96%B9%E6%B3%95.md).

1. **Reflection**: use Java reflection to access hidden methods. Be aware that Android 9 and later may trigger runtime restrictions.

```java
Method method = Class.forName("android.os.SystemProperties")
                     .getDeclaredMethod("get", String.class);
method.setAccessible(true);
String value = (String) method.invoke(null, "os.version");
```

2. **Modify the Hidden API policy**: use an ADB command to adjust the hidden API restriction level.

```bash
adb shell settings put global hidden_api_policy 0
```

---

## 5. How Developers Should Respond

### 5.1 Recommended Alternatives

1. **Prefer public APIs**:
   - Look for public APIs that provide equivalent functionality.
   - For example, use `Settings` instead of directly reading or writing system properties.
2. **Request vendor support**:
   - For device-specific capabilities, contact the device vendor and ask for an officially supported interface.

### 5.2 Avoiding Risk

1. **Compatibility problems**:
   - Hidden APIs may change or be removed in future Android releases, causing crashes.
2. **Google Play restrictions**:
   - Apps that use hidden APIs may be rejected from Google Play.

---

## 6. Summary and Outlook

Hidden APIs are an important Android mechanism for maintaining stability, security, and compatibility. Although developers can sometimes call them through technical workarounds, avoiding hidden API dependencies is still the safest engineering choice. When a feature seems to require hidden access, prefer public APIs first, or work with the device vendor for official support.

As Android continues to evolve, Google's restrictions on hidden APIs will become stricter. Developers should follow official platform guidance to preserve long-term app compatibility and stability.
