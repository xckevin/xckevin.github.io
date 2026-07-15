---
title: "On-Device LLM Tokenization and Decoding on Android"
lang: en
translationKey: android-on-device-ai-tokenization-decoding
slug: android-on-device-ai-tokenization-decoding
excerpt: "How BPE tokenization, Top-K, and Top-P sampling shape quality, latency, and memory use in Android on-device AI."
publishDate: '2026-06-28'
tags:
- "Android"
- "On-device Inference"
- "LLM"
- "Tokenization"
seo:
  title: "Android LLM Tokenization and Decoding Strategies"
  description: "A practical guide to BPE tokenization and Top-K/Top-P decoding for Android on-device LLMs."
  pageType: article
---

## A quality issue of client-side reasoning

When running the Gemma 2B model on MediaPipe LLM Inference, I encountered a problem: for the same prompt, the text returned by the server was smooth and natural, but repeated phrases and logical breaks appeared frequently on the client side. After investigation, we found that the problem was not in the model weight, but in the default configuration of the decoding strategy—the server used Top-P + Top-K joint sampling, and the client-side SDK used Greedy Search by default.

This difference is amplified in end-to-end inference. The computing power of the server is sufficient, and even if the sampling strategy is not ideal, large models can rely on the number of parameters; the number of parameters of the end-side model is usually 1-3B, and the quality of the decoding strategy directly determines the lower limit of the generation quality.

## BPE word segmentation: How does the model "see" the text?

The input of LLM is not a raw string, but a sequence of integers, and each integer corresponds to a Token in the vocabulary. BPE (Byte Pair Encoding) is the core algorithm of SentencePiece tokenizer and the standard choice for models such as Gemma and Llama.

The training process of BPE is very straightforward: starting from the character level, counting the frequency of adjacent token pairs, merging high-frequency pairs into a new token, and iterating repeatedly until the word expression reaches the preset size.
```
Initial vocabulary: 'l', 'o', 'w', 'e', 'r' (individual characters)
Round 1: find the most frequent pair → merge 'l' + 'o' into 'lo'
Round 2: find the most frequent pair → merge 'lo' + 'w' into 'low'
Round 3: find the most frequent pair → merge 'e' + 'r' into 'er'
...repeat until the vocabulary reaches its target size (for example, 32K)
```

The advantage of BPE lies in subword granularity: character-level segmentation will make the sequence too long and slow down reasoning; word-level segmentation will be helpless when encountering unregistered words. The sub-word takes the best of both worlds - "unbelievable" is split into `un` + `believe` + `able`, and the model can reuse the understanding of known root words.

On the Android side, the SentencePiece model is packaged with the APK in a `.model` file, and loading is simple:

```kotlin
val processor = SentencePieceProcessor(
    context.assets.openFd("tokenizer.model")
)
val tokens = processor.encode("Hello, how are you?")
// tokens: [2, 1234, 567, 890, 123, 45]
```

The encoded token sequence is sent to model inference to obtain the probability distribution of each position on the vocabulary. The core problem to be solved by the decoding strategy is: how to select the most appropriate token sequence from these probability distributions.

## Greedy Search and Beam Search: Dilemma between the client and the client

Greedy search selects the token with the highest probability at each step without backtracking. The delay is the lowest, but there is an obvious flaw: once you choose a wrong step, everything else will be wrong. What is more common is to fall into a repetitive cycle - the model selects a high-frequency but meaningless token at a certain step, and the subsequent probability distribution pushes it back to the same choice.

Actual measurement of Gemma 2B uses greedy search to generate Chinese, and more than 30% of the output contains at least one consecutive repeated phrase (more than 3 tokens). This is a common problem with small end-side models, not a bug.

Beam Search maintains k candidate sequences, expands all candidates at each step, and retains the k ones with the highest probability product. Theoretically, it is better than greedy search, but there are two problems when it comes to implementation: when beam width=4, the amount of inference calculation is 4 times that of greedy search; beams tend to converge, and the generated text is uneven and lacks diversity. Actual measurement on Pixel 8 shows that when beam width=3, the first token delay soars from 200ms to 600ms. Doing Beam Search on the client side is not cost-effective.

## Top-K and Top-P: The optimal solution for end-side sampling

Top-K and Top-P are both based on random sampling, but control the randomness in different ways.

Top-K sampling: At each step, only the K tokens with the highest probability are sampled, and the long-tail distribution is truncated by a fixed number. The smaller K is, the more conservative the output is.

Top-P (Nucleus Sampling): Start accumulating from the token with the highest probability, stop when the cumulative probability reaches P, and only use this dynamic set for sampling. When the distribution is sharp (the model is very sure of the next token), the candidate pool is automatically narrowed; when the distribution is flat, more room for choice is given.

The industry usually uses a combination of the two: first Top-K filtering, then Top-P filtering, and finally sampling from the remaining set.

```kotlin
fun sampleToken(logits: FloatArray, topK: Int, topP: Float, temp: Float): Int {
    // Temperature scaling
    val scaled = logits.map { it / temp }
    val probs = softmax(scaled)
    
    // Top-K filtering
    val sortedIndices = probs.indices.sortedByDescending { probs[it] }.take(topK)
    
    // Top-P filtering
    var cumProb = 0f
    val nucleus = mutableListOf<Int>()
    for (idx in sortedIndices) {
        nucleus.add(idx)
        cumProb += probs[idx]
        if (cumProb >= topP) break
    }
    
    // Renormalize and sample
    val filteredProbs = nucleus.map { probs[it] }
    val sum = filteredProbs.sum()
    var rand = Random.nextFloat() * sum
    for ((i, p) in filteredProbs.withIndex()) {
        rand -= p
        if (rand <= 0) return nucleus[i]
    }
    return nucleus.last()
}
```

The core difference between the two: K is a fixed window and P is a dynamic threshold. When the probability distribution is highly concentrated, Top-P's candidate pool may only have 2-3 tokens, while Top-K still gives 40 tokens, and the extra ones are noise.

## End-side parameter adjustment practice

After repeated debugging on Gemma 2B and Phi-2, I compiled a set of reference configurations:

| Scene | Top-K | Top-P | Temperature | Description |
|------|-------|-------|-------------|------|
| Translation/Abstract | 20-30 | 0.85 | 0.7 | Partially certain, less hallucinations |
| Conversation/Q&A | 40-50 | 0.9 | 0.8 | Balancing fluency and variety |
| Creative Writing | 60-80 | 0.95 | 1.0 | High variety, jumping allowed |

Some experience:

Do not turn Temperature and Top-P up at the same time. When Temp=1.2 and Top-P=0.95, the model output becomes incoherent. First fix Top-P, adjust Temperature separately, and then fine-tune Top-P after finding an acceptable range.

For client-side dialogue scenarios, it is recommended that Top-K=40, Top-P=0.9, and Temp=0.8. This is the most stable starting configuration after repeated verification on different models, and it can produce readable Chinese text. If there are still duplicates, give priority to lowering Temperature rather than lowering Top-K.

Repetition Penalty is a mandatory option on both sides. Small end-side models are more likely to fall into token duplication. Set a penalty factor of 1.1-1.2 to reduce the probability of tokens that have appeared:

```kotlin
for (tokenId in generatedTokens) {
    probs[tokenId] /= penalty
}
```

## Selection decision

The selection of the end-side decoding strategy is essentially a triangular trade-off between delay, quality, and diversity.

If the product is extremely sensitive to delays (such as input method completion), use greedy search, but add duplicate detection logic at the business layer as a backup. Conversational applications use Top-K + Top-P joint sampling by default, which is the most cost-effective solution on the device side. Beam Search is not a good choice on the client side, unless you are running an ultra-small model below 0.5B.

Decoding strategy is not a set-and-forget parameter. For the same model, the optimal Top-P values ​​in Chinese and English may be different - Chinese tokens have coarser granularity and more concentrated distribution, and Top-P can be set lower by 0.05-0.1. Spending an afternoon adjusting parameters will pay off far more than a week of prompt engineering.
