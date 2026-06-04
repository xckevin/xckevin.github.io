---
title: "Android On-device AI Prompt Engineering: Token Budgets, Few-shot Compression, and TTFT Control"
lang: en
translationKey: android-on-device-ai-prompt-engineering
slug: android-on-device-ai-prompt-engineering
excerpt: "A practical Android on-device LLM prompt-engineering guide showing how token budgeting, few-shot template compression, and dynamic budget switching reduced first-token latency from 8.7 seconds to under 2 seconds."
publishDate: '2026-04-28'
tags:
- "Android"
- "Prompt Engineering"
- "On-device AI"
- "Performance Optimization"
- "LLM Inference"
seo:
  title: "Android On-device AI Prompt Engineering for Token Budgets and TTFT"
  description: "Optimize Android on-device LLM prompts with token budgets, few-shot compression, dynamic budget switching, and max output limits to cut TTFT."
  pageType: article
---

While building an on-device document summarization feature, the same 3,000-character contract returned from a cloud API in 1.2 seconds. After moving it to Android with the MediaPipe LLM Inference API, time to first token jumped to 8.7 seconds. Every second users stared at a blank screen cost engagement.

Official optimization advice mostly came down to "use a smaller model" or "lower precision." But the business requirement was that summary quality could not drop. Under that hard constraint, the optimization space moved to the prompt itself.

## Two hard constraints in on-device inference

On-device LLM inference is fundamentally different from cloud inference. Time to first token, or TTFT, grows roughly linearly with prompt length. The bottleneck is the prefill stage: the model must process all input tokens and build the complete KV cache before it can generate the first output token.

Using measured Gemma 2B data on a Pixel 8:

| Prompt tokens | TTFT | Throughput |
|:---:|:---:|:---:|
| 64 | 380 ms | 18.2 tok/s |
| 256 | 1200 ms | 16.8 tok/s |
| 1024 | 4200 ms | 14.3 tok/s |
| 2048 | 8900 ms | 11.1 tok/s |

A 2048-token prompt has 23x the TTFT of a 64-token prompt. That is not even the worst part. The usable context window on device is already tight. Gemma 2B under MediaPipe has roughly 4096 usable tokens, and input and output share that budget.

The second constraint is memory bandwidth. Model weights consume around 2-4 GB, and the KV cache created during prefill grows linearly with input length. One issue I hit: a 4096-token prompt could push KV cache usage above 200 MB. Low-end devices went straight to OOM before writing a useful error log.

## Splitting the token budget

I manage tokens as a finite budget: first define an upper bound for each prompt component, then design the content inside those limits.

```python
# Token budget allocation, using a 512-token limit as an example
TOKEN_BUDGET = 512

BUDGET = {
    "system_prompt": 80,      # Role + output format
    "few_shot": 180,          # 2-3 compressed examples
    "task_instruction": 40,   # Core task
    "input_content": 200,     # User input
    "reserve": 12,            # Buffer
}
```

The point of this system is to force prompts to become compact, instead of accepting a vague "quality for latency" compromise.

```python
# Verbose system prompt, around 80 tokens
"""You are a professional technical-document analysis assistant.
Carefully read the technical document provided by the user and extract
the key information. Output JSON with the following fields:
summary, keywords, difficulty_level.
Make sure the JSON format is correct and parseable."""

# Compact version, around 35 tokens
"""Extract key information from the technical document. Output plain JSON:
{"summary":"...","keywords":[],"difficulty_level":"basic|intermediate|advanced"}
Output JSON only, with no extra text."""
```

Use format constraints instead of behavioral description. Do not say "make sure the JSON format is correct"; provide the schema directly. Do not say "carefully read"; let the output fields drive the model's attention. After compression, I saw no perceptible quality difference.

## Compressing few-shot templates

Few-shot examples are the biggest token sink in on-device scenarios. The traditional approach includes 3-5 full input-output pairs, but under an on-device budget, the input side of each example is mostly redundant. Large source passages inside the prompt add little understanding and a lot of latency.

My approach is template compression: move constants into the system prompt and keep only variables inside examples. For document summarization:

Before compression, more than 100 tokens per example:

```
Example 1:
Input: {the full text of an 800-character technical contract...}
Output: {"summary": "This contract defines a software development
collaboration between Party A and Party B, including project scope,
delivery schedule, payment terms, and other core clauses...",
"keywords": ["software development", "contract", "payment"], "difficulty_level": "intermediate"}
```

After compression, about 30 tokens per example:

```
Example 1:
Input: [contract text]
Output: {"summary":"Software development contract covering scope/delivery/payment terms",
"keywords":["contract","development","payment"],"difficulty_level":"intermediate"}
```

Three techniques compound well:

1. Input placeholders: replace real input with `[contract text]`, cutting about 90% of those tokens
2. Output compression: prioritize keywords, remove unnecessary predicates, and reduce a 50-word summary to about 20 words
3. Example selection: keep only the two most extreme examples, one positive and one negative, and remove the middle cases

Measured result: three examples dropped from 320 tokens to 95 tokens. TTFT fell from 2.1 seconds to 0.9 seconds, while ROUGE-L dropped by only 1.2%. The business team accepted that trade-off.

## Dynamic budgets at runtime

A fixed budget wastes latency headroom. Simple inputs and complex inputs should not pay for the same prompt.

My solution is a two-level budget switch:

```python
def select_budget(input_len: int) -> dict:
    if input_len < 200:
        return {"few_shot": 60, "system": 40}
    elif input_len < 800:
        return {"few_shot": 120, "system": 60}
    else:
        return {"few_shot": 150, "system": 80}
```

The implementation is simple: tokenize the input before building the prompt, reusing MediaPipe's `BertTokenizer`, then select the budget tier by token count.

Task difficulty also needs dynamic handling. For tasks like keyword extraction, removing few-shot examples and using zero-shot plus format constraints reduced tokens from 180 to 60, cut latency by 40%, and did not noticeably hurt accuracy. For reasoning tasks like contract-clause compliance, removing examples caused the false-judgment rate to rise. The decision rule is simple: does the output have a clear right-or-wrong boundary, or is it open-ended generation?

## Engineering trade-offs between latency and quality

I turned these ideas into an operational decision framework:

- **TTFT red line**: if first-token latency exceeds 3 seconds, cut few-shot examples before cutting the system prompt. The system prompt carries output-format constraints. Removing it can produce unparseable JSON, which hurts not just quality but feature availability.
- **Quality fallback**: if zero-shot is not good enough, add one minimal example first, keeping only output structure and the key judgment logic. Add a second only if needed. Marginal gains fade quickly; the third example often contributes less than one-tenth of the first.
- **Budget output tokens too**: set `max_output_tokens` to 256 instead of the default 1024. On-device generation runs around 10-15 tok/s, so 1024 tokens can mean more than a minute of waiting. A small, reasonable cap forces the prompt to elicit denser output.

From Gemma 2B plus MediaPipe on a Pixel 7, my practical numbers are: keep prompts under 400 tokens to hold TTFT under 2 seconds; use a loading animation for 500-800 tokens; above 1000 tokens, fall back to cloud instead of forcing it on device.

The exact numbers will change with hardware, but the budget-first mindset will not. Treat every prompt design as resource allocation, not writing style. The competitiveness of on-device AI is not just model capability; it is engineering judgment under constraints. The tokens you save are not just tokens. They are the seconds users do not spend staring at an empty screen.
