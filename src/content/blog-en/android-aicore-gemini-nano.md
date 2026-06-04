---
title: "Android AICore and Gemini Nano: System Services, Safety Filters, and LoRA Adaptation"
lang: en
translationKey: android-aicore-gemini-nano
slug: android-aicore-gemini-nano
excerpt: "A deep dive into Google AICore for Gemini Nano on Android, covering APEX delivery, permission isolation, model distribution, safety filtering, session management, and LoRA adapters."
publishDate: '2025-05-21'
tags:
- "Android"
- "AICore"
- "Gemini Nano"
- "LoRA"
- "On-device Inference"
seo:
  title: "Android AICore and Gemini Nano: System Services, Safety, and LoRA"
  description: "Explore Google AICore for Gemini Nano on Android, including APEX delivery, permission isolation, safety filters, model updates, and LoRA adapters."
  pageType: article
---

When discussing on-device LLM inference earlier, the focus was mostly on MediaPipe LLM Inference and general-purpose inference engines. A reader asked a sharper question: how does Google's own Gemini Nano actually run on Android, and how is it different from third-party models?

The answer is **AICore**, Android's system-level inference service built by Google for Gemini Nano. It is not a simple JNI wrapper. It is a complete engineering system that covers model distribution, permission isolation, safety filtering, and hot-swappable LoRA adapters.

## Why AICore is needed

Putting a large model into a phone is much harder than running a normal TF Lite model:

- **Model size**: the 4-bit quantized version of Gemini Nano 1.0 is about 1.8 GB, so it cannot be packaged into an APK like a regular `.so` library
- **Permission isolation**: Gemini Nano can read SMS content and summarize pages, which is far more sensitive than an OCR model
- **Multi-app sharing**: Android cannot let every app store its own 1.8 GB copy of the model
- **Hot updates**: model iteration happens on a weekly cadence and cannot wait for OTA updates

AICore solves this in a very Google way: make inference a system service, distribute it through an APK-in-APEX mechanism, and concentrate permissions at the system layer.

## AICore system service architecture

```
┌─────────────────────────────────┐
│       App (3rd party)           │
│  AiCoreService.connect()        │
└───────────┬─────────────────────┘
            │ AIDL (IPC)
┌───────────▼─────────────────────┐
│   AICore System Service (APEX)  │
│  ┌───────────────────────────┐  │
│  │  InferenceSessionManager  │  │
│  │  - LoRA Adapter Registry  │  │
│  │  - Safety Filter Pipeline │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Google AI Edge Runtime   │  │
│  │  (TF Lite + XNN Pack)     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

AICore exists as an APEX package and runs inside the `system_server` process. Two design choices matter most.

**Permission consolidation**: apps communicate with AICore through AIDL. They do not directly access model files or the inference engine. Sensitive interfaces, such as SMS summarization, require explicit user authorization in Settings instead of app-declared permissions alone.

**Resource scheduling**: AICore is aware of system memory pressure and actively unloads LoRA weights when memory is low. On a Pixel 8 Pro, unloading a 40 MB LoRA adapter takes about 200 ms, while the base model remains in 4 GB+ resident memory. This is coordinated with the `lmkd` daemon.

### Session management: one connection, many inferences

```kotlin
val session = AICore.createTextSession(
    TextSessionConfig.Builder()
        .setTemperature(0.7f)
        .setTopK(40)
        .setLoraPath("/data/.../finance-v1.lora")
        .build()
)

val response = session.generateText("Summarize the key risk factors in this earnings report:\n$text")
session.close()
```

Every `createTextSession` call creates an independent KV cache context, and sessions are fully isolated from one another. A single Service connection can create multiple sessions for one app, for example a translation session and a summarization session, each with its own LoRA adapter and system prompt.

## Model distribution: from Google Play Services to AICore

Gemini Nano is not packaged into the system image. It is downloaded on demand through Google Play Services. Distribution happens in three steps:

1. **Trigger condition**: when an app first calls `AICoreService.isModelAvailable()`, AICore asks Google Play Services whether the model is available
2. **Download decision**: Google Play Services checks device capability, such as RAM >= 8 GB and either an NPU or enough CPU compute, then triggers the download if the device qualifies; otherwise it returns `MODEL_UNAVAILABLE`
3. **Incremental updates**: model updates download only the delta, borrowing from the bsdiff-style differential update mechanism used by Android APKs; a 1.8 GB model version bump typically downloads only 200-400 MB

The SELinux policy around model storage is an easy detail to miss. AICore's data directory is `/data/misc/aicore/`, and only the `system_server` domain can read and write it:

```
/data/misc/aicore/
├── models/
│   └── gemini_nano_v1/
│       ├── model.tflite        # Main 1.8 GB model
│       └── tokenizer.json       # SentencePiece vocabulary
├── lora_adapters/
│   └── finance-v1.lora          # 40 MB LoRA weights
└── sessions/
    └── <uuid>/                  # Session-level KV cache
```

Even if an app somehow gets root, it still cannot bypass SELinux domain isolation. This design blocks filesystem-based model extraction at the root.

## Safe inference and Safety Filter

Getting the model to run is one thing. Keeping its output controlled is another. AICore has two built-in safety-filtering layers.

**Layer 1: input filtering.** Before the prompt reaches the model, AICore runs a Tiny Safety Classifier, about 200 MB, to detect PII exfiltration intent and jailbreak prompt patterns. If a high-risk rule is hit, inference is rejected directly and the prompt never reaches Gemini Nano.

**Layer 2: output filtering.** After the model generates a result, AICore checks for harmful content and hallucinated references before returning the response to the app.

```kotlin
val config = TextSessionConfig.Builder()
    .setSafetySetting(
        SafetySetting.Builder()
            .setHarmCategory(HarmCategory.DANGEROUS_CONTENT)
            .setThreshold(SafetyThreshold.BLOCK_MEDIUM_AND_ABOVE)
            .build()
    )
    .build()
```

In real projects, output filtering is one of the main latency sources. A single Safety classifier pass takes about 80-120 ms. For streaming output, AICore performs incremental checks by token instead of waiting for the full response. The first visible token is not delayed, but the final few tokens may be truncated.

## LoRA fine-tuning adapters

LoRA, or Low-Rank Adaptation, learns task-specific low-rank side matrices without modifying the original model weights. AICore's LoRA support means the same 1.8 GB Gemini Nano model can become a financial analyst by loading a 40 MB `finance-v1.lora`, then become a travel-planning assistant by switching to `travel-v1.lora`. This is the most interesting design point in AICore.

### Loading mechanism and path strategy

LoRA weights are stored in `.lora` format. Conceptually, they are weight-delta matrices for specific layers of the base model. AICore loads them during Session initialization and supports two path types:

```kotlin
// Path 1: app-private directory, suitable for business-specific LoRA adapters
val loraPath = context.filesDir.resolve("finance-v1.lora").absolutePath

// Path 2: AICore shared directory, suitable for vendor-preloaded general LoRA adapters
val loraPath = "/data/misc/aicore/lora_adapters/travel-v1.lora"

val session = AICore.createTextSession(
    TextSessionConfig.Builder()
        .setSystemPrompt("You are a professional financial analyst.")
        .setLoraPath(loraPath)
        .build()
)
```

Business-specific LoRA files should live in the app's private directory so they are not exposed to other apps. Vendor-preinstalled general-purpose LoRA adapters can live in the shared AICore directory and be reused across apps to save storage.

### The hidden cost of hot swapping

One trap I hit: when creating multiple Sessions with different LoRA adapters, each Session loads its own copy of the LoRA matrices into memory. Three Sessions means 3 x 40 MB = 120 MB of LoRA memory, on top of the 1.8 GB base model. Even a 12 GB Pixel 8 Pro becomes tight, and the third background Session is often killed by `lmkd`.

The practical optimization is to reuse a single Session and switch the system prompt when changing tasks, instead of switching LoRA adapters. Create independent Sessions only when the task boundary is truly sharp, such as finance versus medicine. If multiple LoRA adapters must coexist, manage Session lifetime with an LRU strategy and keep no more than two active Sessions.

## Integration practice: minimal three-step setup

**1. Declare the dependency**

```kotlin
dependencies {
    implementation("com.google.android.aicore:aicore:1.0.0")
}
```

**2. Check availability**

```kotlin
if (AICore.isAvailable(context)) {
    // Devices such as Pixel 8 Pro and the Samsung S24 series
    val models = AICore.listAvailableModels()
    // Returns ["gemini_nano_text_v1"]
}
```

**3. Create a session and stream inference**

```kotlin
val session = AICore.createTextSession(defaultConfig)
val stream = session.generateTextStream("Explain Android's Zygote process.")
stream.collect { chunk -> appendToUI(chunk) }
```

`generateTextStream` returns a `Flow<String>`. On a Pixel 8 Pro with Tensor G3, first-token latency is about 300-500 ms including Safety Filter, and generation speed is about 15-20 tokens per second.

If your scenario is general conversation plus lightweight text processing, AICore + Gemini Nano is the first option to consider: no server cost, better privacy control, and continuous model updates from Google. Its closed nature is also its boundary. It does not support loading third-party models; you get Gemini Nano plus LoRA adaptation. Google's positioning is to provide a trusted inference environment that keeps evolving. Developers should spend less attention on the base model itself and more on how to use a 40 MB LoRA adapter to turn the general model into a domain expert.
