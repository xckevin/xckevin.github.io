---
title: "Android On-device RAG: From Local Vector Databases to LLM Inference"
lang: en
translationKey: android-on-device-rag-vector-database
slug: android-on-device-rag-vector-database
excerpt: "A practical walkthrough of on-device Android RAG, covering document chunking, local vector search with SQLite, MediaPipe LLM inference, and performance trade-offs."
publishDate: '2025-12-18'
tags:
- "Android"
- "RAG"
- "LLM"
- "MediaPipe"
- "Vector Search"
seo:
  title: "Android On-device RAG with SQLite Vector Search and LLMs"
  description: "Build an on-device Android RAG pipeline with text embeddings, SQLite vector search, prompt assembly, and Gemma 2B inference through MediaPipe."
  pageType: article
---

Last year, while building an enterprise knowledge-base app, product asked for a feature that sounded unreasonable at first: users should still be able to search internal documents and ask technical questions while sitting on a plane. A server-side RAG system was immediately ruled out because there would be no network. My first reaction was, "How is this supposed to work?" After breaking it down, though, the three major pieces of on-device RAG already had usable building blocks.

This article walks through the full on-device RAG pipeline I shipped on Android: text chunking, vector embedding, local vector retrieval, and LLM-based answer generation.

## On-device RAG architecture

A standard RAG, or Retrieval-Augmented Generation, flow has three steps: **split documents into chunks and vectorize them into a database, vectorize the user's question and retrieve relevant chunks, then pass those chunks as context into an LLM to generate an answer**.

In a server-side system, those steps might be handled by LangChain, Pinecone or Milvus, and the OpenAI API. The on-device version is different because all computation has to happen locally on the device, without relying on any remote service.

```
User question
  |
  v
Embedding model (local) -> question vector
  |
  v
Vector similarity search (local vector store) -> Top-K document chunks
  |
  v
Prompt assembly (template + retrieved context + question)
  |
  v
LLM inference (MediaPipe/LiteRT) -> generated answer
```

For the final technical stack, I settled on this combination:

- **Text embeddings**: all-MiniLM-L6-v2 converted to TFLite through MediaPipe, producing 384-dimensional vectors
- **Vector storage**: a lightweight custom implementation based on SQLite plus cosine similarity
- **LLM inference**: Gemma 2B or Phi-2 loaded through MediaPipe LLM Inference

## Document embedding: turning text into searchable numbers

The first step in RAG is splitting knowledge-base documents into chunks. Chunk size has a direct impact on retrieval quality.

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
            start += chunkSize - overlap // Overlap preserves semantic continuity
        }
        return chunks
    }
}
```

After repeated testing, I found that 512 tokens per chunk with a 64-token overlap is a good default. If chunks are too small, their meaning is incomplete. If they are too large, retrieval precision drops. If your documents are mostly short FAQ entries, you can reduce the chunk size to 256.

Choosing the embedding model is trickier. Server-side systems often use something like OpenAI `text-embedding-3-large` with 3072 dimensions, but that scale does not fit well on a phone. In practice, **all-MiniLM-L6-v2** is a good on-device trade-off. After conversion to TFLite it is about 90 MB, a single embedding call takes around 30-50 ms on a Snapdragon 8 Gen 2 device, and the 384-dimensional vectors are accurate enough for this use case.

The model can be converted with the MediaPipe toolchain:

```bash
# Download from Hugging Face and convert to TFLite
pip install mediapipe
python -m mediapipe.tools.convert_sentence_piece \
  --model_name all-MiniLM-L6-v2 \
  --output_dir ./models/
```

After conversion, you get a `.tflite` file and a tokenizer configuration. On Android, loading it looks like this:

```kotlin
val embedder = TextEmbedder.createFromFile(context, "all_minilm_l6_v2.tflite")
val result = embedder.embed(question)
val embedding = result.embeddingResult().embeddings()[0].floatEmbedding() // 384 dimensions
```

## Local vector retrieval: building a practical vector store with SQLite

This was the part I debated the most. On-device Android does not have Pinecone or Milvus, and the available local options are either too heavy or incomplete.

ObjectBox Vector Search looked promising, but adding it increased APK size by about 15 MB, which was not worth it for this project. I eventually used a plain approach: **store vectors in SQLite and compute cosine similarity in Java or Kotlin**. For a local knowledge base with a few thousand records, it is completely sufficient.

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

Retrieval was much faster than expected. With 3000 vectors at 384 dimensions, one search took about 8 ms. The bottleneck was not computation at all, but disk I/O. Once the dataset grows into the tens of thousands, caching hot records in memory can bring a single search below 5 ms, and SIMD-accelerated dot products can make it even faster. For fewer than 3000 records, though, that extra complexity is not necessary.

## LLM inference: fitting Gemma onto a phone

After retrieval returns the Top-5 relevant chunks, the next step is assembling a prompt and sending it to a local LLM.

MediaPipe introduced the LLM Inference API in late 2024. It supports models such as Gemma, Phi-2, and Falcon, and integrates directly into Android through an AAR:

```kotlin
// build.gradle
dependencies {
    implementation("com.google.mediapipe:tasks-genai:0.10.14")
}
```

During initialization, you specify the model path and optional settings such as max token count and temperature:

```kotlin
val options = LlmInference.LlmInferenceOptions.builder()
    .setModelPath("/data/local/tmp/gemma2b.bin")
    .setMaxTokens(512)
    .setTemperature(0.7f)
    .build()

val llmInference = LlmInference.createFromOptions(context, options)
```

Prompt assembly is the core factor behind answer quality. My template uses this structure:

```kotlin
fun buildPrompt(question: String, retrievedChunks: List<String>): String {
    val context = retrievedChunks.joinToString("\n\n") { "---\n$it" }
    return """
You are an internal knowledge-base assistant. Answer the question using the reference material below.
If the reference material does not contain relevant information, say so honestly.

Reference material:
$context

Question: $question

Answer:
""".trimIndent()
}
```

The retrieved chunks are sorted by similarity, and I usually place the Top-3 to Top-5 chunks into the context. Adding more than five increases inference latency and tends to confuse the model.

```kotlin
val response = llmInference.generateResponse(prompt)
// The response is streamed token by token, which works well for a typewriter effect
```

One issue I hit: Gemma 2B's understanding of Chinese documents is weaker than its English performance, and it can hallucinate around specialized terminology. Adding a strict prompt rule, "If the reference material does not contain relevant information, say so honestly," noticeably improved the results.

## Wiring the full pipeline together

Once the three modules are in place, the complete question-answering call fits into fewer than 80 lines:

```kotlin
class OnDeviceRAG(
    private val embedder: TextEmbedder,
    private val vectorStore: LocalVectorStore,
    private val llm: LlmInference
) {
    suspend fun ask(question: String): String = withContext(Dispatchers.Default) {
        // Step 1: vectorize the question
        val embedding = embedder.embed(question)
            .embeddingResult().embeddings()[0].floatEmbedding()

        // Step 2: run vector retrieval
        val chunks = vectorStore.search(embedding, topK = 5).map { it.second.content }

        // Step 3: assemble the prompt and run LLM inference
        val prompt = buildPrompt(question, chunks)
        llm.generateResponse(prompt)
    }
}
```

## Performance and trade-offs

On a Snapdragon 8 Gen 2 device, with a 2000-chunk knowledge base and an int8-quantized Gemma 2B model, I measured the following:

| Stage | Latency |
|------|------|
| Embedding encoding | 35 ms |
| Vector retrieval (cosine similarity) | 12 ms |
| LLM inference (first token) | 1.8 s |
| LLM inference (200 tokens total) | 8 s |

A first-token latency near two seconds does affect the interaction experience. One current optimization is switching to a 4-bit quantized model, which can reduce first-token latency to around 800 ms, at the cost of slightly lower answer quality. I prefer to keep int8 and use a loading animation in the UI.

Memory usage is another hard constraint. The full pipeline consumes about 2.8 GB of RAM, with Gemma 2B taking most of it. Low-end devices simply cannot run this comfortably, so I currently recommend this only for mid-range and high-end devices.

Knowledge-base updates are another practical problem. When a document changes, it needs to be split and embedded again. This should run on a background thread and stay transparent to the user:

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

For larger document sets, use incremental indexing: record each file's modification time and process only changed content.

Each module is manageable in isolation. The time-consuming part is finding the right balance between model quality and device performance. If I could recommend only one approach, it would be this: start with a small model and get the full pipeline working first, then improve model quality and optimize speed step by step.
