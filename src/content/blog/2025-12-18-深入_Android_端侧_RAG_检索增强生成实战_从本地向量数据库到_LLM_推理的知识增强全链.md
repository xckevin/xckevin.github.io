---
title: 深入 Android 端侧 RAG 检索增强生成实战：从本地向量数据库到 LLM 推理的知识增强全链路
excerpt: 本文介绍在 Android 端侧落地 RAG 检索增强生成的全链路实践，涵盖文档向量化、SQLite 本地向量检索、MediaPipe LLM 推理等关键技术选型与性能优化。
publishDate: '2025-12-18'
tags:
- Android
- RAG
- LLM
- MediaPipe
- 向量检索
seo:
  title: 深入 Android 端侧 RAG 检索增强生成实战：从本地向量数据库到 LLM 推理的知识增强全链路
  description: 深入解析 Android 端侧 RAG 系统构建全流程：从 all-MiniLM-L6-v2 文本向量化、SQLite 本地向量检索到 Gemma 2B LLM 推理，附完整代码实现与性能评测。
---

去年在做一个企业知识库 App 时，产品提了个需求：用户在飞机上也能查内部文档、问技术问题。服务端 RAG 方案直接 pass——没网。当时的第一反应是"这怎么可能"，但拆解下来发现，端侧 RAG 的三块拼图其实都有现成的轮子。

这篇文章直接走一遍我在 Android 上落地端侧 RAG 的全链路：文本分块 → 向量嵌入 → 本地向量检索 → LLM 推理生成。

## 端侧 RAG 的架构总览

标准 RAG（Retrieval-Augmented Generation）流程分三步：**文档切块并向量化存入数据库 → 用户问题同样向量化后检索相关片段 → 将检索结果作为上下文送入 LLM 生成答案**。

服务端方案里，这三步分别由 LangChain、Pinecone/Milvus、OpenAI API 承担。端侧方案的不同点在于所有计算都在设备本地完成，不能依赖任何远程服务。

```
用户问题
  │
  ▼
Embedding 模型（本地）→ 问题向量
  │
  ▼
向量相似度检索（本地向量库）→ Top-K 文档片段
  │
  ▼
Prompt 拼接（模板+检索结果+问题）
  │
  ▼
LLM 推理（MediaPipe/LiteRT）→ 生成答案
```

技术选型上，我最终确定了这个组合：

- **文本嵌入**：all-MiniLM-L6-v2 通过 MediaPipe 转换为 TFLite 格式，输出 384 维向量
- **向量存储**：自建轻量方案，基于 SQLite + 余弦相似度计算
- **LLM 推理**：Gemma 2B 或 Phi-2，通过 MediaPipe LLM Inference 加载运行

## 文档向量化：把文本变成可以"搜索"的数字

RAG 的第一步是把知识库文档切成块，块大小直接影响检索质量。

```kotlin
data class DocumentChunk(
    val id: String,
    val content: String,
    val embedding: FloatArray,
    val metadata: Map<String, String>
)

class DocumentSplitter(
    private val chunkSize: Int = 512,
    private val overlap: Int = 64
) {
    fun split(text: String): List<String> {
        val chunks = mutableListOf<String>()
        var start = 0
        while (start < text.length) {
            val end = minOf(start + chunkSize, text.length)
            chunks.add(text.substring(start, end))
            start += chunkSize - overlap // 重叠保证语义连续性
        }
        return chunks
    }
}
```

块大小 512 个 token、重叠 64 个 token 是我反复测试后的取值——太小语义不完整，太大检索精度下降。如果你的文档以 FAQ 短句为主，可以降到 256。

嵌入模型的选型更棘手。服务端动不动就是 OpenAI text-embedding-3-large（3072 维），端侧跑不了那个体量。实测下来，**all-MiniLM-L6-v2** 转 TFLite 后约 90MB，在骁龙 8 Gen 2 上单次嵌入耗时 30-50ms，384 维向量精度足够。

模型转换用 MediaPipe 的工具链：

```bash
# 从 HuggingFace 下载并转换为 TFLite
pip install mediapipe
python -m mediapipe.tools.convert_sentence_piece \
  --model_name all-MiniLM-L6-v2 \
  --output_dir ./models/
```

转换完得到一个 `.tflite` 文件和一个 tokenizer 配置。Android 端加载方式：

```kotlin
val embedder = TextEmbedder.createFromFile(context, "all_minilm_l6_v2.tflite")
val result = embedder.embed(question)
val embedding = result.embeddingResult().embeddings()[0].floatEmbedding() // 384维
```

## 本地向量检索：用 SQLite 造一个够用的向量库

这是整个方案里我最纠结的一环。端侧没有 Pinecone 和 Milvus，市面上能看的方案要么太重要么不全。

ObjectBox Vector Search 看起来不错，但引入额外依赖后 APK 体积多了 15MB，不值得。我最后用了一个"土办法"：**SQLite 存向量，Java/Kotlin 侧做余弦相似度计算**。对于一个本地知识库几千条记录的场景，完全够用。

```kotlin
class LocalVectorStore(private val db: SQLiteDatabase) {

    companion object {
        private const val TABLE = "embeddings"
    }

    init {
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS $TABLE (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                embedding BLOB NOT NULL,
                metadata TEXT
            )
        """)
    }

    fun search(queryEmbedding: FloatArray, topK: Int = 5): List<Pair<Float, DocumentChunk>> {
        val results = mutableListOf<Pair<Float, DocumentChunk>>()
        val cursor = db.rawQuery("SELECT * FROM $TABLE", null)

        while (cursor.moveToNext()) {
            val storedEmbedding = deserialize(cursor.getBlob(2))
            val similarity = cosineSimilarity(queryEmbedding, storedEmbedding)
            results.add(similarity to DocumentChunk(
                id = cursor.getString(0),
                content = cursor.getString(1),
                embedding = storedEmbedding,
                metadata = emptyMap()
            ))
        }
        cursor.close()
        return results.sortedByDescending { it.first }.take(topK)
    }

    private fun cosineSimilarity(a: FloatArray, b: FloatArray): Float {
        var dot = 0f; var normA = 0f; var normB = 0f
        for (i in a.indices) {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        return dot / (sqrt(normA) * sqrt(normB))
    }
}
```

检索速度远比想象中快。3000 条 384 维向量，单次检索耗时约 8ms——瓶颈根本不在计算，而在磁盘 I/O。数据量上到万条级别时，内存缓存热数据可以把单次检索压到 5ms 以内，SIMD 加速点积运算也能再快一截，但 3000 条以下完全没必要折腾。

## LLM 推理：把 Gemma 塞进手机

检索拿到了 Top-5 相关片段，下一步是拼 Prompt 并送入本地 LLM。

MediaPipe 在 2024 年底推出了 LLM Inference API，支持 Gemma、Phi-2、Falcon 等模型，Android 端通过 AAR 直接集成：

```kotlin
// build.gradle
dependencies {
    implementation("com.google.mediapipe:tasks-genai:0.10.14")
}
```

初始化时指定模型路径，可选配置最大 token 数和温度：

```kotlin
val options = LlmInference.LlmInferenceOptions.builder()
    .setModelPath("/data/local/tmp/gemma2b.bin")
    .setMaxTokens(512)
    .setTemperature(0.7f)
    .build()

val llmInference = LlmInference.createFromOptions(context, options)
```

Prompt 拼接是影响回答质量的核心环节。我的模板结构：

```kotlin
fun buildPrompt(question: String, retrievedChunks: List<String>): String {
    val context = retrievedChunks.joinToString("\n\n") { "---\n$it" }
    return """
你是一个内部知识库助手。请根据以下参考资料回答问题。
如果参考资料中没有相关信息，请如实说明。

参考资料：
$context

问题：$question

回答：
""".trimIndent()
}
```

检索结果按相似度排序，取 Top-3 到 Top-5 塞入上下文——超过 5 条会增加推理耗时且容易让模型困惑。

```kotlin
val response = llmInference.generateResponse(prompt)
// response 以流式方式逐 token 返回，适合做打字机效果
```

踩过一个坑：Gemma 2B 对中文文档的理解不如英文，遇到专业术语容易编造内容。解决方案是在 Prompt 里加一条强约束——"如果参考资料中没有相关信息，请如实说明"——效果提升明显。

## 全链路串起来：一个完整的问答调用

把三个模块串成一条调用链，整个文件不超过 80 行：

```kotlin
class OnDeviceRAG(
    private val embedder: TextEmbedder,
    private val vectorStore: LocalVectorStore,
    private val llm: LlmInference
) {
    suspend fun ask(question: String): String = withContext(Dispatchers.Default) {
        // Step 1: 问题向量化
        val embedding = embedder.embed(question)
            .embeddingResult().embeddings()[0].floatEmbedding()

        // Step 2: 向量检索
        val chunks = vectorStore.search(embedding, topK = 5).map { it.second.content }

        // Step 3: Prompt 拼接 + LLM 推理
        val prompt = buildPrompt(question, chunks)
        llm.generateResponse(prompt)
    }
}
```

## 性能与取舍

在骁龙 8 Gen 2 设备上实测（知识库 2000 条文档片段，Gemma 2B int8 量化）：

| 环节 | 耗时 |
|------|------|
| Embedding 编码 | 35ms |
| 向量检索（余弦相似度） | 12ms |
| LLM 推理（首 token） | 1.8s |
| LLM 推理（总计 200 token） | 8s |

首 token 延迟接近 2 秒，对交互体验有影响。目前能做的优化：用 4-bit 量化模型，首 token 可以降到 800ms，代价是回答质量略有下降。我更倾向于保持 int8，然后在 UI 上做一个加载动画过渡。

内存占用方面，整个管线大约占用 2.8GB RAM——Gemma 2B 占大头。低端机跑不动是硬伤，目前只建议中高端设备使用。

知识库更新是另一个现实问题。文档变更后需要重新切块和向量化，这个过程放在后台线程执行，对用户透明：

```kotlin
suspend fun reindex(documentDir: File) = withContext(Dispatchers.IO) {
    val splitter = DocumentSplitter()
    documentDir.walk().filter { it.extension == "txt" || it.extension == "md" }.forEach { file ->
        val chunks = splitter.split(file.readText())
        chunks.forEach { chunk ->
            val embedding = embedder.embed(chunk).embeddingResult().embeddings()[0].floatEmbedding()
            vectorStore.insert(chunk, embedding)
        }
    }
}
```

文档量大时做增量索引即可——记录文件修改时间，只处理变更部分。

三个模块拆开来看都不复杂，真正花时间的是踩模型质量与设备性能的平衡点。如果只推荐一条经验：先用小模型跑通全链路，再逐步升级模型和优化速度，比一开始就追求完美要务实得多。
