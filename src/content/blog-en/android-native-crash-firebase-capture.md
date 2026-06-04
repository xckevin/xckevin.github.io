---
title: "Android Native Crash Handling and Firebase Capture Guide"
lang: en
translationKey: android-native-crash-firebase-capture
slug: android-native-crash-firebase-capture
excerpt: "How to trigger Android native crashes, why Firebase Crashlytics misses them by default, and how to configure NDK symbol uploads."
publishDate: '2025-02-03'
tags:
- "Android"
- "NDK"
- "Crash Governance"
- "Firebase"
seo:
  title: "Android Native Crash Handling with Firebase Crashlytics NDK"
  description: "Learn how to trigger Android native crashes, configure Firebase Crashlytics NDK, upload debug symbols, and troubleshoot missing symbol tasks."
  pageType: article
---

![](../../assets/android-native-crash-%E5%8F%8A-firebase-%E6%8D%95%E8%8E%B7%E6%96%B9%E6%A1%88%E8%AF%A6%E8%A7%A3-1.png)

In Android development, app crashes can be divided into **Java-layer crashes, such as RuntimeException**, and **native-layer crashes, such as NDK-related SIGSEGV crashes**. Java crashes are usually easy for Firebase Crashlytics to capture, but **native crashes are not recorded by Firebase by default** and require additional configuration.

This article covers five topics:

1. **How to trigger a native crash on Android**
2. **Why Firebase does not capture native crashes by default**
3. **How to configure Firebase to support native crash capture**
4. **How to fix the missing uploadCrashlyticsSymbolFileDebug task**
5. **Summary and best practices**

---

## 1. How to trigger a native crash on Android

### 1.1 Create an NDK project and enable NDK support

First, make sure the project supports the NDK. Enable the NDK and specify `ndkVersion` in `app/build.gradle`:

```plain
android {
    defaultConfig {
        ndk {
            abiFilters "armeabi-v7a", "arm64-v8a"  // Compile only common architectures
        }
    }
    buildFeatures {
        prefab true
    }
    externalNativeBuild {
        cmake {
            path "src/main/cpp/CMakeLists.txt"
            version "3.22.1"
        }
    }
}
```

### 1.2 Write C++ code that triggers a crash

Create `native_crash.cpp` under `app/src/main/cpp/` and add the following C++ code:

```plain
#include <jni.h>
#include <stdlib.h>

extern "C"
JNIEXPORT void JNICALL
Java_com_example_crash_MainActivity_nativeCrash(JNIEnv *env, jobject instance) {
    int *p = nullptr;
    *p = 42;  // Dereference a null pointer to force a crash
}
```

### 1.3 Call the native method from Java code

In `MainActivity.java`:

```plain
public class MainActivity extends AppCompatActivity {
    static {
        System.loadLibrary("native-lib");
    }
    public native void nativeCrash();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        findViewById(R.id.btn_crash).setOnClickListener(v -> nativeCrash());
    }
}
```

Run the app and tap the button to trigger a native crash.

---

## 2. Why does Firebase not capture native crashes by default?

Firebase Crashlytics primarily targets **Java-layer crashes**. Native-layer crashes, such as SIGSEGV, are not captured by default for several reasons:

1. **Firebase needs an additional NDK component** to parse native crash information.
2. **Symbol files are missing**, so Firebase cannot resolve the crash logs.
3. **Native crash logs are stored in the app's private directory**, so special handling is needed before they can be uploaded to Firebase.

To solve these issues, configure Firebase Crashlytics manually to support NDK crash capture.

---

## 3. Configure Firebase to support native crash capture

### 3.1 Install firebase-crashlytics-ndk

Add the Firebase NDK dependency in `app/build.gradle`:

```plain
dependencies {
    implementation 'com.google.firebase:firebase-crashlytics-ndk:18.6.1'
}
```

After adding it, run **Gradle sync**.

### 3.2 Make sure symbol files, or debug symbols, are uploaded

Enable symbol upload in `app/build.gradle`:

```plain
android {
    buildTypes {
        release {
            minifyEnabled false
            ndk {
                debugSymbolLevel 'FULL'  // Let Firebase parse full native crash logs
            }
        }
    }
}
```

Then run:

```plain
./gradlew app:uploadCrashlyticsSymbolFileRelease
```

---

## 4. How to fix the missing uploadCrashlyticsSymbolFileDebug task

### 4.1 Firebase does not generate uploadCrashlyticsSymbolFileDebug by default

Firebase uploads symbol files only for release builds by default. It does not automatically generate the `uploadCrashlyticsSymbolFileDebug` task for debug builds.

### 4.2 Enable Crashlytics symbol upload for debug builds

Explicitly enable debug builds in `app/build.gradle`:

```plain
android {
    buildTypes {
        debug {
            firebaseCrashlytics {
                mappingFileUploadEnabled true
            }
            ndk {
                debugSymbolLevel 'FULL'
            }
        }
    }
}
```

Then run:

```plain
./gradlew app:uploadCrashlyticsSymbolFileDebug
```

If the task still cannot be found, upload the symbols manually:

```plain
firebase crashlytics:symbols:upload --app=your-firebase-app-id --symbols=path/to/symbols
```

---

## 5. Summary

1. **By default, Firebase captures only Java crashes and cannot capture native crashes.**
2. **To capture native crashes, install the `firebase-crashlytics-ndk` dependency.**
3. **You must enable `debugSymbolLevel 'FULL'` and upload symbol files; otherwise Firebase cannot parse native crash logs.**
4. **Firebase generates only the `uploadCrashlyticsSymbolFileRelease` task by default. If you need debug-build support, configure it manually in the debug build type.**

### Best practices

- **Use Firebase Crashlytics to record native crashes in release builds, and make sure symbol files are complete.**
- **Debug builds can also upload symbol files, which makes native crash debugging easier.**
- **Combine tools such as ndk-stack with Firebase to get more detailed crash information.**

With the right configuration, Firebase can capture native crashes effectively and improve app stability and debugging efficiency.
