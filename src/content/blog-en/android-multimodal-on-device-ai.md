---
title: "Android Multimodal On-device AI: Gemini Nano, Image Tokens, Streaming, and Compose"
lang: en
translationKey: android-multimodal-on-device-ai
slug: android-multimodal-on-device-ai
excerpt: "A practical Android multimodal AI walkthrough covering Gemini Nano Multimodality, AICore model loading, image preprocessing, ViT tokenization, streaming inference, Compose rendering, memory, and thermals."
publishDate: '2026-05-11'
tags:
- "Android"
- "Gemini Nano"
- "Multimodal AI"
- "Compose"
- "On-device Inference"
seo:
  title: "Android Multimodal On-device AI with Gemini Nano and Compose"
  description: "Build Android multimodal AI with Gemini Nano, AICore loading, ViT image encoding, streaming inference, Compose rendering, memory, and thermal control."
  pageType: article
---

Last month, while building intelligent local photo search, we ran into a very practical question: a user takes a photo of a plant and wants to ask, directly on the phone, "How often should I water this plant?" The traditional approach is on-device object detection plus a cloud LLM, but image uploads are a hard privacy problem, and offline environments make the cloud path unusable.

Android 16's AICore now officially supports **Gemini Nano Multimodality** on Pixel devices: the first on-device multimodal model on Android that can understand image and text input together. It took two weeks to get the full path working, and there were plenty of traps. This article walks through the validated path in order: model loading, image encoding, streaming inference, and Compose integration.

## The architecture skeleton of Gemini Nano Multimodality

The first key question is simple: how does an image become something a large model can understand?

Gemini Nano itself is a decoder-only Transformer and natively consumes only text tokens. Multimodal capability is added by placing a **Vision Encoder** in front of it. The encoder uses a ViT architecture: the input image is split into fixed-size patches, usually 16 x 16 pixels each. Each patch is converted into a vector through convolutional embedding, and the encoder outputs a sequence of tokens.

```
Input image (512x512)
  → Vision Encoder (ViT)
  -> 1024 image tokens (768 dimensions each)
  -> Concatenate with text tokens in embedding space
  -> Joint inference in the Gemini Nano decoder
```

Text tokens and image tokens must be projected into **the same embedding space** before they enter the Decoder. That is the prerequisite for cross-modal understanding. Gemini Nano does this with a lightweight projection matrix that maps visual features into the text embedding dimension. AICore hides these details from developers, but understanding the mechanism helps later performance tuning. For example, it explains why image size directly affects token count and inference latency.

## Model loading: AICore download and memory strategy

AICore's loading API is deliberately restrained. The core flow is only a few steps:

```kotlin
val config = GenerativeModelConfig(
    capabilities = setOf(GenerativeCapability.MULTIMODAL)
)
val aicore = AiCore.getDefault()
if (!aicore.isAvailable(context, config)) {
    aicore.download(context, config)
}
val session = aicore.createSession(context, config)
```

The downloaded model lands under `/data/data/com.google.android.aicore/files/` and is about 1.8 GB after INT4 quantization. AICore does one critical thing: it loads model weights into a **contiguous memory region** instead of scattered allocations. GPU and NPU inference rely on contiguous memory to move data efficiently. A fragmented memory layout can directly cause inference failure.

One trap I hit: on some devices, `download()` was interrupted even on Wi-Fi. The root cause was that the Google Play Services download job had limited priority and could be killed in the background. The fix was to move download logic into a `ForegroundService`:

```kotlin
class ModelDownloadService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        scope.launch { aicore.download(this@ModelDownloadService, config) }
        return START_STICKY
    }
}
```

KV cache preallocation is another easy detail to miss. In multimodal scenarios, image token count is usually 256-1024, more than ten times a pure text prompt. If the KV cache is preallocated for text only, the first multimodal inference triggers reallocation and adds hundreds of milliseconds of latency. Warm it up before the first visible inference:

```kotlin
// Send a minimal image-text request to initialize the KV cache
session.sendMessage(
    Content(parts = listOf(ImagePart(dummyBitmap), TextPart("init")))
)
```

On a Pixel 8, this line saves roughly 400 ms of first-frame latency.

## Image preprocessing and token alignment

Before entering the Vision Encoder, the image must be normalized and resized to the expected shape. ViT usually requires a fixed input size, such as 512 x 512 or 336 x 336:

```kotlin
suspend fun Bitmap.prepare(): Bitmap = withContext(Dispatchers.Default) {
    Bitmap.createScaledBitmap(this@prepare, 512, 512, true)
}
```

Choosing 512 versus 336 is a trade-off. A 512 image produces 1024 tokens, while 336 produces about 576 tokens. Fewer tokens make inference faster, but small-object and text recognition quality drops noticeably. In photo-search scenarios where detail matters, 512 is a necessary cost.

Image tokens and text tokens are not just concatenated front to back. Gemini Nano uses **interleaved embedding**: the prompt marks image position with an `<image>` placeholder, visual tokens are inserted at that position, and `<bos>` and `<eos>` separators are added around the boundaries so the model can distinguish modalities. This mechanism lets the model connect "this image" to "this text."

One issue cost me half a day: **EXIF orientation**. Bitmap decoding does not always correct orientation automatically, so the image may enter the Vision Encoder sideways or upside down:

```kotlin
fun Bitmap.correctOrientation(path: String): Bitmap {
    val exif = ExifInterface(path)
    val rotation = when (exif.getAttributeInt(
        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL
    )) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
    }
    if (rotation == 0f) return this
    return Bitmap.createBitmap(this, 0, 0, width, height,
        Matrix().apply { postRotate(rotation) }, true)
}
```

When orientation is wrong, the model sees inverted content and output quality falls sharply. This correction looks minor, but in on-device scenarios users take photos from every possible angle. Skipping it is a production-grade failure.

## Streaming inference and real-time Compose rendering

Measured on a Pixel 8 Pro, Gemini Nano Multimodality has about 1.8 seconds of first-token latency for a 512 x 512 image plus a 50-token text prompt, then generates at about 12 tokens per second. The latency is not low, but zero network overhead and privacy preservation are unique advantages of the on-device path. For many product scenarios, "the image never leaves the phone" is already a hard requirement.

Streaming output is exposed through Kotlin Flow:

```kotlin
session.sendMessageStream(content).collect { response ->
    _responseText.update { it + response.text }  // response.text is an incremental 1-5 token chunk
}
```

Compose integration can bind directly to `StateFlow`:

```kotlin
@Composable
fun MultimodalChat(session: GenerativeSession) {
    val responseText by viewModel.responseText.collectAsStateWithLifecycle()
    Text(text = responseText, style = MaterialTheme.typography.bodyLarge)
}
```

At 12 tokens per second, recomposition happens roughly every 80 ms. High-frequency recomposition can cause dropped frames on lower-end devices. I used `debounce` to throttle UI updates to once every 200 ms:

```kotlin
var buffer by remember { mutableStateOf("") }
var displayText by remember { mutableStateOf("") }

LaunchedEffect(Unit) {
    snapshotFlow { buffer }
        .debounce(200)
        .collect { displayText = it }
}
```

This reduced recomposition frequency by 60%, and users did not perceive any difference. A 200 ms rendering interval still feels real time.

## Three painful engineering details

Looking back after the whole pipeline worked, the most time-consuming work was not the model logic. It was these small systems problems.

**Memory fragmentation.** On a Pixel 6 with 8 GB RAM, after the system had been running for a few hours, available contiguous memory could drop below 1.5 GB and model loading failed. The issue was not total capacity but timing. Load the model early, while memory is less fragmented, and claim the contiguous region. I moved loading to `Application.onCreate()`, and success rate rose from about 70% to over 95%.

**Thermal throttling.** After five consecutive image-text inferences, SoC temperature rose enough to trigger throttling, and inference latency jumped from 1.8 seconds to over 4 seconds. The current compromise is to force a 2-second cooldown after every 3 inferences. It is blunt but effective. A more elegant strategy is still worth exploring, but if you do not handle thermal behavior, continuous on-device multimodal use feels half broken.

**Overlong token sequences.** A 1024-token image plus 50 text tokens, plus KV cache growth, can easily push total sequence length past 2048. Gemini Nano's context window is 4096, so multi-turn conversation exhausts it quickly. Real products need sliding-window truncation and should usually keep only the latest 2-3 turns of KV cache.

This is what on-device AI engineering really looks like: a lot of low-level, unglamorous work. I spent twice as much time on memory management, thermal policy, and orientation correction as on inference code itself. That is not surprising for people who have spent years in client engineering, but engineers coming from server-side AI need to adjust their expectations. Model capability is only the starting point. Running the model reliably across uneven real devices is the real threshold.
